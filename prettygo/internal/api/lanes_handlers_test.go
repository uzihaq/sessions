package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/ledger"
	sessionruntime "github.com/uzihaq/pretty-pty/prettygo/internal/session"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

func TestHeadlessLaneLifecycleManifestAndLedger(t *testing.T) {
	base, err := os.MkdirTemp("/tmp", "pretty-lane-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	repo := filepath.Join(base, "repo")
	if err := os.Mkdir(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	git := exec.Command("git", "init", "--quiet", repo)
	if output, err := git.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	specPath := filepath.Join(repo, "lane-spec.md")
	if err := os.WriteFile(specPath, []byte("scratch lane\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	runnerBinary := filepath.Join(base, "runner")
	build := exec.Command("go", "build", "-o", runnerBinary, "./cmd/runner")
	build.Dir = filepath.Join("..", "..")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build runner: %v\n%s", err, output)
	}
	config := state.Config{
		DefaultShell: "/bin/bash", DefaultCwd: repo, DefaultCols: 300, DefaultRows: 50,
		StateRoot: filepath.Join(base, "state"), UserStateRoot: filepath.Join(base, "user-state"),
		RunnerStateDir:  filepath.Join(base, "state", "runners"),
		LaunchAgentsDir: filepath.Join(base, "agents"), RunnerPath: runnerBinary,
	}
	store, err := ledger.Open(context.Background(), ledger.Options{Path: filepath.Join(base, "ledger", "lanes.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	launcher := newProcessLauncher(t, runnerBinary)
	defer launcher.Close()
	notifications := make(chan sessionruntime.PushPayload, 1)
	manager := sessionruntime.NewManager(config, launcher, sessionruntime.ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
		Notify: func(payload sessionruntime.PushPayload) { notifications <- payload },
	})
	defer manager.Close()
	server := httptest.NewServer(New(config, manager, manager.Push()))
	defer server.Close()

	requestBody, _ := json.Marshal(state.CreateSessionRequest{
		Cmd: "/bin/sh", Args: []string{"-c", "sleep 0.1; printf 'OUT_MARKER\\n'; printf 'ERR_MARKER\\n' >&2; exit 3"},
		Cwd: repo, Name: "scratch failure", SpecPath: specPath,
	})
	createdResponse := doE2ERequest(t, http.MethodPost, server.URL+"/api/lanes", requestBody)
	defer createdResponse.Body.Close()
	if createdResponse.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createdResponse.Body)
		t.Fatalf("create lane status=%d body=%s", createdResponse.StatusCode, body)
	}
	var created state.SessionInfo
	if err := json.NewDecoder(createdResponse.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Kind != state.KindLane || created.Tool != "lane:sh" || created.SpecPath != specPath {
		t.Fatalf("lane create response = %#v", created)
	}

	waitFor(t, func() bool {
		session, ok := manager.Get(created.ID)
		return ok && session.Info().Exited
	})
	manifest, err := state.ReadCompletionManifest(state.For(config.RunnerStateDir, created.ID).Manifest)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ExitCode != 3 || manifest.DurationMS < 50 || manifest.SpecPath != specPath ||
		!strings.Contains(manifest.LastOutputTail, "OUT_MARKER") || !strings.Contains(manifest.LastOutputTail, "ERR_MARKER") ||
		manifest.FilesChanged == nil || *manifest.FilesChanged < 1 || len([]byte(manifest.LastOutputTail)) > 4*1024 {
		t.Fatalf("completion manifest = %#v", manifest)
	}

	snapshotResponse := doE2ERequest(t, http.MethodGet, server.URL+"/api/sessions/"+created.ID+"/snapshot", nil)
	snapshot, _ := io.ReadAll(snapshotResponse.Body)
	snapshotResponse.Body.Close()
	if !bytes.Contains(snapshot, []byte("OUT_MARKER")) || !bytes.Contains(snapshot, []byte("ERR_MARKER")) {
		t.Fatalf("lane snapshot = %q", snapshot)
	}
	manifestResponse := doE2ERequest(t, http.MethodGet, server.URL+"/api/lanes/"+created.ID+"/manifest", nil)
	manifestResponse.Body.Close()
	if manifestResponse.StatusCode != http.StatusOK {
		t.Fatalf("manifest endpoint status=%d", manifestResponse.StatusCode)
	}

	events, err := store.Events(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantTypes := []ledger.EventType{ledger.EventCreated, ledger.EventLaunchStarted, ledger.EventRunnerExited}
	for _, want := range wantTypes {
		found := false
		for _, event := range events {
			if event.Type == want {
				found = true
				if want == ledger.EventRunnerExited && !strings.Contains(string(event.Payload), `"code":3`) {
					t.Fatalf("runner_exited payload = %s", event.Payload)
				}
			}
		}
		if !found {
			t.Fatalf("ledger events %#v missing %s", events, want)
		}
	}
	select {
	case notification := <-notifications:
		if notification.Title != "🔴 scratch failure died (exit 3)" || notification.Body != "ERR_MARKER" {
			t.Fatalf("lane notification = %#v", notification)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for lane death notification")
	}
}
