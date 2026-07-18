// Package search matches text in normalized Claude and Codex conversation
// history. Conversation discovery and parsing remain owned by integrations and
// watch; this package only filters normalized messages and builds snippets.
package search

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/uzihaq/pretty-pty/prettygo/internal/integrations"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

const (
	DefaultLimit     = 100
	MaxLimit         = 1000
	MaxFileReadBytes = 64 << 20
	SnippetContext   = 96
	MaxSnippetRunes  = 240
)

type Options struct {
	Query     string
	SessionID string
	Role      string
	Tool      string
	Regex     bool
	Limit     int
}

type Match struct {
	SessionID string  `json:"session_id"`
	Name      string  `json:"name"`
	Tool      string  `json:"tool"`
	Role      string  `json:"role"`
	Timestamp *string `json:"timestamp"`
	Text      string  `json:"text"`
	Snippet   string  `json:"snippet"`
}

type Response struct {
	Matches []Match `json:"matches"`
	Total   int     `json:"total"`
}

type HistorySource interface {
	SearchSessions([]state.SessionInfo) ([]integrations.HistorySession, error)
	TranscriptLimited([]state.SessionInfo, string, int64) (integrations.TranscriptResponse, error)
}

type optionError struct{ message string }

func (e *optionError) Error() string { return e.message }

func IsOptionError(err error) bool {
	var target *optionError
	return errors.As(err, &target)
}

type matcher struct {
	pattern *regexp.Regexp
}

func newMatcher(query string, regex bool) (matcher, error) {
	if query == "" {
		return matcher{}, &optionError{message: "q is required"}
	}
	if !regex {
		pattern, err := regexp.Compile("(?i:" + regexp.QuoteMeta(query) + ")")
		if err != nil {
			return matcher{}, &optionError{message: fmt.Sprintf("invalid query: %v", err)}
		}
		return matcher{pattern: pattern}, nil
	}
	pattern, err := regexp.Compile(query)
	if err != nil {
		return matcher{}, &optionError{message: fmt.Sprintf("invalid regex: %v", err)}
	}
	return matcher{pattern: pattern}, nil
}

func (m matcher) find(text string) (int, int, bool) {
	location := m.pattern.FindStringIndex(text)
	if location == nil {
		return 0, 0, false
	}
	return location[0], location[1], true
}

// Run searches known sessions in recent-activity order and messages in their
// normalized conversation order. One message contributes at most one match.
func Run(ctx context.Context, source HistorySource, live []state.SessionInfo, options Options) (Response, error) {
	options.Role = strings.ToLower(strings.TrimSpace(options.Role))
	options.Tool = strings.ToLower(strings.TrimSpace(options.Tool))
	if options.Role != "" && options.Role != "user" && options.Role != "assistant" {
		return Response{}, &optionError{message: "role must be user or assistant"}
	}
	if options.Tool != "" && options.Tool != "claude" && options.Tool != "codex" && options.Tool != "shell" {
		return Response{}, &optionError{message: "tool must be claude, codex, or shell"}
	}
	if options.Limit == 0 {
		options.Limit = DefaultLimit
	}
	if options.Limit < 1 || options.Limit > MaxLimit {
		return Response{}, &optionError{message: fmt.Sprintf("limit must be between 1 and %d", MaxLimit)}
	}
	matchText, err := newMatcher(options.Query, options.Regex)
	if err != nil {
		return Response{}, err
	}

	sessions, err := source.SearchSessions(live)
	if err != nil {
		return Response{}, err
	}
	selectedID, err := resolveSessionID(sessions, options.SessionID)
	if err != nil {
		return Response{}, err
	}
	result := Response{Matches: make([]Match, 0, min(options.Limit, 16))}
	for _, session := range sessions {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		tool := normalizeTool(session.Tool)
		if selectedID != "" && session.ID != selectedID {
			continue
		}
		if options.Tool != "" && tool != options.Tool {
			continue
		}
		if !session.ConversationAvailable {
			continue
		}
		transcript, err := source.TranscriptLimited(live, session.ID, MaxFileReadBytes)
		if errors.Is(err, integrations.ErrHistoryNotFound) {
			continue
		}
		if err != nil {
			return Response{}, err
		}
		for _, message := range transcript.Messages {
			if options.Role != "" && message.Role != options.Role {
				continue
			}
			start, end, ok := matchText.find(message.Text)
			if !ok {
				continue
			}
			result.Matches = append(result.Matches, Match{
				SessionID: session.ID, Name: session.Name, Tool: tool,
				Role: message.Role, Timestamp: message.Timestamp, Text: message.Text,
				Snippet: makeSnippet(message.Text, start, end),
			})
			if len(result.Matches) == options.Limit {
				result.Total = len(result.Matches)
				return result, nil
			}
		}
	}
	result.Total = len(result.Matches)
	return result, nil
}

func normalizeTool(tool string) string {
	switch tool {
	case "claude-code", "claude":
		return "claude"
	case "terminal", "":
		return "shell"
	default:
		return tool
	}
}

func resolveSessionID(sessions []integrations.HistorySession, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", nil
	}
	for _, session := range sessions {
		if session.ID == requested {
			return session.ID, nil
		}
	}
	matches := make([]string, 0, 2)
	for _, session := range sessions {
		if strings.HasPrefix(session.ID, requested) {
			matches = append(matches, session.ID)
		}
	}
	switch len(matches) {
	case 0:
		return "", &optionError{message: fmt.Sprintf("no history session matching %q", requested)}
	case 1:
		return matches[0], nil
	default:
		return "", &optionError{message: fmt.Sprintf("ambiguous history session prefix %q", requested)}
	}
}

func makeSnippet(text string, matchStart, matchEnd int) string {
	if matchStart < 0 || matchEnd < matchStart || matchEnd > len(text) {
		return ""
	}
	startRune := utf8.RuneCountInString(text[:matchStart])
	endRune := startRune + utf8.RuneCountInString(text[matchStart:matchEnd])
	runes := []rune(text)
	matchRunes := endRune - startRune
	if matchRunes >= MaxSnippetRunes {
		highlight := runes[startRune : startRune+MaxSnippetRunes-1]
		return "[[" + collapseWhitespace(string(highlight)) + "…]]"
	}
	contextBudget := MaxSnippetRunes - matchRunes
	leftBudget := min(SnippetContext, contextBudget/2)
	rightBudget := min(SnippetContext, contextBudget-leftBudget)
	leftAvailable := startRune
	rightAvailable := len(runes) - endRune
	if leftAvailable < leftBudget {
		rightBudget = min(rightAvailable, rightBudget+(leftBudget-leftAvailable))
		leftBudget = leftAvailable
	}
	if rightAvailable < rightBudget {
		leftBudget = min(leftAvailable, leftBudget+(rightBudget-rightAvailable))
		rightBudget = rightAvailable
	}
	start := startRune - leftBudget
	end := endRune + rightBudget
	var output strings.Builder
	if start > 0 {
		output.WriteRune('…')
	}
	output.WriteString(string(runes[start:startRune]))
	output.WriteString("[[")
	output.WriteString(string(runes[startRune:endRune]))
	output.WriteString("]]")
	output.WriteString(string(runes[endRune:end]))
	if end < len(runes) {
		output.WriteRune('…')
	}
	return collapseWhitespace(output.String())
}

func collapseWhitespace(value string) string {
	return strings.Join(strings.FieldsFunc(value, unicode.IsSpace), " ")
}
