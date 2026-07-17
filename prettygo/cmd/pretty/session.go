package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

type session struct {
	ID                string          `json:"id"`
	Name              string          `json:"name,omitempty"`
	Kind              string          `json:"kind,omitempty"`
	Cmd               string          `json:"cmd"`
	Args              []string        `json:"args"`
	Cwd               string          `json:"cwd"`
	Cols              int             `json:"cols"`
	Rows              int             `json:"rows"`
	CreatedAt         int64           `json:"createdAt"`
	PID               int             `json:"pid"`
	Tool              string          `json:"tool"`
	Working           bool            `json:"working"`
	LastDataAt        int64           `json:"lastDataAt"`
	LastUserMessageAt *int64          `json:"lastUserMessageAt"`
	Exited            bool            `json:"exited"`
	ExitCode          *int            `json:"exitCode"`
	ExitSignal        *string         `json:"exitSignal"`
	ExitedAt          *int64          `json:"exitedAt"`
	ConversationID    string          `json:"conversationId,omitempty"`
	RemoteEndpoint    string          `json:"remoteEndpoint,omitempty"`
	ClaudeSessionID   string          `json:"claudeSessionId,omitempty"`
	CreatorKind       string          `json:"creator_kind,omitempty"`
	CreatorID         string          `json:"creator_id,omitempty"`
	ParentSessionID   string          `json:"parent_session_id,omitempty"`
	CreatorAncestry   []string        `json:"creator_ancestry,omitempty"`
	RootCreatorKind   string          `json:"root_creator_kind,omitempty"`
	RootCreatorID     string          `json:"root_creator_id,omitempty"`
	ProvenanceStatus  string          `json:"provenance_status,omitempty"`
	Extra             json.RawMessage `json:"-"`
}

type sessionsResponse struct {
	Sessions []session `json:"sessions"`
}

func (a *app) listSessions(includeExited bool) ([]session, error) {
	path := "/api/sessions"
	if includeExited {
		path += "?include_exited=1"
	}
	var response sessionsResponse
	if err := a.getJSON(path, &response); err != nil {
		return nil, err
	}
	return response.Sessions, nil
}

func classifyTool(command string) string {
	command = strings.ToLower(command)
	if strings.HasSuffix(command, "/claude") || command == "claude" {
		return "claude"
	}
	if strings.HasSuffix(command, "/codex") || command == "codex" {
		return "codex"
	}
	if command == "" {
		return "shell"
	}
	return filepath.Base(command)
}

func toolOfSession(value session) string {
	if value.Tool != "" {
		return value.Tool
	}
	return classifyTool(value.Cmd)
}

func shortToolName(tool string) string {
	if tool == "claude-code" {
		return "claude"
	}
	if tool == "" {
		return "shell"
	}
	return tool
}

func isConfirmableTool(tool string) bool { return tool == "claude-code" || tool == "codex" }

func unknownSessionMessage(id string) string {
	return fmt.Sprintf("no session matching '%s' — it may be a stale id after a daemon restart; run `pretty ls`", id)
}

func (a *app) sessionLabel(value session) string {
	parts := []string{shortToolName(toolOfSession(value))}
	if value.Name != "" {
		parts = append(parts, value.Name)
	}
	if value.Cwd != "" {
		parts = append(parts, strings.Replace(value.Cwd, a.home, "~", 1))
	}
	if value.Exited {
		parts = append(parts, "exited")
	} else if value.Working {
		parts = append(parts, "working")
	} else {
		parts = append(parts, "idle")
	}
	return strings.Join(parts, " ")
}

func (a *app) resolveSessionID(idOrPrefix string) (string, error) {
	sessions, err := a.listSessions(true)
	if err != nil {
		return "", err
	}
	for _, candidate := range sessions {
		if candidate.ID == idOrPrefix {
			return candidate.ID, nil
		}
	}
	matches := make([]session, 0)
	for _, candidate := range sessions {
		if strings.HasPrefix(candidate.ID, idOrPrefix) {
			matches = append(matches, candidate)
		}
	}
	if len(matches) == 1 {
		return matches[0].ID, nil
	}
	if len(matches) == 0 {
		return "", fail(1, "%s", unknownSessionMessage(idOrPrefix))
	}
	var lines strings.Builder
	for _, candidate := range matches {
		fmt.Fprintf(&lines, "  %s  %s\n", prefixString(candidate.ID, 8), a.sessionLabel(candidate))
	}
	return "", fail(1, "ambiguous session prefix '%s' — matches:\n%srun `pretty ls`", idOrPrefix, lines.String())
}

func prefixString(value string, count int) string {
	if len(value) <= count {
		return value
	}
	return value[:count]
}

