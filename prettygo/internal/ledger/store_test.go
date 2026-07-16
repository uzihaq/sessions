package ledger

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func openTestStore(t *testing.T, options Options) *Store {
	t.Helper()
	if options.Path == "" {
		options.Path = filepath.Join(t.TempDir(), "ledger", "lanes.sqlite3")
	}
	store, err := Open(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close ledger: %v", err)
		}
	})
	return store
}

func TestStoreIsPrivateWALFullAndAppendOnly(t *testing.T) {
	store := openTestStore(t, Options{})
	boundary := store.Boundaries()
	if err := boundary.RecordCreated(context.Background(), Created{
		Meta: Meta{LaneID: "lane-private"}, Tool: "terminal", Cwd: "/tmp", LaneUUID: "lane-private",
	}); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{
		filepath.Dir(store.Path()): 0o700,
		store.Path():               0o600,
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("mode %s = %o, want %o", path, got, want)
		}
	}
	var mode string
	if err := store.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || !strings.EqualFold(mode, "wal") {
		t.Fatalf("journal_mode=%q err=%v", mode, err)
	}
	var synchronous int
	if err := store.db.QueryRow("PRAGMA synchronous").Scan(&synchronous); err != nil || synchronous != 2 {
		t.Fatalf("synchronous=%d err=%v, want FULL(2)", synchronous, err)
	}
	var busyTimeout int
	if err := store.db.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil || busyTimeout != 5000 {
		t.Fatalf("busy_timeout=%d err=%v, want 5000", busyTimeout, err)
	}
	if _, err := store.db.Exec("UPDATE lane_events SET actor='user' WHERE lane_id='lane-private'"); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("UPDATE append-only guard err=%v", err)
	}
	if _, err := store.db.Exec("DELETE FROM lane_events WHERE lane_id='lane-private'"); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("DELETE append-only guard err=%v", err)
	}
}

func TestObservationCapabilityCannotWriteTombstones(t *testing.T) {
	var _ ObservationWriter = observationWriter{}
	methods := reflect.TypeOf(observationWriter{})
	for _, forbidden := range []string{"RecordCreated", "RecordUserKill"} {
		if _, exists := methods.MethodByName(forbidden); exists {
			t.Fatalf("observation capability unexpectedly exposes %s", forbidden)
		}
	}
}

func TestSafeResumeRecipeDropsPromptsAndSecrets(t *testing.T) {
	provider := "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	tests := []struct {
		name string
		tool string
		cmd  string
		args []string
		want []string
	}{
		{
			name: "claude fresh becomes resume", tool: "claude-code", cmd: "claude",
			args: []string{"--session-id", provider, "--append-system-prompt", "TOP-SECRET"},
			want: []string{"claude", "--resume", provider},
		},
		{
			name: "codex flag becomes subcommand", tool: "codex", cmd: "/opt/homebrew/bin/codex",
			args: []string{"--resume=" + provider, "--", "private prompt"},
			want: []string{"/opt/homebrew/bin/codex", "resume", provider},
		},
		{name: "terminal stores no argv", tool: "terminal", cmd: "/bin/sh", args: []string{"-c", "echo secret"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotProvider, got := SafeResumeRecipe(test.tool, test.cmd, test.args)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("recipe=%q, want %q", got, test.want)
			}
			if test.want != nil && gotProvider != provider {
				t.Fatalf("provider=%q, want %q", gotProvider, provider)
			}
			if strings.Contains(strings.Join(got, " "), "secret") {
				t.Fatalf("unsafe argv persisted: %q", got)
			}
		})
	}

	store := openTestStore(t, Options{})
	err := store.Boundaries().RecordCreated(context.Background(), Created{
		Meta: Meta{LaneID: "unsafe"}, Tool: "claude-code", Cwd: "/tmp", LaneUUID: "unsafe",
		ProviderUUID: provider, ResumeArgv: []string{"claude", "--resume", provider, "TOP-SECRET"},
	})
	if err == nil || !strings.Contains(err.Error(), "minimal provider resume recipe") {
		t.Fatalf("unsafe direct writer payload err=%v", err)
	}
}

