package interop

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

type interopToolchain struct {
	repoRoot   string
	buildRoot  string
	goDaemon   string
	goRunner   string
	node       string
	nodeDaemon string
	nodeRunner string
}

var tools interopToolchain

func TestMain(m *testing.M) {
	if runtime.GOOS != "darwin" {
		os.Exit(m.Run())
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cutover interop setup: %v\n", err)
		os.Exit(1)
	}
	buildRoot, err := os.MkdirTemp("/tmp", "pretty-cutover-build-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "cutover interop setup: %v\n", err)
		os.Exit(1)
	}

	node, err := exec.LookPath("node")
	if err != nil {
		fmt.Fprintln(os.Stderr, "cutover interop setup: node is required")
		_ = os.RemoveAll(buildRoot)
		os.Exit(1)
	}
	if err := runBuild(repoRoot, envWith(os.Environ(), map[string]string{}), "npm", "--prefix", "prettyd", "run", "build"); err != nil {
		fmt.Fprintf(os.Stderr, "cutover interop setup: %v\n", err)
		_ = os.RemoveAll(buildRoot)
		os.Exit(1)
	}

	goRoot := filepath.Join(repoRoot, "prettygo")
	goEnv := envWith(os.Environ(), map[string]string{"CGO_ENABLED": "0"})
	goDaemon := filepath.Join(buildRoot, "prettyd")
	goRunner := filepath.Join(buildRoot, "runner")
	if err := runBuild(goRoot, goEnv, "go", "build", "-o", goDaemon, "./cmd/prettyd"); err != nil {
		fmt.Fprintf(os.Stderr, "cutover interop setup: %v\n", err)
		_ = os.RemoveAll(buildRoot)
		os.Exit(1)
	}
	if err := runBuild(goRoot, goEnv, "go", "build", "-o", goRunner, "./cmd/runner"); err != nil {
		fmt.Fprintf(os.Stderr, "cutover interop setup: %v\n", err)
		_ = os.RemoveAll(buildRoot)
		os.Exit(1)
	}

	tools = interopToolchain{
		repoRoot:   repoRoot,
		buildRoot:  buildRoot,
		goDaemon:   goDaemon,
		goRunner:   goRunner,
		node:       node,
		nodeDaemon: filepath.Join(repoRoot, "prettyd", "dist", "server.js"),
		nodeRunner: filepath.Join(repoRoot, "prettyd", "dist", "runner.js"),
	}
	code := m.Run()
	_ = os.RemoveAll(buildRoot)
	os.Exit(code)
}

func TestNodeRunnerUnderGoDaemonCutover(t *testing.T) {
	requireDarwin(t)
	scratch := newScratch(t, "node-to-go")
	id := newUUID(t)

	runner := startProcess(t, "node-runner", scratch.root, scratch.env(map[string]string{
		"RUNNER_ID":        id,
		"RUNNER_STATE_DIR": scratch.runnerDir,
		"RUNNER_CMD":       "/bin/bash",
		"RUNNER_ARGS_JSON": `["-i"]`,
		"RUNNER_CWD":       scratch.workDir,
		"RUNNER_COLS":      "120",
		"RUNNER_ROWS":      "40",
	}), tools.node, tools.nodeRunner)
	t.Cleanup(func() { runner.stop(t, false) })
	waitForRunnerState(t, runner, scratch.runnerDir, id)

	port := unusedPort(t)
	daemonEnv := scratch.env(map[string]string{
		"PRETTYD_HOST":       "127.0.0.1",
		"PRETTYD_PORT":       fmt.Sprint(port),
		"PRETTYD_STATE_DIR":  scratch.runnerDir,
		"PRETTYD_RUNNER":     tools.goRunner,
		"PRETTY_LEDGER_PATH": filepath.Join(scratch.root, "ledger", "lanes.sqlite3"),
	})
	daemon := startProcess(t, "go-daemon", scratch.root, daemonEnv, tools.goDaemon)
	t.Cleanup(func() { daemon.stop(t, false) })
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitForSession(t, baseURL, id)
	firstMarker := roundTrip(t, baseURL, id, "NODE_TO_GO")

	daemon.stop(t, true)
	assertRunnerSurvived(t, runner, filepath.Join(scratch.runnerDir, id+".sock"))

	restarted := startProcess(t, "go-daemon-restarted", scratch.root, daemonEnv, tools.goDaemon)
	t.Cleanup(func() { restarted.stop(t, false) })
	waitForSession(t, baseURL, id)
	secondMarker := roundTrip(t, baseURL, id, "NODE_TO_GO_REATTACHED")

	t.Logf("node runner discovered by Go daemon: id=%s first=%s after_restart=%s", id, firstMarker, secondMarker)
}

