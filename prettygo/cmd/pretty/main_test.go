package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestDecideSendConfirmation(t *testing.T) {
	tests := []struct {
		name       string
		evidence   sendEvidence
		confidence string
		exitCode   int
	}{
		{"confirmed", sendEvidence{JSONLConfirmed: true}, "confirmed", 0},
		{"accepted-working", sendEvidence{Working: true}, "accepted", 0},
		{"still-in-composer", sendEvidence{TextStillInComposer: true}, "unconfirmed", 1},
		{"ambiguous", sendEvidence{}, "unconfirmed", 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actual := decideSendConfirmation(test.evidence)
			if actual.Confidence != test.confidence || actual.ExitCode != test.exitCode {
				t.Fatalf("decision = %#v, want confidence=%s exit=%d", actual, test.confidence, test.exitCode)
			}
			t.Logf("%s: confidence=%s exit=%d", test.name, actual.Confidence, actual.ExitCode)
		})
	}
}

func TestClaudeSubmitSequenceMatchesNodeCLI(t *testing.T) {
	const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	text := "\x1b[200~Reply with exactly PONG.\x1b[201~"
	inputs := make([]string, 0, 2)
	submitted := false
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/sessions":
			lastUser := any(nil)
			if submitted {
				lastUser = int64(2)
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"sessions": []any{map[string]any{
				"id": id, "cmd": "claude", "tool": "claude-code", "lastUserMessageAt": lastUser,
			}}})
		case request.Method == http.MethodGet && request.URL.Path == "/api/sessions/"+id+"/events":
			events := []any{}
			if submitted {
				events = append(events, map[string]any{
					"type": "user", "message": map[string]any{"role": "user", "content": text},
				})
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"events": events, "nextIndex": len(events)})
		case request.Method == http.MethodPost && request.URL.Path == "/api/sessions/"+id+"/input":
			var body map[string]string
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				http.Error(response, err.Error(), http.StatusBadRequest)
				return
			}
			inputs = append(inputs, body["data"])
			if body["data"] == "\r" {
				submitted = true
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"ok": true})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	t.Setenv("HOME", t.TempDir())

	application, err := newApp([]string{"--host", server.URL}, strings.NewReader(""), io.Discard, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	defer application.close()
	var sleeps []time.Duration
	application.sleep = func(duration time.Duration) { sleeps = append(sleeps, duration) }
	result, err := application.sendAndConfirm(id, text, time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Confirmed == nil || !*result.Confirmed || result.Text != text {
		t.Fatalf("result = %+v, want confirmed exact text", result)
	}
	if want := []string{text, "\r"}; !reflect.DeepEqual(inputs, want) {
		t.Fatalf("input sequence = %q, want %q", inputs, want)
	}
	if want := []time.Duration{sendTextSettleDelay}; !reflect.DeepEqual(sleeps, want) {
		t.Fatalf("sleeps = %v, want %v", sleeps, want)
	}
}

func TestClaudeEnterRetriesRequireTextStillInComposer(t *testing.T) {
	const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	const text = "Reply with exactly PONG."
	tests := []struct {
		name       string
		snapshot   string
		wantEnters int
	}{
		{name: "visible text gets two bounded retries", snapshot: "❯ " + text, wantEnters: 3},
		{name: "cleared composer never retries", snapshot: "❯ ", wantEnters: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			enters := 0
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				switch {
				case request.Method == http.MethodGet && request.URL.Path == "/api/sessions":
					_ = json.NewEncoder(response).Encode(map[string]any{"sessions": []any{map[string]any{
						"id": id, "cmd": "claude", "tool": "claude-code", "working": false,
					}}})
				case request.Method == http.MethodGet && request.URL.Path == "/api/sessions/"+id+"/events":
					_ = json.NewEncoder(response).Encode(map[string]any{"events": []any{}, "nextIndex": 0})
				case request.Method == http.MethodGet && request.URL.Path == "/api/sessions/"+id+"/snapshot":
					response.Header().Set("Content-Type", "text/plain")
					_, _ = io.WriteString(response, test.snapshot)
				case request.Method == http.MethodPost && request.URL.Path == "/api/sessions/"+id+"/input":
					var body map[string]string
					_ = json.NewDecoder(request.Body).Decode(&body)
					if body["data"] == "\r" {
						enters++
					}
					_ = json.NewEncoder(response).Encode(map[string]any{"ok": true})
				default:
					http.NotFound(response, request)
				}
			}))
			defer server.Close()
			t.Setenv("HOME", t.TempDir())

			application, err := newApp([]string{"--host", server.URL}, strings.NewReader(""), io.Discard, io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			defer application.close()
			clock := time.Unix(0, 0)
			application.now = func() time.Time { return clock }
			application.sleep = func(duration time.Duration) { clock = clock.Add(duration) }
			result, err := application.sendAndConfirm(id, text, 650*time.Millisecond, false)
			if err != nil {
				t.Fatal(err)
			}
			if result.Confirmed == nil || *result.Confirmed {
				t.Fatalf("result = %+v, want unconfirmed timeout", result)
			}
			if enters != test.wantEnters {
				t.Fatalf("Enter count = %d, want %d", enters, test.wantEnters)
			}
		})
	}
}

