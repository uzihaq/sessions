package search

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/uzihaq/pretty-pty/prettygo/internal/integrations"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

type fakeHistory struct {
	sessions   []integrations.HistorySession
	transcript map[string]integrations.TranscriptResponse
	limits     []int64
}

func (f *fakeHistory) SearchSessions([]state.SessionInfo) ([]integrations.HistorySession, error) {
	return append([]integrations.HistorySession(nil), f.sessions...), nil
}

func (f *fakeHistory) TranscriptLimited(_ []state.SessionInfo, id string, limit int64) (integrations.TranscriptResponse, error) {
	f.limits = append(f.limits, limit)
	transcript, ok := f.transcript[id]
	if !ok {
		return integrations.TranscriptResponse{}, integrations.ErrHistoryNotFound
	}
	return transcript, nil
}

func searchFixture() *fakeHistory {
	firstTimestamp := "2026-07-17T10:00:00Z"
	secondTimestamp := "2026-07-17T11:00:00Z"
	first := integrations.HistorySession{
		ID: "aaaaaaaa-1111-4222-8333-444444444444", Name: "alpha", Tool: "claude",
		ConversationAvailable: true,
	}
	second := integrations.HistorySession{
		ID: "bbbbbbbb-1111-4222-8333-444444444444", Name: "beta", Tool: "codex",
		ConversationAvailable: true,
	}
	return &fakeHistory{
		sessions: []integrations.HistorySession{first, second},
		transcript: map[string]integrations.TranscriptResponse{
			first.ID: {Messages: []integrations.TranscriptMessage{
				{Role: "user", Timestamp: &firstTimestamp, Text: strings.Repeat("a", 150) + " Daily NEEDLE target " + strings.Repeat("z", 150)},
				{Role: "assistant", Text: "The migration plan mentions Needle again."},
			}},
			second.ID: {Messages: []integrations.TranscriptMessage{
				{Role: "user", Text: "A codex needle question"},
				{Role: "assistant", Timestamp: &secondTimestamp, Text: "The worker failed with error code 42."},
			}},
		},
	}
}

func TestSearchSubstringFiltersAndCenteredSnippet(t *testing.T) {
	fixture := searchFixture()
	result, err := Run(context.Background(), fixture, nil, Options{Query: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 3 || len(result.Matches) != 3 {
		t.Fatalf("result = %#v", result)
	}
	first := result.Matches[0]
	if first.SessionID != fixture.sessions[0].ID || first.Name != "alpha" || first.Tool != "claude" ||
		first.Role != "user" || first.Timestamp == nil || !strings.Contains(first.Snippet, "[[NEEDLE]]") ||
		!strings.HasPrefix(first.Snippet, "…") || !strings.HasSuffix(first.Snippet, "…") {
		t.Fatalf("first match = %#v", first)
	}
	before, after, ok := strings.Cut(first.Snippet, "[[NEEDLE]]")
	if !ok || len([]rune(before)) < 80 || len([]rune(after)) < 80 || len([]rune(first.Snippet)) > MaxSnippetRunes+6 {
		t.Fatalf("snippet was not centered and capped: %q", first.Snippet)
	}
	for _, limit := range fixture.limits {
		if limit != MaxFileReadBytes {
			t.Fatalf("transcript limit = %d, want %d", limit, MaxFileReadBytes)
		}
	}

	tests := []struct {
		name     string
		options  Options
		wantID   string
		wantRole string
	}{
		{name: "session prefix", options: Options{Query: "needle", SessionID: "bbbbbbbb"}, wantID: fixture.sessions[1].ID, wantRole: "user"},
		{name: "role", options: Options{Query: "needle", Role: "assistant"}, wantID: fixture.sessions[0].ID, wantRole: "assistant"},
		{name: "tool", options: Options{Query: "needle", Tool: "codex"}, wantID: fixture.sessions[1].ID, wantRole: "user"},
		{name: "regex", options: Options{Query: `error code [0-9]+`, Regex: true}, wantID: fixture.sessions[1].ID, wantRole: "assistant"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := Run(context.Background(), searchFixture(), nil, test.options)
			if err != nil {
				t.Fatal(err)
			}
			if result.Total != 1 || result.Matches[0].SessionID != test.wantID || result.Matches[0].Role != test.wantRole {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestSearchLimitValidationAndEmptyShape(t *testing.T) {
	result, err := Run(context.Background(), searchFixture(), nil, Options{Query: "needle", Limit: 2})
	if err != nil || result.Total != 2 || len(result.Matches) != 2 {
		t.Fatalf("limited result=%#v err=%v", result, err)
	}
	result, err = Run(context.Background(), searchFixture(), nil, Options{Query: "absent"})
	if err != nil || result.Total != 0 || result.Matches == nil {
		t.Fatalf("empty result=%#v err=%v", result, err)
	}
	for _, options := range []Options{
		{}, {Query: "(", Regex: true}, {Query: "x", Role: "tool"},
		{Query: "x", Tool: "terminal"}, {Query: "x", Limit: MaxLimit + 1},
		{Query: "x", SessionID: "missing"},
	} {
		if _, err := Run(context.Background(), searchFixture(), nil, options); err == nil || !IsOptionError(err) {
			t.Errorf("options %#v error = %v, want option error", options, err)
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Run(canceled, searchFixture(), nil, Options{Query: "needle"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error = %v", err)
	}
}
