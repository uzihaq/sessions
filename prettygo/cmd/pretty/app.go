package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type cliFailure struct {
	message string
	code    int
	quiet   bool
}

func (e *cliFailure) Error() string { return e.message }

func fail(code int, format string, args ...any) error {
	return &cliFailure{message: fmt.Sprintf(format, args...), code: code}
}

func status(code int) error { return &cliFailure{code: code, quiet: true} }

func exitCode(err error) int {
	var failure *cliFailure
	if errors.As(err, &failure) {
		if failure.code > 0 {
			return failure.code
		}
		return 1
	}
	return 2
}

func writeFailure(stderr io.Writer, err error) {
	var failure *cliFailure
	if errors.As(err, &failure) {
		if failure.quiet || failure.message == "" {
			return
		}
		fmt.Fprintf(stderr, "pretty: %s\n", failure.message)
		return
	}
	fmt.Fprintf(stderr, "pretty: %s\n", err)
}

type app struct {
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer

	args     []string
	sub      string
	host     string
	port     string
	wantJSON bool
	exitCode int
	home     string
	now      func() time.Time
	sleep    func(time.Duration)
	api      *apiClient
}

func newApp(arguments []string, stdin io.Reader, stdout, stderr io.Writer) (*app, error) {
	args := append([]string(nil), arguments...)
	host := readGlobalFlag(&args, "host", getenv("PRETTYD_HOST", "127.0.0.1"))
	port := readGlobalFlag(&args, "port", getenv("PRETTYD_PORT", "8787"))
	wantJSON := removeFirst(&args, "--json")
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve home directory: %w", err)
	}
	app := &app{
		stdin: stdin, stdout: stdout, stderr: stderr,
		args: args, host: host, port: port, wantJSON: wantJSON,
		home: home, now: time.Now, sleep: time.Sleep,
	}
	if len(app.args) > 0 {
		app.sub = app.args[0]
		app.args = app.args[1:]
	}
	client, err := newAPIClient(host, port, filepath.Join(home, ".local", "state", "pretty-PTY", "token"))
	if err != nil {
		return nil, fail(2, "%s", err)
	}
	app.api = client
	return app, nil
}

func (a *app) close() {
	if a.api != nil {
		a.api.close()
	}
}

func (a *app) dispatch() error {
	switch a.sub {
	case "ls":
		return a.cmdLSDispatch(append([]string(nil), a.args...))
	case "lanes":
		return a.cmdLanes(append([]string(nil), a.args...))
	case "backup":
		return a.cmdBackup(append([]string(nil), a.args...))
	case "recall":
		return a.cmdRecall(append([]string(nil), a.args...))
	case "run":
		return a.cmdRun(append([]string(nil), a.args...))
	case "snap":
		return a.cmdSnap(append([]string(nil), a.args...))
	case "send", "input":
		return a.cmdSend(append([]string(nil), a.args...))
	case "last":
		return a.cmdLastDispatch(append([]string(nil), a.args...))
	case "transcript":
		return a.cmdTranscript(append([]string(nil), a.args...))
	case "ask":
		return a.cmdAsk(append([]string(nil), a.args...))
	case "keys":
		return a.cmdKeys(append([]string(nil), a.args...))
	case "new":
		return a.cmdNew(append([]string(nil), a.args...))
	case "move":
		return a.cmdMove(append([]string(nil), a.args...))
	case "recover":
		return a.cmdRecover(append([]string(nil), a.args...))
	case "adopt":
		return a.cmdAdopt(append([]string(nil), a.args...))
	case "verdict":
		return a.cmdVerdict(append([]string(nil), a.args...))
	case "status":
		return a.cmdStatus(append([]string(nil), a.args...))
	case "model":
		return a.cmdModel(append([]string(nil), a.args...))
	case "kill":
		return a.cmdKill(append([]string(nil), a.args...))
	case "tail":
		return a.cmdTail(append([]string(nil), a.args...))
	case "wait":
		return a.cmdWaitDispatch(append([]string(nil), a.args...))
	case "attach":
		return a.cmdAttach(append([]string(nil), a.args...))
	case "resize":
		return a.cmdResize(append([]string(nil), a.args...))
	case "doctor":
		return a.cmdDoctor()
	case "token":
		return a.cmdToken()
	case "install":
		return a.cmdInstall(append([]string(nil), a.args...))
	case "uninstall":
		return a.cmdUninstall(append([]string(nil), a.args...))
	case "deploy":
		return a.cmdDeploy(append([]string(nil), a.args...))
	case "remote":
		return a.cmdRemote(append([]string(nil), a.args...))
	case "version", "--version", "-v":
		_, err := fmt.Fprintln(a.stdout, version)
		return err
	case "", "help", "--help", "-h":
		_, err := io.WriteString(a.stdout, helpText)
		return err
	default:
		return fail(1, "unknown command: %s\n\nrun 'pretty help' for usage", a.sub)
	}
}

