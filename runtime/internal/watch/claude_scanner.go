package watch

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const claudePreviewBytes = 16 * 1024

// ResumableSession is the exact metadata shape returned by the TypeScript
// /api/claude-sessions route.
type ResumableSession struct {
	SessionID        string  `json:"sessionId"`
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
