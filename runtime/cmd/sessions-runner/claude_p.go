package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/somewhere-tech/sessions/runtime/internal/claudep"
	"github.com/somewhere-tech/sessions/runtime/internal/proto"
	"github.com/somewhere-tech/sessions/runtime/internal/state"
)

// claudeStructuredRunner is the durable socket/history owner for a structured
// Claude conversation. Each user turn is a separate claude -p process; the
// persisted Claude UUID is the continuity and restart boundary.
type claudeStructuredRunner struct {
	cfg       config
	paths     state.Paths
	createdAt int64
	client    *claudep.Client
	logger    *log.Logger

	sessionID   string
	initialized bool
	listener    *net.UnixListener
	historyFile *os.File

	ctx    context.Context
	cancel context.CancelFunc
	done   chan int

	streamMu sync.Mutex
	mu       sync.Mutex
	clients  map[*client]struct{}
	history  []json.RawMessage
	composer strings.Builder
	active   bool
	pending  []string

	shutdownOnce sync.Once
}

func runClaudeStructured(cfg config, paths state.Paths, logger *log.Logger) int {
	ctx, cancel := context.WithCancel(context.Background())
	host := &claudeStructuredRunner{
		cfg: cfg, paths: paths, logger: logger, ctx: ctx, cancel: cancel,
		done: make(chan int, 1), clients: make(map[*client]struct{}),
	}
	if err := host.start(); err != nil {
		logger.Printf("structured Claude host failed: %v", err)
		cancel()
		return 1
	}
	signal.Ignore(os.Interrupt, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM)
	defer signal.Stop(term)
	go func() {
		select {
		case <-term:
			host.shutdown(false, 1)
		case <-ctx.Done():
		}
	}()
	return <-host.done
}

func (r *claudeStructuredRunner) start() error {
	metadata, _ := state.ReadRunnerMetadata(r.paths.Meta)
	r.createdAt = metadata.Info.CreatedAt
	if r.createdAt == 0 {
		r.createdAt = time.Now().UnixMilli()
	}
	r.sessionID = metadata.Info.ClaudeSessionID
	if r.sessionID == "" {
		r.sessionID = codexArgValue(r.cfg.args, "--session-id", "--resume", "-r")
	}
	if r.sessionID == "" {
		var err error
		r.sessionID, err = claudep.NewSessionID()
		if err != nil {
			return fmt.Errorf("generate Claude session id: %w", err)
		}
	}
	created, err := claudep.NewClient(claudep.Options{ClaudePath: r.cfg.cmd})
	if err != nil {
		return err
	}
	r.client = created
	if err := r.openHistory(); err != nil {
		return err
	}
	if codexArgValue(r.cfg.args, "--resume", "-r") != "" {
		r.initialized = true
	}
	if r.historyWorking() {
		recovery, _ := claudep.FailureHistoryEvent(r.sessionID, errors.New("structured runner restarted during an unfinished Claude turn"), time.Now())
		r.appendStructured(recovery)
	}
	if err := r.writeMetadata(); err != nil {
		r.closeHistory()
		return err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: r.paths.Socket, Net: "unix"})
	if err != nil {
		r.closeHistory()
		return err
	}
	r.listener = listener
	if err := os.Chmod(r.paths.Socket, 0o600); err != nil {
		r.shutdown(false, 1)
		return err
	}
	go r.acceptLoop()
	return nil
}

func (r *claudeStructuredRunner) historyWorking() bool {
	working := false
	for _, raw := range r.history {
		if claudep.HistoryInitialized(raw) {
			r.initialized = true
		}
		if value, ok := claudep.HistoryLifecycle(raw); ok {
			working = value
		}
	}
	return working
}

func (r *claudeStructuredRunner) writeMetadata() error {
	return state.WriteMetadata(r.paths.Meta, state.Metadata{
		ID: r.cfg.id, Name: r.cfg.name, Description: r.cfg.description,
		DescriptionSource: r.cfg.descriptionSource, Kind: r.cfg.kind, SpecPath: r.cfg.specPath,
		Profile: r.cfg.profile, ConfigDir: r.cfg.configDir,
		Cmd: r.cfg.cmd, Args: r.cfg.args, Cwd: r.cfg.cwd,
		Cols: r.cfg.cols, Rows: r.cfg.rows, CreatedAt: r.createdAt,
		PID: os.Getpid(), SockPath: r.paths.Socket, ClaudeSessionID: r.sessionID,
	})
}

