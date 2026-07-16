package state

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
)

const (
	defaultEventLogBytes = 4 * 1024 * 1024
	maxClaudeEvents      = 5000
	exitedGrace          = 30 * time.Second
)

type Registry struct {
	config   Config
	launcher proto.RunnerLauncher
	started  time.Time

	mu          sync.RWMutex
	sessions    map[string]*Session
	order       []string
	discovering bool
}

func NewRegistry(config Config, launcher proto.RunnerLauncher) *Registry {
	return &Registry{
		config:   config,
		launcher: launcher,
		started:  time.Now(),
		sessions: make(map[string]*Session),
	}
}

func (r *Registry) Config() Config        { return r.config }
func (r *Registry) Uptime() time.Duration { return time.Since(r.started) }

func (r *Registry) IsDiscovering() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.discovering
}

func (r *Registry) setDiscovering(value bool) {
	r.mu.Lock()
	r.discovering = value
	r.mu.Unlock()
}

func (r *Registry) Create(ctx context.Context, request CreateSessionRequest) (SessionInfo, error) {
	if r.launcher == nil {
		return SessionInfo{}, errors.New("runner launcher is unavailable")
	}
	cmd := request.Cmd
	if cmd == "" {
		cmd = r.config.DefaultShell
	}
	cwd := request.Cwd
	if cwd == "" {
		cwd = r.config.DefaultCwd
	}
	info, err := os.Stat(cwd)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return SessionInfo{}, fmt.Errorf("cwd does not exist: %s", cwd)
		}
		return SessionInfo{}, err
	}
	if !info.IsDir() {
		return SessionInfo{}, fmt.Errorf("cwd is not a directory: %s", cwd)
	}

	cols := request.Cols
	if cols == 0 {
		cols = r.config.DefaultCols
	}
	rows := request.Rows
	if rows == 0 {
		rows = r.config.DefaultRows
	}
	id, err := randomUUID()
	if err != nil {
		return SessionInfo{}, fmt.Errorf("generate session id: %w", err)
	}
	if err := os.MkdirAll(r.config.RunnerStateDir, 0o700); err != nil {
		return SessionInfo{}, fmt.Errorf("create runner state directory: %w", err)
	}
	args := appendClaudeSessionID(cmd, request.Args, id)
	args = withToolDefaultArgs(cmd, args)

	createdAt := time.Now().UnixMilli()
	runnerInfo := proto.RunnerInfo{
		ID:         id,
		Cmd:        cmd,
		Args:       args,
		Cwd:        cwd,
		Cols:       cols,
		Rows:       rows,
		CreatedAt:  createdAt,
		SocketPath: filepath.Join(r.config.RunnerStateDir, id+".sock"),
	}
	launchRequest := proto.LaunchRequest{
		Info: runnerInfo,
		Env:  r.runnerEnvironment(runnerInfo, request.Env),
	}
	if err := writeMetadata(r.config.RunnerStateDir, runnerInfo); err != nil {
		return SessionInfo{}, err
	}
	_, err = writePlist(r.config.LaunchAgentsDir, plistArgs{
		ID:               id,
		ProgramArguments: r.launcher.ProgramArguments(launchRequest),
		Env:              launchRequest.Env,
		Cwd:              cwd,
		LogPath:          filepath.Join(r.config.RunnerStateDir, id+".log"),
	})
	if err != nil {
		return SessionInfo{}, err
	}

	runner, err := r.launcher.Launch(ctx, launchRequest)
	if err != nil {
		// Preserve the TS daemon's diagnostic posture: a failed launch leaves
		// its plist and state metadata available for inspection/recovery.
		return SessionInfo{}, err
	}
	actual := runner.Info()
	if actual.ID != id {
		return SessionInfo{}, fmt.Errorf("runner id mismatch: got %q, want %q", actual.ID, id)
	}
	if actual.SocketPath == "" {
		actual.SocketPath = runnerInfo.SocketPath
	}
	if err := writeMetadata(r.config.RunnerStateDir, actual); err != nil {
		return SessionInfo{}, err
	}
	session, err := r.register(ctx, runner, strings.TrimSpace(request.Name), strings.TrimSpace(request.OnIdle))
	if err != nil {
		return SessionInfo{}, err
	}
	return session.Info(), nil
}

