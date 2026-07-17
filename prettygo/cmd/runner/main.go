// Command runner is the long-lived per-session PTY owner used by prettyd.
// Its environment variables, state files, and socket protocol intentionally
// match prettyd/src/runner.ts so either implementation can be swapped alone.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

const idleShutdown = 30 * time.Second

type config struct {
	id       string
	name     string
	kind     string
	specPath string
	stateDir string
	cmd      string
	args     []string
	cwd      string
	cols     int
	rows     int
}

type hello struct {
	ID              string   `json:"id"`
	Cmd             string   `json:"cmd"`
	Args            []string `json:"args"`
	Cwd             string   `json:"cwd"`
	Cols            int      `json:"cols"`
	Rows            int      `json:"rows"`
	CreatedAt       int64    `json:"createdAt"`
	PID             int      `json:"pid"`
	CurrentSeq      uint32   `json:"currentSeq"`
	ProtocolVersion int      `json:"protocolVersion"`
	ConversationID  string   `json:"conversationId,omitempty"`
	RemoteEndpoint  string   `json:"remoteEndpoint,omitempty"`
}

type exitInfo struct {
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
	Seq    uint32  `json:"seq"`
}

type resizeRequest struct {
	Cols float64 `json:"cols"`
	Rows float64 `json:"rows"`
}

type client struct {
	conn net.Conn
	mu   sync.Mutex
}

func (c *client) write(typ proto.Type, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err := proto.Write(c.conn, typ, payload)
	_ = c.conn.SetWriteDeadline(time.Time{})
	return err
}

func (c *client) writeOutput(ev state.Event) error {
	b, err := proto.EncodeOutput(ev.Seq, ev.Data)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err = writeBytes(c.conn, b)
	_ = c.conn.SetWriteDeadline(time.Time{})
	return err
}

type runner struct {
	cfg        config
	paths      state.Paths
	createdAt  int64
	cmd        *exec.Cmd
	ptmx       *os.File
	output     *os.File
	listener   *net.UnixListener
	log        *state.EventLog
	persistent *state.PersistentLog
	logger     *log.Logger

	// streamMu makes REPLAY output atomic relative to live output, matching
	// JavaScript's single event loop. It also guarantees HELLO is first.
	streamMu sync.Mutex
	mu       sync.Mutex
	clients  map[*client]struct{}
	cols     int
	rows     int
	exited   bool
	exit     *exitInfo
	idle     *time.Timer

	shutdownOnce sync.Once
	readDone     chan struct{}
	jsonlMissing bool
}

func main() {
	os.Exit(run())
}

