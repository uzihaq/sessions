package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	daemonapi "github.com/uzihaq/pretty-pty/prettygo/internal/api"
	"github.com/uzihaq/pretty-pty/prettygo/internal/ledger"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest"
	sessionruntime "github.com/uzihaq/pretty-pty/prettygo/internal/session"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

func TestSessionsMineUnifiesOwnedAgentAndLaneIncludesClosedAndKillNoops(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("PRETTY_OWNER_ID", "team:ownership")
	t.Setenv("PRETTY_SESSION_ID", "")
	config := cliRecoveryConfig(root)
	store, err := ledger.Open(context.Background(), ledger.Options{Path: filepath.Join(root, "ledger", "lanes.sqlite3")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	manager := sessionruntime.NewManager(config, prototest.NewLauncher(), sessionruntime.ManagerOptions{
		DisableWatchers: true, ActivityInterval: time.Hour,
		Boundaries: store.Boundaries(), Observations: store.Observations(), LedgerReader: store,
	})
	t.Cleanup(manager.Close)

	agent, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Name: "owned agent", CreatorOwnerID: "team:ownership",
	})
	if err != nil {
		t.Fatal(err)
	}
	lane, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Name: "owned lane", Kind: state.KindLane, CreatorOwnerID: "team:ownership",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: root, Name: "other owner", CreatorOwnerID: "team:other",
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(daemonapi.New(config, manager, manager.Push()))
	defer server.Close()

	stdout, stderr, code := runOwnershipCLI(t, server.URL, "sessions", "--mine")
	if code != 0 || stderr != "" || !strings.Contains(stdout, agent.ID[:8]) || !strings.Contains(stdout, lane.ID[:8]) ||
		!strings.Contains(stdout, "owned agent") || !strings.Contains(stdout, "owned lane") || strings.Contains(stdout, "other owner") {
		t.Fatalf("sessions --mine exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	stdout, stderr, code = runOwnershipCLI(t, server.URL, "ls", "--mine")
	if code != 0 || stderr != "" || !strings.Contains(stdout, "owned agent") || strings.Contains(stdout, "owned lane") || strings.Contains(stdout, "other owner") {
		t.Fatalf("ls --mine exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	stdout, stderr, code = runOwnershipCLI(t, server.URL, "lanes", "--mine")
	if code != 0 || stderr != "" || !strings.Contains(stdout, "owned lane") || strings.Contains(stdout, "owned agent") {
		t.Fatalf("lanes --mine exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}

	if err := manager.RequestKill(context.Background(), lane.ID, false); err != nil {
		t.Fatal(err)
	}
	cliWaitFor(t, func() bool {
		current, ok := manager.Get(lane.ID)
		return ok && current.Info().Exited && cliHasLedgerEvent(t, store, lane.ID, ledger.EventRunnerExited)
	})
	stdout, stderr, code = runOwnershipCLI(t, server.URL, "sessions", "--mine")
	if code != 0 || stderr != "" || strings.Contains(stdout, "owned lane") {
		t.Fatalf("sessions default closed filtering exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	stdout, stderr, code = runOwnershipCLI(t, server.URL, "sessions", "--mine", "--include-closed")
	if code != 0 || stderr != "" || !strings.Contains(stdout, "owned lane") || !strings.Contains(stdout, "exited(0)") {
		t.Fatalf("sessions --include-closed exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	stdout, stderr, code = runOwnershipCLI(t, server.URL, "kill", lane.ID)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "already exited; nothing to kill") || strings.Contains(stderr, "stale") {
		t.Fatalf("kill exited lane exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}

}

func TestSessionsMineLabelsOSUserFallbackAsUserWide(t *testing.T) {
	t.Setenv("PRETTY_OWNER_ID", "")
	t.Setenv("PRETTY_SESSION_ID", "")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/sessions":
			_, _ = response.Write([]byte(`{"sessions":[{"id":"20000000-0000-4000-8000-000000000001","cmd":"/bin/sh","cwd":"/tmp","createdAt":1,"tool":"terminal","root_creator_kind":"user","root_creator_id":"uid:424242"}]}`))
		case "/api/lanes":
			_, _ = response.Write([]byte(`{"lanes":[],"user_creator_id":"uid:424242"}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	stdout, stderr, code := runOwnershipCLI(t, server.URL, "sessions", "--mine")
	if code != 0 || stderr != "" || !strings.Contains(stdout, "ownership scope: OS user uid:424242") ||
		!strings.Contains(stdout, "no PRETTY_OWNER_ID or PRETTY_SESSION_ID") {
		t.Fatalf("OS-user fallback exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

func TestKillExitedLaneUsesDurableManifestAsCleanNoop(t *testing.T) {
	id := "21000000-0000-4000-8000-000000000001"
	deleteRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/lanes":
			_, _ = response.Write([]byte(`{"lanes":[],"user_creator_id":"uid:424242"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/api/lanes/"+id+"/manifest":
			_, _ = response.Write([]byte(`{"exit_code":0,"signal":null,"duration_ms":1,"last_output_tail":"done\n","spec_path":""}`))
		case request.Method == http.MethodDelete:
			deleteRequests++
			response.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	stdout, stderr, code := runOwnershipCLI(t, server.URL, "kill", id)
	if code != 0 || stderr != "" || !strings.Contains(stdout, "already exited; nothing to kill") || deleteRequests != 0 {
		t.Fatalf("manifest kill noop exit=%d deletes=%d stdout=%q stderr=%q", code, deleteRequests, stdout, stderr)
	}
}

func TestLSMineJSONFiltersTypesWithoutRewritingRawFieldCasing(t *testing.T) {
	t.Setenv("PRETTY_OWNER_ID", "team:json")
	t.Setenv("PRETTY_SESSION_ID", "")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"sessions":[` +
			`{"id":"22000000-0000-4000-8000-000000000001","kind":"","cmd":"/bin/sh","root_creator_kind":"external","root_creator_id":"team:json","futureMixedCase":"kept"},` +
			`{"id":"22000000-0000-4000-8000-000000000002","kind":"lane","cmd":"/bin/sh","root_creator_kind":"external","root_creator_id":"team:json","futureMixedCase":"lane"}` +
			`]}`))
	}))
	defer server.Close()
	stdout, stderr, code := runOwnershipCLI(t, server.URL, "--json", "ls", "--mine")
	if code != 0 || stderr != "" || !strings.Contains(stdout, `"futureMixedCase": "kept"`) || strings.Contains(stdout, `"futureMixedCase": "lane"`) {
		t.Fatalf("ls --mine JSON exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

func runOwnershipCLI(t *testing.T, host string, args ...string) (string, string, int) {
	t.Helper()
	arguments := append([]string{"--host", host}, args...)
	var stdout, stderr bytes.Buffer
	code := run(arguments, strings.NewReader(""), &stdout, &stderr)
	return stdout.String(), stderr.String(), code
}
