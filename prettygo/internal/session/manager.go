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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/uzihaq/pretty-pty/prettygo/internal/claudep"
	"github.com/uzihaq/pretty-pty/prettygo/internal/codexapp"
	"github.com/uzihaq/pretty-pty/prettygo/internal/ledger"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
	"github.com/uzihaq/pretty-pty/prettygo/internal/watch"
)

const (
	workingBytesThreshold    = 80
	workingDecay             = 800 * time.Millisecond
	discoveryAttempts        = 3
	discoveryRetryDelay      = 800 * time.Millisecond
	orphanStartingGrace      = 30 * time.Second
	readySettle              = 800 * time.Millisecond
	DefaultMassKillLimit     = 3
	DefaultDiscoveryInterval = 30 * time.Second
	discoveryIntervalEnv     = "PRETTYD_DISCOVERY_INTERVAL"
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
	Boundaries       ledger.BoundaryWriter
	Observations     ledger.ObservationWriter
	LedgerReader     LedgerReader
	Notify           func(PushPayload)
	ListCodexModels  func(context.Context, string) ([]codexapp.Model, error)
}

type DiscoverOptions struct{ Force bool }

type LedgerReader interface {
	Events(context.Context, string) ([]ledger.Event, error)
	LiveBindingFor(context.Context, string) (*ledger.LiveBinding, error)
	MovedBinding(context.Context, string) (*ledger.MovedConversation, error)
}

type ConversationLiveError struct {
	ProviderUUID string
	Binding      ledger.LiveBinding
}

func (e *ConversationLiveError) Error() string {
	return fmt.Sprintf("conversation %s is already live as %q (session %s) — attach with `pretty attach %s`, or re-run with --force to take over.",
		e.ProviderUUID, e.Binding.Name, e.Binding.SessionID, e.Binding.SessionID)
}

type ConversationMovedError struct {
	ProviderUUID string
	Machine      string
}

func (e *ConversationMovedError) Error() string {
	return fmt.Sprintf("conversation moved to %s; reopening here forks it. --force to fork.", e.Machine)
}

type Manager struct {
	config   state.Config
	launcher proto.RunnerLauncher
	registry *state.Registry
	push     *PushService
	guard    MassKillGuard
	options  ManagerOptions
	started  time.Time

	boundaries   ledger.BoundaryWriter
	observations ledger.ObservationWriter
	ledgerReader LedgerReader
	notify       func(PushPayload)
	listModels   func(context.Context, string) ([]codexapp.Model, error)

	deathMu     sync.Mutex
	laneDeaths  map[string]laneDeathBurst
	discoveryMu sync.Mutex
	bindMu      sync.Mutex

	ctx    context.Context
	cancel context.CancelFunc
	ticker *time.Ticker

	mu       sync.Mutex
	runtimes map[string]*runtimeSession
	hooks    globalHooks
}

type laneDeathBurst struct {
	started  time.Time
	count    int
	digested bool
}

type globalHooks struct {
	OnIdle string `json:"onIdle"`
}

type runtimeSession struct {
	manager    *Manager
	session    *state.Session
	attachment state.Attachment

	mu                         sync.Mutex
	recentBytes                int
	structuredLifecycleWorking *bool
	pushWorkingObserved        bool
	workingStartedAt           time.Time
	watcher                    *watch.FileWatcher
	stopOnce                   sync.Once
	outputObserved             chan struct{}
	structuredEventArrived     chan struct{}
	firstMessageInput          []byte
	firstMessageDone           bool
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
		boundaries: selected.Boundaries, observations: selected.Observations, ledgerReader: selected.LedgerReader,
		runtimes: make(map[string]*runtimeSession), hooks: loadGlobalHooks(config.GlobalHooksPath),
		laneDeaths: make(map[string]laneDeathBurst),
	}
	manager.listModels = selected.ListCodexModels
	if manager.listModels == nil {
		manager.listModels = listLiveCodexModels
	}
	manager.notify = selected.Notify
	if manager.notify == nil {
		manager.notify = func(payload PushPayload) {
			go manager.push.Send(context.Background(), payload)
		}
	}
	manager.registry.SetTerminalObservers(manager.recordRunnerExited, manager.recordReaped)
	manager.recordDaemonRestart(ctx)
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
	ctx := context.Background()
	infos := m.registry.List(includeExited)
	if includeExited {
		infos = m.withDurableClosed(ctx, infos)
	}
	return m.withProvenance(ctx, infos)
}
func (m *Manager) Get(id string) (*state.Session, bool) { return m.registry.Get(id) }
func (m *Manager) DeepDiagnostics() []map[string]any    { return m.registry.DeepDiagnostics() }