func readGlobalFlag(args *[]string, name, fallback string) string {
	flag := "--" + name
	for i, arg := range *args {
		if arg != flag {
			continue
		}
		value := ""
		if i+1 < len(*args) {
			value = (*args)[i+1]
			*args = append((*args)[:i], (*args)[i+2:]...)
		} else {
			*args = (*args)[:i]
		}
		return value
	}
	return fallback
}

func removeFirst(args *[]string, target string) bool {
	for i, arg := range *args {
		if arg == target {
			*args = append((*args)[:i], (*args)[i+1:]...)
			return true
		}
	}
	return false
}

func pluck(args *[]string, target string) (string, bool) {
	for i, arg := range *args {
		if arg != target {
			continue
		}
		if i+1 >= len(*args) {
			*args = (*args)[:i]
			return "", true
		}
		value := (*args)[i+1]
		*args = append((*args)[:i], (*args)[i+2:]...)
		return value, true
	}
	return "", false
}

func (a *app) configureCreateOwner(args *[]string) error {
	owner, explicit := pluck(args, "--owner")
	detach := removeFirst(args, "--detach")
	if !explicit {
		if detach {
			return fail(1, "--detach requires --owner")
		}
		return nil
	}
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return fail(1, "--owner needs a non-empty id")
	}
	if a.api.creatorSession != "" && !detach {
		return fail(1, "--owner conflicts with inherited PRETTY_SESSION_ID; pass --detach to create an external root")
	}
	a.api.ownerID = owner
	return nil
}

func writeJSON(w io.Writer, value any, indent bool) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	if indent {
		encoder.SetIndent("", "  ")
	}
	return encoder.Encode(value)
}

func compactJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

var durationPattern = regexp.MustCompile(`(?i)^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$`)

func parseDuration(raw string, fallback time.Duration) (time.Duration, error) {
	if raw == "" {
		return fallback, nil
	}
	match := durationPattern.FindStringSubmatch(raw)
	if match == nil {
		return 0, fail(1, "bad duration '%s' — try 2s, 500ms, 1m, 30s", raw)
	}
	number, _ := strconv.ParseFloat(match[1], 64)
	multiplier := time.Second
	switch strings.ToLower(match[2]) {
	case "ms":
		multiplier = time.Millisecond
	case "m":
		multiplier = time.Minute
	case "h":
		multiplier = time.Hour
	}
	return time.Duration(number * float64(multiplier)), nil
}

func randomUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