func (a *app) ageOf(timestamp int64) string {
	seconds := math.Max(0, math.Floor(float64(a.now().UnixMilli()-timestamp)/1000+0.5))
	if seconds < 60 {
		return strconv.FormatInt(int64(seconds), 10) + "s"
	}
	minutes := math.Floor(seconds/60 + 0.5)
	if minutes < 60 {
		return strconv.FormatInt(int64(minutes), 10) + "m"
	}
	hours := math.Floor(minutes/60 + 0.5)
	if hours < 48 {
		return strconv.FormatInt(int64(hours), 10) + "h"
	}
	days := math.Floor(hours/24 + 0.5)
	return strconv.FormatInt(int64(days), 10) + "d"
}

func (a *app) cmdLS(args []string) error {
	includeExited := contains(args, "--include-exited") || contains(args, "-a") || a.wantJSON
	path := "/api/sessions"
	if includeExited {
		path += "?include_exited=1"
	}
	response, err := a.api.request(context.Background(), "GET", path, nil, 0)
	if err != nil {
		return err
	}
	if response.status >= 400 {
		return fail(2, "%s → %d %s", path, response.status, prefixBytes(response.body, 200))
	}
	var raw struct {
		Sessions json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(response.body, &raw); err != nil {
		return err
	}
	var sessions []session
	if err := json.Unmarshal(raw.Sessions, &sessions); err != nil {
		return err
	}
	if a.wantJSON {
		var formatted bytes.Buffer
		if err := json.Indent(&formatted, raw.Sessions, "", "  "); err != nil {
			return err
		}
		formatted.WriteByte('\n')
		_, err := formatted.WriteTo(a.stdout)
		return err
	}
	if len(sessions) == 0 {
		_, err := io.WriteString(a.stdout, "(no sessions)\n")
		return err
	}
	rows := [][]string{{"ID", "NAME", "TOOL", "CWD", "STATE", "AGE", "LAST-USER", "PID"}}
	for _, value := range sessions {
		state := "idle"
		if value.Exited {
			code := "∅"
			if value.ExitCode != nil {
				code = strconv.Itoa(*value.ExitCode)
			}
			signal := ""
			if value.ExitSignal != nil && *value.ExitSignal != "" {
				signal = " " + *value.ExitSignal
			}
			state = "exited(" + code + signal + ")"
		} else if value.Working {
			state = "working"
		}
		name := "-"
		if strings.TrimSpace(value.Name) != "" {
			name = regexp.MustCompile(`\s+`).ReplaceAllString(strings.TrimSpace(value.Name), " ")
		}
		lastUser := "-"
		if value.LastUserMessageAt != nil && *value.LastUserMessageAt != 0 {
			lastUser = a.ageOf(*value.LastUserMessageAt)
		}
		rows = append(rows, []string{
			prefixString(value.ID, 8), name, toolOfSession(value),
			strings.Replace(value.Cwd, a.home, "~", 1), state,
			a.ageOf(value.CreatedAt), lastUser, strconv.Itoa(value.PID),
		})
	}
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for column, cell := range row {
			if jsLength(cell) > widths[column] {
				widths[column] = jsLength(cell)
			}
		}
	}
	for _, row := range rows {
		for column, cell := range row {
			if column > 0 {
				io.WriteString(a.stdout, "  ")
			}
			io.WriteString(a.stdout, cell)
			io.WriteString(a.stdout, strings.Repeat(" ", widths[column]-jsLength(cell)))
		}
		io.WriteString(a.stdout, "\n")
	}
	return nil
}

func jsLength(value string) int { return len(utf16.Encode([]rune(value))) }

var (
	ansiPattern          = regexp.MustCompile("\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07]*\\x07")
	cursorForwardPattern = regexp.MustCompile("\\x1b\\[(\\d+)C")
)

func normalize(value string) string {
	return cursorForwardPattern.ReplaceAllStringFunc(value, func(match string) string {
		parts := cursorForwardPattern.FindStringSubmatch(match)
		count, _ := strconv.Atoi(parts[1])
		return strings.Repeat(" ", count)
	})
}

func cleanANSI(value string) string { return ansiPattern.ReplaceAllString(normalize(value), "") }

func (a *app) cmdSnap(args []string) error {
	if len(args) == 0 || args[0] == "" {
		return fail(1, "usage: pretty snap <id> [--raw]")
	}
	id, err := a.resolveSessionID(args[0])
	if err != nil {
		return err
	}
	text, err := a.getText("/api/sessions/" + escapeID(id) + "/snapshot")
	if err != nil {
		return err
	}
	if !contains(args, "--raw") {
		text = cleanANSI(text)
	}
	io.WriteString(a.stdout, text)
	if !strings.HasSuffix(text, "\n") {
		io.WriteString(a.stdout, "\n")
	}
	return nil
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
