package state

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/mirror"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
)

type Session struct {
	runner proto.Runner
	mirror *mirror.Mirror

	mu           sync.RWMutex
	info         SessionInfo
	outputs      []proto.OutputEvent
	outputSize   int
	nextSeq      uint32
	claude       []json.RawMessage
	claudeBase   int64
	exit         proto.ExitEvent
	subs         map[uint64]chan proto.Event
	nextSubID    uint64
	runnerEvents <-chan proto.Event
	cancelRunner func()
}

type Attachment struct {
	Replay            proto.ReplayWindow
	ClaudeEvents      []json.RawMessage
	ClaudeEventsCount int64
	ClaudeReplayStart int64
	Events            <-chan proto.Event
	Cancel            func()
}

type AttachOptions struct {
	LastSeq             uint32
	ClaudeEventsSince   int64
	IncludeClaudeReplay bool
	InitialReplayCap    int
}

func newSession(ctx context.Context, info proto.RunnerInfo, runner proto.Runner, name, onIdle string) (*Session, error) {
	terminal, err := mirror.NewSize(info.Cols, info.Rows)
	if err != nil {
		return nil, fmt.Errorf("create session mirror: %w", err)
	}
	tool := classifyTool(info.Cmd)
	model, effort, fast := spawnControls(tool, info.Args)
	now := time.Now().UnixMilli()
	session := &Session{
		runner: runner,
		mirror: terminal,
		info: SessionInfo{
			ID: info.ID, Name: name, Cmd: info.Cmd, Args: append([]string{}, info.Args...),
			Cwd: info.Cwd, Cols: info.Cols, Rows: info.Rows, CreatedAt: info.CreatedAt,
			PID: info.PID, Tool: tool, LastDataAt: now, OnIdle: onIdle,
			Model: model, Effort: effort, Fast: fast,
		},
		nextSeq: 1,
		subs:    make(map[uint64]chan proto.Event),
	}
	session.runnerEvents, session.cancelRunner = runner.Subscribe()
	replay := runner.Replay(ctx, 0)
	for _, event := range replay.Events {
		session.appendOutputLocked(event)
	}
	if replay.Current >= session.nextSeq {
		session.nextSeq = replay.Current + 1
	}
	return session, nil
}

func (s *Session) start(onExit func(proto.Event)) {
	go func() {
		defer s.cancelRunner()
		for event := range s.runnerEvents {
			terminal := s.applyEvent(event)
			if terminal {
				onExit(event)
				return
			}
		}
	}()
}

func (s *Session) applyEvent(event proto.Event) bool {
	s.mu.Lock()
	terminal := false
	switch event.Kind {
	case proto.EventOutput:
		if event.Output.Seq == 0 {
			event.Output.Seq = s.nextSeq
		}
		if event.Output.Seq >= s.nextSeq {
			s.appendOutputLocked(event.Output)
			s.info.LastDataAt = time.Now().UnixMilli()
		}
	case proto.EventClaude:
		event.ClaudeIndex = s.claudeBase + int64(len(s.claude))
		s.claude = append(s.claude, append(json.RawMessage(nil), event.ClaudeEvent...))
		if len(s.claude) > maxClaudeEvents {
			removed := len(s.claude) - maxClaudeEvents
			s.claude = append([]json.RawMessage(nil), s.claude[removed:]...)
			s.claudeBase += int64(removed)
		}
	case proto.EventExit, proto.EventRunnerLost:
		now := time.Now().UnixMilli()
		exit := event.Exit
		if event.Kind == proto.EventRunnerLost && exit.Reason == "" {
			exit.Reason = "runner-lost"
		}
		if exit.Seq == 0 && s.nextSeq > 0 {
			exit.Seq = s.nextSeq - 1
		}
		event.Exit = exit
		s.info.Exited = true
		s.info.Working = false
		s.info.ExitCode = exit.Code
		s.info.ExitSignal = exit.Signal
		s.info.ExitedAt = &now
		s.exit = exit
		terminal = true
	}
	for _, subscriber := range s.subs {
		select {
		case subscriber <- event:
		default:
			// A slow client must not stall every other session. WebSocket
			// reconnect/replay repairs dropped output using sequence numbers.
			if terminal {
				<-subscriber
				subscriber <- event
			}
		}
	}
	if terminal {
		for id, subscriber := range s.subs {
			close(subscriber)
			delete(s.subs, id)
		}
	}
	s.mu.Unlock()
	return terminal
}

func (s *Session) appendOutputLocked(event proto.OutputEvent) {
	if event.At == 0 {
		event.At = time.Now().UnixMilli()
	}
	_, _ = s.mirror.Write([]byte(event.Data))
	s.outputs = append(s.outputs, event)
	s.outputSize += len(event.Data)
	if event.Seq >= s.nextSeq {
		s.nextSeq = event.Seq + 1
	}
	for s.outputSize > defaultEventLogBytes && len(s.outputs) > 1 {
		s.outputSize -= len(s.outputs[0].Data)
		s.outputs = s.outputs[1:]
	}
}

