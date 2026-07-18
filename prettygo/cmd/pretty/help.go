package main

import (
	"fmt"
	"io"
	"strings"
)

type commandSpec struct {
	name      string
	usage     string
	summary   string
	longHelp  string
	examples  []string
	group     string
	aliases   []string
	localJSON bool
	run       func(*app, []string) error
}

const (
	dailyCommandGroup = "Daily workflows"
	modelCommandGroup = "Models and interactive"
	adminCommandGroup = "Admin/operational"
)

// commandTable is the single source of truth for command discovery, dispatch,
// top-level help, and per-command help. Keep the daily path first.
var commandTable = []commandSpec{
	{
		name: "new", usage: "new [--tool claude|codex|shell] [--cwd P] [--name L] [--description PURPOSE] [options] [args...]",
		summary: "create an interactive session", group: dailyCommandGroup,
		longHelp: "Create a session. --tool selects a built-in Claude, Codex, or shell preset; --cmd supplies a command directly. --description (alias --desc) records why the session exists. Session controls include --model, --effort, --fast, --on-idle, --wait-ready, and --force.",
		examples: []string{"pretty new --tool claude --cwd ~/work", "pretty new --tool codex --model gpt-5-codex", "pretty new --cmd /bin/zsh"},
		run:      (*app).cmdNew,
	},
	{
		name: "run", usage: "run [--name N] [--description PURPOSE] [--cwd D] [--spec FILE] [--wait [--output]] -- <cmd args...>",
		summary: "run a command in a headless lane", group: dailyCommandGroup,
		longHelp: "Create a headless lane for the command following the first -- separator. --description (alias --desc) records why the lane exists. Every child argument after that separator is passed unchanged. Without --wait, print the lane id and return. --wait blocks for completion and propagates the child exit code; --output prints the captured output tail.",
		examples: []string{"pretty run -- make test", "pretty run --name lint --wait --output -- npm run lint", "pretty --json run --wait -- sh -c 'exit 3'"},
		run:      (*app).cmdRun,
	},
	{
		name: "ls", usage: "ls [--mine | --all] [-a | --include-exited]",
		summary: "list sessions", group: dailyCommandGroup, localJSON: true,
		longHelp: "List agent sessions known to the daemon. --mine follows PRETTY_OWNER_ID, then the PRETTY_SESSION_ID descendant subtree, then the daemon OS user. The OS-user fallback is user-wide, not invocation-scoped. Exited sessions are hidden by default; -a and --include-exited include them.",
		examples: []string{"pretty ls", "pretty ls --mine", "pretty --json ls"}, run: (*app).cmdLSDispatch,
	},
	{
		name: "sessions", usage: "sessions [--mine | --owner ID | --all] [--include-closed]",
		summary: "list agent sessions and headless lanes", group: dailyCommandGroup, localJSON: true,
		longHelp: "List agent sessions and headless lanes together. --mine follows PRETTY_OWNER_ID, then the PRETTY_SESSION_ID descendant subtree, then the daemon OS user. The OS-user fallback is user-wide, not invocation-scoped. Closed records are hidden unless --include-closed is supplied.",
		examples: []string{"pretty sessions --mine", "pretty sessions --mine --include-closed", "pretty sessions --owner team:mine"}, run: (*app).cmdSessions,
	},
	{
		name: "lanes", usage: "lanes [--all | --mine [--owner ID] | --subtree ID] [--direct] [--detach]",
		summary: "list headless lanes", group: dailyCommandGroup, localJSON: true,
		longHelp: "List retained headless lanes. --mine follows PRETTY_OWNER_ID, then the PRETTY_SESSION_ID descendant subtree, then the daemon OS user. The OS-user fallback is user-wide, not invocation-scoped. --subtree selects session ancestry; --direct limits ancestry to immediate children.",
		examples: []string{"pretty lanes", "pretty lanes --mine", "pretty lanes --subtree 0123abcd --direct"}, run: (*app).cmdLanes,
	},
	{
		name: "send", usage: "send <id> [--timeout D] [--no-wait] [--file PATH] <text...>",
		summary: "send text and Enter to a session", group: dailyCommandGroup,
		longHelp: "Send a message and Enter. Claude and Codex sessions wait for receipt confirmation by default; --no-wait uses fire-and-forget behavior and --file reads the message body from a UTF-8 file.",
		examples: []string{"pretty send 0123abcd 'Run the focused tests.'", "pretty send 0123abcd --file prompt.md"}, run: (*app).cmdSend,
	},
	{
		name: "ask", usage: "ask <id> [--timeout D] [--idle D] [--wait-timeout D] <text...>",
		summary: "send, wait, and print the reply", group: dailyCommandGroup,
		longHelp: "Send a confirmed message to a Claude or Codex session, wait for the reply to finish, and print the last assistant message.",
		examples: []string{"pretty ask 0123abcd 'Summarize the failing test.'", "pretty --json ask 0123abcd --wait-timeout 2m 'Report status.'"}, run: (*app).cmdAsk,
	},
	{
		name: "wait", usage: "wait <id> [<id>... --any] [--idle D] [--timeout D] [condition]",
		summary: "wait for session idle or lane exit", group: dailyCommandGroup, localJSON: true,
		longHelp: "Wait for a session to become idle or a lane to exit. Lane waits propagate the lane exit code. Conditions include --until commit, --until-file-contains FILE STRING, and --until-idle-stable D.",
		examples: []string{"pretty wait 0123abcd --timeout 2m", "pretty wait lane-a lane-b --any", "pretty wait 0123abcd --until commit --timeout 10m"}, run: (*app).cmdWaitDispatch,
	},
	{
		name: "last", usage: "last <id> [--role user|assistant] [-n N]",
		summary: "print recent conversation or lane output", group: dailyCommandGroup, localJSON: true,
		longHelp: "For sessions, print recent user and assistant messages from the event log. For completed lanes, print the captured output tail.",
		examples: []string{"pretty last 0123abcd", "pretty last 0123abcd --role assistant -n 1", "pretty --json last 0123abcd"}, run: (*app).cmdLastDispatch,
	},
	{
		name: "status", usage: "status <id>",
		summary: "show a compact session status card", group: dailyCommandGroup, localJSON: true,
		longHelp: "Show session state, tool, working directory, git state, activity timestamps, and the latest explicit verdict when present.",
		examples: []string{"pretty status 0123abcd", "pretty --json status 0123abcd"}, run: (*app).cmdStatus,
	},
	{
		name: "kill", usage: "kill <id> [<id>...]",
		summary: "terminate sessions or lanes", group: dailyCommandGroup,
		longHelp: "Resolve each id or unique prefix and request termination. The command exits nonzero if a requested target cannot be terminated.",
		examples: []string{"pretty kill 0123abcd", "pretty kill 0123abcd 89abcdef"}, run: (*app).cmdKill,
	},
	{
		name: "recover", usage: "recover [--all | --reopen [--force]]",
		summary: "inspect or reopen recoverable sessions", group: dailyCommandGroup, localJSON: true,
		longHelp: "List actionable recovery recipes. --all also shows blocked and unresumable lost records with reasons. --reopen creates replacement sessions for eligible records; --force overrides the live or moved conversation guard.",
		examples: []string{"pretty recover", "pretty recover --all", "pretty recover --reopen", "pretty --json recover --reopen --force"}, run: (*app).cmdRecover,
	},
	{
		name: "recall", usage: "recall [<full-session-id> [--raw]]",
		summary: "inspect integration recall data", group: dailyCommandGroup, localJSON: true,
		longHelp: "Show the integration-backed recall view, optionally for one full session id. --raw prints the source payload.",
		examples: []string{"pretty recall", "pretty recall 00000000-0000-4000-8000-000000000001 --raw"}, run: (*app).cmdRecall,
	},
	{
		name: "snap", usage: "snap <id> [--raw]",
		summary: "print the current terminal buffer", group: dailyCommandGroup,
		longHelp: "Print the current terminal snapshot. The default cleans terminal control sequences; --raw preserves the daemon response.",
		examples: []string{"pretty snap 0123abcd", "pretty snap 0123abcd --raw"}, run: (*app).cmdSnap,
	},
	{
		name: "tail", usage: "tail <id> [-f] [-n N]",
		summary: "print or follow recent terminal lines", group: dailyCommandGroup,
		longHelp: "Print the last N terminal lines, defaulting to 50. -f keeps following new output.",
		examples: []string{"pretty tail 0123abcd", "pretty tail 0123abcd -n 200 -f"}, run: (*app).cmdTail,
	},
	{
		name: "transcript", usage: "transcript <id>",
		summary: "print the full conversation transcript", group: dailyCommandGroup, localJSON: true,
		longHelp: "Print all user and assistant turns decoded from the session event log. Use the global --json flag for structured turns.",
		examples: []string{"pretty transcript 0123abcd", "pretty --json transcript 0123abcd"}, run: (*app).cmdTranscript,
	},
	{
		name: "input", usage: "input <id> [send options] <text...>",
		summary: "alias for send", group: dailyCommandGroup,
		longHelp: "Send text and Enter using the same confirmation behavior and options as pretty send.",
		examples: []string{"pretty input 0123abcd 'Continue.'"}, run: (*app).cmdSend,
	},
	{
		name: "keys", usage: "keys <id> <esc|up|down|left|right|^c|^d|enter|tab>",
		summary: "send a named key to a session", group: dailyCommandGroup,
		longHelp: "Translate a supported key name to terminal bytes and send it to the session.",
		examples: []string{"pretty keys 0123abcd esc", "pretty keys 0123abcd ^c"}, run: (*app).cmdKeys,
	},
	{
		name: "resize", usage: "resize <id> <cols> <rows>",
		summary: "resize a session PTY", group: dailyCommandGroup, localJSON: true,
		longHelp: "Resize the terminal associated with a session to the requested columns and rows.",
		examples: []string{"pretty resize 0123abcd 160 48"}, run: (*app).cmdResize,
	},
	{
		name: "verdict", usage: "verdict <id> | verdict emit <id> [JSON]",
		summary: "read or emit an explicit producer verdict", group: dailyCommandGroup, localJSON: true,
		longHelp: "Print the latest verdict for a session or lane. verdict emit appends a schemaVersion 1 verdict, reading JSON from the argument or standard input.",
		examples: []string{"pretty verdict 0123abcd", "pretty --json verdict emit 0123abcd '{\"schemaVersion\":1,\"verdict\":\"pass\",\"findings\":[]}'"}, run: (*app).cmdVerdict,
	},
	{
		name: "move", usage: "move <session> --to <target-endpoint> [--token T] [--dry-run] [--allow-dirty]",
		summary: "move a session to another endpoint", group: dailyCommandGroup, localJSON: true,
		longHelp: "Validate and transfer a session to another Pretty endpoint. --dry-run reports the plan; --allow-dirty permits a dirty working tree.",
		examples: []string{"pretty move 0123abcd --to https://pretty.example", "pretty move 0123abcd --to https://pretty.example --dry-run"}, run: (*app).cmdMove,
	},
	{
		name: "adopt", usage: "adopt <path-or-uuid> [--force]",
		summary: "bind an existing conversation into Pretty", group: dailyCommandGroup, localJSON: true,
		longHelp: "Adopt an existing conversation path or UUID as a Pretty session. --force overrides the live or moved conversation guard.",
		examples: []string{"pretty adopt 00000000-0000-4000-8000-000000000001", "pretty adopt ~/.claude/projects/example/session.jsonl --force"}, run: (*app).cmdAdopt,
	},
	{
		name: "model", usage: "model <session> <model> [--effort LEVEL]",
		summary: "switch an idle session model", group: modelCommandGroup,
		longHelp: "Switch the model, and optionally effort, for an idle supported session.",
		examples: []string{"pretty model 0123abcd sonnet", "pretty model 0123abcd opus --effort high"}, run: (*app).cmdModel,
	},
	{
		name: "models", usage: "models",
		summary: "list the live Codex model catalog", group: modelCommandGroup, localJSON: true,
		longHelp: "Query the Codex app-server model catalog, including supported efforts and service tiers. Use the global --json flag for the full structured catalog.",
		examples: []string{"pretty models", "pretty --json models"}, run: (*app).cmdModels,
	},
	{
		name: "attach", usage: "attach <id>",
		summary: "attach a raw two-way terminal stream", group: modelCommandGroup,
		longHelp: "Attach the local terminal to a session. Press Ctrl+Q to detach without terminating the session.",
		examples: []string{"pretty attach 0123abcd"}, run: (*app).cmdAttach,
	},
	{
		name: "install", usage: "install",
		summary: "install and start the development daemon", group: adminCommandGroup,
		longHelp: "Register the development prettyd macOS LaunchAgent and start it.",
		examples: []string{"pretty install"}, run: (*app).cmdInstall,
	},
	{
		name: "uninstall", usage: "uninstall",
		summary: "stop and remove the development daemon", group: adminCommandGroup,
		longHelp: "Stop and remove the development prettyd macOS LaunchAgent.",
		examples: []string{"pretty uninstall"}, run: (*app).cmdUninstall,
	},
	{
		name: "deploy", usage: "deploy [--repo DIR] [--no-pull] [--dry-run]",
		summary: "perform the canonical safe update", group: adminCommandGroup,
		longHelp: "Update dependencies, build, smoke-test, restart, health-check, and verify runners. --no-pull skips git pull; --dry-run performs only non-mutating validation.",
		examples: []string{"pretty deploy", "pretty deploy --repo ~/src/pretty-PTY --no-pull", "pretty deploy --dry-run"}, run: (*app).cmdDeploy,
	},
	{
		name: "remote", usage: "remote <enable|disable|status>",
		summary: "manage tailnet-only remote access", group: adminCommandGroup, localJSON: true,
		longHelp: "Enable, disable, or inspect the Tailscale Serve HTTPS endpoint used for Pretty remote access.",
		examples: []string{"pretty remote enable", "pretty remote status", "pretty remote disable"}, run: (*app).cmdRemote,
	},
	{
		name: "token", usage: "token",
		summary: "print the daemon authentication token", group: adminCommandGroup,
		longHelp: "Read and print the local daemon token for use by an authorized Pretty client.",
		examples: []string{"pretty token"}, run: func(a *app, _ []string) error { return a.cmdToken() },
	},
	{
		name: "backup", usage: "backup <enable|now|status> [options]",
		summary: "configure and run session backups", group: adminCommandGroup, localJSON: true,
		longHelp: "Enable scheduled backup storage, push a backup immediately, or show backup status. Enable requires --project and accepts --interval.",
		examples: []string{"pretty backup enable --project my-project --interval 15m", "pretty backup now", "pretty --json backup status"}, run: (*app).cmdBackup,
	},
	{
		name: "doctor", usage: "doctor",
		summary: "diagnose daemon and session health", group: adminCommandGroup, localJSON: true,
		longHelp: "Report per-session health, spawn path, QoS state, and sessions which should be recreated.",
		examples: []string{"pretty doctor", "pretty --json doctor"}, run: func(a *app, _ []string) error { return a.cmdDoctor() },
	},
	{
		name: "help", usage: "help [command]",
		summary: "show top-level or command help", group: adminCommandGroup,
		longHelp: "Show complete command help, or detailed help for one command. pretty <command> --help is equivalent.",
		examples: []string{"pretty help", "pretty help run", "pretty recover --help"}, run: func(_ *app, _ []string) error { return nil },
	},
	{
		name: "version", usage: "version",
		summary: "print the CLI version", group: adminCommandGroup, aliases: []string{"--version", "-v"},
		longHelp: "Print the Pretty CLI version and exit.",
		examples: []string{"pretty version", "pretty --version"}, run: func(a *app, _ []string) error { _, err := fmt.Fprintln(a.stdout, version); return err },
	},
}