func TestGoRunnerUnderNodeDaemonRegression(t *testing.T) {
	requireDarwin(t)
	scratch := newScratch(t, "go-to-node")
	id := newUUID(t)

	runner := startProcess(t, "go-runner", scratch.root, scratch.env(map[string]string{
		"RUNNER_ID":        id,
		"RUNNER_STATE_DIR": scratch.runnerDir,
		"RUNNER_CMD":       "/bin/bash",
		"RUNNER_ARGS_JSON": `["-i"]`,
		"RUNNER_CWD":       scratch.workDir,
		"RUNNER_COLS":      "120",
		"RUNNER_ROWS":      "40",
	}), tools.goRunner)
	t.Cleanup(func() { runner.stop(t, false) })
	waitForRunnerState(t, runner, scratch.runnerDir, id)

	port := unusedPort(t)
	daemon := startProcess(t, "node-daemon", scratch.root, scratch.env(map[string]string{
		"PRETTYD_HOST":      "127.0.0.1",
		"PRETTYD_PORT":      fmt.Sprint(port),
		"PRETTYD_STATE_DIR": scratch.runnerDir,
	}), tools.node, tools.nodeDaemon)
	t.Cleanup(func() { daemon.stop(t, false) })
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitForSession(t, baseURL, id)
	marker := roundTrip(t, baseURL, id, "GO_TO_NODE")

	daemon.stop(t, true)
	assertRunnerSurvived(t, runner, filepath.Join(scratch.runnerDir, id+".sock"))
	t.Logf("Go runner discovered by node daemon: id=%s marker=%s", id, marker)
}

type scratchState struct {
	root      string
	home      string
	workDir   string
	runnerDir string
}

func newScratch(t *testing.T, name string) scratchState {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "pc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	state := scratchState{
		root: root, home: filepath.Join(root, "home"), workDir: filepath.Join(root, "work"),
	}
	state.runnerDir = filepath.Join(root, "state", "runners")
	for _, dir := range []string{state.home, state.workDir, state.runnerDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// Keep HTTP authorization out of this protocol test while retaining the
	// exact state-root behavior both daemons use in production.
	openPaths := []string{
		filepath.Join(filepath.Dir(state.runnerDir), "open"),
		filepath.Join(state.home, ".local", "state", "pretty-PTY", "open"),
	}
	for _, path := range openPaths {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("scratch %s state: %s", name, root)
	return state
}

func (s scratchState) env(overrides map[string]string) []string {
	base := map[string]string{
		"HOME":  s.home,
		"USER":  "pretty-cutover-test",
		"LANG":  "en_US.UTF-8",
		"SHELL": "/bin/bash",
	}
	for key, value := range overrides {
		base[key] = value
	}
	return envWith(os.Environ(), base)
}

type managedProcess struct {
	name    string
	command *exec.Cmd
	done    chan struct{}
	logPath string
	waitErr error
	stopMu  sync.Mutex
}

func startProcess(t *testing.T, name, dir string, env []string, argv ...string) *managedProcess {
	t.Helper()
	if len(argv) == 0 {
		t.Fatal("startProcess requires argv")
	}
	logPath := filepath.Join(dir, name+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(argv[0], argv[1:]...)
	command.Dir = dir
	command.Env = env
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		t.Fatalf("start %s: %v", name, err)
	}
	process := &managedProcess{name: name, command: command, done: make(chan struct{}), logPath: logPath}
	go func() {
		process.waitErr = command.Wait()
		_ = logFile.Close()
		close(process.done)
	}()
	return process
}

func (p *managedProcess) stop(t *testing.T, requireClean bool) {
	t.Helper()
	p.stopMu.Lock()
	defer p.stopMu.Unlock()
	select {
	case <-p.done:
	default:
		_ = p.command.Process.Signal(syscall.SIGTERM)
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			_ = p.command.Process.Kill()
			<-p.done
		}
	}
	if requireClean && p.waitErr != nil {
		t.Fatalf("%s did not stop cleanly: %v\n%s", p.name, p.waitErr, readLog(p.logPath))
	}
}

func (p *managedProcess) alive() bool {
	select {
	case <-p.done:
		return false
	default:
		return p.command.Process.Signal(syscall.Signal(0)) == nil
	}
}

func waitForRunnerState(t *testing.T, runner *managedProcess, dir, id string) {
	t.Helper()
	socketPath := filepath.Join(dir, id+".sock")
	metadataPath := filepath.Join(dir, id+".json")
	waitFor(t, 15*time.Second, func() (bool, string) {
		if !runner.alive() {
			t.Fatalf("%s exited before creating state: %v\n%s", runner.name, runner.waitErr, readLog(runner.logPath))
		}
		if info, err := os.Stat(socketPath); err != nil || info.Mode()&os.ModeSocket == 0 {
			return false, fmt.Sprintf("socket not ready: %v", err)
		}
		encoded, err := os.ReadFile(metadataPath)
		if err != nil {
			return false, fmt.Sprintf("metadata not ready: %v", err)
		}
		var metadata struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(encoded, &metadata); err != nil || metadata.ID != id {
			return false, fmt.Sprintf("metadata invalid: id=%q err=%v", metadata.ID, err)
		}
		return true, ""
	})
}