const helpText = `pretty — prettyd CLI
Session ids may be full ids or unique prefixes from ` + "`pretty ls`" + `.

Subcommands:
  ls [-a | --include-exited]  list sessions (default: hides exited)
  lanes [--all | --mine [--owner ID] | --subtree ID] [--direct] [--detach]
                           list headless lanes. Plain lanes/--all is global;
                           --mine follows PRETTY_OWNER_ID, PRETTY_SESSION_ID,
                           then the daemon user. Session ancestry is transitive;
                           --direct limits it to immediate children. Explicit
                           --owner inside a session requires --detach.
  snap <id> [--raw]        print current buffer (default: clean text)
  tail <id> [-f] [-n N]    print last N (default 50) lines; -f to follow
  wait <id> [--idle Ns] [--timeout Ns]
                           block until session has been idle for Ns.
                           Default --idle 2s, default --timeout 30s;
                           --timeout is tunable/uncapped (e.g. 30m).
                           Background use: pretty wait <id> --timeout 1800s &
                           so an orchestrating agent can be re-invoked on completion.
  send <id> [--timeout Ns] [--no-wait] [--file path] <text...>
                           send text + Enter (alias: ` + "`input`" + `).
                           For Claude/Codex sessions: blocks until the
                           event log confirms receipt (default --timeout 10s),
                           or the cleared composer is visibly working.
                           Re-presses Enter only when text is still visible
                           in the composer (anti-duplicate guard).
                           --file reads the message body from UTF-8 file.
                           --no-wait: fire-and-forget (old behavior).
                           Ambiguous timeouts exit 2; definite failures exit 1.
  input <id> <text...>     same as send
  last <id> [--role user|assistant] [-n N]
                           print the last message(s) from the JSONL log.
                           Default: last user + last assistant message.
  transcript <id>          print all user/assistant turns from the event log
                           (clean text; --json emits structured turns).
  ask <id> [--timeout Ns] [--idle Ns] [--wait-timeout Ns] <text...>
                           send (with event confirmation), wait for the tool
                           to finish its reply (working→idle), then print
                           the last assistant message. Claude/Codex only.
  keys <id> <key>          send esc|up|down|left|right|^c|^d|enter|tab
  resize <id> <cols> <rows> resize the session PTY through the daemon
  verdict <id> [--json]    print the latest explicit producer verdict
  verdict emit <id> --json '{...}'
                           append a schemaVersion 1 producer verdict;
                           omit the JSON argument to read it from stdin
  status <id> [--json]     compact session, git, activity, and verdict card
  new --tool <claude|codex|shell> [--cwd P] [--name L]
                           [--model M] [--effort L] [--fast]
                           [--on-idle C] [--wait-ready] [--no-skip-perms]
                           [--codex-appserver|--pty-codex] [--force] [extra args]
  new [--cwd P] [--name L] [--model M] [--effort L] [--fast]
                           [--on-idle C] [--wait-ready] [--cmd C] [args...]
                           create a session.  --tool is the easy path:
                              pretty new --tool claude
                              pretty new --tool claude --cwd ~/foo
                              pretty new --tool codex --no-skip-perms
                           Codex uses the structured app-server by default.
                           PRETTY_CODEX_APPSERVER=0 or --pty-codex restores
                           the original PTY-backed Codex session.
                           --name labels the session in ` + "`pretty ls`" + `.
                           --on-idle runs a shell command on working→idle.
                           --wait-ready waits for tool startup before returning.
                           --force overrides a live/moved conversation guard.
                           or supply --cmd / a positional command directly.
  model <id> <model> [--effort L]
                           switch model/effort on an idle Claude session.
  kill <id> [<id>...]      terminate one or more sessions
  attach <id>              raw two-way stream (Ctrl+Q to detach)
  doctor                   per-session health: QoS (throttled?), spawn
                           path (dist/tsx), flags sessions needing recreate
  token                    print the daemon auth token (paste into web UI)
  install                  register the dev prettyd macOS LaunchAgent and start it
  uninstall                stop and remove the dev prettyd LaunchAgent
  deploy [--repo P] [--no-pull] [--dry-run]
                           canonical safe update: pull, always install both
                           dependency trees, build, smoke-import dist/server.js,
                           then restart, health-check, and verify runners.
                           --no-pull skips only git pull; --dry-run executes
                           only the smoke import and never touches launchd.
  remote enable            expose the daemon over tailnet-only Tailscale HTTPS
  remote disable           remove Pretty's Tailscale Serve HTTPS root handler
  remote status            verify the Serve endpoint and /api/health

Global flags:
  --json   machine-friendly output
  --host   prettyd host (default 127.0.0.1)
  --port   prettyd port (default 8787)
`