func TestNodeCLIGoldenOutputShapes(t *testing.T) {
	lsFixture, err := os.ReadFile("testdata/node-ls.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtureSessions []map[string]any
	if err := json.Unmarshal(lsFixture, &fixtureSessions); err != nil {
		t.Fatal(err)
	}
	id, _ := fixtureSessions[0]["id"].(string)
	if id == "" {
		t.Fatal("node ls fixture has no session id")
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/sessions":
			fmt.Fprintf(response, `{"sessions":%s}`, bytes.TrimSpace(lsFixture))
		case request.Method == http.MethodPost && request.URL.Path == "/api/sessions/"+id+"/input":
			_, _ = io.Copy(io.Discard, request.Body)
			_ = json.NewEncoder(response).Encode(map[string]any{"ok": true})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	t.Setenv("HOME", t.TempDir())

	tests := []struct {
		name    string
		args    []string
		fixture string
		exact   bool
	}{
		{"ls", []string{"--host", server.URL, "--json", "ls"}, "testdata/node-ls.json", true},
		{"send", []string{"--host", server.URL, "--json", "send", id[:8], "echo", "GOLDEN_SEND"}, "testdata/node-send.json", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if code := run(test.args, strings.NewReader(""), &stdout, &stderr); code != 0 {
				t.Fatalf("exit=%d stderr=%q stdout=%q", code, stderr.String(), stdout.String())
			}
			fixtureBytes, err := os.ReadFile(test.fixture)
			if err != nil {
				t.Fatal(err)
			}
			if test.exact && !bytes.Equal(stdout.Bytes(), fixtureBytes) {
				t.Fatalf("exact Node golden mismatch\nactual:\n%s\nexpected:\n%s", stdout.String(), fixtureBytes)
			}
			var actual, fixture any
			if err := json.Unmarshal(stdout.Bytes(), &actual); err != nil {
				t.Fatalf("decode actual: %v\n%s", err, stdout.String())
			}
			if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
				t.Fatalf("decode fixture: %v", err)
			}
			if diff := compareJSONShape("$", actual, fixture); diff != "" {
				t.Fatal(diff)
			}
			t.Logf("%s shape matches %s", test.name, test.fixture)
		})
	}
}

