package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	historysearch "github.com/uzihaq/sessions/runtime/internal/search"
	"github.com/uzihaq/sessions/runtime/internal/state"
	"github.com/uzihaq/sessions/runtime/internal/watch"
)

func TestSearchRouteUsesNormalizedKnownSessionHistory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	daemon := newTestDaemon(t)
	daemon.config.UserStateRoot = filepath.Join(daemon.root, "user-state")
	daemon.handler.config.UserStateRoot = daemon.config.UserStateRoot
	if err := os.MkdirAll(daemon.config.RunnerStateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.July, 17, 18, 0, 0, 0, time.UTC)
	claudeID := "aaaaaaaa-1111-4222-8333-444444444444"
	claudeCWD := filepath.Join(daemon.root, "claude-worktree")
	writeSearchMetadata(t, daemon.config.RunnerStateDir, claudeID, "claude fixture", "claude", []string{"--session-id", claudeID}, claudeCWD, now)
	claudePath := filepath.Join(home, ".claude", "projects", watch.EncodeClaudeCWD(claudeCWD), claudeID+".jsonl")
	writeSearchJSONL(t, claudePath, []map[string]any{
		{"type": "user", "timestamp": "2026-07-17T18:00:01Z", "message": map[string]any{"role": "user", "content": "Find the Aurora emails phrase"}},
		{"type": "assistant", "timestamp": "2026-07-17T18:00:02Z", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Claude saw AURORA."}}}},
	})
	if err := os.Chtimes(claudePath, now.Add(time.Minute), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	codexID := "bbbbbbbb-1111-4222-8333-444444444444"
	resumeID := "01234567-89ab-4cde-8fab-0123456789ab"
	codexCWD := filepath.Join(daemon.root, "codex-worktree")
	writeSearchMetadata(t, daemon.config.RunnerStateDir, codexID, "codex fixture", "codex", []string{"resume", resumeID}, codexCWD, now)
	rolloutPath := filepath.Join(home, ".codex", "sessions", "2026", "07", "17", "rollout-"+resumeID+".jsonl")
	writeSearchJSONL(t, rolloutPath, []map[string]any{
		{"type": "session_meta", "timestamp": now.Format(time.RFC3339Nano), "payload": map[string]any{"cwd": codexCWD, "timestamp": now.Format(time.RFC3339Nano)}},
		{"type": "response_item", "timestamp": "2026-07-17T18:01:01Z", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "Codex asks about aurora"}}}},
		{"type": "response_item", "timestamp": "2026-07-17T18:01:02Z", "payload": map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "Codex answer number 73"}}}},
	})
	if err := os.Chtimes(rolloutPath, now.Add(2*time.Minute), now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	response := serve(t, daemon.handler, http.MethodGet, "/api/search?q=Aurora", nil, "127.0.0.1:4321", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("search status=%d body=%s", response.Code, response.Body.String())
	}
	var result historysearch.Response
	decodeBody(t, response, &result)
	claudeMatches, codexMatches, highlighted := 0, 0, false
	for _, match := range result.Matches {
		switch match.SessionID {
		case claudeID:
			claudeMatches++
			highlighted = highlighted || strings.Contains(match.Snippet, "[[AURORA]]")
		case codexID:
			codexMatches++
		}
	}
	if result.Total != 3 || len(result.Matches) != 3 || claudeMatches != 2 || codexMatches != 1 || !highlighted {
		t.Fatalf("result = %#v", result)
	}
	ranked := serve(t, daemon.handler, http.MethodGet, "/api/search?q=email&ranked=1", nil, "127.0.0.1:4321", nil)
	decodeBody(t, ranked, &result)
	if ranked.Code != http.StatusOK || result.Total != 1 || result.Matches[0].Text != "Find the Aurora emails phrase" ||
		!strings.Contains(result.Matches[0].Snippet, "[[emails]]") {
		t.Fatalf("ranked status=%d result=%#v", ranked.Code, result)
	}
	if _, err := os.Stat(filepath.Join(daemon.config.UserStateRoot, "search-index.db")); err != nil {
		t.Fatalf("search index: %v", err)
	}

	parameters := url.Values{
		"q": {`number [0-9]+`}, "regex": {"true"}, "session": {codexID[:8]},
		"role": {"assistant"}, "tool": {"codex"}, "limit": {"1"},
	}
	filtered := serve(t, daemon.handler, http.MethodGet, "/api/search?"+parameters.Encode(), nil, "127.0.0.1:4321", nil)
	decodeBody(t, filtered, &result)
	if filtered.Code != http.StatusOK || result.Total != 1 || result.Matches[0].Text != "Codex answer number 73" ||
		result.Matches[0].Timestamp == nil || *result.Matches[0].Timestamp != "2026-07-17T18:01:02Z" {
		t.Fatalf("filtered status=%d result=%#v", filtered.Code, result)
	}

	for _, target := range []string{
		"/api/search", "/api/search?q=(&regex=true", "/api/search?q=x&role=tool", "/api/search?q=x&limit=0",
		"/api/search?q=x&ranked=maybe", "/api/search?q=x&ranked=true&regex=true",
	} {
		invalid := serve(t, daemon.handler, http.MethodGet, target, nil, "127.0.0.1:4321", nil)
		if invalid.Code != http.StatusBadRequest {
			t.Errorf("%s status=%d body=%s", target, invalid.Code, invalid.Body.String())
		}
	}
	method := serve(t, daemon.handler, http.MethodPost, "/api/search?q=x", nil, "127.0.0.1:4321", nil)
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d body=%s", method.Code, method.Body.String())
	}
}

func writeSearchMetadata(t *testing.T, runnerDir, id, name, command string, args []string, cwd string, created time.Time) {
	t.Helper()
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := state.WriteMetadata(filepath.Join(runnerDir, id+".json"), state.Metadata{
		ID: id, Name: name, Cmd: command, Args: args, Cwd: cwd,
		CreatedAt: created.UnixMilli(), SockPath: filepath.Join(runnerDir, id+".sock"),
	}); err != nil {
		t.Fatal(err)
	}
}

func writeSearchJSONL(t *testing.T, path string, records []map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(file)
	for _, record := range records {
		if err := encoder.Encode(record); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}
