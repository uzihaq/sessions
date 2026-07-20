package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUsageReportAndValidation(t *testing.T) {
	daemon := newTestDaemon(t)
	project := filepath.Join(daemon.root, ".claude", "projects", "sessions")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"timestamp":"2026-07-20T08:00:00Z","sessionId":"usage-session","requestId":"request-1","costUSD":0.25,"message":{"id":"message-1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":20,"cache_creation_input_tokens":10,"cache_read_input_tokens":30}}}` + "\n"
	if err := os.WriteFile(filepath.Join(project, "usage-session.jsonl"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	response := serve(t, daemon.handler, http.MethodGet, "/api/usage?group=daily&mode=auto&since=2026-07-20&until=2026-07-20", nil, "127.0.0.1:1", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"recordedCostUSD":0.25`) || !strings.Contains(response.Body.String(), `"entries":1`) {
		t.Fatalf("usage report: status=%d body=%s", response.Code, response.Body.String())
	}
	invalid := serve(t, daemon.handler, http.MethodGet, "/api/usage?group=tag", nil, "127.0.0.1:1", nil)
	if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), "dimension") {
		t.Fatalf("invalid usage report: status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	badDate := serve(t, daemon.handler, http.MethodGet, "/api/usage?since=yesterday", nil, "127.0.0.1:1", nil)
	if badDate.Code != http.StatusBadRequest {
		t.Fatalf("bad usage date: status=%d body=%s", badDate.Code, badDate.Body.String())
	}
}