func waitForSession(t *testing.T, baseURL, id string) state.SessionInfo {
	t.Helper()
	var found state.SessionInfo
	waitFor(t, 20*time.Second, func() (bool, string) {
		response, err := httpClient().Get(baseURL + "/api/sessions")
		if err != nil {
			return false, err.Error()
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			return false, err.Error()
		}
		if response.StatusCode != http.StatusOK {
			return false, fmt.Sprintf("status=%d body=%s", response.StatusCode, body)
		}
		var envelope struct {
			Sessions []state.SessionInfo `json:"sessions"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			return false, err.Error()
		}
		for _, session := range envelope.Sessions {
			if session.ID == id && !session.Exited {
				found = session
				return true, ""
			}
		}
		return false, fmt.Sprintf("session %s absent from %s", id, body)
	})
	if found.Cmd != "/bin/bash" || len(found.Args) != 1 || found.Args[0] != "-i" || found.PID <= 0 {
		t.Fatalf("discovered session metadata mismatch: %#v", found)
	}
	return found
}

func roundTrip(t *testing.T, baseURL, id, prefix string) string {
	t.Helper()
	prefix = strings.ToUpper(prefix)
	command := fmt.Sprintf("echo %s_$RANDOM\r", prefix)
	encoded, err := json.Marshal(map[string]string{"data": command})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, baseURL+"/api/sessions/"+id+"/input", strings.NewReader(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := httpClient().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("input status=%d body=%s", response.StatusCode, body)
	}

	pattern := regexp.MustCompile(regexp.QuoteMeta(prefix) + `_[0-9]+`)
	var marker string
	waitFor(t, 15*time.Second, func() (bool, string) {
		snapshot, err := httpClient().Get(baseURL + "/api/sessions/" + id + "/snapshot")
		if err != nil {
			return false, err.Error()
		}
		defer snapshot.Body.Close()
		body, err := io.ReadAll(snapshot.Body)
		if err != nil {
			return false, err.Error()
		}
		if snapshot.StatusCode != http.StatusOK {
			return false, fmt.Sprintf("status=%d body=%s", snapshot.StatusCode, body)
		}
		if match := pattern.Find(body); match != nil {
			marker = string(match)
			return true, ""
		}
		return false, fmt.Sprintf("expanded marker absent from snapshot: %q", body)
	})
	return marker
}

func assertRunnerSurvived(t *testing.T, runner *managedProcess, socketPath string) {
	t.Helper()
	if !runner.alive() {
		t.Fatalf("runner exited with daemon: %v\n%s", runner.waitErr, readLog(runner.logPath))
	}
	if info, err := os.Stat(socketPath); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("runner socket did not survive daemon shutdown: %v", err)
	}
}

func waitFor(t *testing.T, timeout time.Duration, probe func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	last := "condition not ready"
	for time.Now().Before(deadline) {
		if ok, detail := probe(); ok {
			return
		} else if detail != "" {
			last = detail
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timeout after %s: %s", timeout, last)
}

func unusedPort(t *testing.T) int {
	t.Helper()
	for {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()
		if port != state.DefaultPort {
			return port
		}
	}
}

func httpClient() *http.Client {
	return &http.Client{Timeout: 2 * time.Second}
}

func newUUID(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

func runBuild(dir string, env []string, argv ...string) error {
	command := exec.Command(argv[0], argv[1:]...)
	command.Dir = dir
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w\n%s", strings.Join(argv, " "), err, output)
	}
	return nil
}

func envWith(current []string, overrides map[string]string) []string {
	result := make([]string, 0, len(current)+len(overrides))
	for _, entry := range current {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if _, overridden := overrides[key]; !overridden {
			result = append(result, entry)
		}
	}
	for key, value := range overrides {
		result = append(result, key+"="+value)
	}
	return result
}

func findRepoRoot() (string, error) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("resolve test source path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "..", "..", ".."))
	if _, err := os.Stat(filepath.Join(root, "prettyd", "src", "runner.ts")); err != nil {
		return "", fmt.Errorf("resolve repository root %s: %w", root, err)
	}
	return root, nil
}

func readLog(path string) string {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return fmt.Sprintf("read %s: %v", path, err)
	}
	return string(encoded)
}

func requireDarwin(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("the normative node runner uses node-pty and is supported on darwin")
	}
}