func (r *Registry) register(ctx context.Context, runner proto.Runner, name, onIdle string) (*Session, error) {
	info := runner.Info()
	if info.ID == "" {
		return nil, errors.New("runner returned an empty session id")
	}
	if info.ProtocolVersion != proto.ProtocolVersion {
		log.Printf("[protocol] runner %s reports v%d, daemon expects v%d; attaching anyway", info.ID, info.ProtocolVersion, proto.ProtocolVersion)
	}
	session, err := newSession(ctx, info, runner, name, onIdle)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	if _, exists := r.sessions[info.ID]; exists {
		r.mu.Unlock()
		_ = session.Close()
		return nil, fmt.Errorf("session %s is already registered", info.ID)
	}
	r.sessions[info.ID] = session
	r.order = append(r.order, info.ID)
	r.mu.Unlock()
	session.start(func(event proto.Event) {
		if event.Kind == proto.EventRunnerLost {
			// Match sessions.ts: a lost runner disappears immediately, but its
			// plist and state stay intact so launchd/restart discovery can recover it.
			r.mu.Lock()
			if r.sessions[info.ID] == session {
				delete(r.sessions, info.ID)
				r.removeOrderLocked(info.ID)
			}
			r.mu.Unlock()
			_ = session.Close()
			return
		}
		if reaper, ok := r.launcher.(interface{ Reap(string) error }); ok {
			_ = reaper.Reap(info.ID)
		} else {
			_ = os.Remove(plistPath(r.config.LaunchAgentsDir, info.ID))
		}
		time.AfterFunc(exitedGrace, func() {
			r.mu.Lock()
			if r.sessions[info.ID] == session {
				delete(r.sessions, info.ID)
				r.removeOrderLocked(info.ID)
			}
			r.mu.Unlock()
			_ = session.Close()
		})
	})
	return session, nil
}

// Register attaches an already-probed runner to the in-memory registry. The
// session runtime uses it after applying the conservative discovery policy.
func (r *Registry) Register(ctx context.Context, runner proto.Runner, name, onIdle string) (*Session, error) {
	return r.register(ctx, runner, name, onIdle)
}

// MarkDiscovering exposes startup progress to the API while the higher-level
// session runtime performs its guarded discovery sweep.
func (r *Registry) MarkDiscovering(value bool) { r.setDiscovering(value) }

func (r *Registry) Discover(ctx context.Context) error {
	if r.launcher == nil {
		return errors.New("runner launcher is unavailable")
	}
	r.setDiscovering(true)
	defer r.setDiscovering(false)

	entries, err := os.ReadDir(r.config.RunnerStateDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read runner state directory: %w", err)
	}
	var attachErrors []error
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sock") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".sock")
		metadata, err := readMetadata(filepath.Join(r.config.RunnerStateDir, id+".json"))
		if err != nil {
			attachErrors = append(attachErrors, fmt.Errorf("discover %s: %w", id, err))
			continue
		}
		if metadata.ID != id {
			attachErrors = append(attachErrors, fmt.Errorf("discover %s: metadata id is %q", id, metadata.ID))
			continue
		}
		r.mu.RLock()
		_, exists := r.sessions[id]
		r.mu.RUnlock()
		if exists {
			continue
		}
		runner, err := r.launcher.Attach(ctx, metadata)
		if err != nil {
			// Sessions are sacred: an unreachable socket is never deleted here.
			attachErrors = append(attachErrors, fmt.Errorf("discover %s: %w", id, err))
			continue
		}
		if actual := runner.Info().ID; actual != id {
			attachErrors = append(attachErrors, fmt.Errorf("discover %s: runner id is %q", id, actual))
			continue
		}
		if _, err := r.register(ctx, runner, "", ""); err != nil {
			attachErrors = append(attachErrors, fmt.Errorf("discover %s: %w", id, err))
		}
	}
	return errors.Join(attachErrors...)
}