func TestNewNameFlowsThroughPostBodyAndList(t *testing.T) {
	const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	var posted createSessionRequest
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/sessions":
			if err := json.NewDecoder(request.Body).Decode(&posted); err != nil {
				http.Error(response, err.Error(), http.StatusBadRequest)
				return
			}
			response.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"id": id, "name": posted.Name, "cmd": posted.Cmd, "args": posted.Args,
				"cwd": posted.Cwd, "cols": 300, "rows": 50, "createdAt": 1, "pid": 4242,
				"tool": "terminal", "working": false, "lastDataAt": 1,
				"lastUserMessageAt": nil, "exited": false, "exitCode": nil, "exitSignal": nil, "exitedAt": nil,
			})
		case request.Method == http.MethodGet && request.URL.Path == "/api/sessions":
			_ = json.NewEncoder(response).Encode(map[string]any{"sessions": []any{map[string]any{
				"id": id, "name": posted.Name, "cmd": posted.Cmd, "args": posted.Args,
				"cwd": posted.Cwd, "cols": 300, "rows": 50, "createdAt": 1, "pid": 4242,
				"tool": "terminal", "working": false, "lastDataAt": 1,
				"lastUserMessageAt": nil, "exited": false, "exitCode": nil, "exitSignal": nil, "exitedAt": nil,
			}}})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	home := t.TempDir()
	t.Setenv("HOME", home)

	var stdout, stderr bytes.Buffer
	code := run([]string{"--host", server.URL, "new", "--cmd", "/bin/sh", "--cwd", home, "--name", "  soak label  "}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("new exit=%d stderr=%q", code, stderr.String())
	}
	if posted.Name != "soak label" {
		t.Fatalf("POST name = %q, want soak label", posted.Name)
	}
	stdout.Reset()
	stderr.Reset()
	code = run([]string{"--host", server.URL, "--json", "ls"}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("ls exit=%d stderr=%q", code, stderr.String())
	}
	var listed []map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0]["name"] != "soak label" {
		t.Fatalf("listed sessions = %#v", listed)
	}
}

func compareJSONShape(path string, actual, expected any) string {
	if actual == nil || expected == nil {
		if actual == nil && expected == nil {
			return ""
		}
		return fmt.Sprintf("%s null mismatch: actual=%T expected=%T", path, actual, expected)
	}
	if reflect.TypeOf(actual) != reflect.TypeOf(expected) {
		return fmt.Sprintf("%s type mismatch: actual=%T expected=%T", path, actual, expected)
	}
	switch expectedValue := expected.(type) {
	case map[string]any:
		actualValue := actual.(map[string]any)
		expectedKeys := make([]string, 0, len(expectedValue))
		actualKeys := make([]string, 0, len(actualValue))
		for key := range expectedValue {
			expectedKeys = append(expectedKeys, key)
		}
		for key := range actualValue {
			actualKeys = append(actualKeys, key)
		}
		sort.Strings(expectedKeys)
		sort.Strings(actualKeys)
		if !reflect.DeepEqual(actualKeys, expectedKeys) {
			return fmt.Sprintf("%s keys mismatch: actual=%v expected=%v", path, actualKeys, expectedKeys)
		}
		for _, key := range expectedKeys {
			if diff := compareJSONShape(path+"."+key, actualValue[key], expectedValue[key]); diff != "" {
				return diff
			}
		}
	case []any:
		actualValue := actual.([]any)
		if len(actualValue) != len(expectedValue) {
			return fmt.Sprintf("%s length mismatch: actual=%d expected=%d", path, len(actualValue), len(expectedValue))
		}
		for index := range expectedValue {
			if diff := compareJSONShape(fmt.Sprintf("%s[%d]", path, index), actualValue[index], expectedValue[index]); diff != "" {
				return diff
			}
		}
	}
	return ""
}