func (r *claudeStructuredRunner) openHistory() error {
	file, err := os.OpenFile(r.paths.ClaudeP, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if err := os.Chmod(r.paths.ClaudeP, 0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return err
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), structuredScannerBuffer)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) > 0 && json.Valid(line) {
			r.history = append(r.history, append(json.RawMessage(nil), line...))
		}
	}
	if err := scanner.Err(); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Seek(0, io.SeekEnd); err != nil {
		_ = file.Close()
		return err
	}
	r.historyFile = file
	return nil
}

func (r *claudeStructuredRunner) closeHistory() {
	if r.historyFile != nil {
		_ = r.historyFile.Close()
	}
}

func (r *claudeStructuredRunner) acceptLoop() {
	for {
		connection, err := r.listener.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				r.logger.Printf("structured Claude socket accept failed: %v", err)
			}
			return
		}
		go r.serveClient(connection)
	}
}

func (r *claudeStructuredRunner) serveClient(connection net.Conn) {
	c := &client{conn: connection}
	r.streamMu.Lock()
	r.mu.Lock()
	r.clients[c] = struct{}{}
	h := hello{
		ID: r.cfg.id, Cmd: r.cfg.cmd, Args: r.cfg.args, Cwd: r.cfg.cwd,
		Cols: r.cfg.cols, Rows: r.cfg.rows, CreatedAt: r.createdAt,
		PID: os.Getpid(), ProtocolVersion: proto.ProtocolVersion, RuntimeVersion: version,
		ClaudeSessionID: r.sessionID,
	}
	r.mu.Unlock()
	payload, err := json.Marshal(h)
	if err == nil {
		err = c.write(proto.Hello, payload)
	}
	r.streamMu.Unlock()
	if err != nil {
		_ = connection.Close()
	}
	defer func() {
		_ = connection.Close()
		r.mu.Lock()
		delete(r.clients, c)
		r.mu.Unlock()
	}()
	for {
		frame, err := proto.Read(connection)
		if err != nil {
			return
		}
		if err := r.handleFrame(c, frame); err != nil {
			return
		}
	}
}

func (r *claudeStructuredRunner) handleFrame(c *client, frame proto.Frame) error {
	switch frame.Type {
	case proto.Input:
		r.handleInput(string(frame.Payload))
	case proto.Resize:
		return nil
	case proto.SnapshotReq:
		r.streamMu.Lock()
		snapshot := []byte(r.snapshot())
		if len(snapshot)+1 > proto.MaxFrameLen {
			snapshot = snapshot[len(snapshot)-(proto.MaxFrameLen-1):]
		}
		err := c.write(proto.SnapshotRes, snapshot)
		r.streamMu.Unlock()
		return err
	case proto.ReplayReq:
		r.streamMu.Lock()
		r.mu.Lock()
		history := cloneStructured(r.history)
		r.mu.Unlock()
		for _, event := range history {
			if err := c.write(proto.Structured, event); err != nil {
				r.streamMu.Unlock()
				return err
			}
		}
		err := c.write(proto.ReplayDone, nil)
		r.streamMu.Unlock()
		return err
	case proto.Kill:
		go r.shutdown(true, 0)
	}
	return nil
}

func (r *claudeStructuredRunner) handleInput(data string) {
	r.mu.Lock()
	parts := strings.Split(data, "\r")
	for index, part := range parts {
		r.composer.WriteString(part)
		if index == len(parts)-1 {
			continue
		}
		text := cleanComposerInput(r.composer.String())
		r.composer.Reset()
		if text == "" {
			continue
		}
		if r.active {
			r.pending = append(r.pending, text)
			continue
		}
		r.active = true
		go r.runTurn(text)
	}
	r.mu.Unlock()
}

