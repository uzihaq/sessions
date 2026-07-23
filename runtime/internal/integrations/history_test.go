package integrations

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/somewhere-tech/sessions/runtime/internal/state"
	"github.com/somewhere-tech/sessions/runtime/internal/watch"
)

func TestHistoryNormalizesCodexRolloutThroughWatchContract(t *testing.T) {
	root := t.TempDir()
	runnerDir := filepath.Join(root, "runners")
	sessionsDir := filepath.Join(root, "codex-sessions")
	cwd := filepath.Join(root, "worktree")
	for _, dir := range []string{runnerDir, sessionsDir, cwd} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Date(2026, time.July, 16, 20, 0, 0, 0, time.UTC)
	id := "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	resumeID := "01234567-89ab-4cde-8fab-0123456789ab"
	metadataPath := filepath.Join(runnerDir, id+".json")
	if err := state.WriteMetadata(metadataPath, state.Metadata{
		ID: id, Name: "codex recall", Cmd: "codex", Args: []string{"resume", resumeID},
		Cwd: cwd, CreatedAt: now.Add(-time.Minute).UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	rolloutPath := filepath.Join(sessionsDir, "2026", "07", "16", "rollout-"+resumeID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(rolloutPath), 0o700); err != nil {
		t.Fatal(err)
	}
	lines := []map[string]any{
		{"timestamp": now.Add(-time.Minute).Format(time.RFC3339Nano), "type": "session_meta", "payload": map[string]any{
			"cwd": cwd, "timestamp": now.Add(-time.Minute).Format(time.RFC3339Nano),
		}},
		{"timestamp": now.Format(time.RFC3339Nano), "type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "Codex fixture question"}},
		}},
		{"timestamp": now.Add(time.Second).Format(time.RFC3339Nano), "type": "response_item", "payload": map[string]any{
			"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "Codex fixture answer"}},
		}},
		{"timestamp": now.Add(2 * time.Second).Format(time.RFC3339Nano), "type": "event_msg", "payload": map[string]any{"type": "task_complete"}},
	}
	file, err := os.OpenFile(rolloutPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(file)
	for _, line := range lines {
		if err := encoder.Encode(line); err != nil {
			file.Close()
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	store := NewHistoryStore(HistoryOptions{
		RunnerStateDir: runnerDir, CodexSessionsDir: sessionsDir, Machine: "fixture-mac",
		Now: func() time.Time { return now },
	})
	history, err := store.List(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Sessions) != 1 || history.Sessions[0].Tool != "codex" ||
		history.Sessions[0].MessageCount != 2 || !history.Sessions[0].ConversationAvailable {
		t.Fatalf("history = %#v", history)
	}
	transcript, err := store.Transcript(nil, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(transcript.Messages) != 2 || transcript.Messages[0].Role != "user" ||
		transcript.Messages[0].Text != "Codex fixture question" ||
		transcript.Messages[1].Role != "assistant" || transcript.Messages[1].Text != "Codex fixture answer" {
		t.Fatalf("messages = %#v", transcript.Messages)
	}
	raw, err := os.ReadFile(rolloutPath)
	if err != nil {
		t.Fatal(err)
	}
	cut := bytes.Index(raw, []byte(`"role":"assistant"`))
	if cut < 1 {
		t.Fatalf("assistant record missing from fixture: %s", raw)
	}
	limited, err := store.TranscriptLimited(nil, id, int64(cut))
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.Messages) != 1 || limited.Messages[0].Text != "Codex fixture question" {
		t.Fatalf("bounded messages = %#v", limited.Messages)
	}
}

func TestTranscriptPreviewReturnsBoundedTail(t *testing.T) {
	root := t.TempDir()
	runnerDir := filepath.Join(root, "runners")
	claudeDir := filepath.Join(root, "claude-projects")
	cwd := filepath.Join(root, "worktree")
	for _, dir := range []string{runnerDir, claudeDir, cwd} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	id := "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
	if err := state.WriteMetadata(filepath.Join(runnerDir, id+".json"), state.Metadata{
		ID: id, Name: "preview", Cmd: "claude", Args: []string{"--session-id", id}, Cwd: cwd,
	}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(claudeDir, watch.EncodeClaudeCWD(cwd), id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for index := range 8 {
		lines = append(lines, fmt.Sprintf(`{"type":"user","message":{"role":"user","content":"message-%d"}}`, index))
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewHistoryStore(HistoryOptions{RunnerStateDir: runnerDir, ClaudeProjectsDir: claudeDir})
	preview, err := store.TranscriptPreview(nil, id, 1<<20, 3)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Truncated || len(preview.Messages) != 3 || preview.Messages[0].Text != "message-5" || preview.Messages[2].Text != "message-7" {
		t.Fatalf("message-bounded preview=%#v", preview)
	}
	preview, err = store.TranscriptPreview(nil, id, int64(len(lines[len(lines)-1])+2), 20)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Truncated || len(preview.Messages) != 1 || preview.Messages[0].Text != "message-7" {
		t.Fatalf("byte-bounded preview=%#v", preview)
	}
}
