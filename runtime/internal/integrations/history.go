// Package integrations owns the stable, versioned contracts consumed by
// external Sessions integrations. It does not call any external service.
package integrations

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/somewhere-tech/sessions/runtime/internal/backup"
	"github.com/somewhere-tech/sessions/runtime/internal/state"
	"github.com/somewhere-tech/sessions/runtime/internal/watch"
)

const SchemaVersion = 1

var ErrHistoryNotFound = errors.New("history session not found")

type HistorySession struct {
	ID                    string `json:"id"`
	Name                  string `json:"name"`
	Tool                  string `json:"tool"`
	CWD                   string `json:"cwd"`
	Machine               string `json:"machine"`
	CreatedAt             int64  `json:"created_at"`
	LastActivityAt        int64  `json:"last_activity_at"`
	MessageCount          int    `json:"message_count"`
	ConversationAvailable bool   `json:"conversation_available"`
}

type HistoryResponse struct {
	SchemaVersion int              `json:"schemaVersion"`
	Sessions      []HistorySession `json:"sessions"`
}

type TranscriptMessage struct {
	Role      string  `json:"role"`
	Text      string  `json:"text"`
	Timestamp *string `json:"timestamp"`
}

type TranscriptResponse struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Session       HistorySession      `json:"session"`
	Messages      []TranscriptMessage `json:"messages"`
	Truncated     bool                `json:"truncated,omitempty"`
}

type HistoryOptions struct {
	RunnerStateDir    string
	ClaudeProjectsDir string
	CodexSessionsDir  string
	Machine           string
	Now               func() time.Time
}

type historyCacheEntry struct {
	size        int64
	modTimeNano int64
	count       int
}

type HistoryStore struct {
	options HistoryOptions
	cacheMu sync.Mutex
	cache   map[string]historyCacheEntry
}

func NewHistoryStore(options HistoryOptions) *HistoryStore {
	if options.Now == nil {
		options.Now = time.Now
	}
	return &HistoryStore{options: options, cache: make(map[string]historyCacheEntry)}
}

func (h *HistoryStore) List(live []state.SessionInfo) (HistoryResponse, error) {
	sessions, err := h.list(live, true)
	if err != nil {
		return HistoryResponse{}, err
	}
	return HistoryResponse{SchemaVersion: SchemaVersion, Sessions: sessions}, nil
}

// SearchSessions returns the known history sources without parsing every
// transcript just to count its messages. Search reads only candidates that
// survive its session/tool filters and applies its own bounded transcript read.
func (h *HistoryStore) SearchSessions(live []state.SessionInfo) ([]HistorySession, error) {
	return h.list(live, false)
}

func (h *HistoryStore) list(live []state.SessionInfo, countMessages bool) ([]HistorySession, error) {
	sources := backup.CollectSessions(live, h.options.RunnerStateDir)
	sessions := make([]HistorySession, 0, len(sources))
	for _, source := range sources {
		session, _, _, err := h.describe(source, countMessages)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].LastActivityAt != sessions[j].LastActivityAt {
			return sessions[i].LastActivityAt > sessions[j].LastActivityAt
		}
		return sessions[i].ID < sessions[j].ID
	})
	return sessions, nil
}

func (h *HistoryStore) Transcript(live []state.SessionInfo, id string) (TranscriptResponse, error) {
	return h.transcript(live, id, 0)
}

// TranscriptLimited reads at most maxBytes from the normalized conversation
// file. A non-positive limit preserves the unbounded recall behavior.
func (h *HistoryStore) TranscriptLimited(live []state.SessionInfo, id string, maxBytes int64) (TranscriptResponse, error) {
	return h.transcript(live, id, maxBytes)
}

// TranscriptPreview returns a tail-bounded window suitable for interactive
// rendering. The full Transcript and Raw contracts remain available to
// integrations that deliberately request the complete history.
func (h *HistoryStore) TranscriptPreview(live []state.SessionInfo, id string, maxBytes int64, maxMessages int) (TranscriptResponse, error) {
	source, ok := h.find(live, id)
	if !ok {
		return TranscriptResponse{}, ErrHistoryNotFound
	}
	session, path, tool, err := h.describe(source, false)
	if err != nil {
		return TranscriptResponse{}, err
	}
	if path == "" || !session.ConversationAvailable {
		return TranscriptResponse{}, ErrHistoryNotFound
	}
	messages, truncated, err := normalizeTranscriptTail(path, tool, maxBytes, maxMessages)
	if err != nil {
		return TranscriptResponse{}, fmt.Errorf("read history transcript preview %s: %w", id, err)
	}
	session.MessageCount = len(messages)
	return TranscriptResponse{
		SchemaVersion: SchemaVersion,
		Session:       session,
		Messages:      messages,
		Truncated:     truncated,
	}, nil
}

