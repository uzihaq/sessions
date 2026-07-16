package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
	"github.com/uzihaq/pretty-pty/prettygo/internal/watch"
)

const (
	workingBytesThreshold = 80
	workingDecay          = 800 * time.Millisecond
	discoveryAttempts     = 3
	discoveryRetryDelay   = 800 * time.Millisecond
	orphanStartingGrace   = 30 * time.Second
	readySettle           = 800 * time.Millisecond
	DefaultMassKillLimit  = 3
)

type MassKillGuard struct{ Limit int }

type MassKillError struct {
	Count int
	Limit int
}

func (e *MassKillError) Error() string {
	return fmt.Sprintf("mass-kill guard refused %d runner removals (limit %d); retry with force", e.Count, e.Limit)
}

func (g MassKillGuard) Check(count int, force bool) error {
	limit := g.Limit
	if limit <= 0 {
		limit = DefaultMassKillLimit
	}
	if !force && count > limit {
		return &MassKillError{Count: count, Limit: limit}
	}
	return nil
}

type ManagerOptions struct {
	MassKillLimit    int
	ActivityInterval time.Duration
	DiscoveryRetries int
	DiscoveryDelay   time.Duration
	DisableWatchers  bool
	ProcessAlive     func(int) bool
	ProcessCommand   func(int) string
}

type DiscoverOptions struct{ Force bool }

type Manager struct {
	config   state.Config
	launcher proto.RunnerLauncher
	registry *state.Registry
	push     *PushService
	guard    MassKillGuard
	options  ManagerOptions
	started  time.Time

	ctx    context.Context
	cancel context.CancelFunc
	ticker *time.Ticker

	mu       sync.Mutex
	runtimes map[string]*runtimeSession
	hooks    globalHooks
}

type globalHooks struct {
	OnIdle string `json:"onIdle"`
}

type runtimeSession struct {
	manager    *Manager
	session    *state.Session
	attachment state.Attachment

	mu                     sync.Mutex
	recentBytes            int
	codexLifecycleWorking  *bool
	pushWorkingObserved    bool
	workingStartedAt       time.Time
	watcher                *watch.FileWatcher
	stopOnce               sync.Once
	structuredEventArrived chan struct{}
}

func NewManager(config state.Config, launcher proto.RunnerLauncher, options ...ManagerOptions) *Manager {
	selected := ManagerOptions{}
	if len(options) > 0 {
		selected = options[0]
	}
	if selected.ActivityInterval <= 0 {
		selected.ActivityInterval = workingDecay
	}
	if selected.DiscoveryRetries <= 0 {
		selected.DiscoveryRetries = discoveryAttempts
	}
	if selected.DiscoveryDelay <= 0 {
		selected.DiscoveryDelay = discoveryRetryDelay
	}
	if selected.ProcessAlive == nil {
		selected.ProcessAlive = processAlive
	}
	if selected.ProcessCommand == nil {
		selected.ProcessCommand = processCommand
	}
	root := config.UserStateRoot
	if root == "" {
		root = config.StateRoot
	}
	ctx, cancel := context.WithCancel(context.Background())
	manager := &Manager{
		config: config, launcher: launcher, registry: state.NewRegistry(config, launcher),
		push: NewPushService(root), guard: MassKillGuard{Limit: selected.MassKillLimit},
		options: selected, started: time.Now(), ctx: ctx, cancel: cancel,
		runtimes: make(map[string]*runtimeSession), hooks: loadGlobalHooks(config.GlobalHooksPath),
	}
	manager.ticker = time.NewTicker(selected.ActivityInterval)
	go manager.activityLoop()
	return manager
}

func (m *Manager) Registry() *state.Registry { return m.registry }
func (m *Manager) Push() *PushService        { return m.push }
func (m *Manager) Config() state.Config      { return m.config }
func (m *Manager) Uptime() time.Duration     { return time.Since(m.started) }
func (m *Manager) IsDiscovering() bool       { return m.registry.IsDiscovering() }
func (m *Manager) List(includeExited bool) []state.SessionInfo {
	return m.registry.List(includeExited)
}
func (m *Manager) Get(id string) (*state.Session, bool) { return m.registry.Get(id) }
func (m *Manager) DeepDiagnostics() []map[string]any    { return m.registry.DeepDiagnostics() }

func (m *Manager) Create(ctx context.Context, request state.CreateSessionRequest) (state.SessionInfo, error) {
	info, err := m.registry.Create(ctx, request)
	if err != nil {
		return state.SessionInfo{}, err
	}
	session, ok := m.registry.Get(info.ID)
	if !ok {
		return state.SessionInfo{}, fmt.Errorf("created session %s was not registered", info.ID)
	}
	runtime := m.manage(session)
	if request.WaitReady {
		m.waitReady(ctx, runtime)
	}
	return session.Info(), nil
}