func (m *Manager) recordCreated(ctx context.Context, prepared state.PreparedSession, creatorKind ledger.CreatorKind, creatorID string) error {
	if m.boundaries == nil {
		return nil
	}
	info := prepared.Info
	providerUUID, resumeArgv := "", []string(nil)
	if prepared.Kind != state.KindLane {
		providerUUID, resumeArgv = ledger.SafeResumeRecipe(string(prepared.Tool), info.Cmd, info.Args)
	}
	if err := m.boundaries.RecordCreated(ctx, ledger.Created{
		Meta: ledger.Meta{LaneID: info.ID, AtMS: info.CreatedAt},
		Name: prepared.Name, Description: prepared.Description,
		DescriptionSource: ledger.DescriptionSource(prepared.DescriptionSource),
		Tool:              string(prepared.Tool), Cwd: info.Cwd,
		ResumeArgv: resumeArgv, LaneUUID: info.ID, ProviderUUID: providerUUID,
		CreatorKind: creatorKind, CreatorID: creatorID,
	}); err != nil {
		return fmt.Errorf("record lane creation before launch: %w", err)
	}
	return nil
}

func (m *Manager) resolveCreator(ctx context.Context, request state.CreateSessionRequest) (ledger.CreatorKind, string, error) {
	if request.CreatorSessionID != "" && request.CreatorOwnerID != "" {
		return "", "", errors.New("creator session and external owner cannot both be set")
	}
	if request.CreatorOwnerID != "" {
		if err := ledger.ValidateCreator(ledger.CreatorExternal, request.CreatorOwnerID); err != nil {
			return "", "", err
		}
		return ledger.CreatorExternal, request.CreatorOwnerID, nil
	}
	if request.CreatorSessionID == "" {
		id := "uid:" + strconv.Itoa(os.Getuid())
		return ledger.CreatorUser, id, nil
	}
	if err := ledger.ValidateCreator(ledger.CreatorSession, request.CreatorSessionID); err != nil {
		return "", "", err
	}
	if m.ledgerReader == nil {
		return "", "", errors.New("cannot validate creator session: ledger reader is unavailable")
	}
	events, err := m.ledgerReader.Events(ctx, request.CreatorSessionID)
	if err != nil {
		return "", "", fmt.Errorf("validate creator session: %w", err)
	}
	for _, candidate := range ledger.Fold(events) {
		if candidate.LaneID == request.CreatorSessionID && candidate.Created {
			return ledger.CreatorSession, request.CreatorSessionID, nil
		}
	}
	return "", "", fmt.Errorf("creator session %s has no created event", request.CreatorSessionID)
}

func (m *Manager) recordLaunchStarted(ctx context.Context, prepared state.PreparedSession) {
	m.observe(ctx, "launch started", func(writer ledger.ObservationWriter) error {
		return writer.RecordLaunchStarted(ctx, ledger.Observation{Meta: ledger.Meta{LaneID: prepared.Info.ID}})
	})
}

func (m *Manager) recordRunnerReady(ctx context.Context, info proto.RunnerInfo) {
	m.observe(ctx, "runner ready", func(writer ledger.ObservationWriter) error {
		return writer.RecordRunnerReady(ctx, ledger.Observation{Meta: ledger.Meta{LaneID: info.ID}})
	})
	if metadata, err := state.ReadRunnerMetadata(filepath.Join(m.config.RunnerStateDir, info.ID+".json")); err == nil {
		if metadata.Kind == state.KindLane {
			return
		}
		if metadata.Kind == state.KindCodexAppServer && info.ConversationID != "" {
			resumeArgv := ledger.ResumeRecipeForProvider("codex", info.Cmd, info.ConversationID)
			m.observe(ctx, "provider bound", func(writer ledger.ObservationWriter) error {
				return writer.RecordProviderBound(ctx, ledger.ProviderBound{
					Meta: ledger.Meta{LaneID: info.ID}, ProviderUUID: info.ConversationID, ResumeArgv: resumeArgv,
				})
			})
			return
		}
		if metadata.Kind == state.KindClaudeStructured && info.ClaudeSessionID != "" {
			resumeArgv := ledger.ResumeRecipeForProvider("claude-code", info.Cmd, info.ClaudeSessionID)
			m.observe(ctx, "provider bound", func(writer ledger.ObservationWriter) error {
				return writer.RecordProviderBound(ctx, ledger.ProviderBound{
					Meta: ledger.Meta{LaneID: info.ID}, ProviderUUID: info.ClaudeSessionID, ResumeArgv: resumeArgv,
				})
			})
			return
		}
	}
	providerUUID, resumeArgv := ledger.SafeResumeRecipe("", info.Cmd, info.Args)
	if providerUUID == "" {
		return
	}
	m.observe(ctx, "provider bound", func(writer ledger.ObservationWriter) error {
		return writer.RecordProviderBound(ctx, ledger.ProviderBound{
			Meta: ledger.Meta{LaneID: info.ID}, ProviderUUID: providerUUID, ResumeArgv: resumeArgv,
		})
	})
}

