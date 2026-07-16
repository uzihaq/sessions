package session

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

type idleHookContext struct {
	Summary    string
	Outcome    IdleOutcome
	DurationMS int64
}

func (m *Manager) idleDir() string {
	root := m.config.UserStateRoot
	if root == "" {
		root = m.config.StateRoot
	}
	return filepath.Join(root, "idle")
}

func sessionDisplayLabel(info state.SessionInfo) string {
	for _, value := range []string{info.Name, info.ClaudeCustomTitle, info.ClaudeAITitle} {
		if value != "" {
			return value
		}
	}
	if base := filepath.Base(info.Cwd); base != "." && base != string(filepath.Separator) && base != "" {
		return base
	}
	if info.Cmd != "" {
		return info.Cmd
	}
	if len(info.ID) > 8 {
		return info.ID[:8]
	}
	return info.ID
}

func (m *Manager) removeIdleSentinel(id string) {
	_ = os.Remove(filepath.Join(m.idleDir(), id))
}

func (m *Manager) writeIdleSentinel(info state.SessionInfo) {
	dir := m.idleDir()
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	body := struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		At   string `json:"at"`
	}{info.ID, sessionDisplayLabel(info), time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	encoded, err := json.Marshal(body)
	if err != nil {
		return
	}
	encoded = append(encoded, '\n')
	path := filepath.Join(dir, info.ID)
	if os.WriteFile(path, encoded, 0o600) == nil {
		_ = os.Chmod(path, 0o600)
	}
}

func (m *Manager) handleIdle(session *state.Session, duration time.Duration) {
	info := session.Info()
	if info.Exited {
		return
	}
	snapshot, _, err := session.Snapshot(context.Background(), 0)
	if err != nil {
		snapshot = ""
	}
	classification := ClassifySnapshot(snapshot)
	summary := FinalAssistantSummary(session.ClaudeEventLog())
	if summary == "" {
		summary = mirrorTailSummary(snapshot)
	}
	hookContext := idleHookContext{Summary: summary, Outcome: classification.Outcome, DurationMS: duration.Milliseconds()}
	label := sessionDisplayLabel(info)
	title := "🟢 " + label + " — done"
	body := summary
	if body == "" {
		body = "finished"
	}
	switch classification.Outcome {
	case IdleBlocked:
		title = "🟡 " + label + " — needs you"
		body = firstNonempty(classification.Line, summary, "waiting for input")
	case IdleError:
		title = "🔴 " + label + " — hit an error"
		body = firstNonempty(classification.Line, summary, "error detected")
	}
	m.writeIdleSentinel(info)
	m.runHook(info.OnIdle, info, hookContext, false)
	m.runHook(m.hooks.OnIdle, info, hookContext, true)
	go m.push.Send(context.Background(), PushPayload{
		Title: title, Body: body, Data: map[string]any{"sessionId": info.ID},
	})
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (m *Manager) runHook(script string, info state.SessionInfo, hook idleHookContext, timeout bool) {
	if script == "" {
		return
	}
	command := exec.Command("/bin/sh", "-c", script)
	command.Dir = info.Cwd
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	command.Env = hookEnvironment(info, hook)
	if command.Start() != nil {
		return
	}
	if !timeout {
		go func() { _ = command.Wait() }()
		return
	}
	done := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(done)
	}()
	go func() {
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			_ = command.Process.Kill()
		}
	}()
}

func hookEnvironment(info state.SessionInfo, hook idleHookContext) []string {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		if index := strings.IndexByte(entry, '='); index >= 0 {
			environment[entry[:index]] = entry[index+1:]
		}
	}
	environment["PRETTY_SESSION_ID"] = info.ID
	environment["PRETTY_SESSION_NAME"] = sessionDisplayLabel(info)
	environment["PRETTY_SESSION_TOOL"] = string(info.Tool)
	environment["PRETTY_SESSION_CWD"] = info.Cwd
	environment["PRETTY_FINAL_MESSAGE"] = hook.Summary
	environment["PRETTY_OUTCOME"] = string(hook.Outcome)
	environment["PRETTY_DURATION_MS"] = strconv.FormatInt(hook.DurationMS, 10)
	result := make([]string, 0, len(environment))
	for key, value := range environment {
		result = append(result, key+"="+value)
	}
	return result
}
