package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	backupstore "github.com/uzihaq/pretty-pty/prettygo/internal/backup"
)

func TestBackupEnableStatusAndNow(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	tokenPath := backupstore.SomewhereConfigPath(home)
	if err := os.MkdirAll(filepath.Dir(tokenPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte(`{"auth":{"token":"smt_cli-fixture"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/backup/reload":
			_, _ = response.Write([]byte(`{"ok":true}`))
		case "/api/backup/now":
			_, _ = response.Write([]byte(`{"pushed_at":"2026-07-16T12:00:00Z","uploaded":2,"skipped":3,"session_count":5,"manifest_path":"pretty-sessions/test/manifest.json"}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := run([]string{"--host", server.URL, "backup", "enable", "--project", "cli-project", "--interval", "7m"}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 || stderr.Len() != 0 || !strings.Contains(stdout.String(), "cli-project") {
		t.Fatalf("enable code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	configPath := backupstore.ConfigPath(home)
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %o", info.Mode().Perm())
	}
	encoded, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("smt_cli-fixture")) {
		t.Fatal("backup config contains token")
	}

	stdout.Reset()
	stderr.Reset()
	code = run([]string{"backup", "status", "--json"}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("status code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var status backupstore.Status
	if err := json.Unmarshal(stdout.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.Enabled || status.Project != "cli-project" || status.Interval != "7m0s" {
		t.Fatalf("status = %#v", status)
	}

	stdout.Reset()
	stderr.Reset()
	code = run([]string{"--host", server.URL, "backup", "now"}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 || stderr.Len() != 0 || !strings.Contains(stdout.String(), "2 uploaded, 3 unchanged, 5 sessions") {
		t.Fatalf("now code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}