func (m *Manager) recordReaped(id string) {
	m.observe(context.Background(), "reaped", func(writer ledger.ObservationWriter) error {
		return writer.RecordReaped(context.Background(), ledger.Observation{Meta: ledger.Meta{LaneID: id}})
	})
}

func (m *Manager) recordRunnerExited(id string, event proto.ExitEvent) {
	m.observe(context.Background(), "runner exited", func(writer ledger.ObservationWriter) error {
		return writer.RecordRunnerExited(context.Background(), ledger.RunnerExit{
			Meta: ledger.Meta{LaneID: id}, Code: event.Code, Signal: event.Signal,
		})
	})
	m.notifyLaneExit(id, event)
}

func (m *Manager) notifyLaneExit(id string, event proto.ExitEvent) {
	session, ok := m.registry.Get(id)
	if !ok {
		return
	}
	info := session.Info()
	if info.Kind != state.KindLane {
		return
	}
	manifest, err := state.ReadCompletionManifest(filepath.Join(m.config.RunnerStateDir, id+".manifest.json"))
	if err != nil {
		manifest.ExitCode = exitCodeOf(event)
		manifest.Signal = event.Signal
		manifest.SpecPath = info.SpecPath
		if snapshot, _, snapshotErr := session.Snapshot(context.Background(), 0); snapshotErr == nil {
			manifest.LastOutputTail = snapshot
		}
	}
	label := sessionDisplayLabel(info)
	body := lastOutputLine(manifest.LastOutputTail)
	failed := manifest.ExitCode != 0 || manifest.Signal != nil
	if !failed {
		if body == "" {
			body = "finished"
		}
		m.notify(PushPayload{
			Title: "🟢 " + label + " finished", Body: body,
			Data: map[string]any{"sessionId": id, "kind": state.KindLane, "exitCode": manifest.ExitCode},
		})
		return
	}
	if body == "" {
		body = "no output"
	}
	payload := PushPayload{
		Title: fmt.Sprintf("🔴 %s died (exit %d)", label, manifest.ExitCode), Body: body,
		Data: map[string]any{"sessionId": id, "kind": state.KindLane, "exitCode": manifest.ExitCode},
	}
	signature := fmt.Sprintf("exit:%d", manifest.ExitCode)
	if manifest.Signal != nil {
		signature += ":signal:" + *manifest.Signal
	}
	now := time.Now()
	m.deathMu.Lock()
	burst := m.laneDeaths[signature]
	if burst.started.IsZero() || now.Sub(burst.started) >= time.Minute {
		burst = laneDeathBurst{started: now}
	}
	burst.count++
	send := true
	if burst.count >= 3 {
		if burst.digested {
			send = false
		} else {
			burst.digested = true
			payload.Title = fmt.Sprintf("%d lanes died", burst.count)
			payload.Body = fmt.Sprintf("similar exit %d within 60s", manifest.ExitCode)
			payload.Data = map[string]any{"kind": state.KindLane, "exitCode": manifest.ExitCode, "count": burst.count}
		}
	}
	m.laneDeaths[signature] = burst
	m.deathMu.Unlock()
	if send {
		m.notify(payload)
	}
}

func exitCodeOf(event proto.ExitEvent) int {
	if event.Code != nil {
		return *event.Code
	}
	return 1
}

func lastOutputLine(output string) string {
	lines := snapshotLines(output)
	if len(lines) == 0 {
		return ""
	}
	return displayLine(lines[len(lines)-1])
}

func (m *Manager) observe(ctx context.Context, label string, record func(ledger.ObservationWriter) error) {
	if m.observations == nil {
		return
	}
	if err := record(m.observations); err != nil {
		log.Printf("[ledger] record %s: %v", label, err)
	}
}

func (m *Manager) ledgerStates(ctx context.Context) ([]ledger.LaneState, error) {
	if m.ledgerReader == nil {
		return nil, nil
	}
	events, err := m.ledgerReader.Events(ctx, "")
	if err != nil {
		return nil, err
	}
	return ledger.Fold(events), nil
}

