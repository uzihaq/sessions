package state

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
)

func (s *Session) recordClaudeLocked(event *proto.Event) {
	event.ClaudeIndex = s.claudeBase + int64(len(s.claude))
	raw := append(json.RawMessage(nil), event.ClaudeEvent...)
	s.claude = append(s.claude, raw)
	if len(s.claude) > maxClaudeEvents {
		removed := len(s.claude) - maxClaudeEvents
		s.claude = append([]json.RawMessage(nil), s.claude[removed:]...)
		s.claudeBase += int64(removed)
	}

	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return
	}
	switch value["type"] {
	case "custom-title":
		if title, ok := value["customTitle"].(string); ok && title != "" {
			s.info.ClaudeCustomTitle = title
		}
	case "ai-title":
		if title, ok := value["aiTitle"].(string); ok && title != "" {
			s.info.ClaudeAITitle = title
		}
	}
	if !realUserMessage(value) {
		return
	}
	timestamp, ok := value["timestamp"].(string)
	if !ok {
		return
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return
	}
	millis := parsed.UnixMilli()
	if s.info.LastUserMessageAt == nil || millis > *s.info.LastUserMessageAt {
		s.info.LastUserMessageAt = &millis
	}
}

func realUserMessage(event map[string]any) bool {
	if event["type"] != "user" {
		return false
	}
	message, ok := event["message"].(map[string]any)
	if !ok || message["role"] != "user" {
		return false
	}
	var text string
	switch content := message["content"].(type) {
	case string:
		text = content
	case []any:
		if len(content) == 0 {
			return false
		}
		allToolResults := true
		for _, item := range content {
			block, ok := item.(map[string]any)
			if !ok || block["type"] != "tool_result" {
				allToolResults = false
			}
			if block["type"] == "text" && text == "" {
				text, _ = block["text"].(string)
			}
		}
		if allToolResults {
			return false
		}
	default:
		return false
	}
	trimmed := strings.TrimLeft(text, " \t\r\n")
	for _, prefix := range []string{"<", "Caveat:", "This session is being continued", "[Request interrupted"} {
		if strings.HasPrefix(trimmed, prefix) {
			return false
		}
	}
	return true
}