func (r *claudeStructuredRunner) runTurn(text string) {
	defer func() {
		r.mu.Lock()
		if len(r.pending) == 0 {
			r.active = false
			r.mu.Unlock()
			return
		}
		next := r.pending[0]
		r.pending = r.pending[1:]
		r.mu.Unlock()
		go r.runTurn(next)
	}()
	user, _ := claudep.UserHistoryEvent(r.sessionID, text, time.Now())
	r.appendStructured(user)
	started, _ := claudep.TurnStartedEvent(r.sessionID, time.Now())
	r.appendStructured(started)
	r.mu.Lock()
	resume := r.initialized
	r.mu.Unlock()
	stream, err := r.client.SendTurn(r.ctx, text, claudep.TurnOptions{
		CWD: r.cfg.cwd, SessionID: r.sessionID, Resume: resume,
		Model: codexArgValue(r.cfg.args, "--model", "-m"), ExtraArgs: r.cfg.args,
	})
	if err != nil {
		r.recordTurnFailure(structuredProfileLoginHint(err, r.cfg.profile))
		return
	}
	completed := false
	for event := range stream.Events {
		if claudep.HistoryInitialized(event.Raw) {
			r.mu.Lock()
			r.initialized = true
			r.mu.Unlock()
		}
		if event.Type == "result" {
			completed = true
		}
		r.appendStructured(event.Raw)
	}
	_, err = stream.Result(r.ctx)
	if err != nil && !errors.Is(err, context.Canceled) && (!completed || r.cfg.profile != "") {
		r.recordTurnFailure(structuredProfileLoginHint(err, r.cfg.profile))
	}
}

func structuredProfileLoginHint(err error, profile string) error {
	if err == nil || profile == "" {
		return err
	}
	return fmt.Errorf("%w; new profile: open a regular PTY session with --profile %s once to log in", err, profile)
}

func (r *claudeStructuredRunner) recordTurnFailure(err error) {
	raw, encodeErr := claudep.FailureHistoryEvent(r.sessionID, err, time.Now())
	if encodeErr == nil {
		r.appendStructured(raw)
	}
}

func (r *claudeStructuredRunner) appendStructured(raw json.RawMessage) {
	if len(raw) == 0 || len(raw)+1 > proto.MaxFrameLen {
		return
	}
	r.streamMu.Lock()
	defer r.streamMu.Unlock()
	if _, err := r.historyFile.Write(append(append([]byte(nil), raw...), '\n')); err != nil {
		r.logger.Printf("append structured Claude history failed: %v", err)
	}
	r.mu.Lock()
	r.history = append(r.history, append(json.RawMessage(nil), raw...))
	clients := make([]*client, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.mu.Unlock()
	for _, c := range clients {
		if err := c.write(proto.Structured, raw); err != nil {
			_ = c.conn.Close()
		}
	}
}

func (r *claudeStructuredRunner) snapshot() string {
	r.mu.Lock()
	history := cloneStructured(r.history)
	r.mu.Unlock()
	var output strings.Builder
	for _, raw := range history {
		var event map[string]any
		if json.Unmarshal(raw, &event) != nil {
			continue
		}
		message, ok := event["message"].(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		text := codexMessageText(message["content"])
		if (role != "user" && role != "assistant") || strings.TrimSpace(text) == "" {
			continue
		}
		if output.Len() > 0 {
			output.WriteString("\n\n")
		}
		fmt.Fprintf(&output, "[%s]\n%s", role, text)
	}
	return output.String()
}

func (r *claudeStructuredRunner) shutdown(permanent bool, code int) {
	r.shutdownOnce.Do(func() {
		r.cancel()
		r.streamMu.Lock()
		if r.listener != nil {
			_ = r.listener.Close()
		}
		_ = os.Remove(r.paths.Socket)
		r.mu.Lock()
		exitCode := code
		exit := exitInfo{Code: &exitCode}
		clients := make([]*client, 0, len(r.clients))
		for c := range r.clients {
			clients = append(clients, c)
		}
		r.mu.Unlock()
		payload, _ := json.Marshal(exit)
		for _, c := range clients {
			_ = c.write(proto.Exit, payload)
			_ = c.conn.Close()
		}
		r.closeHistory()
		if permanent {
			_ = os.Remove(r.paths.Meta)
			_ = os.Remove(r.paths.ClaudeP)
		}
		r.streamMu.Unlock()
		r.done <- code
	})
}