func (m *Manager) Kill(ctx context.Context, id string, force bool) bool {
	if err := m.guard.Check(1, force); err != nil {
		return false
	}
	return m.registry.Kill(ctx, id, force)
}

func (m *Manager) KillMany(ctx context.Context, ids []string, force bool) error {
	unique := make(map[string]struct{})
	for _, id := range ids {
		if _, ok := m.registry.Get(id); ok {
			unique[id] = struct{}{}
		}
	}
	if err := m.guard.Check(len(unique), force); err != nil {
		return err
	}
	var failures []error
	for id := range unique {
		if !m.registry.Kill(ctx, id, force) {
			failures = append(failures, fmt.Errorf("kill session %s", id))
		}
	}
	return errors.Join(failures...)
}

func (m *Manager) Close() {
	m.cancel()
	m.ticker.Stop()
	m.mu.Lock()
	runtimes := make([]*runtimeSession, 0, len(m.runtimes))
	for _, runtime := range m.runtimes {
		runtimes = append(runtimes, runtime)
	}
	m.runtimes = make(map[string]*runtimeSession)
	m.mu.Unlock()
	for _, runtime := range runtimes {
		runtime.stop()
	}
}

func (m *Manager) manage(session *state.Session) *runtimeSession {
	info := session.Info()
	m.mu.Lock()
	if existing := m.runtimes[info.ID]; existing != nil {
		m.mu.Unlock()
		return existing
	}
	attachment := session.Attach(state.AttachOptions{IncludeClaudeReplay: true, InitialReplayCap: 5000})
	runtime := &runtimeSession{
		manager: m, session: session, attachment: attachment,
		structuredEventArrived: make(chan struct{}, 1),
	}
	for _, event := range attachment.Replay.Events {
		runtime.recentBytes += len(event.Data)
	}
	m.runtimes[info.ID] = runtime
	m.mu.Unlock()
	if !m.options.DisableWatchers {
		runtime.startWatcher(info)
	}
	go runtime.observe()
	return runtime
}

func (m *Manager) dropRuntime(id string, expected *runtimeSession) {
	m.mu.Lock()
	if m.runtimes[id] == expected {
		delete(m.runtimes, id)
	}
	m.mu.Unlock()
	expected.stop()
}

func (m *Manager) activityLoop() {
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.ticker.C:
			m.mu.Lock()
			runtimes := make([]*runtimeSession, 0, len(m.runtimes))
			for _, runtime := range m.runtimes {
				runtimes = append(runtimes, runtime)
			}
			m.mu.Unlock()
			for _, runtime := range runtimes {
				runtime.tick()
			}
		}
	}
}

func (r *runtimeSession) observe() {
	id := r.session.Info().ID
	for event := range r.attachment.Events {
		switch event.Kind {
		case proto.EventOutput:
			r.mu.Lock()
			r.recentBytes += len(event.Output.Data)
			r.mu.Unlock()
		case proto.EventClaude:
			select {
			case r.structuredEventArrived <- struct{}{}:
			default:
			}
		case proto.EventRunnerLost:
			r.manager.dropRuntime(id, r)
			r.manager.scheduleReconnect(id, []time.Duration{time.Second, 3 * time.Second, 10 * time.Second})
			return
		case proto.EventExit:
			r.manager.dropRuntime(id, r)
			return
		}
	}
}

func (r *runtimeSession) stop() {
	r.stopOnce.Do(func() {
		r.attachment.Cancel()
		r.mu.Lock()
		watcher := r.watcher
		r.watcher = nil
		r.mu.Unlock()
		if watcher != nil {
			watcher.Close()
		}
	})
}

func (r *runtimeSession) tick() {
	info := r.session.Info()
	if info.Exited {
		return
	}
	r.mu.Lock()
	r.recentBytes /= 2
	recent := r.recentBytes
	codex := r.codexLifecycleWorking
	r.mu.Unlock()
	byteWorking := recent >= workingBytesThreshold
	next := byteWorking
	switch info.Tool {
	case state.ToolClaude:
		if recent <= 0 {
			next = false
		} else if snapshot, _, err := r.session.Snapshot(context.Background(), 0); err == nil {
			next = ClaudeWorkingFromSnapshot(snapshot)
		}
	case state.ToolCodex:
		if codex != nil {
			next = *codex
		}
	}
	r.setWorking(next)
}

