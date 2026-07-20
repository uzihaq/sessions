# Sessions

Sessions keeps Claude Code, Codex, shells, and other terminal programs alive
behind Sessions.app, a local web UI, and a CLI. Each session has its own supervised runner,
hosting either a PTY or a structured provider conversation, so work survives a
daemon restart and can be reopened from another browser.

## Trust contract

- **Local runtime:** Pretty drives tools you already installed through a PTY or
  their structured CLI contracts. It makes no direct model API calls.
- **Local by default:** the daemon listens on `127.0.0.1:8787`; remote access is
  opt-in and goes directly over your Tailscale network.
- **No default phone-home:** no Sessions account, analytics, telemetry, or relay.
  Opt-in backup, web push, and Tailscale use their configured services.
- **Native package:** Sessions.app is the primary macOS distribution and keeps
  its Go daemon and runner processes independent. The current early-access
  install exposes the same three `CGO_ENABLED=0` binaries directly.
- **Auditable:** source available under the [MIT license](LICENSE).

Sessions does not replace Claude Code or Codex. Install and authenticate the
agent CLI you want to run separately.

## Install (current early access)

Sessions.app is being completed as the primary installer and updater. Until its
v2 release gate is complete, the standalone Go package remains the honest
early-access path:

On Apple Silicon macOS:

```sh
brew install uzihaq/tap/pretty
pretty install
open http://localhost:8787
```

`pretty install` registers `prettyd` as the per-user development LaunchAgent
`tech.pretty-pty.dev.daemon`, starts it, and checks its health. Override the
label explicitly with `PRETTYD_DAEMON_LABEL` when needed. Direct loopback use is
zero-setup; LAN and remote clients normally authenticate with the token printed
by the command. Print it again later with `pretty token`.

Static archives are published for macOS arm64 and Linux arm64/amd64. Download
the archive for your platform from [GitHub Releases](https://github.com/uzihaq/pretty-PTY/releases),
then install all three adjacent binaries:

```sh
tar -xzf pretty-pty_<version>_<os>_<arch>.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 0755 pretty prettyd runner "$HOME/.local/bin/"
```

There is no `curl | sh` installer. See [installation details](docs/INSTALL.md)
for exact archive names, PATH setup, Linux startup, upgrades, and uninstalling.

## Quickstart

```sh
id=$(pretty new --tool claude --cwd "$HOME/project" --name docs)
pretty send "$id" "Review the documentation and fix stale examples"
pretty wait "$id" --timeout 10m
pretty last "$id" --role assistant
```

Open `http://localhost:8787` for the terminal and structured conversation views.
Session IDs may be replaced with a unique prefix shown by `pretty ls`.

## The CLI in 60 seconds

| Command | Purpose |
| --- | --- |
| `pretty new --tool claude\|codex\|shell [--cwd DIR]` | Start an interactive session |
| `pretty ls` | List live sessions |
| `pretty send <id> <message...>` | Submit text and confirm receipt |
| `pretty ask <id> <message...>` | Send, wait, and print the reply |
| `pretty wait <id> [--timeout 10m]` | Wait for a session to become idle |
| `pretty run [options] -- <command...>` | Start a tracked headless lane |
| `pretty lanes` | List running and completed lanes |
| `pretty status <id>` | Show compact session, git, activity, and verdict state |
| `pretty recover [--reopen]` | Inspect or reopen unexpectedly lost lanes |
| `pretty remote enable\|status\|disable` | Manage early-access Tailscale HTTPS access |
| `pretty model <id> <model> [--effort LEVEL]` | Switch an idle supported Claude session model |
| `pretty kill <id> [<id>...]` | Explicitly terminate selected sessions |

Also useful: `pretty snap`, `last`, `transcript`, `tail`, `keys`, `attach`,
`verdict`, `doctor`, and `help`. Global flags are `--json`, `--host`, and
`--port` (or `PRETTYD_HOST` / `PRETTYD_PORT`).

## Documentation

- [Agent entry point and repository rules](AGENTS.md)
- [Source-derived codebase guide](docs/CODEBASE.md)
- [Generated CLI reference](docs/CLI.md)
- [Product rationale and decision log](docs/WHY.md)
- [Native app package and lifetime contract](docs/NATIVE_APP.md)
- [Current product and deployment state](STATE.md)

## Notifications and hooks

Enable browser push in **Settings → Notify when a session finishes**. Pretty
classifies a completed turn locally and sends done, blocked, or error notices to
the browser subscription you approved.

Run a per-session shell hook after a working-to-idle transition:

```sh
pretty new --tool codex --on-idle 'printf "%s: %s\n" "$PRETTY_SESSION_NAME" "$PRETTY_OUTCOME"'
```

A global `{"onIdle":"..."}` hook may be stored at
`~/.config/pretty/hooks.json`. Hooks receive `PRETTY_SESSION_ID`,
`PRETTY_SESSION_NAME`, `PRETTY_SESSION_TOOL`, `PRETTY_SESSION_CWD`,
`PRETTY_FINAL_MESSAGE`, `PRETTY_OUTCOME`, and `PRETTY_DURATION_MS`.

## Remote access (early access)

Install Tailscale on the daemon host and your client device, then run:

```sh
pretty remote enable
pretty remote status
```

Pretty configures Tailscale Serve, verifies the HTTPS health endpoint, and
prints a QR code. Terminal data is not relayed by Pretty. Tailscale HTTPS issues
a certificate whose machine/tailnet name appears in public Certificate
Transparency logs. Run `pretty remote disable` to remove Pretty's Serve route.

Never bind the daemon to `0.0.0.0`; the binary refuses wildcard listeners.

## Troubleshooting

Start with:

```sh
pretty doctor
pretty status <id>
```

Daemon logs on macOS are in
`~/Library/Logs/pretty-pty/tech.pretty-pty.dev.daemon.log`. If the web UI cannot
authenticate, run `pretty token`. See [installation troubleshooting](docs/INSTALL.md#troubleshooting)
and the [runbooks](docs/RUNBOOKS.md).

## Development

The Go runtime is in `prettygo/`; Sessions.app is in `src-tauri/`. The TypeScript
daemon remains only as mini-cutover and rollback evidence.

```sh
make -C prettygo binaries
make -C prettygo binaries-noui  # fast Go-only iteration
cd prettygo && go test ./...
```

Tracked, non-interactive work uses lanes:

```sh
pretty run --name checks --cwd "$PWD" -- sh -lc 'cd prettygo && go test ./...'
pretty lanes
```

See [architecture](ARCHITECTURE.md), [Go port constraints](prettygo/ARCHITECTURE.md),
and [release instructions](docs/RELEASE.md).