func (h *HistoryStore) transcript(live []state.SessionInfo, id string, maxBytes int64) (TranscriptResponse, error) {
	source, ok := h.find(live, id)
	if !ok {
		return TranscriptResponse{}, ErrHistoryNotFound
	}
	session, path, tool, err := h.describe(source, false)
	if err != nil {
		return TranscriptResponse{}, err
	}
	if path == "" || !session.ConversationAvailable {
		return TranscriptResponse{}, ErrHistoryNotFound
	}
	messages, err := normalizeTranscript(path, tool, maxBytes)
	if err != nil {
		return TranscriptResponse{}, fmt.Errorf("read history transcript %s: %w", id, err)
	}
	session.MessageCount = len(messages)
	return TranscriptResponse{
		SchemaVersion: SchemaVersion,
		Session:       session,
		Messages:      messages,
	}, nil
}

func (h *HistoryStore) Raw(live []state.SessionInfo, id string) ([]byte, error) {
	source, ok := h.find(live, id)
	if !ok {
		return nil, ErrHistoryNotFound
	}
	_, path, _, err := h.describe(source, false)
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, ErrHistoryNotFound
	}
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrHistoryNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("read raw history %s: %w", id, err)
	}
	return encoded, nil
}

func (h *HistoryStore) find(live []state.SessionInfo, id string) (backup.Session, bool) {
	for _, session := range backup.CollectSessions(live, h.options.RunnerStateDir) {
		if session.ID == id {
			return session, true
		}
	}
	return backup.Session{}, false
}

func (h *HistoryStore) describe(source backup.Session, countMessages bool) (HistorySession, string, string, error) {
	// Backup opt-out controls external upload only. These local, authenticated
	// recall endpoints remain able to read the user's own conversation.
	source.OptOut = false
	path, conversationTool := (backup.Resolver{
		ClaudeProjectsDir: h.options.ClaudeProjectsDir,
		CodexSessionsDir:  h.options.CodexSessionsDir,
		Now:               h.options.Now,
	}).Resolve(source)
	tool := historyTool(source.Tool, conversationTool)
	result := HistorySession{
		ID: source.ID, Name: source.Name, Tool: tool, CWD: source.CWD,
		Machine: h.options.Machine, CreatedAt: source.CreatedAt,
		LastActivityAt: source.LastActivityAt,
	}
	if path == "" {
		return result, "", tool, nil
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return result, "", tool, nil
	}
	if err != nil {
		return HistorySession{}, "", "", fmt.Errorf("stat history transcript %s: %w", source.ID, err)
	}
	if !info.Mode().IsRegular() {
		return result, "", tool, nil
	}
	result.ConversationAvailable = true
	result.LastActivityAt = max(result.LastActivityAt, info.ModTime().UnixMilli())
	if !countMessages {
		return result, path, tool, nil
	}
	count, err := h.messageCount(path, tool, info)
	if err != nil {
		return HistorySession{}, "", "", fmt.Errorf("count history transcript %s: %w", source.ID, err)
	}
	result.MessageCount = count
	return result, path, tool, nil
}

func (h *HistoryStore) messageCount(path, tool string, info os.FileInfo) (int, error) {
	h.cacheMu.Lock()
	cached, ok := h.cache[path]
	if ok && cached.size == info.Size() && cached.modTimeNano == info.ModTime().UnixNano() {
		h.cacheMu.Unlock()
		return cached.count, nil
	}
	h.cacheMu.Unlock()
	messages, err := normalizeTranscript(path, tool, 0)
	if err != nil {
		return 0, err
	}
	entry := historyCacheEntry{size: info.Size(), modTimeNano: info.ModTime().UnixNano(), count: len(messages)}
	h.cacheMu.Lock()
	h.cache[path] = entry
	h.cacheMu.Unlock()
	return entry.count, nil
}

func historyTool(tool state.SessionTool, resolved string) string {
	if resolved != "" {
		return resolved
	}
	switch tool {
	case state.ToolClaude:
		return "claude"
	case state.ToolCodex:
		return "codex"
	case state.ToolTerminal:
		return "terminal"
	default:
		return string(tool)
	}
}

