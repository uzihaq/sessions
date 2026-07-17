package session

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/uzihaq/pretty-pty/prettygo/internal/ledger"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

type compositionLauncher struct {
	base  *prototest.Launcher
	store *ledger.Store

	mu          sync.Mutex
	killOrdered map[string]bool
}

func (l *compositionLauncher) ProgramArguments(request proto.LaunchRequest) []string {
	return l.base.ProgramArguments(request)
}

func (l *compositionLauncher) Launch(ctx context.Context, request proto.LaunchRequest) (proto.Runner, error) {
	runner, err := l.base.Launch(ctx, request)
	if err != nil {
		return nil, err
	}
	return &compositionRunner{Runner: runner, launcher: l, laneID: request.Info.ID}, nil
}

func (l *compositionLauncher) Attach(ctx context.Context, info proto.RunnerInfo) (proto.Runner, error) {
	return l.base.Attach(ctx, info)
}

type compositionRunner struct {
	proto.Runner
	launcher *compositionLauncher
	laneID   string
}

func (r *compositionRunner) Kill(ctx context.Context) error {
	events, err := r.launcher.store.Events(ctx, r.laneID)
	if err != nil {
		return err
	}
	ordered := len(events) > 0 && events[len(events)-1].Type == ledger.EventUserKillRequested
	r.launcher.mu.Lock()
	r.launcher.killOrdered[r.laneID] = ordered
	r.launcher.mu.Unlock()
	if !ordered {
		return errors.New("runner kill observed no committed tombstone")
	}
	return r.Runner.Kill(ctx)
}