func TestDaemonPlistUsesScratchLabelWithoutLaunchctl(t *testing.T) {
	label := "tech.pretty-pty.daemon.scratch-test"
	directory := t.TempDir()
	path := filepath.Join(directory, label+".plist")
	xml := daemonPlist(daemonPlistOptions{
		Label: label, Program: "/tmp/pretty-cli/prettyd", WorkingDir: "/tmp/pretty-cli",
		LogFile: "/tmp/pretty-cli/daemon.log",
		Env:     []plistEnvironment{{Key: "PATH", Value: "/usr/bin:/bin"}, {Key: "PRETTYD_PORT", Value: "18787"}},
	})
	if err := os.WriteFile(path, []byte(xml), 0o600); err != nil {
		t.Fatal(err)
	}
	if strings.Count(xml, "<string>"+label+"</string>") != 1 {
		t.Fatalf("scratch label missing or duplicated:\n%s", xml)
	}
	for _, want := range []string{"<string>/tmp/pretty-cli/prettyd</string>", "<key>KeepAlive</key>", "<key>PRETTYD_PORT</key>"} {
		if !strings.Contains(xml, want) {
			t.Fatalf("plist missing %q", want)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("plist mode=%#o, want 0600", info.Mode().Perm())
	}
	t.Logf("scratch plist label=%s mode=%#o (launchctl not invoked)", label, info.Mode().Perm())
}

func TestAgentControlTranslation(t *testing.T) {
	model := "gpt-5.2-codex"
	effort := "high"
	body := createSessionRequest{Cmd: "codex"}
	if err := applyToolDefault(&body, false); err != nil {
		t.Fatal(err)
	}
	if err := applyAgentControls(&body, agentControls{model: &model, effort: &effort, fast: true}); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(body.Args, " ")
	for _, want := range []string{
		"--dangerously-bypass-approvals-and-sandbox", "--model gpt-5.2-codex",
		`model_reasoning_effort="high"`, `service_tier="priority"`,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args %q missing %q", joined, want)
		}
	}
}

func TestLastAndTranscriptJSONShapes(t *testing.T) {
	const id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
	events := []any{
		map[string]any{
			"type": "user", "timestamp": "2026-07-16T20:00:00.000Z",
			"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "hello"}}},
		},
		map[string]any{
			"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "content": "ignored"}}},
		},
		map[string]any{
			"type": "assistant", "timestamp": "2026-07-16T20:00:01.000Z",
			"message": map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": "answer"},
				map[string]any{"type": "tool_use", "name": "Read"},
			}},
		},
		map[string]any{
			"type": "assistant", "timestamp": "2026-07-16T20:00:01.100Z",
			"message": map[string]any{"role": "assistant", "content": []any{}, "usage": map[string]any{"output_tokens": 1}},
		},
		map[string]any{
			"type": "assistant", "timestamp": "2026-07-16T20:00:01.200Z",
			"message": map[string]any{"role": "assistant", "content": []any{}, "stop_reason": "end_turn"},
		},
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/sessions":
			_ = json.NewEncoder(response).Encode(map[string]any{"sessions": []any{map[string]any{
				"id": id, "cmd": "claude", "args": []any{}, "cwd": "/tmp", "createdAt": 1,
				"tool": "claude-code", "working": false,
			}}})
		case "/api/sessions/" + id + "/events":
			_ = json.NewEncoder(response).Encode(map[string]any{"events": events, "nextIndex": len(events)})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	t.Setenv("HOME", t.TempDir())

	tests := []struct {
		command string
		want    string
	}{
		{
			"last",
			`[{"role":"user","text":"hello","timestamp":"2026-07-16T20:00:00.000Z"},{"role":"assistant","text":"answer","timestamp":"2026-07-16T20:00:01.000Z"}]`,
		},
		{
			"transcript",
			`[{"role":"user","text":"hello","timestamp":"2026-07-16T20:00:00.000Z"},{"role":"assistant","text":"answer","timestamp":"2026-07-16T20:00:01.000Z","toolCalls":["Read"]}]`,
		},
	}
	for _, test := range tests {
		t.Run(test.command, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run([]string{"--host", server.URL, "--json", test.command, id[:8]}, strings.NewReader(""), &stdout, &stderr)
			if code != 0 {
				t.Fatalf("exit=%d stderr=%q", code, stderr.String())
			}
			assertJSONEqual(t, stdout.String(), test.want)
		})
	}
}

func assertJSONEqual(t *testing.T, actual, expected string) {
	t.Helper()
	var actualValue, expectedValue any
	if err := json.Unmarshal([]byte(actual), &actualValue); err != nil {
		t.Fatalf("decode actual: %v\n%s", err, actual)
	}
	if err := json.Unmarshal([]byte(expected), &expectedValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("JSON mismatch\nactual:   %s\nexpected: %s", actual, expected)
	}
}
