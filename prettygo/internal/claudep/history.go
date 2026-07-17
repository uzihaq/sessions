package claudep

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const HistorySource = "claude-p-stream-json"

// UserHistoryEvent records accepted composer input in Pretty's existing
// canonical user-message shape.
func UserHistoryEvent(sessionID, text string, at time.Time) (json.RawMessage, error) {
	return marshalHistory(map[string]any{
		"type": "user", "subtype": "user_message", "source": HistorySource,
		"timestamp": historyTimestamp(at), "session_id": sessionID,
		"message": map[string]any{"role": "user", "content": text},
	})
}

// TurnStartedEvent is the authoritative working=true boundary for one
// per-turn Claude process.
func TurnStartedEvent(sessionID string, at time.Time) (json.RawMessage, error) {
	return marshalHistory(map[string]any{
		"type": "claude", "subtype": "turn_started", "source": HistorySource,
		"timestamp": historyTimestamp(at), "session_id": sessionID,
	})
}

// FailureHistoryEvent closes the lifecycle when Claude exits without a valid
// result record.
func FailureHistoryEvent(sessionID string, cause error, at time.Time) (json.RawMessage, error) {
	message := "Claude turn failed"
	if cause != nil {
		message = cause.Error()
	}
	return marshalHistory(map[string]any{
		"type": "result", "subtype": "error_during_execution", "source": HistorySource,
		"timestamp": historyTimestamp(at), "session_id": sessionID,
		"is_error": true, "error": message,
	})
}

// NormalizeEvent validates and annotates one native stream-json record. The
// provider payload remains otherwise intact, including assistant content
// blocks, tool_use/tool_result blocks, result text, and token usage.
func NormalizeEvent(raw json.RawMessage, at time.Time) (Event, error) {
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return Event{}, fmt.Errorf("decode Claude stream-json event: %w", err)
	}
	typeName, _ := value["type"].(string)
	if strings.TrimSpace(typeName) == "" {
		return Event{}, fmt.Errorf("Claude stream-json event has no type")
	}
	if existing, ok := value["source"].(string); ok && existing != "" && existing != HistorySource {
		value["provider_source"] = existing
	}
	value["source"] = HistorySource
	if _, present := value["timestamp"]; !present {
		value["timestamp"] = historyTimestamp(at)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return Event{}, err
	}
	event := Event{Raw: encoded, Type: typeName}
	event.Subtype, _ = value["subtype"].(string)
	event.SessionID, _ = value["session_id"].(string)
	if event.Type == "result" {
		event.Message, _ = value["result"].(string)
		if usage, present := value["usage"]; present {
			event.Usage, _ = json.Marshal(usage)
		}
	} else if event.Type == "assistant" {
		event.Message = messageText(value["message"])
	}
	return event, nil
}

func messageText(raw any) string {
	message, _ := raw.(map[string]any)
	content, _ := message["content"].([]any)
	var result strings.Builder
	for _, item := range content {
		block, _ := item.(map[string]any)
		if block["type"] != "text" {
			continue
		}
		text, _ := block["text"].(string)
		result.WriteString(text)
	}
	return result.String()
}

// HistoryLifecycle decodes the authoritative turn boundaries.
func HistoryLifecycle(raw json.RawMessage) (working bool, authoritative bool) {
	var value struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Source  string `json:"source"`
	}
	if json.Unmarshal(raw, &value) != nil || value.Source != HistorySource {
		return false, false
	}
	if value.Type == "claude" && value.Subtype == "turn_started" {
		return true, true
	}
	if value.Type == "result" {
		return false, true
	}
	return false, false
}

// HistoryInitialized reports whether Claude acknowledged the persisted UUID.
func HistoryInitialized(raw json.RawMessage) bool {
	var value struct {
		Type      string `json:"type"`
		Subtype   string `json:"subtype"`
		Source    string `json:"source"`
		SessionID string `json:"session_id"`
	}
	return json.Unmarshal(raw, &value) == nil && value.Source == HistorySource &&
		value.Type == "system" && value.Subtype == "init" && value.SessionID != ""
}

func marshalHistory(value map[string]any) (json.RawMessage, error) {
	encoded, err := json.Marshal(value)
	return json.RawMessage(encoded), err
}

func historyTimestamp(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