func lookupCommand(name string) (commandSpec, bool) {
	for _, command := range commandTable {
		if command.name == name {
			return command, true
		}
		for _, alias := range command.aliases {
			if alias == name {
				return command, true
			}
		}
	}
	return commandSpec{}, false
}

func helpRequested(args []string) bool {
	for _, argument := range args {
		if argument == "--" {
			return false
		}
		if argument == "--help" || argument == "-h" {
			return true
		}
	}
	return false
}

func writeTopLevelHelp(writer io.Writer) error {
	if _, err := io.WriteString(writer, "pretty — prettyd CLI\n\nUsage:\n  pretty [global flags] <command> [args]\n  pretty help <command>\n\nSession ids may be full ids or unique prefixes from `pretty ls`.\n"); err != nil {
		return err
	}
	groups := []string{dailyCommandGroup, modelCommandGroup, adminCommandGroup}
	for _, group := range groups {
		if _, err := fmt.Fprintf(writer, "\n%s:\n", group); err != nil {
			return err
		}
		for _, command := range commandTable {
			if command.group != group {
				continue
			}
			name := command.name
			if len(command.aliases) > 0 {
				name += " (" + strings.Join(command.aliases, ", ") + ")"
			}
			if _, err := fmt.Fprintf(writer, "  %-24s %s\n", name, command.summary); err != nil {
				return err
			}
		}
	}
	_, err := io.WriteString(writer, "\nGlobal flags (must precede the command):\n  --json           machine-friendly output\n  --host HOST      prettyd host (default 127.0.0.1)\n  --port PORT      prettyd port (default 8787)\n\nRun `pretty help <command>` for usage, options, and examples.\n")
	return err
}

func writeCommandHelp(writer io.Writer, name string) error {
	command, ok := lookupCommand(name)
	if !ok {
		return fail(1, "unknown help topic: %s\n\nrun 'pretty help' for commands", name)
	}
	if _, err := fmt.Fprintf(writer, "Usage:\n  pretty %s\n\n%s\n\n%s\n", command.usage, command.summary, command.longHelp); err != nil {
		return err
	}
	if len(command.examples) > 0 {
		if _, err := io.WriteString(writer, "\nExamples:\n"); err != nil {
			return err
		}
		for _, example := range command.examples {
			if _, err := fmt.Fprintf(writer, "  %s\n", example); err != nil {
				return err
			}
		}
	}
	_, err := io.WriteString(writer, "\nGlobal flags --json, --host, and --port must appear before the command.\n")
	return err
}
