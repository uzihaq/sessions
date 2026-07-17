package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRunPostsHeadlessLaneRequest(t *testing.T) {
	root := t.TempDir()
	spec := filepath.Join(root, "spec.md")
	if err := os.WriteFile(spec, []byte("lane\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var posted runLaneRequest
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/lanes" || request.Method != http.MethodPost {
			http.NotFound(response, request)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&posted); err != nil {
			t.Error(err)
		}
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(`{"id":"00000000-0000-4000-8000-000000000001"}`))
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--host", server.URL, "run", "--name", "test lane", "--cwd", root, "--spec", spec,
		"--", "/bin/sh", "-c", "printf marker",
	}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("run exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if posted.Kind != "lane" || posted.Name != "test lane" || posted.Cwd != root || posted.SpecPath != spec ||
		posted.Cmd != "/bin/sh" || len(posted.Args) != 2 || posted.Args[1] != "printf marker" {
		t.Fatalf("posted lane = %#v", posted)
	}
}

func TestLaneWaitAnyUsesSharedCompositionAndWinningExitCode(t *testing.T) {
	const first = "00000000-0000-4000-8000-000000000001"
	const second = "00000000-0000-4000-8000-000000000002"
	started := time.Now()
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/lanes":
			_, _ = response.Write([]byte(`{"lanes":[{"id":"` + first + `","kind":"lane","tool":"lane:sh"},{"id":"` + second + `","kind":"lane","tool":"lane:sh"}]}`))
		case "/api/lanes/" + first + "/manifest":
			mu.Lock()
			ready := time.Since(started) >= 500*time.Millisecond
			mu.Unlock()
			if !ready {
				response.WriteHeader(http.StatusConflict)
				_, _ = response.Write([]byte(`{"error":"running"}`))
				return
			}
			_, _ = response.Write([]byte(`{"exit_code":4,"duration_ms":500,"last_output_tail":"first\n","spec_path":""}`))
		case "/api/lanes/" + second + "/manifest":
			mu.Lock()
			ready := time.Since(started) >= 100*time.Millisecond
			mu.Unlock()
			if !ready {
				response.WriteHeader(http.StatusConflict)
				_, _ = response.Write([]byte(`{"error":"running"}`))
				return
			}
			_, _ = response.Write([]byte(`{"exit_code":6,"duration_ms":100,"last_output_tail":"second\n","spec_path":""}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--host", server.URL, "wait", first, second, "--any", "--timeout", "2s", "--json",
	}, strings.NewReader(""), &stdout, &stderr)
	if code != 6 || stderr.Len() != 0 {
		t.Fatalf("wait --any exit=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	var output struct {
		ID       string `json:"id"`
		ExitCode int    `json:"exit_code"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if output.ID != second || output.ExitCode != 6 {
		t.Fatalf("wait --any output = %#v", output)
	}
}