// withDurableClosed restores closed records after Registry's short exited
// grace has elapsed. The ledger is authoritative for lifecycle and ownership;
// live runtime details continue to come from Registry while they are present.
func (m *Manager) withDurableClosed(ctx context.Context, infos []state.SessionInfo) []state.SessionInfo {
	states, err := m.ledgerStates(ctx)
	if err != nil {
		log.Printf("[ledger] read durable closed sessions: %v", err)
		return infos
	}
	seen := make(map[string]struct{}, len(infos))
	for _, info := range infos {
		seen[info.ID] = struct{}{}
	}
	for _, lane := range states {
		if !lane.Created || !durablyClosed(lane) {
			continue
		}
		if _, exists := seen[lane.LaneID]; exists {
			continue
		}
		exitedAt := lane.LastEventAtMS
		info := state.SessionInfo{
			ID: lane.LaneID, Name: lane.Name, Description: lane.Description,
			DescriptionSource: string(lane.DescriptionSource), Cwd: lane.Cwd,
			CreatedAt: lane.CreatedAtMS, LastDataAt: lane.LastEventAtMS,
			Tool: state.SessionTool(lane.Tool), Exited: true, ExitedAt: &exitedAt,
			ExitCode: lane.ExitCode, ExitSignal: lane.ExitSignal,
		}
		if len(lane.ResumeArgv) > 0 {
			info.Cmd = lane.ResumeArgv[0]
			info.Args = append([]string(nil), lane.ResumeArgv[1:]...)
		}
		if lane.Tool == string(state.ToolLane) {
			info.Kind = state.KindLane
		}
		infos = append(infos, info)
		seen[lane.LaneID] = struct{}{}
	}
	return infos
}

func durablyClosed(lane ledger.LaneState) bool {
	return lane.UserKillRequested || lane.RunnerExited || lane.Reaped || lane.ReopenedAs != ""
}

func (m *Manager) withProvenance(ctx context.Context, infos []state.SessionInfo) []state.SessionInfo {
	if m.ledgerReader == nil || len(infos) == 0 {
		return infos
	}
	states, err := m.ledgerStates(ctx)
	if err != nil {
		log.Printf("[ledger] read provenance graph: %v", err)
		return infos
	}
	byID := make(map[string]ledger.LaneState, len(states))
	for _, candidate := range states {
		byID[candidate.LaneID] = candidate
	}
	for index := range infos {
		current, exists := byID[infos[index].ID]
		if !exists || !current.Created {
			continue
		}
		if infos[index].DescriptionSource != state.DescriptionExplicit && current.Description != "" {
			infos[index].Description = current.Description
			infos[index].DescriptionSource = string(current.DescriptionSource)
		}
		infos[index].CreatorKind = string(current.CreatorKind)
		infos[index].CreatorID = current.CreatorID
		if current.CreatorKind == ledger.CreatorSession {
			infos[index].ParentSessionID = current.CreatorID
		}

		visited := map[string]struct{}{current.LaneID: {}}
		parentDead := false
		for current.CreatorKind == ledger.CreatorSession {
			parentID := current.CreatorID
			infos[index].CreatorAncestry = append(infos[index].CreatorAncestry, parentID)
			if _, cycle := visited[parentID]; cycle {
				infos[index].ProvenanceStatus = "cycle"
				break
			}
			visited[parentID] = struct{}{}
			parent, found := byID[parentID]
			if !found || !parent.Created {
				infos[index].RootCreatorKind = string(ledger.CreatorSession)
				infos[index].RootCreatorID = parentID
				infos[index].ProvenanceStatus = "parent-missing"
				break
			}
			if provenanceParentDead(parent) {
				parentDead = true
			}
			current = parent
		}
		if infos[index].RootCreatorKind == "" && current.CreatorKind != "" {
			infos[index].RootCreatorKind = string(current.CreatorKind)
			infos[index].RootCreatorID = current.CreatorID
		}
		if parentDead {
			infos[index].ProvenanceStatus = "parent-dead"
		} else if infos[index].ProvenanceStatus == "" {
			if len(infos[index].CreatorAncestry) > 0 {
				infos[index].ProvenanceStatus = "parent-live"
			} else if current.CreatorKind != "" {
				infos[index].ProvenanceStatus = "rooted"
			} else {
				infos[index].ProvenanceStatus = "legacy"
			}
		}
	}
	return infos
}

func provenanceParentDead(parent ledger.LaneState) bool {
	return parent.UserKillRequested || parent.RunnerExited || parent.RunnerLost || parent.Reaped
}

