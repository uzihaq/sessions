package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

var keyBytes = map[string]string{
	"esc": "\x1b", "escape": "\x1b", "up": "\x1b[A", "down": "\x1b[B",
	"left": "\x1b[D", "right": "\x1b[C", "^c": "\x03", "ctrlc": "\x03",
	"^d": "\x04", "ctrld": "\x04", "enter": "\r", "tab": "\t",
}

var keyOrder = []string{"esc", "escape", "up", "down", "left", "right", "^c", "ctrlc", "^d", "ctrld", "enter", "tab"}

func (a *app) cmdKeys(args []string) error {
	if len(args) < 2 || args[0] == "" || args[1] == "" {
		return fail(1, "usage: pretty keys <id> <esc|up|down|left|right|^c|^d|enter|tab>")
	}
	data, ok := keyBytes[strings.ToLower(args[1])]
	if !ok {
		return fail(1, "unknown key '%s'. valid: %s", args[1], strings.Join(keyOrder, ", "))
	}
	id, err := a.resolveSessionID(args[0])
	if err != nil {
		return err
	}
	return a.postJSON("/api/sessions/"+escapeID(id)+"/input", map[string]string{"data": data}, &map[string]any{}, 2)
}

type toolPreset struct {
	command  string
	args     []string
	safeArgs []string
}

