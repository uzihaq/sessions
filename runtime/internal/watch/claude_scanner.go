package watch

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const claudePreviewBytes = 16 * 1024

// ResumableSession is the exact metadata shape returned by the TypeScript
// /api/claude-sessions route.
type ResumableSession struct {
	SessionID        string  `json:"sessionId"`
	Tool             string  `json:"tool"`
	Origin           string  `json:"origin,omitempty"`
	Cwd              string  `json:"cwd"`
	ModifiedAt       float64 `json:"modifiedAt"`
	FirstUserMessage string  `json:"firstUserMessage"`
	SizeBytes        int64   `json:"sizeBytes"`
}

type resumableTask struct {
	path      string
	cwd       string
	sessionID string
}

type resumableResult struct {
	session ResumableSession
	ok      bool
}

// ScanResumableSessions walks ~/.claude/projects without modifying it and
// returns Claude conversations newest-first. HOME is resolved at call time so
// callers can isolate the scan with a fixture HOME.
func ScanResumableSessions() []ResumableSession {
	projectsDir, err := ClaudeProjectsDir()
	if err != nil {
		return []ResumableSession{}
	}
	projects, err := os.ReadDir(projectsDir)
	if err != nil {
		return []ResumableSession{}
	}

	tasks := make([]resumableTask, 0)
	for _, project := range projects {
		if !project.IsDir() {
			continue
		}
		projectDir := filepath.Join(projectsDir, project.Name())
		files, err := os.ReadDir(projectDir)
		if err != nil {
			continue
		}
		cwd := strings.ReplaceAll(project.Name(), "-", "/")
		for _, file := range files {
			if !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}
			info, err := file.Info()
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			tasks = append(tasks, resumableTask{
				path:      filepath.Join(projectDir, file.Name()),
				cwd:       cwd,
				sessionID: strings.TrimSuffix(file.Name(), ".jsonl"),
			})
		}
	}

	out := make([]ResumableSession, 0, len(tasks))
	const pool = 16
	for start := 0; start < len(tasks); start += pool {
		end := min(start+pool, len(tasks))
		results := make([]resumableResult, end-start)
		done := make(chan struct{}, len(results))
		for i, task := range tasks[start:end] {
			go func(index int, task resumableTask) {
				defer func() { done <- struct{}{} }()
				info, err := os.Stat(task.path)
				if err != nil {
					return
				}
				results[index] = resumableResult{
					ok: true,
					session: ResumableSession{
						SessionID:        task.sessionID,
						Tool:             "claude",
						Origin:           "Claude Code",
						Cwd:              task.cwd,
						ModifiedAt:       float64(info.ModTime().UnixNano()) / 1_000_000,
						FirstUserMessage: firstUserMessageOf(task.path),
						SizeBytes:        info.Size(),
					},
				}
			}(i, task)
		}
		for range results {
			<-done
		}
		for _, result := range results {
			if result.ok {
				out = append(out, result.session)
			}
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		return out[i].ModifiedAt > out[j].ModifiedAt
	})
	return out
}

// ScanResumableConversations returns provider conversations which can be
// safely bound through the audited recovery/adopt boundary. It reads only
// local provider metadata and a bounded first-message preview; no transcript
// content leaves this Mac.
func ScanResumableConversations() []ResumableSession {
	out := append([]ResumableSession(nil), ScanResumableSessions()...)
	root := resolveCodexRoot("")
	for _, candidate := range listRolloutsRecursive(root) {
		if session, ok := resumableCodexConversation(candidate.path, candidate.modTime); ok {
			out = append(out, session)
		}
	}

	// A provider may create more than one rollout file when the same logical
	// conversation is resumed. Keep only the newest physical source per
	// provider identity so the picker never presents duplicate cards.
	byIdentity := make(map[string]ResumableSession, len(out))
	for _, session := range out {
		key := session.Tool + ":" + session.SessionID
		current, exists := byIdentity[key]
		if !exists || session.ModifiedAt > current.ModifiedAt {
			byIdentity[key] = session
		}
	}
	out = out[:0]
	for _, session := range byIdentity {
		out = append(out, session)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].ModifiedAt != out[j].ModifiedAt {
			return out[i].ModifiedAt > out[j].ModifiedAt
		}
		if out[i].Tool != out[j].Tool {
			return out[i].Tool < out[j].Tool
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

const codexResumePreviewBytes = 512 * 1024

func resumableCodexConversation(path string, modified time.Time) (ResumableSession, bool) {
	file, err := os.Open(path)
	if err != nil {
		return ResumableSession{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ResumableSession{}, false
	}
	reader := bufio.NewReader(io.LimitReader(file, codexResumePreviewBytes))
	session := ResumableSession{
		Tool: "codex", Origin: "Codex", ModifiedAt: float64(modified.UnixNano()) / 1_000_000,
		SizeBytes: info.Size(),
	}
	lineIndex := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			var decoded map[string]any
			if json.Unmarshal(line, &decoded) == nil {
				if decoded["type"] == "session_meta" && session.SessionID == "" {
					if payload, ok := decoded["payload"].(map[string]any); ok {
						session.SessionID, _ = payload["id"].(string)
						session.Cwd, _ = payload["cwd"].(string)
						if originator, ok := payload["originator"].(string); ok && strings.TrimSpace(originator) != "" {
							session.Origin = originator
						}
						if codexSubagentSource(payload) {
							session.Origin = "Codex child agent"
						}
					}
				}
				if session.FirstUserMessage == "" {
					normalized := NormalizeCodexRolloutLine(decoded, CodexNormalizeContext{
						RolloutBasename: filepath.Base(path), LineIndex: lineIndex,
					})
					for _, event := range normalized.Events {
						if event["type"] != "user" {
							continue
						}
						message, _ := event["message"].(map[string]any)
						if text := normalizedMessageText(message); text != "" {
							session.FirstUserMessage = previewText(text)
							break
						}
					}
				}
			}
			lineIndex++
		}
		if readErr != nil {
			break
		}
	}
	if session.SessionID == "" || session.Cwd == "" {
		return ResumableSession{}, false
	}
	if session.FirstUserMessage == "" && session.Origin == "Codex child agent" {
		session.FirstUserMessage = "Delegated child-agent work"
	}
	return session, true
}

func codexSubagentSource(payload map[string]any) bool {
	source, ok := payload["source"].(map[string]any)
	if !ok {
		return false
	}
	_, ok = source["subagent"].(map[string]any)
	return ok
}

func normalizedMessageText(message map[string]any) string {
	blocks, _ := message["content"].([]any)
	parts := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok || block["type"] != "text" {
			continue
		}
		if text, ok := block["text"].(string); ok && strings.TrimSpace(text) != "" {
			parts = append(parts, strings.TrimSpace(text))
		}
	}
	return strings.Join(parts, "\n\n")
}

func firstUserMessageOf(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()

	buffer := make([]byte, claudePreviewBytes)
	n, err := file.Read(buffer)
	if err != nil && err != io.EOF {
		return ""
	}
	for _, line := range strings.Split(string(buffer[:n]), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) != nil || event["type"] != "user" {
			continue
		}
		message, ok := event["message"].(map[string]any)
		if !ok {
			continue
		}
		switch content := message["content"].(type) {
		case string:
			return previewText(content)
		case []any:
			for _, raw := range content {
				block, ok := raw.(map[string]any)
				if !ok || block["type"] != "text" {
					continue
				}
				if text, ok := block["text"].(string); ok {
					return previewText(text)
				}
			}
		}
	}
	return ""
}

func previewText(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > 200 {
		value = string(runes[:200])
	}
	return value
}