func run() int {
	cfg, malformedArgs, err := configFromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner:", err)
		return 2
	}
	// TypeScript intentionally exits successfully on corrupt args so launchd's
	// SuccessfulExit=false policy does not create a crash loop.
	if malformedArgs != "" {
		fmt.Fprintf(os.Stderr, "runner: failed to parse RUNNER_ARGS_JSON=%q: %s\n", malformedArgs, errText(malformedArgs))
		return 0
	}
	if err := state.EnsureDir(cfg.stateDir); err != nil {
		fmt.Fprintln(os.Stderr, "runner: create state directory:", err)
		return 1
	}
	paths := state.For(cfg.stateDir, cfg.id)
	if anotherRunnerAlive(paths.Socket) {
		fmt.Fprintf(os.Stderr, "runner %s: another instance already owns %s — exiting to avoid a duplicate\n", cfg.id, paths.Socket)
		return 0
	}
	_ = os.Remove(paths.Socket)

	logFile, err := os.OpenFile(paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, "runner: open log:", err)
		return 1
	}
	defer logFile.Close()
	_ = os.Chmod(paths.Log, 0o644)
	logger := log.New(io.MultiWriter(os.Stderr, logFile), "runner: ", log.LstdFlags|log.Lmicroseconds)
	if cfg.kind == state.KindCodexAppServer {
		return runCodexAppServer(cfg, paths, logger)
	}

	spawnArgs, jsonlMissing := respawnArgs(cfg, paths.Events)
	command := exec.Command(cfg.cmd, spawnArgs...)
	command.Dir = cfg.cwd
	command.Env = childEnv()
	var ptmx *os.File
	var output *os.File
	if cfg.kind == state.KindLane {
		var writePipe *os.File
		output, writePipe, err = os.Pipe()
		if err == nil {
			command.Stdin = nil
			command.Stdout = writePipe
			command.Stderr = writePipe
			err = command.Start()
			_ = writePipe.Close()
		}
	} else {
		ptmx, err = pty.StartWithSize(command, &pty.Winsize{Rows: uint16(cfg.rows), Cols: uint16(cfg.cols)})
		output = ptmx
	}
	if err != nil {
		logger.Printf("spawn %q failed: %v", cfg.cmd, err)
		if output != nil {
			_ = output.Close()
		}
		return 1
	}

	persistent, err := state.OpenPersistent(paths.Events)
	if err != nil {
		logger.Printf("open persistent log failed: %v", err)
		_ = command.Process.Signal(syscall.SIGHUP)
		if output != nil {
			_ = output.Close()
		}
		_, _ = command.Process.Wait()
		return 1
	}
	eventLog := state.NewEventLog(state.DefaultEventCap)
	restored, err := state.Restore(paths.Events)
	if err != nil {
		logger.Printf("restore persistent log failed: %v", err)
	}
	for _, ev := range restored {
		eventLog.PushAt(ev.Seq, ev.Data)
	}
	if len(restored) > 0 {
		banner := fmt.Sprintf("\r\n\x1b[2m[pretty-pty: replayed %d events from disk · %s]\x1b[0m\r\n", len(restored), jsISOString(time.Now()))
		eventLog.Push([]byte(banner))
	}
	if jsonlMissing {
		notice := "\r\n\x1b[33m[pretty-pty: backing Claude JSONL not found — attempted --resume may fail; events history is preserved]\x1b[0m\r\n"
		eventLog.Push([]byte(notice))
	}

	r := &runner{
		cfg:          cfg,
		paths:        paths,
		createdAt:    time.Now().UnixMilli(),
		cmd:          command,
		ptmx:         ptmx,
		output:       output,
		log:          eventLog,
		persistent:   persistent,
		logger:       logger,
		clients:      make(map[*client]struct{}),
		cols:         cfg.cols,
		rows:         cfg.rows,
		readDone:     make(chan struct{}),
		jsonlMissing: jsonlMissing,
	}
	meta := state.Metadata{
		ID: cfg.id, Name: cfg.name, Kind: cfg.kind, SpecPath: cfg.specPath,
		Cmd: cfg.cmd, Args: cfg.args, Cwd: cfg.cwd,
		Cols: cfg.cols, Rows: cfg.rows, CreatedAt: r.createdAt,
		PID: command.Process.Pid, SockPath: paths.Socket,
	}
	if err := state.WriteMetadata(paths.Meta, meta); err != nil {
		logger.Printf("write metadata failed: %v", err)
		r.shutdown(false, 1)
	}

	addr := &net.UnixAddr{Name: paths.Socket, Net: "unix"}
	listener, err := net.ListenUnix("unix", addr)
	if err != nil {
		logger.Printf("socket listen failed: %v", err)
		r.shutdown(false, 1)
	}
	r.listener = listener
	if err := os.Chmod(paths.Socket, 0o600); err != nil {
		logger.Printf("socket chmod failed: %v", err)
	}

	go r.readOutput()
	go r.waitChild()
	go r.acceptLoop()

	// runner.ts ignores SIGINT/SIGHUP because daemon/editor restarts must not
	// tear down sessions. SIGTERM is the launchd/reboot preservation path.
	signal.Ignore(os.Interrupt, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM)
	go func() {
		<-term
		r.mu.Lock()
		permanent := r.exited && !r.jsonlMissing
		r.mu.Unlock()
		r.shutdown(permanent, 0)
	}()

	select {}
}