var toolPresets = map[string]toolPreset{
	"claude": {
		command: "claude", args: []string{"--dangerously-skip-permissions"}, safeArgs: []string{},
	},
	"codex": {
		command:  "codex",
		args:     []string{"-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"},
		safeArgs: []string{"-c", "check_for_update_on_startup=false", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"},
	},
	"shell": {},
}

var toolPresetOrder = []string{"claude", "codex", "shell"}

type createSessionRequest struct {
	Cmd         string   `json:"cmd,omitempty"`
	Args        []string `json:"args,omitempty"`
	Cwd         string   `json:"cwd,omitempty"`
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description,omitempty"`
	Profile     string   `json:"profile,omitempty"`
	Worktree    bool     `json:"worktree,omitempty"`
	Base        string   `json:"base,omitempty"`
	OnIdle      string   `json:"onIdle,omitempty"`
	WaitReady   bool     `json:"waitReady,omitempty"`
	Kind        string   `json:"kind,omitempty"`
	Force       bool     `json:"force,omitempty"`
}

type agentControls struct {
	model  *string
	effort *string
	fast   bool
}

func applyToolDefault(body *createSessionRequest, noSkipPermissions bool) error {
	if body.Cmd == "" {
		return nil
	}
	base := strings.ToLower(filepath.Base(body.Cmd))
	preset, ok := toolPresets[base]
	if !ok || preset.args == nil {
		return nil
	}
	for _, argument := range body.Args {
		switch argument {
		case "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "--sandbox", "--ask-for-approval", "--full-auto":
			return nil
		}
	}
	defaults := preset.args
	if noSkipPermissions {
		defaults = preset.safeArgs
	}
	body.Args = append(append([]string(nil), defaults...), body.Args...)
	if base == "claude" && !hasAnyArg(body.Args, "--session-id", "--resume") {
		id, err := randomUUID()
		if err != nil {
			return err
		}
		body.Args = append(body.Args, "--session-id", id)
	}
	return nil
}

func hasAnyArg(args []string, values ...string) bool {
	for _, arg := range args {
		for _, value := range values {
			if arg == value {
				return true
			}
		}
	}
	return false
}

func hasArgValue(args []string, values ...string) bool {
	for index, arg := range args {
		for _, value := range values {
			if arg == value && index+1 < len(args) {
				return true
			}
		}
	}
	return false
}

func hasConfigValue(args []string, key string) bool {
	for index, arg := range args {
		if (arg == "-c" || arg == "--config") && index+1 < len(args) && strings.HasPrefix(args[index+1], key+"=") {
			return true
		}
	}
	return false
}

func applyAgentControls(body *createSessionRequest, controls agentControls) error {
	if controls.model == nil && controls.effort == nil && !controls.fast {
		return nil
	}
	base := "shell"
	if body.Cmd != "" {
		base = strings.ToLower(filepath.Base(body.Cmd))
	}
	if base != "claude" && base != "codex" {
		return fail(1, "--model, --effort, and --fast are only for claude/codex")
	}
	if base == "claude" && controls.fast {
		return fail(1, "--fast is not supported for claude (claude has no service tier)")
	}
	if controls.model != nil && !hasArgValue(body.Args, "--model", "-m") {
		body.Args = append(body.Args, "--model", *controls.model)
	}
	if controls.effort != nil {
		if base == "claude" && !hasArgValue(body.Args, "--effort") {
			body.Args = append(body.Args, "--effort", *controls.effort)
		} else if base == "codex" && !hasConfigValue(body.Args, "model_reasoning_effort") {
			body.Args = append(body.Args, "-c", fmt.Sprintf("model_reasoning_effort=\"%s\"", *controls.effort))
		}
	}
	if controls.fast && !hasConfigValue(body.Args, "service_tier") {
		body.Args = append(body.Args, "-c", "service_tier=\"priority\"")
	}
	return nil
}

func pluckControl(args *[]string, name string) (*string, error) {
	for index, arg := range *args {
		if arg != name {
			continue
		}
		if index+1 >= len(*args) || strings.HasPrefix((*args)[index+1], "--") {
			return nil, fail(1, "%s needs a value", name)
		}
		value := (*args)[index+1]
		*args = append((*args)[:index], (*args)[index+2:]...)
		return &value, nil
	}
	return nil, nil
}

func pluckDescription(args *[]string) (string, error) {
	description, full := pluck(args, "--description")
	alias, short := pluck(args, "--desc")
	if full && short {
		return "", fail(1, "--description and --desc cannot be combined")
	}
	if short {
		description = alias
	}
	if (full || short) && strings.TrimSpace(description) == "" {
		return "", fail(1, "--description needs a non-empty purpose")
	}
	return strings.TrimSpace(description), nil
}

func pluckWorktreeOptions(args *[]string) (bool, string, error) {
	worktree := removeFirst(args, "--worktree")
	base, hasBase := pluck(args, "--base")
	base = strings.TrimSpace(base)
	if hasBase && (base == "" || strings.HasPrefix(base, "-")) {
		return false, "", fail(1, "--base needs a branch or ref")
	}
	if hasBase && !worktree {
		return false, "", fail(1, "--base requires --worktree")
	}
	return worktree, base, nil
}

func (a *app) cmdNew(args []string) error {
	if err := a.configureCreateOwner(&args); err != nil {
		return err
	}
	var body createSessionRequest
	description, err := pluckDescription(&args)
	if err != nil {
		return err
	}
	body.Description = description
	if value, present := pluck(&args, "--profile"); present {
		if strings.HasPrefix(value, "-") || value == "" {
			return fail(1, "--profile needs a name")
		}
		if err := state.ValidateProfileName(value); err != nil {
			return fail(1, "%s", err)
		}
		body.Profile = value
	}
	body.Worktree, body.Base, err = pluckWorktreeOptions(&args)
	if err != nil {
		return err
	}
	body.Force = removeFirst(&args, "--force")
	forceStructuredClaude := removeFirst(&args, "--structured")
	forceAppServer := removeFirst(&args, "--codex-appserver")
	forcePTYCodex := removeFirst(&args, "--pty-codex")
	if forceAppServer && forcePTYCodex {
		return fail(1, "--codex-appserver and --pty-codex cannot be combined")
	}
	model, err := pluckControl(&args, "--model")
	if err != nil {
		return err
	}
	effort, err := pluckControl(&args, "--effort")
	if err != nil {
		return err
	}
	fast := removeFirst(&args, "--fast")
	if value, present := pluck(&args, "--cwd"); present {
		body.Cwd = value
	}
	if value, present := pluck(&args, "--name"); present {
		if strings.TrimSpace(value) == "" {
			return fail(1, "--name needs a non-empty label")
		}
		body.Name = strings.TrimSpace(value)
	}
	if value, present := pluck(&args, "--on-idle"); present {
		if strings.TrimSpace(value) == "" {
			return fail(1, "--on-idle needs a shell command")
		}
		body.OnIdle = value
	}
	body.WaitReady = removeFirst(&args, "--wait-ready")
	tool, hasTool := pluck(&args, "--tool")
	noSkipPermissions := removeFirst(&args, "--no-skip-perms")
	if hasTool {
		preset, ok := toolPresets[strings.ToLower(tool)]
		if !ok {
			return fail(1, "unknown --tool '%s'. valid: %s", tool, strings.Join(toolPresetOrder, ", "))
		}
		body.Cmd = preset.command
		chosen := preset.args
		if noSkipPermissions {
			chosen = preset.safeArgs
		}
		if chosen != nil {
			body.Args = append([]string(nil), chosen...)
		}
		body.Args = append(body.Args, args...)
		if strings.EqualFold(tool, "codex") {
			if forceStructuredClaude {
				return fail(1, "--structured is only valid with --tool claude")
			}
			if forceAppServer && noSkipPermissions {
				return fail(1, "--codex-appserver requires skip-permissions mode; remove --no-skip-perms or use --pty-codex")
			}
			if !noSkipPermissions && !forcePTYCodex && (forceAppServer || codexAppServerEnabled()) {
				body.Kind = "codex-app-server"
			}
		} else if forceAppServer || forcePTYCodex {
			return fail(1, "--codex-appserver and --pty-codex are only valid with --tool codex")
		}
		if strings.EqualFold(tool, "claude") {
			if forceStructuredClaude {
				body.Kind = "claude-structured"
			}
		} else if forceStructuredClaude {
			return fail(1, "--structured is only valid with --tool claude")
		}
		if strings.EqualFold(tool, "claude") && !hasAnyArg(body.Args, "--session-id", "--resume", "-r") {
			id, err := randomUUID()
			if err != nil {
				return err
			}
			body.Args = append(body.Args, "--session-id", id)
		}
	} else {
		if forceAppServer || forcePTYCodex {
			return fail(1, "--codex-appserver and --pty-codex require --tool codex")
		}
		if forceStructuredClaude {
			return fail(1, "--structured requires --tool claude")
		}
		if command, present := pluck(&args, "--cmd"); present {
			body.Cmd = command
			body.Args = append([]string(nil), args...)
		} else if len(args) > 0 {
			body.Cmd = args[0]
			body.Args = append([]string(nil), args[1:]...)
		}
		if err := applyToolDefault(&body, noSkipPermissions); err != nil {
			return err
		}
	}
	if err := applyAgentControls(&body, agentControls{model: model, effort: effort, fast: fast}); err != nil {
		return err
	}
	if body.Profile != "" {
		tool := state.CommandTool(body.Cmd)
		if _, supported := state.ProfileToolName(tool); !supported {
			return fail(1, "--profile is only for Claude or Codex sessions; remove it for shell sessions")
		}
	}
	if body.Worktree {
		if body.Cwd == "" {
			body.Cwd, err = os.Getwd()
		} else {
			body.Cwd, err = filepath.Abs(body.Cwd)
		}
		if err != nil {
			return fail(1, "resolve worktree source cwd: %s", err)
		}
	}
	var info map[string]any
	if err := a.postJSON("/api/sessions", body, &info, 2); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, info, true)
	}
	_, err = fmt.Fprintln(a.stdout, info["id"])
	return err
}

func codexAppServerEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PRETTY_CODEX_APPSERVER"))) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func (a *app) cmdModel(args []string) error {
	if len(args) < 2 || args[0] == "" || args[1] == "" {
		return fail(1, "usage: pretty model <session> <model> [--effort <level>]")
	}
	idArg, model := args[0], args[1]
	args = args[2:]
	effort, present := pluck(&args, "--effort")
	if present && effort == "" {
		return fail(1, "--effort needs a value")
	}
	if len(args) > 0 {
		return fail(1, "usage: pretty model <session> <model> [--effort <level>]")
	}
	id, err := a.resolveSessionID(idArg)
	if err != nil {
		return err
	}
	sessions, err := a.listSessions(true)
	if err != nil {
		return err
	}
	var current *session
	for index := range sessions {
		if sessions[index].ID == id {
			current = &sessions[index]
			break
		}
	}
	if current == nil {
		return fail(1, "%s", unknownSessionMessage(idArg))
	}
	if current.Working {
		return fail(1, "session is mid-turn; try when idle (pretty wait %s)", id)
	}
	tool := toolOfSession(*current)
	if tool == "codex" {
		return fail(1, "live model switch for codex requires an app-server-backed session (coming); use /model in the Terminal view, or respin with: pretty new --tool codex --model <m>")
	}
	if tool != "claude-code" {
		return fail(1, "live model switch is only supported for claude sessions")
	}
	path := "/api/sessions/" + escapeID(id) + "/input"
	command := "/model " + model
	if err := a.postJSON(path, map[string]string{"data": command + "\r"}, &map[string]any{}, 2); err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "sent %s\n", command)
	if present {
		a.sleep(time.Second)
		command = "/effort " + effort
		if err := a.postJSON(path, map[string]string{"data": command + "\r"}, &map[string]any{}, 2); err != nil {
			return err
		}
		fmt.Fprintf(a.stdout, "sent %s\n", command)
	}
	return nil
}