func (s *Session) Info() SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	info := s.info
	info.Args = append([]string{}, s.info.Args...)
	return info
}

func (s *Session) Replay(after uint32) proto.ReplayWindow {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.replayLocked(after)
}

func (s *Session) replayLocked(after uint32) proto.ReplayWindow {
	oldest := s.nextSeq
	if len(s.outputs) > 0 {
		oldest = s.outputs[0].Seq
	}
	current := uint32(0)
	if s.nextSeq > 0 {
		current = s.nextSeq - 1
	}
	events := make([]proto.OutputEvent, 0, len(s.outputs))
	for _, event := range s.outputs {
		if event.Seq > after {
			events = append(events, event)
		}
	}
	return proto.ReplayWindow{
		Events: events, Gap: len(s.outputs) > 0 && after+1 < oldest,
		Oldest: oldest, Current: current,
	}
}

func (s *Session) Attach(options AttachOptions) Attachment {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextSubID
	s.nextSubID++
	stream := make(chan proto.Event, 512)
	s.subs[id] = stream

	count := s.claudeBase + int64(len(s.claude))
	start := len(s.claude)
	if options.IncludeClaudeReplay {
		if options.ClaudeEventsSince > 0 {
			start = int(options.ClaudeEventsSince - s.claudeBase)
			if start < 0 {
				start = 0
			}
			if start > len(s.claude) {
				start = len(s.claude)
			}
		} else {
			cap := options.InitialReplayCap
			if cap <= 0 {
				cap = 300
			}
			start = len(s.claude) - cap
			if start < 0 {
				start = 0
			}
		}
	}
	claude := make([]json.RawMessage, len(s.claude)-start)
	for i := range claude {
		claude[i] = append(json.RawMessage(nil), s.claude[start+i]...)
	}
	return Attachment{
		Replay:            s.replayLocked(options.LastSeq),
		ClaudeEvents:      claude,
		ClaudeEventsCount: count,
		ClaudeReplayStart: s.claudeBase + int64(start),
		Events:            stream,
		Cancel: func() {
			s.mu.Lock()
			if existing, ok := s.subs[id]; ok {
				delete(s.subs, id)
				close(existing)
			}
			s.mu.Unlock()
		},
	}
}

func (s *Session) Snapshot(_ context.Context, cols int) (string, uint32, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seq := uint32(0)
	if s.nextSeq > 0 {
		seq = s.nextSeq - 1
	}
	if cols > 0 {
		return s.mirror.ReflowTo(cols), seq, nil
	}
	return s.mirror.SerializeANSI(), seq, nil
}

func (s *Session) Input(ctx context.Context, data string) bool {
	s.mu.RLock()
	exited := s.info.Exited
	s.mu.RUnlock()
	return !exited && s.runner.Input(ctx, data) == nil
}

func (s *Session) Resize(ctx context.Context, cols, rows int) bool {
	s.mu.RLock()
	exited := s.info.Exited
	s.mu.RUnlock()
	if exited || s.runner.Resize(ctx, cols, rows) != nil {
		return false
	}
	s.mu.Lock()
	if err := s.mirror.Resize(cols, rows); err != nil {
		s.mu.Unlock()
		return false
	}
	s.info.Cols = cols
	s.info.Rows = rows
	s.mu.Unlock()
	return true
}

func (s *Session) Kill(ctx context.Context) bool {
	return s.runner.Kill(ctx) == nil
}

func (s *Session) EventsWindow(since, tail, before *int64) ClaudeEventsWindow {
	s.mu.RLock()
	defer s.mu.RUnlock()
	length := int64(len(s.claude))
	total := s.claudeBase + length
	end := length
	if before != nil && *before >= 0 {
		end = clamp(*before-s.claudeBase, 0, length)
	}
	start := int64(0)
	if since != nil && *since >= 0 {
		start = clamp(*since-s.claudeBase, 0, end)
	}
	if tail != nil && *tail > 0 {
		candidate := end - *tail
		if candidate < 0 {
			candidate = 0
		}
		if candidate > start {
			start = candidate
		}
	}
	if start > end {
		start = end
	}
	events := make([]json.RawMessage, end-start)
	for i := range events {
		events[i] = append(json.RawMessage(nil), s.claude[start+int64(i)]...)
	}
	return ClaudeEventsWindow{
		Events: events, NextIndex: total, TotalCount: total,
		StartIndex: s.claudeBase + start, EndIndex: s.claudeBase + end,
	}
}

func (s *Session) ClaudeEventCount() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.claudeBase + int64(len(s.claude))
}

func (s *Session) TerminalState() (bool, proto.ExitEvent) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.info.Exited, s.exit
}

func (s *Session) Close() error {
	s.cancelRunner()
	return s.mirror.Close()
}

func clamp(value, minimum, maximum int64) int64 {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