func normalizeTranscript(path, tool string, maxBytes int64) ([]TranscriptMessage, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var source io.Reader = file
	if maxBytes > 0 {
		source = io.LimitReader(file, maxBytes)
	}
	return normalizeTranscriptReader(bufio.NewReader(source), path, tool)
}

func normalizeTranscriptTail(path, tool string, maxBytes int64, maxMessages int) ([]TranscriptMessage, bool, error) {
	if maxBytes <= 0 || maxMessages <= 0 {
		return nil, false, errors.New("preview limits must be positive")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	offset := max(int64(0), info.Size()-maxBytes)
	truncated := offset > 0
	var reader *bufio.Reader
	if offset > 0 {
		// Keep a record that begins exactly at the window boundary. Otherwise
		// discard the partial first JSONL record before normalization.
		if _, err := file.Seek(offset-1, io.SeekStart); err != nil {
			return nil, false, err
		}
		previous := []byte{0}
		if _, err := io.ReadFull(file, previous); err != nil {
			return nil, false, err
		}
		reader = bufio.NewReader(io.LimitReader(file, maxBytes))
		if previous[0] != '\n' {
			if _, err := reader.ReadBytes('\n'); err != nil && !errors.Is(err, io.EOF) {
				return nil, false, err
			}
		} else if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return nil, false, err
		} else {
			reader = bufio.NewReader(io.LimitReader(file, maxBytes))
		}
	} else {
		reader = bufio.NewReader(io.LimitReader(file, maxBytes))
	}
	messages, err := normalizeTranscriptReader(reader, path, tool)
	if err != nil {
		return nil, false, err
	}
	if len(messages) > maxMessages {
		messages = messages[len(messages)-maxMessages:]
		truncated = true
	}
	return messages, truncated, nil
}

func normalizeTranscriptReader(reader *bufio.Reader, path, tool string) ([]TranscriptMessage, error) {
	messages := make([]TranscriptMessage, 0)
	lineIndex := 0
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := strings.TrimSpace(string(line))
			currentIndex := lineIndex
			lineIndex++
			if trimmed != "" {
				var decoded map[string]any
				if json.Unmarshal([]byte(trimmed), &decoded) == nil {
					if tool == "codex" {
						normalized := watch.NormalizeCodexRolloutLine(decoded, watch.CodexNormalizeContext{
							RolloutBasename: filepath.Base(path), LineIndex: currentIndex,
						})
						for _, event := range normalized.Events {
							if message, ok := transcriptMessage(event); ok {
								messages = append(messages, message)
							}
						}
					} else if message, ok := transcriptMessage(decoded); ok {
						messages = append(messages, message)
					}
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	return messages, nil
}

func transcriptMessage(event map[string]any) (TranscriptMessage, bool) {
	message, ok := event["message"].(map[string]any)
	if !ok {
		return TranscriptMessage{}, false
	}
	role, _ := message["role"].(string)
	if role != "user" && role != "assistant" {
		return TranscriptMessage{}, false
	}
	text := contentText(message["content"])
	if text == "" {
		return TranscriptMessage{}, false
	}
	return TranscriptMessage{Role: role, Text: text, Timestamp: normalizedTimestamp(event["timestamp"])}, true
}

func contentText(content any) string {
	switch value := content.(type) {
	case string:
		return strings.TrimSpace(value)
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			block, ok := item.(map[string]any)
			if !ok || block["type"] != "text" {
				continue
			}
			if text, ok := block["text"].(string); ok && strings.TrimSpace(text) != "" {
				parts = append(parts, strings.TrimSpace(text))
			}
		}
		return strings.Join(parts, "\n\n")
	default:
		return ""
	}
}

func normalizedTimestamp(value any) *string {
	switch timestamp := value.(type) {
	case string:
		if timestamp == "" {
			return nil
		}
		return &timestamp
	case float64:
		var parsed time.Time
		if timestamp > -100_000_000_000 && timestamp < 100_000_000_000 {
			seconds := int64(timestamp)
			nanos := int64((timestamp - float64(seconds)) * float64(time.Second))
			parsed = time.Unix(seconds, nanos)
		} else {
			parsed = time.UnixMilli(int64(timestamp))
		}
		formatted := parsed.UTC().Format(time.RFC3339Nano)
		return &formatted
	default:
		return nil
	}
}