func (a *app) cmdKill(ids []string) error {
	if len(ids) == 0 {
		return fail(1, "usage: pretty kill <id> [<id>...]")
	}
	anyFailed := false
	for _, idArg := range ids {
		laneID, isLane, err := a.resolveLaneID(idArg)
		if err != nil {
			return err
		}
		if isLane {
			_, statusCode, err := a.fetchLaneManifest(context.Background(), laneID)
			if err != nil {
				return err
			}
			if statusCode == http.StatusOK {
				fmt.Fprintf(a.stdout, "lane %s already exited; nothing to kill\n", laneID)
				continue
			}
		}
		id := laneID
		if !isLane {
			id, err = a.resolveSessionID(idArg)
			if err != nil {
				return err
			}
		}
		listed, err := a.listSessions(true)
		if err != nil {
			return err
		}
		alreadyExitedLane := false
		for _, candidate := range listed {
			if candidate.ID == id && candidate.Kind == "lane" && candidate.Exited {
				alreadyExitedLane = true
				break
			}
		}
		if alreadyExitedLane {
			fmt.Fprintf(a.stdout, "lane %s already exited; nothing to kill\n", id)
			continue
		}
		ok, err := a.delete("/api/sessions/" + escapeID(id))
		if err != nil {
			return err
		}
		if ok {
			fmt.Fprintf(a.stdout, "killed %s\n", id)
		} else {
			fmt.Fprintln(a.stderr, unknownSessionMessage(idArg))
			anyFailed = true
		}
	}
	if anyFailed {
		return status(1)
	}
	return nil
}

func (a *app) cmdWait(args []string) error {
	if isWaitUntilArgs(args) {
		return a.cmdWaitUntil(args)
	}
	if len(args) == 0 || args[0] == "" {
		return fail(1, "usage: pretty wait <id> [--idle 2s] [--timeout 30s]")
	}
	idArg := args[0]
	args = args[1:]
	idle := 2 * time.Second
	timeout := 30 * time.Second
	var err error
	if raw, present := pluck(&args, "--idle"); present && raw != "" {
		idle, err = parseDuration(raw, 0)
		if err != nil {
			return err
		}
	}
	if raw, present := pluck(&args, "--timeout"); present && raw != "" {
		timeout, err = parseDuration(raw, 0)
		if err != nil {
			return err
		}
	}
	id, err := a.resolveSessionID(idArg)
	if err != nil {
		return err
	}
	start := a.now()
	poll := idle / 4
	if poll < 100*time.Millisecond {
		poll = 100 * time.Millisecond
	}
	if poll > 500*time.Millisecond {
		poll = 500 * time.Millisecond
	}
	var notWorkingSince time.Time
	for {
		sessions, err := a.listSessions(false)
		if err != nil {
			return err
		}
		var current *session
		for index := range sessions {
			if sessions[index].ID == id {
				current = &sessions[index]
				break
			}
		}
		if current == nil {
			if a.wantJSON {
				return writeJSON(a.stdout, struct {
					OK     bool   `json:"ok"`
					Reason string `json:"reason"`
				}{true, "gone"}, false)
			}
			_, err := io.WriteString(a.stdout, "gone\n")
			return err
		}
		idleFor := time.Duration(0)
		if isConfirmableTool(toolOfSession(*current)) {
			if current.Working {
				notWorkingSince = time.Time{}
			} else if notWorkingSince.IsZero() {
				notWorkingSince = a.now()
			}
			if !notWorkingSince.IsZero() {
				idleFor = a.now().Sub(notWorkingSince)
			}
		} else {
			base := current.LastDataAt
			if base == 0 {
				base = current.CreatedAt
			}
			idleFor = a.now().Sub(time.UnixMilli(base))
		}
		if idleFor >= idle {
			if a.wantJSON {
				return writeJSON(a.stdout, struct {
					OK      bool   `json:"ok"`
					Reason  string `json:"reason"`
					IdleMS  int64  `json:"idleMs"`
					Working bool   `json:"working"`
				}{true, "idle", idleFor.Milliseconds(), current.Working}, false)
			}
			_, err := fmt.Fprintf(a.stdout, "idle for %dms\n", idleFor.Milliseconds())
			return err
		}
		if a.now().Sub(start) >= timeout {
			if a.wantJSON {
				writeJSON(a.stdout, struct {
					OK      bool   `json:"ok"`
					Reason  string `json:"reason"`
					IdleMS  int64  `json:"idleMs"`
					Working bool   `json:"working"`
				}{false, "timeout", idleFor.Milliseconds(), current.Working}, false)
			} else {
				fmt.Fprintf(a.stderr, "timeout: still active after %dms (last %dms ago)\n", timeout.Milliseconds(), idleFor.Milliseconds())
			}
			return status(1)
		}
		a.sleep(poll)
	}
}

func positiveInt(raw, label string) (int, error) {
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fail(1, "%s must be a positive integer", label)
	}
	return value, nil
}

func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}
