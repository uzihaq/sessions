package watch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScanResumableConversationsIncludesCodexAndDeduplicatesRollouts(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".codex", "sessions", "2026", "07", "22")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	id := "11111111-1111-4111-8111-111111111111"
	cwd := filepath.Join(home, "work")
	first := `{"timestamp":"2026-07-22T08:00:00Z","type":"session_meta","payload":{"id":"` + id + `","cwd":"` + cwd + `","originator":"Codex Desktop"}}
{"timestamp":"2026-07-22T08:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Improve the Sessions handoff"}]}}
`
	older := filepath.Join(root, "rollout-old.jsonl")
	newer := filepath.Join(root, "rollout-new.jsonl")
	if err := os.WriteFile(older, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newer, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(older, mustTime(t, "2026-07-22T08:00:00Z"), mustTime(t, "2026-07-22T08:00:00Z")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, mustTime(t, "2026-07-22T09:00:00Z"), mustTime(t, "2026-07-22T09:00:00Z")); err != nil {
		t.Fatal(err)
	}

	conversations := ScanResumableConversations()
	if len(conversations) != 1 {
		t.Fatalf("conversations = %#v", conversations)
	}
	got := conversations[0]
	if got.Tool != "codex" || got.SessionID != id || got.Cwd != cwd || got.Origin != "Codex Desktop" ||
		got.FirstUserMessage != "Improve the Sessions handoff" {
		t.Fatalf("codex conversation = %#v", got)
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
