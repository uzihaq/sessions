package integrations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
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
}
