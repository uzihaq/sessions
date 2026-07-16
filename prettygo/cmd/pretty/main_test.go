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

func TestNodeCLIGoldenOutputShapes(t *testing.T) {
	const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	sessionPayload := map[string]any{
		"id": id, "cmd": "/bin/bash", "args": []string{"-i"}, "cwd": "/tmp/go-cli-golden/work",
		"cols": 300, "rows": 50, "createdAt": float64(1784240220437), "pid": 4242,
		"tool": "terminal", "working": false, "lastDataAt": float64(1784240220600),
		"lastUserMessageAt": nil, "exited": false, "exitCode": nil, "exitSignal": nil, "exitedAt": nil,
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/sessions":
			_ = json.NewEncoder(response).Encode(map[string]any{"sessions": []any{sessionPayload}})
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
	}{
		{"ls", []string{"--host", server.URL, "--json", "ls"}, "testdata/node-ls.json"},
		{"send", []string{"--host", server.URL, "--json", "send", id[:8], "echo", "GOLDEN_SEND"}, "testdata/node-send.json"},
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