func (r *runtimeSession) setWorking(next bool) {
	previous, exited := r.session.SetWorking(next)
	now := time.Now()
	r.mu.Lock()
	if !previous && next {
		r.workingStartedAt = now
		r.manager.removeIdleSentinel(r.session.Info().ID)
	}
	if !r.pushWorkingObserved {
		r.pushWorkingObserved = true
		r.mu.Unlock()
		return
	}
	if !previous || next {
		r.mu.Unlock()
		return
	}
	started := r.workingStartedAt
	r.workingStartedAt = time.Time{}
	r.mu.Unlock()
	if exited {
		return
	}
	duration := time.Duration(0)
	if !started.IsZero() {
		duration = now.Sub(started)
		if duration < 0 {
			duration = 0
		}
	}
	r.manager.handleIdle(r.session, duration)
}

func (r *runtimeSession) startWatcher(info state.SessionInfo) {
	var watcher *watch.FileWatcher
	switch info.Tool {
	case state.ToolClaude:
		created, err := watch.WatchSessionFile(watch.ClaudeWatcherOptions{
			CWD: info.Cwd, ClaudeSessionID: extractClaudeSessionID(info.Args),
		})
		if err != nil {
			return
		}
		watcher = created
	case state.ToolCodex:
		watcher = watch.WatchCodexRollout(watch.CodexWatcherOptions{
			CWD: info.Cwd, Args: info.Args, CreatedAt: time.UnixMilli(info.CreatedAt),
		})
	default:
		return
	}
	r.mu.Lock()
	r.watcher = watcher
	r.mu.Unlock()
	go func() {
		for watcher != nil {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				raw, err := json.Marshal(event)
				if err == nil {
					r.session.RecordClaudeEvent(raw)
				}
			case working, ok := <-watcher.Working:
				if !ok {
					return
				}
				r.mu.Lock()
				value := working
				r.codexLifecycleWorking = &value
				r.mu.Unlock()
				r.setWorking(working)
			case _, ok := <-watcher.Errors:
				if !ok {
					return
				}
			case <-r.manager.ctx.Done():
				return
			}
		}
	}()
}

func (m *Manager) waitReady(ctx context.Context, runtime *runtimeSession) {
	if runtime.session.ClaudeEventCount() > 0 {
		select {
		case <-ctx.Done():
		case <-time.After(readySettle):
		}
		return
	}
	info := runtime.session.Info()
	if info.Tool != state.ToolClaude && info.Tool != state.ToolCodex {
		select {
		case <-ctx.Done():
		case <-time.After(readySettle):
		}
		return
	}
	select {
	case <-ctx.Done():
	case <-runtime.structuredEventArrived:
	case <-time.After(readySettle):
	}
}

func extractClaudeSessionID(args []string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] != "--session-id" && args[i] != "--resume" {
			continue
		}
		value := args[i+1]
		if len(value) < 8 {
			continue
		}
		valid := true
		for _, r := range value {
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') || r == '-') {
				valid = false
				break
			}
		}
		if valid {
			return value
		}
	}
	return ""
}

func (m *Manager) scheduleReconnect(id string, delays []time.Duration) {
	if len(delays) == 0 {
		return
	}
	delay := delays[0]
	time.AfterFunc(delay, func() {
		select {
		case <-m.ctx.Done():
			return
		default:
		}
		if _, exists := m.registry.Get(id); exists {
			return
		}
		path := filepath.Join(m.config.RunnerStateDir, id+".sock")
		if _, err := os.Stat(path); err != nil {
			m.scheduleReconnect(id, delays[1:])
			return
		}
		metadata, _ := state.ReadRunnerInfo(filepath.Join(m.config.RunnerStateDir, id+".json"))
		metadata.ID = id
		metadata.SocketPath = path
		if runner, attachErr := m.launcher.Attach(m.ctx, metadata); attachErr == nil {
			if session, registerErr := m.registry.Register(m.ctx, runner, "", ""); registerErr == nil {
				m.manage(session)
				log.Printf("[reconnect] runner %s reattached after unexpected disconnect", id)
				return
			}
		}
		m.scheduleReconnect(id, delays[1:])
	})
}

func (m *Manager) Discover(ctx context.Context) error {
	return m.DiscoverWithOptions(ctx, DiscoverOptions{})
}