func (m *Manager) recordDaemonRestart(ctx context.Context) {
	lanes, err := m.ledgerStates(ctx)
	if err != nil {
		log.Printf("[ledger] read lanes for daemon restart: %v", err)
		return
	}
	for _, lane := range lanes {
		laneID := lane.LaneID
		m.observe(ctx, "daemon restart", func(writer ledger.ObservationWriter) error {
			return writer.RecordDaemonRestart(ctx, ledger.Observation{Meta: ledger.Meta{LaneID: laneID}})
		})
	}
}

func (m *Manager) reconcileLedger(ctx context.Context) {
	lanes, err := m.ledgerStates(ctx)
	if err != nil {
		log.Printf("[ledger] read lanes for discovery reconciliation: %v", err)
		return
	}
	for _, lane := range lanes {
		closed := lane.UserKillRequested || lane.RunnerExited || lane.Reaped
		if !lane.Created || closed || lane.RunnerLost {
			continue
		}
		if _, present := m.registry.Get(lane.LaneID); present {
			continue
		}
		laneID := lane.LaneID
		m.observe(ctx, "runner lost during discovery reconciliation", func(writer ledger.ObservationWriter) error {
			return writer.RecordRunnerLost(ctx, ledger.Observation{Meta: ledger.Meta{LaneID: laneID}})
		})
	}
}

func (m *Manager) Create(ctx context.Context, request state.CreateSessionRequest) (state.SessionInfo, error) {
	resolvedRequest, err := m.resolveCodexModelChoice(ctx, request)
	if err != nil {
		return state.SessionInfo{}, err
	}
	request = resolvedRequest

	// Serialize the ledger query with the pre-launch binding write. Without
	// this lock two concurrent resume requests could both observe no owner.
	m.bindMu.Lock()
	defer m.bindMu.Unlock()

	creatorKind, creatorID, err := m.resolveCreator(ctx, request)
	if err != nil {
		return state.SessionInfo{}, fmt.Errorf("resolve lane creator: %w", err)
	}

	providerUUID, _ := ledger.ExistingProviderResume(request.Cmd, request.Args)
	var takeover *ledger.LiveBinding
	if providerUUID != "" && m.ledgerReader != nil {
		binding, err := m.ledgerReader.LiveBindingFor(ctx, providerUUID)
		if err != nil {
			return state.SessionInfo{}, fmt.Errorf("check live conversation binding: %w", err)
		}
		moved, err := m.ledgerReader.MovedBinding(ctx, providerUUID)
		if err != nil {
			return state.SessionInfo{}, fmt.Errorf("check moved conversation binding: %w", err)
		}
		if moved != nil && !request.Force {
			return state.SessionInfo{}, &ConversationMovedError{ProviderUUID: providerUUID, Machine: moved.Machine}
		}
		if binding != nil && !request.Force {
			return state.SessionInfo{}, &ConversationLiveError{ProviderUUID: providerUUID, Binding: *binding}
		}
		if binding != nil {
			takeover = binding
		} else if moved != nil {
			// A moved source can be tombstoned locally while its remote driver
			// remains live. Record the forced fork against that source lane.
			takeover = &ledger.LiveBinding{SessionID: moved.SourceSessionID}
		}
	}

	beforeLaunch := func(ctx context.Context, prepared state.PreparedSession) error {
		if err := m.recordCreated(ctx, prepared, creatorKind, creatorID); err != nil {
			return err
		}
		if takeover == nil {
			return nil
		}
		if m.boundaries == nil {
			return errors.New("record forced conversation takeover before launch: ledger writer is unavailable")
		}
		if err := m.boundaries.RecordProviderRebound(ctx, ledger.ProviderRebound{
			Meta: ledger.Meta{LaneID: takeover.SessionID}, ProviderUUID: providerUUID, NewLaneID: prepared.Info.ID,
		}); err != nil {
			return fmt.Errorf("record forced conversation takeover before launch: %w", err)
		}
		return nil
	}
	info, err := m.registry.CreateWithLifecycle(ctx, request, state.CreateLifecycle{
		BeforeLaunch:  beforeLaunch,
		LaunchStarted: m.recordLaunchStarted,
		RunnerReady:   m.recordRunnerReady,
	})
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
	return m.withProvenance(ctx, []state.SessionInfo{session.Info()})[0], nil
}

func (m *Manager) Kill(ctx context.Context, id string, force bool) bool {
	return m.RequestKill(ctx, id, force) == nil
}

func (m *Manager) RequestKill(ctx context.Context, id string, force bool) error {
	if err := m.guard.Check(1, force); err != nil {
		return err
	}
	if _, ok := m.registry.Get(id); !ok {
		return fmt.Errorf("session %s not found", id)
	}
	return m.killOne(ctx, id)
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
	for _, id := range sortedKeys(unique) {
		if err := m.killOne(ctx, id); err != nil {
			failures = append(failures, fmt.Errorf("kill session %s: %w", id, err))
		}
	}
	return errors.Join(failures...)
}

