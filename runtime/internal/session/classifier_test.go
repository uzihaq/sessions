package session

import (
	"encoding/json"
	"testing"
)

func TestClassifyIdleReasonHeritageSnapshots(t *testing.T) {
	tests := []struct {
		name     string
		snapshot string
		want     IdleOutcome
	}{
		{name: "done screen", snapshot: "Implemented finish notifications.\n12 tests passed, 0 failed.\n❯", want: IdleDone},
		{name: "y/n prompt", snapshot: "The migration changes production data.\nContinue? [y/N]", want: IdleBlocked},
		{name: "numbered picker", snapshot: "Deployment target\n❯ 1) Staging\n  2) Production\n  3) Cancel", want: IdleBlocked},
		{name: "error trace", snapshot: "Traceback (most recent call last):\n  at notify.ts:42\nFatal error: connection failed", want: IdleError},
		{name: "resolved error", snapshot: "Error: first attempt failed\nRetrying with fallback\nAll checks passed", want: IdleDone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ClassifyIdleReason(test.snapshot); got != test.want {
				t.Fatalf("ClassifyIdleReason() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestFinalAssistantSummary(t *testing.T) {
	events := []json.RawMessage{
		json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"## Shipped **lovable notifications**. Added rich hook metadata too."}]}}`),
		json.RawMessage(`{"type":"assistant","message":{"role":"assistant","content":[]}}`),
	}
	if got := FinalAssistantSummary(events); got != "Shipped lovable notifications." {
		t.Fatalf("FinalAssistantSummary() = %q", got)
	}
}

func TestClaudeWorkingFromSnapshot(t *testing.T) {
	tests := []struct {
		name     string
		snapshot string
		want     bool
	}{
		{name: "spinner", snapshot: "✻ Honking… (3m53s · ↓ 15.4k tokens)", want: true},
		{name: "footer", snapshot: "prompt\n(shift+tab to cycle) · esc to interrupt", want: true},
		{name: "prose mention outside footer", snapshot: "esc to interrupt is discussed here\n" + "a\nb\nc\nd\ne\nf\ng", want: false},
		{name: "finished", snapshot: "✻ Cooked for 2m 33s\n· ← for agents", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ClaudeWorkingFromSnapshot(test.snapshot); got != test.want {
				t.Fatalf("ClaudeWorkingFromSnapshot() = %v, want %v", got, test.want)
			}
		})
	}
}
