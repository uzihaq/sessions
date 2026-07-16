package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type testDaemon struct {
	config   state.Config
	registry *state.Registry
	launcher *prototest.Launcher
	handler  *Server
	root     string
}

func newTestDaemon(t *testing.T) testDaemon {
	t.Helper()
	root := t.TempDir()
	webDir := filepath.Join(root, "frontend", "dist")
	if err := os.MkdirAll(webDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("<!doctype html><title>pretty test ui</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := state.Config{
		Host: "127.0.0.1", Port: 8787,
		DefaultShell: "/bin/bash", DefaultCwd: root, DefaultCols: 300, DefaultRows: 50,
		StateRoot:       filepath.Join(root, "state"),
		RunnerStateDir:  filepath.Join(root, "state", "runners"),
		TokenPath:       filepath.Join(root, "state", "token"),
		OpenPath:        filepath.Join(root, "state", "open"),
		LaunchAgentsDir: filepath.Join(root, "LaunchAgents"),
		WebDir:          webDir,
	}
	if err := os.MkdirAll(config.StateRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.TokenPath, []byte(testToken), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := prototest.NewLauncher()
	registry := state.NewRegistry(config, launcher)
	return testDaemon{config: config, registry: registry, launcher: launcher, handler: New(config, registry), root: root}
}

func TestHealthShapeAndStaticUI(t *testing.T) {
	daemon := newTestDaemon(t)

	health := serve(t, daemon.handler, http.MethodGet, "/api/health", nil, "198.51.100.10:4321", nil)
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d, body = %s", health.Code, health.Body.String())
	}
	var body map[string]any
	decodeBody(t, health, &body)
	for _, key := range []string{"ok", "name", "version", "listen", "discovering", "sessionsLoaded"} {
		if _, exists := body[key]; !exists {
			t.Errorf("health missing key %q: %#v", key, body)
		}
	}
	listen := body["listen"].(map[string]any)
	if listen["host"] != "127.0.0.1" || listen["port"] != float64(8787) {
		t.Fatalf("unexpected listen shape: %#v", listen)
	}

	deep := serve(t, daemon.handler, http.MethodGet, "/api/health/deep", nil, "198.51.100.10:4321", nil)
	decodeBody(t, deep, &body)
	for _, key := range []string{"uptimeSec", "sessions"} {
		if _, exists := body[key]; !exists {
			t.Errorf("deep health missing key %q: %#v", key, body)
		}
	}

	index := serve(t, daemon.handler, http.MethodGet, "/", nil, "198.51.100.10:4321", nil)
	if index.Code != http.StatusOK || !strings.Contains(index.Body.String(), "pretty test ui") {
		t.Fatalf("static index: status=%d body=%q", index.Code, index.Body.String())
	}
	spa := serve(t, daemon.handler, http.MethodGet, "/sessions/example", nil, "198.51.100.10:4321", nil)
	if spa.Code != http.StatusOK || !strings.Contains(spa.Body.String(), "pretty test ui") {
		t.Fatalf("SPA fallback: status=%d body=%q", spa.Code, spa.Body.String())
	}
}

func TestAuthAndOriginMatrix(t *testing.T) {
	daemon := newTestDaemon(t)
	external := "198.51.100.25:5555"

	tests := []struct {
		name       string
		remote     string
		target     string
		headers    http.Header
		wantStatus int
		wantOrigin string
	}{
		{name: "no token", remote: external, target: "/api/sessions", wantStatus: http.StatusUnauthorized},
		{name: "bearer token", remote: external, target: "/api/sessions", headers: http.Header{"Authorization": {"Bearer " + testToken}}, wantStatus: http.StatusOK},
		{name: "query token", remote: external, target: "/api/sessions?token=" + testToken, wantStatus: http.StatusOK},
		{name: "loopback exempt", remote: "127.0.0.1:4567", target: "/api/sessions", wantStatus: http.StatusOK},
		{name: "xff defeats exemption", remote: "127.0.0.1:4567", target: "/api/sessions", headers: http.Header{"X-Forwarded-For": {"127.0.0.1"}}, wantStatus: http.StatusUnauthorized},
		{name: "evil origin not echoed", remote: external, target: "/api/sessions?token=" + testToken, headers: http.Header{"Origin": {"https://evil.test"}}, wantStatus: http.StatusOK},
		{name: "hosted site allowed", remote: external, target: "/api/sessions?token=" + testToken, headers: http.Header{"Origin": {"https://pretty-pty.somewhere.site"}}, wantStatus: http.StatusOK, wantOrigin: "https://pretty-pty.somewhere.site"},
		{name: "hosted tech allowed", remote: external, target: "/api/sessions?token=" + testToken, headers: http.Header{"Origin": {"https://pretty-pty.somewhere.tech"}}, wantStatus: http.StatusOK, wantOrigin: "https://pretty-pty.somewhere.tech"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serve(t, daemon.handler, http.MethodGet, test.target, nil, test.remote, test.headers)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != test.wantOrigin {
				t.Fatalf("ACAO = %q, want %q", got, test.wantOrigin)
			}
			if vary := response.Header().Get("Vary"); vary != "Origin" {
				t.Fatalf("Vary = %q, want Origin", vary)
			}
		})
	}

	if err := os.WriteFile(daemon.config.OpenPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	opened := serve(t, daemon.handler, http.MethodGet, "/api/sessions", nil, external, nil)
	if opened.Code != http.StatusOK {
		t.Fatalf("open escape hatch status = %d, body=%s", opened.Code, opened.Body.String())
	}
}

func TestTokenCreationAndJSONBodyLimit(t *testing.T) {
	daemon := newTestDaemon(t)
	if err := os.Remove(daemon.config.TokenPath); err != nil {
		t.Fatal(err)
	}
	unauthorized := serve(t, daemon.handler, http.MethodGet, "/api/sessions", nil, "198.51.100.25:5555", nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body=%s", unauthorized.Code, unauthorized.Body.String())
	}
	encoded, err := os.ReadFile(daemon.config.TokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if !validToken(string(encoded)) {
		t.Fatalf("generated token is not 64 lowercase hex characters: %q", encoded)
	}
	assertMode(t, daemon.config.TokenPath, 0o600)

	tooLarge := strings.NewReader(`{"data":"` + strings.Repeat("x", maxJSONBody) + `"}`)
	response := serve(t, daemon.handler, http.MethodPost, "/api/sessions/missing/input", tooLarge, "127.0.0.1:1", nil)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "request body too large") {
		t.Fatalf("oversized JSON: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSessionsLifecycleAndRouteShapes(t *testing.T) {
	daemon := newTestDaemon(t)

	list := serve(t, daemon.handler, http.MethodGet, "/api/sessions", nil, "127.0.0.1:1", nil)
	var listed struct {
		Sessions []state.SessionInfo `json:"sessions"`
	}
	decodeBody(t, list, &listed)
	if len(listed.Sessions) != 0 {
		t.Fatalf("initial sessions = %#v, want empty", listed.Sessions)
	}

	createBody := map[string]any{
		"cmd": "/bin/sh", "args": []string{"-l"}, "cwd": daemon.root,
		"cols": 120, "rows": 40, "name": "acceptance fake",
		"env": map[string]string{"SAFE_VALUE": "yes", "RUNNER_ID": "evil", "NODE_OPTIONS": "--require bad"},
	}
	encoded, _ := json.Marshal(createBody)
	created := serve(t, daemon.handler, http.MethodPost, "/api/sessions", bytes.NewReader(encoded), "127.0.0.1:1", http.Header{"Content-Type": {"application/json"}})
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", created.Code, created.Body.String())
	}
	var info state.SessionInfo
	decodeBody(t, created, &info)
	if info.ID == "" || info.Name != "acceptance fake" || info.Tool != state.ToolTerminal || info.PID != daemon.launcher.PID {
		t.Fatalf("unexpected create response: %#v", info)
	}

	metadataPath := filepath.Join(daemon.config.RunnerStateDir, info.ID+".json")
	metadata, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"id": "` + info.ID + `"`, `"cmd": "/bin/sh"`, `"sockPath"`} {
		if !bytes.Contains(metadata, []byte(want)) {
			t.Errorf("metadata missing %q: %s", want, metadata)
		}
	}
	assertMode(t, metadataPath, 0o600)
	plistPath := filepath.Join(daemon.config.LaunchAgentsDir, "tech.pretty-pty.runner."+info.ID+".plist")
	plist, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"tech.pretty-pty.runner." + info.ID, "<string>Interactive</string>", "<key>RUNNER_ID</key>"} {
		if !bytes.Contains(plist, []byte(want)) {
			t.Errorf("plist missing %q", want)
		}
	}
	if bytes.Contains(plist, []byte("NODE_OPTIONS")) || bytes.Contains(plist, []byte("<string>evil</string>")) {
		t.Fatalf("unsafe caller environment leaked into plist: %s", plist)
	}
	assertMode(t, plistPath, 0o600)

	list = serve(t, daemon.handler, http.MethodGet, "/api/sessions", nil, "127.0.0.1:1", nil)
	decodeBody(t, list, &listed)
	if len(listed.Sessions) != 1 || listed.Sessions[0].ID != info.ID {
		t.Fatalf("sessions after create = %#v", listed.Sessions)
	}

	runner := daemon.launcher.Runner(info.ID)
	runner.AddOutput("hello from fake runner\n")
	runner.AddClaudeEvent(map[string]any{"type": "user", "n": 1})
	runner.AddClaudeEvent(map[string]any{"type": "assistant", "n": 2})
	runner.AddClaudeEvent(map[string]any{"type": "assistant", "n": 3})
	waitFor(t, func() bool {
		session, _ := daemon.registry.Get(info.ID)
		return session.Replay(0).Current == 1 && session.ClaudeEventCount() == 3
	})

	snapshot := serve(t, daemon.handler, http.MethodGet, "/api/sessions/"+info.ID+"/snapshot?cols=80", nil, "127.0.0.1:1", nil)
	wantSnapshot := "hello from fake runner" + strings.Repeat(" ", 80-len("hello from fake runner"))
	if snapshot.Code != http.StatusOK || snapshot.Header().Get("X-Pretty-Seq") != "1" || snapshot.Body.String() != wantSnapshot {
		t.Fatalf("snapshot status=%d seq=%q body=%q", snapshot.Code, snapshot.Header().Get("X-Pretty-Seq"), snapshot.Body.String())
	}

	events := serve(t, daemon.handler, http.MethodGet, "/api/sessions/"+info.ID+"/events?tail=2", nil, "127.0.0.1:1", nil)
	var eventBody struct {
		Events     []map[string]any `json:"events"`
		NextIndex  int64            `json:"nextIndex"`
		StartIndex int64            `json:"startIndex"`
		EndIndex   int64            `json:"endIndex"`
	}
	decodeBody(t, events, &eventBody)
	if len(eventBody.Events) != 2 || eventBody.NextIndex != 3 || eventBody.StartIndex != 1 || eventBody.EndIndex != 3 {
		t.Fatalf("unexpected events tail: %#v", eventBody)
	}

	input := serve(t, daemon.handler, http.MethodPost, "/api/sessions/"+info.ID+"/input", strings.NewReader(`{"data":"pwd\n"}`), "127.0.0.1:1", nil)
	if input.Code != http.StatusOK {
		t.Fatalf("input status=%d body=%s", input.Code, input.Body.String())
	}
	if got := runner.Inputs(); len(got) != 1 || got[0] != "pwd\n" {
		t.Fatalf("runner inputs = %#v", got)
	}

	killed := serve(t, daemon.handler, http.MethodDelete, "/api/sessions/"+info.ID, nil, "127.0.0.1:1", nil)
	if killed.Code != http.StatusOK {
		t.Fatalf("kill status=%d body=%s", killed.Code, killed.Body.String())
	}
	waitFor(t, func() bool { return len(daemon.registry.List(false)) == 0 })
	if sessions := daemon.registry.List(true); len(sessions) != 1 || !sessions[0].Exited || sessions[0].ExitCode == nil || *sessions[0].ExitCode != 0 {
		t.Fatalf("include-exited sessions = %#v", sessions)
	}
}

func TestWebSocketSingleMuxAndHandshakePolicy(t *testing.T) {
	daemon := newTestDaemon(t)
	info, err := daemon.registry.Create(context.Background(), state.CreateSessionRequest{Cmd: "/bin/sh", Cwd: daemon.root})
	if err != nil {
		t.Fatal(err)
	}
	runner := daemon.launcher.Runner(info.ID)
	httpServer := httptest.NewServer(daemon.handler)
	defer httpServer.Close()
	wsBase := "ws" + strings.TrimPrefix(httpServer.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, wsBase+"/ws?sessionId="+url.QueryEscape(info.ID), nil)
	if err != nil {
		t.Fatal(err)
	}
	message := readWS(t, ctx, connection)
	if message["type"] != "hello" || message["protocol"] != float64(2) {
		t.Fatalf("single hello = %#v", message)
	}
	runner.AddOutput("live-output")
	message = readWS(t, ctx, connection)
	if message["type"] != "output" || message["data"] != "live-output" {
		t.Fatalf("single output = %#v", message)
	}
	writeWS(t, ctx, connection, map[string]any{"type": "ping"})
	if message = readWS(t, ctx, connection); message["type"] != "pong" {
		t.Fatalf("single pong = %#v", message)
	}
	writeWS(t, ctx, connection, map[string]any{"type": "input", "data": "whoami\n"})
	writeWS(t, ctx, connection, map[string]any{"type": "resize", "cols": 1, "rows": 999})
	waitFor(t, func() bool {
		cols, rows := runner.Size()
		return cols == 40 && rows == 200 && len(runner.Inputs()) > 0
	})
	_ = connection.Close(websocket.StatusNormalClosure, "done")

	mux, _, err := websocket.Dial(ctx, wsBase+"/ws?mux=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer mux.CloseNow()
	falseValue := false
	writeWS(t, ctx, mux, map[string]any{"type": "attach", "sessionId": info.ID, "outputReplay": falseValue})
	message = readWS(t, ctx, mux)
	if message["type"] != "hello" || message["sessionId"] != info.ID {
		t.Fatalf("mux hello = %#v", message)
	}
	writeWS(t, ctx, mux, map[string]any{"type": "snapshot", "requestId": "snap-1", "sessionId": info.ID, "cols": 80})
	message = readWS(t, ctx, mux)
	wantMuxSnapshot := "live-output" + strings.Repeat(" ", 80-len("live-output"))
	if message["type"] != "snapshot" || message["requestId"] != "snap-1" || message["text"] != wantMuxSnapshot {
		t.Fatalf("mux snapshot = %#v", message)
	}
	writeWS(t, ctx, mux, map[string]any{"type": "input", "requestId": "input-1", "sessionId": info.ID, "data": "date\n"})
	message = readWS(t, ctx, mux)
	if message["type"] != "inputAck" || message["ok"] != true {
		t.Fatalf("mux input ack = %#v", message)
	}
	writeWS(t, ctx, mux, map[string]any{"type": "events", "requestId": "events-1", "sessionId": "missing", "tail": 4})
	message = readWS(t, ctx, mux)
	if message["type"] != "rpcError" || message["code"] != "not_found" {
		t.Fatalf("mux rpc error = %#v", message)
	}

	evilHeader := http.Header{"Origin": {"https://evil.test"}}
	evil, response, err := websocket.Dial(ctx, wsBase+"/ws?mux=1", &websocket.DialOptions{HTTPHeader: evilHeader})
	if evil != nil {
		evil.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("evil WS origin: err=%v response=%v", err, response)
	}

	allowedHeader := http.Header{"Origin": {"https://pretty-pty.somewhere.site"}}
	allowed, response, err := websocket.Dial(ctx, wsBase+"/ws?mux=1", &websocket.DialOptions{HTTPHeader: allowedHeader})
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("allowed WS origin: err=%v response=%v", err, response)
	}
	allowed.CloseNow()

	xffHeader := http.Header{"X-Forwarded-For": {"127.0.0.1"}}
	xff, response, err := websocket.Dial(ctx, wsBase+"/ws?mux=1", &websocket.DialOptions{HTTPHeader: xffHeader})
	if xff != nil {
		xff.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("XFF WS auth: err=%v response=%v", err, response)
	}
}

func serve(t *testing.T, handler http.Handler, method, target string, body io.Reader, remote string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, body)
	request.RemoteAddr = remote
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeBody(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode(%s) = %04o, want %04o", path, got, want)
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(time.Millisecond)
	}
}

func readWS(t *testing.T, ctx context.Context, connection *websocket.Conn) map[string]any {
	t.Helper()
	_, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatalf("decode WS %q: %v", payload, err)
	}
	return message
}

func writeWS(t *testing.T, ctx context.Context, connection *websocket.Conn, message any) {
	t.Helper()
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Write(ctx, websocket.MessageText, encoded); err != nil {
		t.Fatal(err)
	}
}