func (m *Manager) DiscoverWithOptions(ctx context.Context, options DiscoverOptions) error {
	m.registry.MarkDiscovering(true)
	defer m.registry.MarkDiscovering(false)

	candidates := m.orphanPlistCandidates()
	deadArtifacts := make(map[string]struct{})
	entries, err := os.ReadDir(m.config.RunnerStateDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read runner state directory: %w", err)
	}
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sock") {
				continue
			}
			id := strings.TrimSuffix(entry.Name(), ".sock")
			if _, exists := m.registry.Get(id); exists {
				continue
			}
			metadataPath := filepath.Join(m.config.RunnerStateDir, id+".json")
			metadata, metadataErr := state.ReadRunnerInfo(metadataPath)
			probe := metadata
			probe.ID = id
			probe.SocketPath = filepath.Join(m.config.RunnerStateDir, entry.Name())
			connected := false
			for attempt := 0; attempt < m.options.DiscoveryRetries; attempt++ {
				runner, attachErr := m.launcher.Attach(ctx, probe)
				if attachErr == nil {
					if session, registerErr := m.registry.Register(ctx, runner, "", ""); registerErr == nil {
						m.manage(session)
						connected = true
						break
					}
				}
				if attempt+1 < m.options.DiscoveryRetries && !waitContext(ctx, m.options.DiscoveryDelay) {
					return ctx.Err()
				}
			}
			if connected {
				delete(candidates, id)
				continue
			}
			if metadataErr == nil && metadata.PID > 0 && m.options.ProcessAlive(metadata.PID) {
				command := m.options.ProcessCommand(metadata.PID)
				if command == "" || strings.Contains(command, "runner.js") || strings.Contains(command, "runner.ts") || strings.Contains(command, id) {
					log.Printf("[discover] runner %s unreachable but pid %d alive — leaving it alone", id, metadata.PID)
					continue
				}
				log.Printf("[discover] runner %s pid %d is PID reuse (%s) — treating as dead", id, metadata.PID, truncate(command, 60))
			}
			deadArtifacts[id] = struct{}{}
			candidates[id] = struct{}{}
		}
	}

	ids := sortedKeys(candidates)
	if err := m.guard.Check(len(ids), options.Force); err != nil {
		return err
	}
	var cleanupErrors []error
	for _, id := range ids {
		if _, dead := deadArtifacts[id]; dead {
			for _, suffix := range []string{".sock", ".json"} {
				if removeErr := os.Remove(filepath.Join(m.config.RunnerStateDir, id+suffix)); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
					cleanupErrors = append(cleanupErrors, removeErr)
				}
			}
		}
		if reapErr := m.reap(id); reapErr != nil {
			cleanupErrors = append(cleanupErrors, reapErr)
		}
	}
	return errors.Join(cleanupErrors...)
}

func (m *Manager) orphanPlistCandidates() map[string]struct{} {
	candidates := make(map[string]struct{})
	entries, err := os.ReadDir(m.config.LaunchAgentsDir)
	if err != nil {
		return candidates
	}
	const prefix = "tech.pretty-pty.runner."
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, ".plist") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".plist")
		if _, err := os.Stat(filepath.Join(m.config.RunnerStateDir, id+".events")); err == nil {
			continue
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) < orphanStartingGrace {
			continue
		}
		_, socketErr := os.Stat(filepath.Join(m.config.RunnerStateDir, id+".sock"))
		_, metadataErr := os.Stat(filepath.Join(m.config.RunnerStateDir, id+".json"))
		if errors.Is(socketErr, os.ErrNotExist) && errors.Is(metadataErr, os.ErrNotExist) {
			candidates[id] = struct{}{}
		}
	}
	return candidates
}

func (m *Manager) reap(id string) error {
	if reaper, ok := m.launcher.(interface{ Reap(string) error }); ok {
		return reaper.Reap(id)
	}
	path := state.RunnerPlistPath(m.config.LaunchAgentsDir, id)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	return err == nil && process.Signal(syscall.Signal(0)) == nil
}

func processCommand(pid int) string {
	commandCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, "ps", "-p", fmt.Sprint(pid), "-o", "args=")
	output, err := command.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func waitContext(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func truncate(value string, length int) string {
	if len(value) <= length {
		return value
	}
	return value[:length]
}

func loadGlobalHooks(path string) globalHooks {
	if path == "" {
		return globalHooks{}
	}
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return globalHooks{}
	}
	if err != nil {
		log.Printf("[hooks] ignoring malformed %s: %v", path, err)
		return globalHooks{}
	}
	var raw map[string]any
	if json.Unmarshal(encoded, &raw) != nil {
		log.Printf("[hooks] ignoring malformed %s: expected an object", path)
		return globalHooks{}
	}
	value, exists := raw["onIdle"]
	if !exists {
		return globalHooks{}
	}
	onIdle, ok := value.(string)
	if !ok || strings.TrimSpace(onIdle) == "" {
		log.Printf("[hooks] ignoring malformed %s: onIdle must be a non-empty string", path)
		return globalHooks{}
	}
	return globalHooks{OnIdle: onIdle}
}