func (r *Registry) List(includeExited bool) []SessionInfo {
	r.mu.RLock()
	sessions := make([]*Session, 0, len(r.order))
	for _, id := range r.order {
		if session := r.sessions[id]; session != nil {
			sessions = append(sessions, session)
		}
	}
	r.mu.RUnlock()
	result := make([]SessionInfo, 0, len(sessions))
	for _, session := range sessions {
		info := session.Info()
		if includeExited || !info.Exited {
			result = append(result, info)
		}
	}
	return result
}

func (r *Registry) removeOrderLocked(id string) {
	for index, existing := range r.order {
		if existing == id {
			r.order = append(r.order[:index], r.order[index+1:]...)
			return
		}
	}
}

func (r *Registry) Get(id string) (*Session, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	session, ok := r.sessions[id]
	return session, ok
}

// Kill sends one runner KILL frame. The higher-level session manager applies
// the mass-kill policy before calling this low-level operation.
func (r *Registry) Kill(ctx context.Context, id string, _ bool) bool {
	session, ok := r.Get(id)
	return ok && session.Kill(ctx)
}

func (r *Registry) DeepDiagnostics() []map[string]any {
	list := r.List(true)
	now := time.Now().UnixMilli()
	result := make([]map[string]any, 0, len(list))
	for _, info := range list {
		session, _ := r.Get(info.ID)
		result = append(result, map[string]any{
			"id":            info.ID,
			"tool":          info.Tool,
			"cols":          info.Cols,
			"rows":          info.Rows,
			"pid":           info.PID,
			"working":       info.Working,
			"exited":        info.Exited,
			"claudeEvents":  session.ClaudeEventCount(),
			"lastDataAgeMs": now - info.LastDataAt,
		})
	}
	return result
}

func (r *Registry) runnerEnvironment(info proto.RunnerInfo, caller map[string]string) map[string]string {
	passthroughKeys := []string{
		"SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
		"http_proxy", "https_proxy", "no_proxy", "all_proxy",
		"NODE_EXTRA_CA_CERTS", "GIT_SSH_COMMAND",
	}
	environment := make(map[string]string)
	for _, key := range passthroughKeys {
		if value := os.Getenv(key); value != "" {
			environment[key] = value
		}
	}
	environment["HOME"] = getenv("HOME", r.config.DefaultCwd)
	environment["USER"] = os.Getenv("USER")
	environment["PATH"] = launchdPath(os.Getenv("PATH"))
	environment["LANG"] = getenv("LANG", "en_US.UTF-8")
	environment["SHELL"] = getenv("SHELL", "/bin/bash")
	blocked := map[string]struct{}{
		"NODE_OPTIONS": {}, "DYLD_INSERT_LIBRARIES": {}, "DYLD_LIBRARY_PATH": {}, "LD_PRELOAD": {},
	}
	for key, value := range caller {
		if strings.HasPrefix(strings.ToUpper(key), "RUNNER_") {
			continue
		}
		if _, denied := blocked[key]; denied {
			continue
		}
		environment[key] = value
	}
	environment["TERM"] = "xterm-256color"
	environment["RUNNER_ID"] = info.ID
	environment["RUNNER_STATE_DIR"] = r.config.RunnerStateDir
	environment["RUNNER_CMD"] = info.Cmd
	encodedArgs, _ := json.Marshal(info.Args)
	environment["RUNNER_ARGS_JSON"] = string(encodedArgs)
	environment["RUNNER_CWD"] = info.Cwd
	environment["RUNNER_COLS"] = fmt.Sprint(info.Cols)
	environment["RUNNER_ROWS"] = fmt.Sprint(info.Rows)
	return environment
}

func launchdPath(value string) string {
	if value == "" {
		value = "/usr/bin:/bin:/usr/sbin:/sbin"
	}
	parts := strings.Split(value, ":")
	contains := func(want string) bool {
		for _, part := range parts {
			if part == want {
				return true
			}
		}
		return false
	}
	prefix := make([]string, 0, 2)
	for _, path := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		if !contains(path) {
			prefix = append(prefix, path)
		}
	}
	return strings.Join(append(prefix, parts...), ":")
}

