package usage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

func TestReportIndexesClaudeAndCodexIncrementallyWithTags(t *testing.T) {
	root := t.TempDir()
	claudeRoot := filepath.Join(root, ".claude", "projects")
	codexRoot := filepath.Join(root, ".codex", "sessions")
	runnerRoot := filepath.Join(root, "runners")
	for _, path := range []string{filepath.Join(claudeRoot, "project"), filepath.Join(codexRoot, "2026", "07", "20"), runnerRoot} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	claudePath := filepath.Join(claudeRoot, "project", "claude-session.jsonl")
	claude := `{"timestamp":"2026-07-20T08:00:00Z","sessionId":"claude-session","requestId":"request-1","costUSD":0.12,"message":{"id":"message-1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":20,"cache_creation_input_tokens":10,"cache_read_input_tokens":30}}}
{"timestamp":"2026-07-20T08:00:01Z","sessionId":"claude-session","requestId":"request-1","costUSD":0.15,"message":{"id":"message-1","model":"claude-sonnet-4-6","usage":{"input_tokens":120,"output_tokens":30,"cache_creation_input_tokens":10,"cache_read_input_tokens":40}}}
`
	if err := os.WriteFile(claudePath, []byte(claude), 0o600); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(codexRoot, "2026", "07", "20", "rollout.jsonl")
	codex := `{"timestamp":"2026-07-20T09:00:00Z","type":"session_meta","payload":{"id":"codex-session"}}
{"timestamp":"2026-07-20T09:00:01Z","type":"turn_context","payload":{"model":"gpt-5.2-codex"}}
{"timestamp":"2026-07-20T09:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":250,"output_tokens":125}}}}
`
	if err := os.WriteFile(codexPath, []byte(codex), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := state.WriteMetadata(filepath.Join(runnerRoot, "sessions-id.json"), state.Metadata{
		ID: "sessions-id", Cmd: "claude", Args: []string{"--session-id", "claude-session"}, Cwd: root,
		CreatedAt: 1, SockPath: filepath.Join(runnerRoot, "sessions-id.sock"), ClaudeSessionID: "claude-session",
		Tags: map[string]string{"product": "Sessions", "team": "native"},
	}); err != nil {
		t.Fatal(err)
	}

	service := NewService(Options{Path: filepath.Join(root, "usage.sqlite3"), ClaudeRoots: []string{claudeRoot},
		CodexRoots: []string{codexRoot}, RunnerStateDir: runnerRoot,
		Now: func() time.Time { return time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC) },
	})
	defer service.Close()
	report, err := service.Report(context.Background(), ReportOptions{Group: "daily", Mode: ModeAuto})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Rows) != 1 || report.Totals.Entries != 2 {
		t.Fatalf("daily report = %#v", report)
	}
	if report.Totals.Tokens.Input != 870 || report.Totals.Tokens.CacheRead != 290 || report.Totals.Tokens.Output != 155 {
		t.Fatalf("daily tokens = %#v", report.Totals.Tokens)
	}
	if report.Totals.RecordedCostUSD != .15 || report.Totals.CostUSD <= .15 {
		t.Fatalf("daily costs = recorded %.6f selected %.6f", report.Totals.RecordedCostUSD, report.Totals.CostUSD)
	}
	db, err := service.database(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE usage_sources SET parser_state = '{}'; UPDATE usage_entries SET calculated_cost_usd = 999`); err != nil {
		t.Fatal(err)
	}
	repriced, err := service.Report(context.Background(), ReportOptions{Group: "daily", Mode: ModeCalculate})
	if err != nil {
		t.Fatal(err)
	}
	if repriced.Scan.FilesRead != 2 || repriced.Totals.CalculatedCostUSD >= 1 {
		t.Fatalf("pricing schema reindex = scan %#v totals %#v", repriced.Scan, repriced.Totals)
	}
	tagReport, err := service.Report(context.Background(), ReportOptions{Group: "tag", Dimension: "product", Mode: ModeCalculate})
	if err != nil {
		t.Fatal(err)
	}
	if len(tagReport.Rows) != 2 {
		t.Fatalf("tag report = %#v", tagReport.Rows)
	}
	tagKeys := map[string]bool{}
	for _, row := range tagReport.Rows {
		tagKeys[row.Key] = true
	}
	if !tagKeys["Sessions"] || !tagKeys["(untagged)"] {
		t.Fatalf("tag report = %#v", tagReport.Rows)
	}
	sessionReport, err := service.Report(context.Background(), ReportOptions{Group: "session", Mode: ModeDisplay})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessionReport.Rows) != 2 || sessionReport.Rows[0].SessionID != "sessions-id" || sessionReport.Rows[0].Tags["team"] != "native" {
		t.Fatalf("session report = %#v", sessionReport.Rows)
	}

	file, err := os.OpenFile(codexPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := file.WriteString(`{"timestamp":"2026-07-20T09:05:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":25}}}}` + "\n")
	closeErr := file.Close()
	if writeErr != nil {
		t.Fatal(writeErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	incremental, err := service.Report(context.Background(), ReportOptions{Group: "daily", Mode: ModeCalculate})
	if err != nil {
		t.Fatal(err)
	}
	if incremental.Scan.FilesRead != 1 || incremental.Scan.LinesRead != 1 || incremental.Totals.Entries != 3 {
		t.Fatalf("incremental report scan=%#v total=%#v", incremental.Scan, incremental.Totals)
	}
}

func TestReportRejectsUnknownModeAndMissingTagDimension(t *testing.T) {
	service := NewService(Options{Path: filepath.Join(t.TempDir(), "usage.sqlite3")})
	defer service.Close()
	if _, err := service.Report(context.Background(), ReportOptions{Group: "daily", Mode: "guess"}); err == nil {
		t.Fatal("unknown mode unexpectedly accepted")
	}
	if _, err := service.Report(context.Background(), ReportOptions{Group: "tag", Mode: ModeAuto}); err == nil {
		t.Fatal("tag report without a dimension unexpectedly accepted")
	}
}

func TestSyncRescansSameSizeRewriteAndProfileRoots(t *testing.T) {
	root := t.TempDir()
	runnerRoot := filepath.Join(root, "runners")
	profileRoot := filepath.Join(root, "profiles", "claude", "work")
	projectRoot := filepath.Join(profileRoot, "projects", "project")
	if err := os.MkdirAll(projectRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(runnerRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := state.WriteMetadata(filepath.Join(runnerRoot, "profile-session.json"), state.Metadata{
		ID: "profile-session", Cmd: "claude", Cwd: root, CreatedAt: 1,
		SockPath: filepath.Join(runnerRoot, "profile-session.sock"), ConfigDir: profileRoot,
		ClaudeSessionID: "profile-provider",
	}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(projectRoot, "profile-provider.jsonl")
	first := `{"timestamp":"2026-07-20T08:00:00Z","sessionId":"profile-provider","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":20}}}` + "\n"
	second := strings.Replace(first, `"input_tokens":100`, `"input_tokens":200`, 1)
	if len(first) != len(second) {
		t.Fatal("rewrite fixture must preserve file size")
	}
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	service := NewService(Options{Path: filepath.Join(root, "usage.sqlite3"), RunnerStateDir: runnerRoot})
	defer service.Close()
	report, err := service.Report(context.Background(), ReportOptions{Group: "session", Mode: ModeCalculate})
	if err != nil {
		t.Fatal(err)
	}
	if report.Totals.Tokens.Input != 100 || report.Rows[0].SessionID != "profile-session" {
		t.Fatalf("profile report = %#v", report)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(second), 0o600); err != nil {
		t.Fatal(err)
	}
	changed := info.ModTime().Add(time.Second)
	if err := os.Chtimes(path, changed, changed); err != nil {
		t.Fatal(err)
	}
	report, err = service.Report(context.Background(), ReportOptions{Group: "session", Mode: ModeCalculate})
	if err != nil {
		t.Fatal(err)
	}
	if report.Totals.Tokens.Input != 200 || report.Totals.Entries != 1 {
		t.Fatalf("rewritten report = %#v", report)
	}
}