func (m *Manager) killOne(ctx context.Context, id string) error {
	if m.boundaries != nil {
		if err := m.boundaries.RecordUserKill(ctx, ledger.UserKill{Meta: ledger.Meta{LaneID: id}}); err != nil {
			return fmt.Errorf("record user kill before runner kill: %w", err)
		}
	}
	return m.registry.RequestKill(ctx, id, true)
}

func (m *Manager) Input(ctx context.Context, id, data string) bool {
	if !m.registry.Input(ctx, id, data) {
		return false
	}
	m.captureFirstMessageDescription(id, data)
	m.observe(ctx, "human activity", func(writer ledger.ObservationWriter) error {
		return writer.RecordActivity(ctx, ledger.Activity{
			Meta: ledger.Meta{LaneID: id}, Source: ledger.ActivityHumanInput,
		})
	})
	return true
}

func (m *Manager) captureFirstMessageDescription(id, data string) {
	m.mu.Lock()
	runtime := m.runtimes[id]
	m.mu.Unlock()
	if runtime == nil {
		return
	}

	runtime.mu.Lock()
	if runtime.firstMessageDone {
		runtime.mu.Unlock()
		return
	}
	info := runtime.session.Info()
	if info.DescriptionSource == state.DescriptionExplicit || info.Description != "" {
		runtime.firstMessageDone = true
		runtime.mu.Unlock()
		return
	}

	complete := false
	for _, value := range []byte(data) {
		if value == '\r' || (value == '\n' && len(data) == 1) {
			complete = len(runtime.firstMessageInput) > 0
			if complete {
				break
			}
			continue
		}
		if len(runtime.firstMessageInput) < 4096 {
			runtime.firstMessageInput = append(runtime.firstMessageInput, value)
		}
	}
	if !complete {
		runtime.mu.Unlock()
		return
	}
	description := firstMessageDescription(string(runtime.firstMessageInput))
	if description == "" {
		runtime.firstMessageInput = nil
		runtime.mu.Unlock()
		return
	}
	runtime.firstMessageDone = true
	runtime.firstMessageInput = nil
	runtime.mu.Unlock()

	changed, err := m.registry.SetFirstMessageDescription(id, description)
	if err != nil {
		log.Printf("[description] persist first-message description for %s: %v", id, err)
	}
	if !changed {
		return
	}
	m.observe(context.Background(), "derived description", func(writer ledger.ObservationWriter) error {
		return writer.RecordDescriptionDerived(context.Background(), ledger.DescriptionDerived{
			Meta: ledger.Meta{LaneID: id}, Description: description, Source: ledger.DescriptionFirstMessage,
		})
	})
}

func firstMessageDescription(value string) string {
	var cleaned strings.Builder
	escapeSequence := 0
	for _, character := range value {
		if escapeSequence != 0 {
			if escapeSequence == 1 {
				if character == '[' {
					escapeSequence = 2
				} else {
					escapeSequence = 0
				}
			} else if character >= '@' && character <= '~' {
				escapeSequence = 0
			}
			continue
		}
		if character == '\x1b' {
			escapeSequence = 1
			continue
		}
		if unicode.IsControl(character) {
			cleaned.WriteRune(' ')
			continue
		}
		cleaned.WriteRune(character)
	}
	description := strings.Join(strings.Fields(cleaned.String()), " ")
	runes := []rune(description)
	if len(runes) > 80 {
		description = string(runes[:79]) + "…"
	}
	return description
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
		outputObserved:         make(chan struct{}, 1),
		structuredEventArrived: make(chan struct{}, 1),
	}
	if info.Kind == state.KindCodexAppServer || info.Kind == state.KindClaudeStructured {
		for _, raw := range attachment.ClaudeEvents {
			if working, ok := structuredHistoryLifecycle(info.Kind, raw); ok {
				value := working
				runtime.structuredLifecycleWorking = &value
			}
		}
		if runtime.structuredLifecycleWorking != nil {
			session.SetWorking(*runtime.structuredLifecycleWorking)
		}
	}
	for _, event := range attachment.Replay.Events {
		runtime.recentBytes += len(event.Data)
	}
	m.runtimes[info.ID] = runtime
	m.mu.Unlock()
	m.observe(context.Background(), "attached", func(writer ledger.ObservationWriter) error {
		return writer.RecordAttached(context.Background(), ledger.Observation{Meta: ledger.Meta{LaneID: info.ID}})
	})
	if !m.options.DisableWatchers {
		runtime.startWatcher(info)
	}
	go runtime.observe()
	return runtime
}