func configFromEnv() (config, string, error) {
	id := os.Getenv("RUNNER_ID")
	if id == "" {
		return config{}, "", errors.New("RUNNER_ID env var required")
	}
	name := strings.TrimSpace(os.Getenv("RUNNER_NAME"))
	kind := strings.TrimSpace(os.Getenv("RUNNER_KIND"))
	if kind != "" && kind != state.KindLane && kind != state.KindCodexAppServer {
		return config{}, "", fmt.Errorf("unsupported RUNNER_KIND=%q", kind)
	}
	specPath := strings.TrimSpace(os.Getenv("RUNNER_SPEC_PATH"))
	stateDir := os.Getenv("RUNNER_STATE_DIR")
	if stateDir == "" {
		var err error
		stateDir, err = state.DefaultRunnerDir()
		if err != nil {
			return config{}, "", err
		}
	}
	cmd := os.Getenv("RUNNER_CMD")
	if cmd == "" {
		cmd = "/bin/bash"
	}
	rawArgs, present := os.LookupEnv("RUNNER_ARGS_JSON")
	args := []string{}
	if present && rawArgs != "" {
		if err := json.Unmarshal([]byte(rawArgs), &args); err != nil {
			return config{}, rawArgs, nil
		}
	}
	cwd := os.Getenv("RUNNER_CWD")
	if cwd == "" {
		var err error
		cwd, err = os.UserHomeDir()
		if err != nil {
			return config{}, "", err
		}
	}
	cols, err := envInt("RUNNER_COLS", 300)
	if err != nil {
		return config{}, "", err
	}
	rows, err := envInt("RUNNER_ROWS", 50)
	if err != nil {
		return config{}, "", err
	}
	if cols <= 0 || cols > 65535 || rows <= 0 || rows > 65535 {
		return config{}, "", fmt.Errorf("invalid PTY size %dx%d", cols, rows)
	}
	return config{id: id, name: name, kind: kind, specPath: specPath, stateDir: stateDir, cmd: cmd, args: args, cwd: cwd, cols: cols, rows: rows}, "", nil
}

func envInt(name string, fallback int) (int, error) {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: %w", name, raw, err)
	}
	return n, nil
}

func errText(raw string) string {
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return err.Error()
	}
	return "expected a JSON string array"
}

func childEnv() []string {
	control := map[string]struct{}{
		"RUNNER_ID": {}, "RUNNER_CMD": {}, "RUNNER_ARGS_JSON": {},
		"RUNNER_CWD": {}, "RUNNER_COLS": {}, "RUNNER_ROWS": {},
		"RUNNER_STATE_DIR": {}, "RUNNER_NAME": {}, "RUNNER_KIND": {},
		"RUNNER_SPEC_PATH": {}, "TERM": {}, "COLORTERM": {},
		"PRETTY_CODEX_APP_SERVER_SOCKET": {},
	}
	out := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if _, drop := control[key]; !drop {
			out = append(out, entry)
		}
	}
	return append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
}

func anotherRunnerAlive(socketPath string) bool {
	if _, err := os.Stat(socketPath); err != nil {
		return false
	}
	conn, err := net.DialTimeout("unix", socketPath, time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func respawnArgs(cfg config, eventsPath string) ([]string, bool) {
	st, err := os.Stat(eventsPath)
	if err != nil || st.Size() <= 0 {
		return cfg.args, false
	}
	idx := -1
	for i, arg := range cfg.args {
		if arg == "--session-id" {
			idx = i
			break
		}
	}
	if idx < 0 {
		return cfg.args, false
	}
	args := append([]string(nil), cfg.args...)
	args[idx] = "--resume"
	if idx+1 >= len(args) || args[idx+1] == "" {
		return args, false
	}
	return args, !claudeJSONLExists(args[idx+1])
}

func claudeJSONLExists(id string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	projects := filepath.Join(home, ".claude", "projects")
	entries, err := os.ReadDir(projects)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if _, err := os.Stat(filepath.Join(projects, entry.Name(), id+".jsonl")); err == nil {
			return true
		}
	}
	return false
}

func (r *runner) acceptLoop() {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				r.logger.Printf("socket accept failed: %v", err)
			}
			return
		}
		go r.serveClient(conn)
	}
}

func (r *runner) serveClient(conn net.Conn) {
	c := &client{conn: conn}
	// Prevent live OUTPUT from racing ahead of the greeting.
	r.streamMu.Lock()
	r.mu.Lock()
	r.clients[c] = struct{}{}
	h := r.helloLocked()
	exit := r.exit
	r.mu.Unlock()
	hPayload, err := json.Marshal(h)
	if err == nil {
		err = c.write(proto.Hello, hPayload)
	}
	if err == nil && exit != nil {
		var payload []byte
		payload, err = json.Marshal(exit)
		if err == nil {
			err = c.write(proto.Exit, payload)
		}
	}
	r.streamMu.Unlock()
	if err != nil {
		_ = conn.Close()
	}

	defer func() {
		_ = conn.Close()
		r.removeClient(c)
	}()
	for {
		frame, err := proto.Read(conn)
		if err != nil {
			return
		}
		if err := r.handleFrame(c, frame); err != nil {
			return
		}
	}
}