func TestActivityIsCoalescedAndOnlyTypedSourcesAdvanceRecency(t *testing.T) {
	store := openTestStore(t, Options{ActivityCoalesce: time.Second})
	ctx := context.Background()
	if err := store.Boundaries().RecordCreated(ctx, Created{
		Meta: Meta{LaneID: "lane-activity", AtMS: 1000}, Tool: "terminal", Cwd: "/tmp", LaneUUID: "lane-activity",
	}); err != nil {
		t.Fatal(err)
	}
	writer := store.Observations()
	for _, activity := range []Activity{
		{Meta: Meta{LaneID: "lane-activity", AtMS: 2000}, Source: ActivityHumanInput},
		{Meta: Meta{LaneID: "lane-activity", AtMS: 2500}, Source: ActivityProviderEvent},
		{Meta: Meta{LaneID: "lane-activity", AtMS: 3100}, Source: ActivityProviderEvent},
	} {
		if err := writer.RecordActivity(ctx, activity); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.RecordActivity(ctx, Activity{Meta: Meta{LaneID: "lane-activity"}, Source: "terminal_output"}); err == nil {
		t.Fatal("invalid activity source unexpectedly accepted")
	}
	events, err := store.Events(ctx, "lane-activity")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 { // created + activity at 2000 + activity at 3100
		t.Fatalf("events=%d, want 3: %#v", len(events), events)
	}
	states := Fold(events)
	if len(states) != 1 || states[0].LastActivityAtMS != 3100 {
		t.Fatalf("folded activity=%#v", states)
	}
}

func TestCrashSimulationKill9WriterKeepsDatabaseValid(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("kill -9 simulation requires Unix process semantics")
	}
	root := t.TempDir()
	path := filepath.Join(root, "ledger", "lanes.sqlite3")
	store, err := Open(context.Background(), Options{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Boundaries().RecordCreated(context.Background(), Created{
		Meta: Meta{LaneID: "committed-before-crash"}, Tool: "terminal", Cwd: root, LaneUUID: "committed-before-crash",
	}); err != nil {
		t.Fatal(err)
	}

	helper := filepath.Join(t.TempDir(), "ledger-crash-helper")
	build := exec.Command("go", "build", "-o", helper, "./testhelper")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		_ = store.Close()
		t.Fatalf("build crash helper: %v\n%s", err, output)
	}
	command := exec.Command(helper, path, "uncommitted-crash")
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "transaction-open" {
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = store.Close()
		t.Fatalf("helper readiness line=%q err=%v", line, err)
	}
	if err := command.Process.Kill(); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		_ = store.Close()
		t.Fatal("kill -9 helper unexpectedly exited successfully")
	}
	if err := store.QuickCheck(context.Background()); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(context.Background(), Options{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.QuickCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
	events, err := reopened.Events(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].LaneID != "committed-before-crash" {
		encoded, _ := json.Marshal(events)
		t.Fatalf("post-crash events=%s, want only committed baseline", encoded)
	}
	t.Log("SIGKILL mid-transaction: quick_check=ok committed_rows=1 uncommitted_rows=0 WAL reopen=ok")
}

func TestEventIDUniquenessIsTransactional(t *testing.T) {
	store := openTestStore(t, Options{})
	ctx := context.Background()
	first := Created{Meta: Meta{EventID: "fixed-id", LaneID: "lane-a"}, Tool: "terminal", Cwd: "/tmp", LaneUUID: "lane-a"}
	if err := store.Boundaries().RecordCreated(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := Created{Meta: Meta{EventID: "fixed-id", LaneID: "lane-b"}, Tool: "terminal", Cwd: "/tmp", LaneUUID: "lane-b"}
	if err := store.Boundaries().RecordCreated(ctx, second); err == nil {
		t.Fatal("duplicate event id unexpectedly committed")
	}
	events, err := store.Events(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].LaneID != "lane-a" {
		t.Fatalf("events after failed transaction=%#v", events)
	}
}

func TestResolvePathHonorsEnvironmentOverride(t *testing.T) {
	want := filepath.Join(t.TempDir(), "scratch.sqlite3")
	t.Setenv("PRETTY_LEDGER_PATH", want)
	got, err := ResolvePath("")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("resolved=%q, want %q", got, want)
	}
}