func structuredHistoryLifecycle(kind string, raw json.RawMessage) (bool, bool) {
	switch kind {
	case state.KindCodexAppServer:
		return codexapp.HistoryLifecycle(raw)
	case state.KindClaudeStructured:
		return claudep.HistoryLifecycle(raw)
	default:
		return false, false
	}
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
			select {
			case r.outputObserved <- struct{}{}:
			default:
			}
		case proto.EventClaude:
			if event.ClaudeActivityAt != 0 {
				r.manager.observe(context.Background(), "provider activity", func(writer ledger.ObservationWriter) error {
					return writer.RecordActivity(context.Background(), ledger.Activity{
						Meta: ledger.Meta{LaneID: id, AtMS: event.ClaudeActivityAt}, Source: ledger.ActivityProviderEvent,
					})
				})
			}
			select {
			case r.structuredEventArrived <- struct{}{}:
			default:
			}
		case proto.EventCodex:
			if event.ClaudeActivityAt != 0 {
				r.manager.observe(context.Background(), "provider activity", func(writer ledger.ObservationWriter) error {
					return writer.RecordActivity(context.Background(), ledger.Activity{
						Meta: ledger.Meta{LaneID: id, AtMS: event.ClaudeActivityAt}, Source: ledger.ActivityProviderEvent,
					})
				})
			}
			if working, ok := structuredHistoryLifecycle(r.session.Info().Kind, event.CodexEvent); ok {
				r.mu.Lock()
				value := working
				r.structuredLifecycleWorking = &value
				r.mu.Unlock()
				r.setWorking(working)
			}
			select {
			case r.structuredEventArrived <- struct{}{}:
			default:
			}
		case proto.EventRunnerLost:
			r.manager.observe(context.Background(), "runner lost", func(writer ledger.ObservationWriter) error {
				return writer.RecordRunnerLost(context.Background(), ledger.Observation{Meta: ledger.Meta{LaneID: id}})
			})
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
	structured := r.structuredLifecycleWorking
	r.mu.Unlock()
	byteWorking := recent >= workingBytesThreshold
	next := byteWorking
	switch info.Tool {
	case state.ToolClaude:
		if info.Kind == state.KindClaudeStructured && structured != nil {
			next = *structured
		} else if recent <= 0 {
			next = false
		} else if snapshot, _, err := r.session.Snapshot(context.Background(), 0); err == nil {
			next = ClaudeWorkingFromSnapshot(snapshot)
		}
	case state.ToolCodex:
		if structured != nil {
			next = *structured
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
	if info.Kind == state.KindCodexAppServer || info.Kind == state.KindClaudeStructured {
		return
	}
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
				r.structuredLifecycleWorking = &value
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
	next := delays
	if len(delays) > 1 {
		next = delays[1:]
	}
	time.AfterFunc(delay, func() {
		select {
		case <-m.ctx.Done():
			return
		default:
		}
		if existing, exists := m.registry.Get(id); exists {
			if existing.Info().Exited {
				m.scheduleReconnect(id, next)
			}
			return
		}
		path := filepath.Join(m.config.RunnerStateDir, id+".sock")
		if _, err := os.Stat(path); err != nil {
			if m.reconnectArtifactsExist(id) {
				m.scheduleReconnect(id, next)
			}
			return
		}
		metadata, _ := state.ReadRunnerMetadata(filepath.Join(m.config.RunnerStateDir, id+".json"))
		metadata.Info.ID = id
		metadata.Info.SocketPath = path
		if runner, attachErr := m.launcher.Attach(m.ctx, metadata.Info); attachErr == nil {
			if session, registerErr := m.registry.RegisterMetadata(m.ctx, runner, metadata, ""); registerErr == nil {
				m.manage(session)
				log.Printf("[reconnect] runner %s reattached after unexpected disconnect", id)
				return
			}
		}
		if m.reconnectArtifactsExist(id) {
			m.scheduleReconnect(id, next)
		}
	})
}

func (m *Manager) reconnectArtifactsExist(id string) bool {
	for _, path := range []string{
		filepath.Join(m.config.RunnerStateDir, id+".json"),
		state.RunnerPlistPath(m.config.LaunchAgentsDir, id),
	} {
		if _, err := os.Stat(path); err == nil {
			return true
		}
	}
	return false
}

// RunDiscoveryLoop performs the startup scan and then repeats the exact same
// guarded discovery path. PRETTYD_DISCOVERY_INTERVAL accepts Go duration
// syntax (for example, "10s"); invalid and non-positive values keep the safe
// production default.
func (m *Manager) RunDiscoveryLoop() {
	interval := DefaultDiscoveryInterval
	if configured := strings.TrimSpace(os.Getenv(discoveryIntervalEnv)); configured != "" {
		parsed, err := time.ParseDuration(configured)
		if err != nil || parsed <= 0 {
			log.Printf("runner discovery: invalid %s=%q; using %s", discoveryIntervalEnv, configured, interval)
		} else {
			interval = parsed
		}
	}
	run := func() {
		if err := m.Discover(m.ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("runner discovery: %v", err)
		}
	}
	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

func (m *Manager) Discover(ctx context.Context) error {
	return m.DiscoverWithOptions(ctx, DiscoverOptions{})
}

func (m *Manager) DiscoverWithOptions(ctx context.Context, options DiscoverOptions) error {
	m.discoveryMu.Lock()
	defer m.discoveryMu.Unlock()
	m.registry.MarkDiscovering(true)
	defer m.registry.MarkDiscovering(false)

	candidates, deadArtifacts := m.orphanPlistCandidates()
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
			metadata, metadataErr := state.ReadRunnerMetadata(metadataPath)
			probe := metadata.Info
			probe.ID = id
			probe.SocketPath = filepath.Join(m.config.RunnerStateDir, entry.Name())
			connected := false
			for attempt := 0; attempt < m.options.DiscoveryRetries; attempt++ {
				runner, attachErr := m.launcher.Attach(ctx, probe)
				if attachErr == nil {
					if session, registerErr := m.registry.RegisterMetadata(ctx, runner, metadata, ""); registerErr == nil {
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
			if metadataErr == nil && metadata.Info.PID > 0 && m.options.ProcessAlive(metadata.Info.PID) {
				command := m.options.ProcessCommand(metadata.Info.PID)
				if runnerCommandMatches(command, id, metadata.Info.Cmd) {
					log.Printf("[discover] runner %s unreachable but pid %d alive — leaving it alone", id, metadata.Info.PID)
					continue
				}
				log.Printf("[discover] runner %s pid %d is PID reuse (%s) — treating as dead", id, metadata.Info.PID, truncate(command, 60))
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
			for _, suffix := range []string{".sock", ".json", ".codexapp.jsonl", ".claudep.jsonl"} {
				if removeErr := os.Remove(filepath.Join(m.config.RunnerStateDir, id+suffix)); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
					cleanupErrors = append(cleanupErrors, removeErr)
				}
			}
		}
		if reapErr := m.reap(id); reapErr != nil {
			cleanupErrors = append(cleanupErrors, reapErr)
		}
	}
	m.reconcileLedger(ctx)
	return errors.Join(cleanupErrors...)
}

func (m *Manager) orphanPlistCandidates() (map[string]struct{}, map[string]struct{}) {
	candidates := make(map[string]struct{})
	deadArtifacts := make(map[string]struct{})
	entries, err := os.ReadDir(m.config.LaunchAgentsDir)
	if err != nil {
		return candidates, deadArtifacts
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
		metadataPath := filepath.Join(m.config.RunnerStateDir, id+".json")
		_, metadataErr := os.Stat(metadataPath)
		if !errors.Is(socketErr, os.ErrNotExist) {
			continue
		}
		if errors.Is(metadataErr, os.ErrNotExist) {
			candidates[id] = struct{}{}
			continue
		}
		if metadataErr != nil {
			continue
		}
		metadata, metadataErr := state.ReadRunnerMetadata(metadataPath)
		if metadataErr != nil || metadata.Info.ID != id || metadata.Info.PID <= 0 {
			continue
		}
		if m.options.ProcessAlive(metadata.Info.PID) {
			command := m.options.ProcessCommand(metadata.Info.PID)
			if runnerCommandMatches(command, id, metadata.Info.Cmd) {
				continue
			}
			log.Printf("[discover] orphan runner %s pid %d is PID reuse (%s) — treating as dead", id, metadata.Info.PID, truncate(command, 60))
		}
		candidates[id] = struct{}{}
		deadArtifacts[id] = struct{}{}
	}
	return candidates, deadArtifacts
}

func runnerCommandMatches(command, id, expectedCommand string) bool {
	if command == "" || strings.Contains(command, "runner.js") || strings.Contains(command, "runner.ts") || strings.Contains(command, id) {
		return true
	}
	expectedBase := filepath.Base(strings.TrimSpace(expectedCommand))
	return expectedBase != "" && expectedBase != "." && strings.Contains(command, expectedBase)
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