func TestMassKillGuardThenTombstoneThenRunnerKillComposition(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	store, err := ledger.Open(context.Background(), ledger.Options{
		Path: filepath.Join(root, "ledger", "lanes.sqlite3"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	launcher := &compositionLauncher{
		base: prototest.NewLauncher(), store: store, killOrdered: make(map[string]bool),
	}
	manager := NewManager(config, launcher, ManagerOptions{
		MassKillLimit: 3, DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
	})
	defer manager.Close()

	ids := make([]string, 0, 4)
	for range 4 {
		created, createErr := manager.Create(context.Background(), state.CreateSessionRequest{
			Cmd: "/bin/sh", Cwd: root,
		})
		if createErr != nil {
			t.Fatal(createErr)
		}
		ids = append(ids, created.ID)
	}

	err = manager.KillMany(context.Background(), ids, false)
	var guardErr *MassKillError
	if !errors.As(err, &guardErr) || guardErr.Count != len(ids) {
		t.Fatalf("KillMany() error = %v, want guard refusal for %d", err, len(ids))
	}
	for _, id := range ids {
		events, readErr := store.Events(context.Background(), id)
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, event := range events {
			if event.Type == ledger.EventUserKillRequested {
				t.Fatalf("guard-refused lane %s received tombstone", id)
			}
		}
		if !manager.Input(context.Background(), id, "still alive") {
			t.Fatalf("guard-refused lane %s was killed", id)
		}
	}

	if err := manager.KillMany(context.Background(), ids, true); err != nil {
		t.Fatal(err)
	}
	launcher.mu.Lock()
	for _, id := range ids {
		if !launcher.killOrdered[id] {
			t.Errorf("lane %s runner kill did not observe committed tombstone", id)
		}
	}
	launcher.mu.Unlock()
	for _, id := range ids {
		awaitCondition(t, func() bool {
			events, readErr := store.Events(context.Background(), id)
			if readErr != nil {
				return false
			}
			for _, event := range events {
				if event.Type == ledger.EventReaped {
					return true
				}
			}
			return false
		})
	}
}

func TestStartupRestartThenDiscoveryReconcilesAbsentLedgerLane(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	store, err := ledger.Open(context.Background(), ledger.Options{
		Path: filepath.Join(root, "ledger", "lanes.sqlite3"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	const laneID = "00000000-0000-4000-8000-000000000123"
	if err := store.Boundaries().RecordCreated(context.Background(), ledger.Created{
		Meta: ledger.Meta{LaneID: laneID}, LaneUUID: laneID, Tool: string(state.ToolTerminal), Cwd: root,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Observations().RecordRunnerReady(context.Background(), ledger.Observation{
		Meta: ledger.Meta{LaneID: laneID},
	}); err != nil {
		t.Fatal(err)
	}

	manager := NewManager(config, prototest.NewLauncher(), ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
	})
	defer manager.Close()
	if err := manager.Discover(context.Background()); err != nil {
		t.Fatal(err)
	}

	events, err := store.Events(context.Background(), laneID)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 || events[2].Type != ledger.EventDaemonRestart || events[3].Type != ledger.EventRunnerLost {
		t.Fatalf("startup reconciliation events = %#v, want created, ready, daemon_restart, runner_lost", events)
	}
}

func TestProviderActivityTimestampFlowsFromRecordClaudeLocked(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	store, err := ledger.Open(context.Background(), ledger.Options{
		Path: filepath.Join(root, "ledger", "lanes.sqlite3"),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	launcher := prototest.NewLauncher()
	manager := NewManager(config, launcher, ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
	})
	defer manager.Close()
	created, err := manager.Create(context.Background(), state.CreateSessionRequest{Cmd: "/bin/sh", Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	const timestamp = "2026-07-16T12:34:56.789Z"
	wantAt, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	managed := manager.runtimes[created.ID]
	manager.mu.Unlock()
	if managed == nil {
		t.Fatal("created session has no managed runtime")
	}
	launcher.Runner(created.ID).AddClaudeEvent(map[string]any{
		"type": "assistant", "timestamp": timestamp,
	})
	<-managed.structuredEventArrived
	events, err := store.Events(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == ledger.EventActivity && event.AtMS == wantAt.UnixMilli() && strings.Contains(string(event.Payload), "provider_event") {
			return
		}
	}
	t.Fatalf("provider activity with timestamp %d was not recorded: %#v", wantAt.UnixMilli(), events)
}

func TestMassKillGuardRefusesDiscoverySweepBeforeBootout(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	if err := os.MkdirAll(config.LaunchAgentsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	paths := make([]string, 0, DefaultMassKillLimit+1)
	for i := 0; i < DefaultMassKillLimit+1; i++ {
		id := "00000000-0000-4000-8000-00000000000" + string(rune('0'+i))
		path := state.RunnerPlistPath(config.LaunchAgentsDir, id)
		if err := os.WriteFile(path, []byte("scratch"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	manager := NewManager(config, prototest.NewLauncher(), ManagerOptions{DisableWatchers: true})
	t.Cleanup(manager.Close)
	err := manager.Discover(context.Background())
	var guardErr *MassKillError
	if !errors.As(err, &guardErr) || guardErr.Count != DefaultMassKillLimit+1 {
		t.Fatalf("Discover() error = %v, want mass-kill guard for %d", err, DefaultMassKillLimit+1)
	}
	for _, path := range paths {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("guarded sweep mutated %s: %v", path, err)
		}
	}
	if err := manager.DiscoverWithOptions(context.Background(), DiscoverOptions{Force: true}); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("forced sweep left %s: %v", path, err)
		}
	}
}

func TestLaunchdFreeCreateWritesMetadataAndPlist(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	config := testConfig(root)
	launcher := prototest.NewLauncher()
	manager := NewManager(config, launcher, ManagerOptions{DisableWatchers: true})
	t.Cleanup(manager.Close)

	created, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "claude", Cwd: root, Name: "  lane acceptance  ",
		Env: map[string]string{"SAFE": "a&b<c>", "RUNNER_ID": "caller-value", "NODE_OPTIONS": "bad"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Cols != 300 || created.Rows != 50 || created.Name != "lane acceptance" {
		t.Fatalf("unexpected defaults: %#v", created)
	}
	joinedArgs := strings.Join(created.Args, " ")
	for _, want := range []string{"--session-id " + created.ID, "--dangerously-skip-permissions"} {
		if !strings.Contains(joinedArgs, want) {
			t.Fatalf("args %q missing %q", joinedArgs, want)
		}
	}

	metadataPath := filepath.Join(config.RunnerStateDir, created.ID+".json")
	plistPath := state.RunnerPlistPath(config.LaunchAgentsDir, created.ID)
	metadata, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(metadata, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["id"] != created.ID || decoded["cols"] != float64(300) || decoded["rows"] != float64(50) {
		t.Fatalf("unexpected metadata: %s", metadata)
	}
	plist, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"tech.pretty-pty.runner." + created.ID,
		"<key>KeepAlive</key>", "<key>SuccessfulExit</key>",
		"<string>Interactive</string>", "<key>RUNNER_ID</key>",
		"<string>a&amp;b&lt;c&gt;</string>",
	} {
		if !strings.Contains(string(plist), want) {
			t.Errorf("plist missing %q:\n%s", want, plist)
		}
	}
	if strings.Contains(string(plist), "NODE_OPTIONS") || strings.Contains(string(plist), "caller-value") {
		t.Fatalf("unsafe environment leaked into plist:\n%s", plist)
	}
	assertMode(t, metadataPath, 0o600)
	assertMode(t, plistPath, 0o600)
}

func TestWorkingEdgeWritesSentinelAndHookEnvironment(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	launcher := prototest.NewLauncher()
	manager := NewManager(config, launcher, ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
	})
	t.Cleanup(manager.Close)
	hookOutput := filepath.Join(root, "hook.txt")
	hookTemporary := hookOutput + ".tmp"
	script := `printf '%s|%s|%s|%s' "$PRETTY_SESSION_ID" "$PRETTY_SESSION_NAME" "$PRETTY_OUTCOME" "$PRETTY_DURATION_MS" > "` + hookTemporary + `" && mv "` + hookTemporary + `" "` + hookOutput + `"`
	hookWatcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hookWatcher.Close() })
	if err := hookWatcher.Add(root); err != nil {
		t.Fatal(err)
	}
	created, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Name: "idle edge", OnIdle: script,
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	runtime := manager.runtimes[created.ID]
	manager.mu.Unlock()
	if runtime == nil {
		t.Fatal("created session has no managed runtime")
	}
	// Drive classifier samples synchronously. The first idle sample only
	// initializes pushWorkingObserved and must not emit an idle edge.
	runtime.tick()
	if _, err := os.Stat(filepath.Join(config.UserStateRoot, "idle", created.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("initial idle sample wrote a sentinel: %v", err)
	}
	runner := launcher.Runner(created.ID)
	// Keep the byte signal above threshold for several classifier ticks so the
	// true state is observable even under the race detector's instrumentation.
	output := "Completed cleanly, all checks passed.\n" + strings.Repeat("x", 900)
	runner.AddOutput(output)
	<-runtime.outputObserved
	runtime.mu.Lock()
	observedBytes := runtime.recentBytes
	runtime.mu.Unlock()
	if observedBytes < len(output) {
		t.Fatalf("output observer recorded %d bytes, want at least %d", observedBytes, len(output))
	}
	runtime.tick()
	if info, ok := manager.Get(created.ID); !ok || !info.Info().Working {
		t.Fatalf("synchronized working sample was not observable: ok=%v info=%#v", ok, info)
	}
	for attempt := 0; attempt < 10; attempt++ {
		info, _ := manager.Get(created.ID)
		if !info.Info().Working {
			break
		}
		runtime.tick()
	}
	if info, ok := manager.Get(created.ID); !ok || info.Info().Working {
		t.Fatalf("working state did not decay after controlled samples: ok=%v info=%#v", ok, info)
	}
	sentinelPath := filepath.Join(config.UserStateRoot, "idle", created.ID)
	if _, err := os.Stat(sentinelPath); err != nil {
		t.Fatalf("idle sentinel was not written: %v", err)
	}
	awaitFile(t, hookWatcher, hookOutput)
	hook, err := os.ReadFile(hookOutput)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(string(hook), "|")
	if len(parts) != 4 || parts[0] != created.ID || parts[1] != "idle edge" || parts[2] != "done" || parts[3] == "" {
		t.Fatalf("hook environment = %q", hook)
	}
	assertMode(t, sentinelPath, 0o600)
}

func TestDiscoveryPreservesUnreachableLivePID(t *testing.T) {
	root := t.TempDir()
	config := testConfig(root)
	if err := os.MkdirAll(config.RunnerStateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	id := "00000000-0000-4000-8000-000000000099"
	socket := filepath.Join(config.RunnerStateDir, id+".sock")
	metadata := filepath.Join(config.RunnerStateDir, id+".json")
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	encoded := `{"id":"` + id + `","cmd":"/bin/sh","args":[],"cwd":"` + root + `","cols":300,"rows":50,"createdAt":1,"pid":1234,"sockPath":"` + socket + `"}`
	if err := os.WriteFile(metadata, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := NewManager(config, prototest.NewLauncher(), ManagerOptions{
		DisableWatchers: true, DiscoveryRetries: 1, DiscoveryDelay: time.Millisecond,
		ProcessAlive: func(int) bool { return true }, ProcessCommand: func(int) string { return "" },
	})
	t.Cleanup(manager.Close)
	if err := manager.Discover(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{socket, metadata} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("discovery removed sacred state %s: %v", path, err)
		}
	}
}

func testConfig(root string) state.Config {
	return state.Config{
		Host: "127.0.0.1", Port: 8787,
		DefaultShell: "/bin/bash", DefaultCwd: root, DefaultCols: 300, DefaultRows: 50,
		StateRoot:       filepath.Join(root, "state"),
		UserStateRoot:   filepath.Join(root, "user-state"),
		RunnerStateDir:  filepath.Join(root, "state", "runners"),
		TokenPath:       filepath.Join(root, "state", "token"),
		OpenPath:        filepath.Join(root, "state", "open"),
		LaunchAgentsDir: filepath.Join(root, "LaunchAgents"),
		GlobalHooksPath: filepath.Join(root, "config", "hooks.json"),
		RunnerPath:      "/scratch/runner",
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("mode(%s) = %04o, want %04o", path, info.Mode().Perm(), want)
	}
}

func awaitCondition(t *testing.T, condition func() bool) {
	t.Helper()
	for !condition() {
		select {
		case <-t.Context().Done():
			t.Fatal("test ended before condition became true")
		default:
			runtime.Gosched()
		}
	}
}

func awaitFile(t *testing.T, watcher *fsnotify.Watcher, path string) {
	t.Helper()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("inspect %s: %v", path, err)
		}
		select {
		case _, ok := <-watcher.Events:
			if !ok {
				t.Fatalf("watcher closed before %s was published", path)
			}
		case err, ok := <-watcher.Errors:
			if ok {
				t.Fatalf("watch %s: %v", path, err)
			}
		case <-t.Context().Done():
			t.Fatalf("test ended before %s was published", path)
		}
	}
}
