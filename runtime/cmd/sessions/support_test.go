package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSupportPreviewIsLocalRedactedAndExplicit(t *testing.T) {
	const secret = "secret-token-that-must-not-appear"
	const sessionID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/health" {
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{
			"ok": true,
			"version": "v0.2.4",
			"discovering": false,
			"sessionsLoaded": 3,
			"token": "`+secret+`",
			"sessionId": "`+sessionID+`",
			"path": "/Users/private/work"
		}`)
	}))
	defer server.Close()
	home := t.TempDir()
	t.Setenv("HOME", home)

	var stdout, stderr bytes.Buffer
	application, err := newApp(
		[]string{"--json", "--host", server.URL, "support", "--diagnostics"},
		strings.NewReader(""),
		&stdout,
		&stderr,
	)
	if err != nil {
		t.Fatal(err)
	}
	application.now = func() time.Time { return time.Date(2026, 7, 23, 20, 0, 0, 0, time.UTC) }
	if err := application.dispatch(); err != nil {
		t.Fatal(err)
	}
	application.close()

	var preview supportPreview
	if err := json.Unmarshal(stdout.Bytes(), &preview); err != nil {
		t.Fatalf("decode support preview: %v\n%s", err, stdout.String())
	}
	if preview.Uploaded || preview.Diagnostics == nil {
		t.Fatalf("preview = %+v, want local diagnostics and uploaded=false", preview)
	}
	if !preview.Diagnostics.Daemon.Reachable || preview.Diagnostics.Daemon.SessionsLoaded != 3 {
		t.Fatalf("daemon preview = %+v", preview.Diagnostics.Daemon)
	}
	if preview.Diagnostics.GeneratedAt != "2026-07-23T20:00:00Z" {
		t.Fatalf("generated_at = %q", preview.Diagnostics.GeneratedAt)
	}
	encoded := stdout.String()
	for _, forbidden := range []string{secret, sessionID, home, "/Users/private/work", server.URL} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("support preview leaked %q:\n%s", forbidden, encoded)
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestSupportWorksWhenDaemonIsUnavailable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--json", "--host", "127.0.0.1", "--port", "1", "support", "--diagnostics"},
		strings.NewReader(""),
		&stdout,
		&stderr,
	)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var preview supportPreview
	if err := json.Unmarshal(stdout.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if preview.Diagnostics == nil || preview.Diagnostics.Daemon.Reachable {
		t.Fatalf("daemon preview = %+v, want unreachable", preview.Diagnostics)
	}
}

func TestSupportDefaultDoesNotProbeDiagnostics(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		http.Error(response, "should not be called", http.StatusInternalServerError)
	}))
	defer server.Close()
	t.Setenv("HOME", t.TempDir())
	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"--host", server.URL, "support"},
		strings.NewReader(""),
		&stdout,
		&stderr,
	)
	if code != 0 || stderr.Len() != 0 || requests != 0 {
		t.Fatalf("exit=%d requests=%d stdout=%q stderr=%q", code, requests, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), supportTicketURL) ||
		!strings.Contains(stdout.String(), "Nothing is uploaded automatically") {
		t.Fatalf("support output = %q", stdout.String())
	}
}

func TestSupportRejectsUnknownOptions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var stdout, stderr bytes.Buffer
	code := run([]string{"support", "--send"}, strings.NewReader(""), &stdout, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "sessions support [--diagnostics]") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}