func writeMetadata(dir string, info proto.RunnerInfo) error {
	metadata := struct {
		ID         string   `json:"id"`
		Cmd        string   `json:"cmd"`
		Args       []string `json:"args"`
		Cwd        string   `json:"cwd"`
		Cols       int      `json:"cols"`
		Rows       int      `json:"rows"`
		CreatedAt  int64    `json:"createdAt"`
		PID        int      `json:"pid"`
		SocketPath string   `json:"sockPath"`
	}{info.ID, info.Cmd, info.Args, info.Cwd, info.Cols, info.Rows, info.CreatedAt, info.PID, info.SocketPath}
	encoded, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("encode runner metadata: %w", err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join(dir, info.ID+".json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		return fmt.Errorf("write runner metadata: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("chmod runner metadata: %w", err)
	}
	return nil
}

func readMetadata(path string) (proto.RunnerInfo, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return proto.RunnerInfo{}, err
	}
	var metadata proto.RunnerInfo
	if err := json.Unmarshal(encoded, &metadata); err != nil {
		return proto.RunnerInfo{}, err
	}
	return metadata, nil
}

// ReadRunnerInfo decodes the canonical runner metadata file for startup
// discovery. It does not mutate or validate filesystem state.
func ReadRunnerInfo(path string) (proto.RunnerInfo, error) { return readMetadata(path) }

func randomUUID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

func classifyTool(cmd string) SessionTool {
	lower := strings.ToLower(cmd)
	switch {
	case lower == "claude" || strings.HasSuffix(lower, "/claude"):
		return ToolClaude
	case lower == "codex" || strings.HasSuffix(lower, "/codex"):
		return ToolCodex
	default:
		return ToolTerminal
	}
}

var toolDefaultArgs = map[string][]string{
	"claude": {"--dangerously-skip-permissions"},
	"codex":  {"-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"},
}

var explicitModeFlags = map[string]struct{}{
	"--dangerously-bypass-approvals-and-sandbox": {},
	"--dangerously-skip-permissions":             {},
	"--sandbox":                                  {}, "-s": {}, "--ask-for-approval": {}, "-a": {}, "--full-auto": {},
}

func withToolDefaultArgs(cmd string, args []string) []string {
	result := append([]string{}, args...)
	defaults := toolDefaultArgs[strings.ToLower(filepath.Base(cmd))]
	if defaults == nil {
		return result
	}
	for _, arg := range result {
		if _, explicit := explicitModeFlags[arg]; explicit {
			return result
		}
	}
	return append(result, defaults...)
}

func appendClaudeSessionID(cmd string, args []string, id string) []string {
	result := append([]string{}, args...)
	if classifyTool(cmd) != ToolClaude {
		return result
	}
	for i, arg := range result {
		if (arg == "--session-id" || arg == "--resume") && i+1 < len(result) {
			return result
		}
	}
	return append(result, "--session-id", id)
}

func spawnControls(tool SessionTool, args []string) (model, effort string, fast bool) {
	argValue := func(names ...string) string {
		for i := 0; i+1 < len(args); i++ {
			for _, name := range names {
				if args[i] == name {
					return args[i+1]
				}
			}
		}
		return ""
	}
	configValue := func(key string) string {
		for i := 0; i+1 < len(args); i++ {
			if args[i] != "-c" && args[i] != "--config" {
				continue
			}
			prefix := key + "="
			if strings.HasPrefix(args[i+1], prefix) {
				return strings.Trim(strings.TrimPrefix(args[i+1], prefix), `"'`)
			}
		}
		return ""
	}
	model = argValue("--model", "-m")
	if tool == ToolCodex {
		effort = configValue("model_reasoning_effort")
		fast = configValue("service_tier") == "priority"
	} else {
		effort = argValue("--effort")
	}
	return
}
