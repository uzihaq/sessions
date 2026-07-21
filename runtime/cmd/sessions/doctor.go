package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/creack/pty"
)

type doctorRow struct {
	ID    string `json:"id"`
	Tool  string `json:"tool"`
	Size  string `json:"size"`
	QoS   string `json:"qos"`
	Spawn string `json:"spawn"`
	OK    bool   `json:"ok"`
}

func (a *app) cmdDoctor() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/true")
	terminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		return fail(2, "PTY preflight failed: %s; run xcode-select --install", err)
	}
	_ = terminal.Close()
	if err := command.Wait(); err != nil && ctx.Err() == nil {
		return fail(2, "PTY preflight failed: %s; run xcode-select --install", err)
	}
	if ctx.Err() != nil {
		return fail(2, "PTY preflight failed: test PTY timed out; run xcode-select --install")
	}
	sessions, err := a.listSessions(false)
	if err != nil {
		return err
	}
	var deep any
	if response, requestErr := a.api.request(context.Background(), "GET", "/api/health/deep", nil, 0); requestErr == nil && response.status < 400 {
		_ = json.Unmarshal(response.body, &deep)
	}
	processTypePattern := regexp.MustCompile(`<key>ProcessType</key>\s*<string>([^<]+)</string>`)
	rows := make([]doctorRow, 0, len(sessions))
	for _, value := range sessions {
		qos := "no-plist"
		plistPath := filepath.Join(a.home, "Library", "LaunchAgents", "tech.somewhere.sessions.runner."+value.ID+".plist")
		if encoded, readErr := os.ReadFile(plistPath); readErr == nil {
			match := processTypePattern.FindSubmatch(encoded)
			if match != nil {
				qos = string(match[1])
			} else {
				qos = "none"
			}
		}
		spawn := "dead?"
		if value.PID != 0 {
			parent := psField("ppid=", value.PID)
			parentPID, _ := strconv.Atoi(strings.TrimSpace(parent))
			parentCommand := ""
			if parentPID != 0 {
				parentCommand = psField("command=", parentPID)
			}
			switch {
			case strings.Contains(parentCommand, "dist/runner.js"):
				spawn = "dist"
			case regexp.MustCompile(`\btsx\b`).MatchString(parentCommand):
				spawn = "tsx-SLOW"
			case parentCommand != "":
				spawn = "other"
			}
		}
		rows = append(rows, doctorRow{
			ID: value.ID, Tool: toolOfSession(value), Size: fmt.Sprintf("%dx%d", value.Cols, value.Rows),
			QoS: qos, Spawn: spawn, OK: qos == "Interactive" && spawn == "dist",
		})
	}
	if a.wantJSON {
		return writeJSON(a.stdout, struct {
			Daemon   any         `json:"daemon"`
			Sessions []doctorRow `json:"sessions"`
		}{deep, rows}, true)
	}
	if deepMap, ok := deep.(map[string]any); ok {
		fmt.Fprintf(a.stdout, "daemon: %s sessions, discovering=%s, uptime=%ss\n\n",
			jsonScalar(deepMap["sessionsLoaded"]), jsonScalar(deepMap["discovering"]), jsonScalar(deepMap["uptimeSec"]))
	}
	fmt.Fprintf(a.stdout, "%s%s%s%s%sSTATUS\n",
		fixedWidth("ID", 10), fixedWidth("TOOL", 8), fixedWidth("SIZE", 10), fixedWidth("QoS", 13), fixedWidth("SPAWN", 10))
	bad := 0
	for _, row := range rows {
		statusText := "ok"
		if !row.OK {
			statusText = "⚠ needs recreate"
			bad++
		}
		fmt.Fprintf(a.stdout, "%s%s%s%s%s%s\n",
			fixedWidth(prefixString(row.ID, 8), 10), fixedWidth(shortToolName(row.Tool), 8),
			fixedWidth(row.Size, 10), fixedWidth(row.QoS, 13), fixedWidth(row.Spawn, 10), statusText)
	}
	fmt.Fprintf(a.stdout, "\n%d of %d sessions need recreate ", bad, len(rows))
	if bad > 0 {
		io.WriteString(a.stdout, "(throttled QoS and/or slow tsx spawn — recreate them or do a full app restart for the fast path).\n")
		a.exitCode = 1
	} else {
		io.WriteString(a.stdout, "— all healthy (Interactive QoS, fast dist spawn).\n")
	}
	return nil
}

func psField(format string, pid int) string {
	output, err := exec.Command("ps", "-o", format, "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func fixedWidth(value string, width int) string {
	if jsLength(value) >= width {
		units := 0
		var truncated strings.Builder
		for _, char := range value {
			charUnits := jsLength(string(char))
			if units+charUnits > width-1 {
				break
			}
			truncated.WriteRune(char)
			units += charUnits
		}
		value = truncated.String()
	}
	return value + strings.Repeat(" ", width-jsLength(value))
}

func jsonScalar(value any) string {
	switch typed := value.(type) {
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
	}
	return fmt.Sprint(value)
}