func (r *runner) helloLocked() hello {
	return hello{
		ID: r.cfg.id, Cmd: r.cfg.cmd, Args: r.cfg.args, Cwd: r.cfg.cwd,
		Cols: r.cols, Rows: r.rows, CreatedAt: r.createdAt,
		PID: r.cmd.Process.Pid, CurrentSeq: r.log.CurrentSeq(),
		ProtocolVersion: proto.ProtocolVersion,
	}
}

func (r *runner) handleFrame(c *client, frame proto.Frame) error {
	switch frame.Type {
	case proto.Input:
		r.mu.Lock()
		exited := r.exited
		r.mu.Unlock()
		if !exited && r.ptmx != nil {
			_, _ = r.ptmx.Write(frame.Payload)
		}
	case proto.Resize:
		var request resizeRequest
		if err := json.Unmarshal(frame.Payload, &request); err != nil {
			return nil
		}
		cols, rows := int(request.Cols), int(request.Rows)
		if request.Cols != float64(cols) || request.Rows != float64(rows) || cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
			return nil
		}
		r.mu.Lock()
		exited := r.exited
		if !exited && r.ptmx != nil {
			r.cols, r.rows = cols, rows
		}
		r.mu.Unlock()
		if !exited && r.ptmx != nil {
			_ = pty.Setsize(r.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
		}
	case proto.SnapshotReq:
		r.streamMu.Lock()
		defer r.streamMu.Unlock()
		snap := r.snapshotLocked()
		if len(snap)+1 > proto.MaxFrameLen {
			snap = snap[len(snap)-(proto.MaxFrameLen-1):]
		}
		return c.write(proto.SnapshotRes, snap)
	case proto.ReplayReq:
		if len(frame.Payload) < 4 {
			return nil
		}
		after := binary.BigEndian.Uint32(frame.Payload[:4])
		r.streamMu.Lock()
		defer r.streamMu.Unlock()
		replay := r.log.Since(after)
		for _, ev := range replay.Events {
			if err := c.writeOutput(ev); err != nil {
				return err
			}
		}
		return c.write(proto.ReplayDone, nil)
	case proto.Kill:
		r.mu.Lock()
		exited := r.exited
		r.mu.Unlock()
		if !exited {
			if err := r.cmd.Process.Signal(syscall.SIGHUP); err != nil {
				_ = r.cmd.Process.Kill()
			}
		}
	}
	return nil
}

