# pretty-PTY

pretty-PTY puts long-lived Claude Code, Codex, and shell sessions in your browser; they survive browser closes, daemon restarts, and Mac reboots. Everything runs on your Mac—we never see your sessions or data. [See what it looks like](https://pretty-pty.somewhere.site).

> **v0.1:** Useful today, still early. Expect rough edges around first-time remote setup and browser notifications.

## Install

Requirements: **macOS** and **Node.js 18+**. Install Claude Code and/or Codex separately if you want to run them.

```sh
npm i -g pretty-pty
pretty install
open http://localhost:8787
```

`pretty install` registers a per-user launchd service and starts it. Re-running it after an npm upgrade is safe.

## Your first session

Create a session in a project, send it work, wait for the turn to finish, and read the reply:

```sh
session=$(pretty new --tool claude --cwd ~/code/my-project --name first-run)
pretty send "$session" "Explain this project and suggest one useful first task."
pretty wait "$session" --timeout 10m
pretty last "$session" --role assistant
```

Open `http://localhost:8787` at any point to use the same session in Terminal, Pretty, or Remote view.

The CLI in 60 seconds:

| Command | What it does |
| --- | --- |
| `pretty new --tool claude --cwd <path>` | Start Claude Code and print the session ID |
| `pretty new --tool codex --cwd <path>` | Start Codex and print the session ID |
| `pretty ls` | List live sessions and their state |
| `pretty send <id> "prompt"` | Send a prompt and confirm receipt |
| `pretty wait <id> --timeout 10m` | Wait until the current turn is idle |
| `pretty last <id> --role assistant` | Print the latest structured reply |
| `pretty model <id> <model> --effort high` | Switch an idle Claude session |
| `pretty kill <id>` | End a session and remove its runner |

Session IDs may be shortened to any unique prefix. `pretty new` also accepts tool-neutral controls:

```sh
pretty new --tool claude --model YOUR_CLAUDE_MODEL --effort high
pretty new --tool codex --model YOUR_CODEX_MODEL --effort high --fast
```

`--model` and `--effort` work for Claude and Codex at creation time. `--fast` is Codex-only, and live `pretty model` switching is currently Claude-only. Tool presets run with permission prompts skipped by default; add `--no-skip-perms` for the tool's approval/sandbox mode.

Run `pretty help` for snapshots, transcripts, special keys, raw attach, JSON output, and other options.

## Remote access (early access)

Pretty uses [Tailscale](https://tailscale.com/download) rather than opening a public port. Install Tailscale and sign in on this Mac and the device you want to use, then run:

```sh
pretty remote enable
```

The command configures tailnet-only HTTPS, verifies the endpoint, and prints a QR code for the phone UI. On first use, Tailscale may print an HTTPS approval link; open it and run the command again. Enabling HTTPS also makes your machine's `.ts.net` name visible in public Certificate Transparency logs—the CLI warns before changing anything.

Remote clients need the daemon token:

```sh
pretty token
pretty remote status
```

Paste the token when the UI asks for it. To remove Pretty's Tailscale Serve handler, run `pretty remote disable`.

## Notifications and hooks

After remote HTTPS is working, open **Settings → Notifications** in the web UI. Pretty sends a green “done,” yellow “needs you,” or red “hit an error” notification when a turn becomes idle. This classifier is intentionally conservative and may not identify every blocked prompt in v0.1.

For scripts and integrations, create `~/.config/pretty/hooks.json`:

```json
{
  "onIdle": "printf '%s: %s\\n' \"$PRETTY_SESSION_NAME\" \"$PRETTY_FINAL_MESSAGE\" >> ~/.local/state/pretty-PTY/completions.log"
}
```

The command runs in the session's working directory and receives:

- `PRETTY_SESSION_ID`, `PRETTY_SESSION_NAME`, `PRETTY_SESSION_TOOL`, `PRETTY_SESSION_CWD`
- `PRETTY_FINAL_MESSAGE`, `PRETTY_OUTCOME` (`done`, `blocked`, or `error`), `PRETTY_DURATION_MS`

Run `pretty install` again after changing the global hooks file. For one session only, use `pretty new ... --on-idle '<command>'`.

## The trust contract

- **We never see your data.** Pretty has no hosted session backend; the daemon, PTYs, transcripts, and state live on your Mac.
- **Pretty makes no LLM calls.** It runs your installed Claude Code or Codex process; those tools keep their own provider relationships and policies.
- **No telemetry or phone-home.** The core daemon does not report usage to us. Tailscale remote access and browser push are opt-in and use their respective services.
- **Local-first security.** Localhost is not exposed to your network and needs no Pretty account. The daemon creates a local token; remote UI/API connections must present it, and Tailscale supplies the encrypted network boundary.
- **MIT licensed.** Read the [license](LICENSE), audit the source, and modify it freely.

Pretty controls real shells as your macOS user. Treat the daemon token like a password, do not expose port 8787 publicly, and use `--no-skip-perms` when you want agent approvals.

## Troubleshooting

Start with:

```sh
pretty doctor
```

- **`node-pty` or `posix_spawn` failure:** install Apple's command-line tools with `xcode-select --install`, then reinstall the package.
- **The browser asks for a token:** run `pretty token` and paste the result into the prompt or server settings.
- **Remote DNS verification fails:** run `tailscale set --accept-dns=true`, confirm MagicDNS is enabled, then retry `pretty remote status`.
- **Daemon will not start:** check `~/Library/Logs/pretty-pty/daemon.log`, then rerun `pretty install`.

To uninstall, first kill any sessions you no longer want, then remove the daemon and package:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/tech.pretty-pty.daemon.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/tech.pretty-pty.daemon.plist
npm uninstall -g pretty-pty
```

Session state remains in `~/.local/state/pretty-PTY` unless you remove it yourself.

## Development

Use a separate worktree so development stays isolated from the checkout serving your installed daemon:

```sh
git worktree add ../pretty-pty-dev -b my-change
cd ../pretty-pty-dev
npm run install:all
npm run dev
```

The dev UI runs on port 5273 and the daemon on 8787. To update a running checkout safely, use `pretty deploy --repo /path/to/pretty-pty`; inspect the sequence first with `--dry-run`. `pretty deploy` installs both dependency trees, builds and preflights them, restarts the daemon, checks health, and verifies runner survival.

For process boundaries, persistence, protocols, and data flow, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