func (r *runner) readOutput() {
	defer close(r.readDone)
	buf := make([]byte, 32*1024)
	for {
		n, err := r.output.Read(buf)
		if n > 0 {
			r.recordOutput(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

func (r *runner) recordOutput(data []byte) {
	r.streamMu.Lock()
	defer r.streamMu.Unlock()
	ev := r.log.Push(data)
	if err := r.persistent.Append(ev.Seq, ev.Data); err != nil {
		r.logger.Printf("persistent.append failed: %v", err)
	}
	frame, err := proto.EncodeOutput(ev.Seq, ev.Data)
	if err != nil {
		r.logger.Printf("encode OUTPUT failed: %v", err)
		return
	}
	r.broadcastBytes(frame)
}

func (r *runner) waitChild() {
	err := r.cmd.Wait()
	select {
	case <-r.readDone:
	case <-time.After(250 * time.Millisecond):
		_ = r.output.Close()
		<-r.readDone
	}
	info := processExitInfo(r.cmd.ProcessState, err, r.cfg.kind == state.KindLane)
	if r.cfg.kind == state.KindLane {
		manifest := r.completionManifest(info)
		if writeErr := state.WriteCompletionManifest(r.paths.Manifest, manifest); writeErr != nil {
			r.logger.Printf("write completion manifest failed: %v", writeErr)
		}
	}
	r.streamMu.Lock()
	info.Seq = r.log.CurrentSeq()
	r.mu.Lock()
	r.exited = true
	if !r.jsonlMissing {
		r.exit = &info
	} else {
		// The EXIT frame is still sent; only persistence cleanup differs.
		r.exit = &info
	}
	noClients := len(r.clients) == 0
	r.mu.Unlock()
	payload, marshalErr := json.Marshal(info)
	if marshalErr == nil {
		frame := proto.MustEncode(proto.Exit, payload)
		r.broadcastBytes(frame)
	}
	r.streamMu.Unlock()
	if noClients {
		r.scheduleIdleShutdown()
	}
}

func processExitInfo(processState *os.ProcessState, waitErr error, headless bool) exitInfo {
	if processState != nil {
		if status, ok := processState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			signalText := strconv.Itoa(int(status.Signal()))
			// node-pty reports exitCode=0 alongside the numeric signal for a
			// signal-terminated PTY. Keep that slightly unusual pairing for
			// byte-level interop with runner.ts.
			code := 0
			if headless {
				code = 128 + int(status.Signal())
			}
			return exitInfo{Code: &code, Signal: &signalText}
		}
		code := processState.ExitCode()
		return exitInfo{Code: &code, Signal: nil}
	}
	if waitErr != nil {
		signalText := waitErr.Error()
		return exitInfo{Code: nil, Signal: &signalText}
	}
	code := 0
	return exitInfo{Code: &code, Signal: nil}
}

func (r *runner) completionManifest(info exitInfo) state.CompletionManifest {
	code := 0
	if info.Code != nil {
		code = *info.Code
	}
	tail := r.snapshotLocked()
	const maximumTail = 4 * 1024
	if len(tail) > maximumTail {
		tail = tail[len(tail)-maximumTail:]
	}
	duration := time.Since(time.UnixMilli(r.createdAt)).Milliseconds()
	if duration < 0 {
		duration = 0
	}
	return state.CompletionManifest{
		ExitCode: code, Signal: info.Signal, DurationMS: duration,
		LastOutputTail: string(tail), SpecPath: r.cfg.specPath,
		FilesChanged: gitFilesChanged(r.cfg.cwd),
	}
}

func gitFilesChanged(cwd string) *int {
	check := exec.Command("git", "-C", cwd, "rev-parse", "--is-inside-work-tree")
	if output, err := check.Output(); err != nil || strings.TrimSpace(string(output)) != "true" {
		return nil
	}
	status := exec.Command("git", "-C", cwd, "status", "--porcelain=v1", "--untracked-files=all")
	output, err := status.Output()
	if err != nil {
		return nil
	}
	count := 0
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if len(line) > 0 {
			count++
		}
	}
	return &count
}

func (r *runner) snapshotLocked() []byte {
	replay := r.log.Since(0)
	var out bytes.Buffer
	for _, ev := range replay.Events {
		_, _ = out.Write(ev.Data)
	}
	return out.Bytes()
}

func (r *runner) broadcastBytes(frame []byte) {
	r.mu.Lock()
	clients := make([]*client, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.mu.Unlock()
	for _, c := range clients {
		c.mu.Lock()
		_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		err := writeBytes(c.conn, frame)
		_ = c.conn.SetWriteDeadline(time.Time{})
		c.mu.Unlock()
		if err != nil {
			_ = c.conn.Close()
		}
	}
}

func (r *runner) removeClient(c *client) {
	r.mu.Lock()
	delete(r.clients, c)
	shouldSchedule := r.exited && len(r.clients) == 0
	r.mu.Unlock()
	if shouldSchedule {
		r.scheduleIdleShutdown()
	}
}

func (r *runner) scheduleIdleShutdown() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.exited || len(r.clients) > 0 || r.idle != nil {
		return
	}
	r.idle = time.AfterFunc(idleShutdown, func() {
		r.shutdown(!r.jsonlMissing, 0)
	})
}

func (r *runner) shutdown(permanent bool, code int) {
	r.shutdownOnce.Do(func() {
		r.streamMu.Lock()
		if r.listener != nil {
			_ = r.listener.Close()
		}
		_ = os.Remove(r.paths.Socket)
		_ = os.Remove(r.paths.Meta)
		if permanent {
			_ = r.persistent.Unlink()
		} else {
			_ = r.persistent.Close()
		}
		if r.cmd.Process != nil {
			_ = r.cmd.Process.Signal(syscall.SIGHUP)
		}
		if r.output != nil {
			_ = r.output.Close()
		}
		r.streamMu.Unlock()
		os.Exit(code)
	})
}

func writeBytes(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}

func jsISOString(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
