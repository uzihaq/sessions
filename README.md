# Sessions

Sessions keeps Claude Code, Codex, shells, and other terminal programs alive
behind Sessions.app, a local web UI, and a CLI. Each session has its own supervised runner,
hosting either a PTY or a structured provider conversation, so work survives a
daemon restart and can be reopened from another browser.

## Trust contract

- **Local runtime:** Sessions drives tools you already installed through a PTY or
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
brew install uzihaq/tap/sessions
sessions install
open http://localhost:8787
```

`sessions install` registers `sessionsd` as the per-user development LaunchAgent
`tech.somewhere.sessions.dev.daemon`, starts it, and checks its health. Override the
label explicitly with `SESSIONS_DAEMON_LABEL` when needed. Direct loopback use is
zero-setup; LAN and remote clients normally authenticate with the token printed
by the command. Print it again later with `sessions token`.

Static archives are published for macOS arm64 and Linux arm64/amd64. Download
the archive for your platform from [GitHub Releases](https://github.com/uzihaq/sessions/releases),
then install all three adjacent binaries:

```sh
tar -xzf sessions_<version>_<os>_<arch>.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 0755 sessions sessionsd sessions-runner "$HOME/.local/bin/"
```

There is no `curl | sh` installer. See [installation details](docs/INSTALL.md)
for exact archive names, PATH setup, Linux startup, upgrades, and uninstalling.

## Quickstart

```sh
id=$(sessions new --tool claude --cwd "$HOME/project" --name docs)
sessions send "$id" "Review the documentation and fix stale examples"
sessions wait "$id" --timeout 10m
sessions last "$id" --role assistant
```

Open `http://localhost:8787` for the terminal and structured conversation views.
Session IDs may be replaced with a unique prefix shown by `sessions ls`.

## The CLI in 60 seconds

| Command | Purpose |
| --- | --- |
| `sessions new --tool claude\|codex\|shell [--cwd DIR]` | Start an interactive session |
| `sessions ls` | List live sessions |
| `sessions send <id> <message...>` | Submit text and confirm receipt |
| `sessions ask <id> <message...>` | Send, wait, and print the reply |
| `sessions wait <id> [--timeout 10m]` | Wait for a session to become idle |
| `sessions run [options] -- <command...>` | Start a tracked headless lane |
| `sessions lanes` | List running and completed lanes |
| `sessions status <id>` | Show compact session, git, activity, and verdict state |
| `sessions recover [--reopen]` | Inspect or reopen unexpectedly lost lanes |
| `sessions remote enable\|status\|disable` | Manage early-access Tailscale HTTPS access |
| `sessions model <id> <model> [--effort LEVEL]` | Switch an idle supported Claude session model |
| `sessions kill <id> [<id>...]` | Explicitly terminate selected sessions |

Also useful: `sessions snap`, `last`, `transcript`, `tail`, `keys`, `attach`,
`verdict`, `doctor`, and `help`. Global flags are `--json`, `--host`, and
`--port` (or `SESSIONS_HOST` / `SESSIONS_PORT`).

## Documentation

- [Agent entry point and repository rules](AGENTS.md)
- [Source-derived codebase guide](docs/CODEBASE.md)
- [Generated CLI reference](docs/CLI.md)
- [Product rationale and decision log](docs/WHY.md)
- [Native app package and lifetime contract](docs/NATIVE_APP.md)
- [Current product and deployment state](STATE.md)

## Notifications and hooks

Enable browser push in **Settings → Notify when a session finishes**. Sessions
classifies a completed turn locally and sends done, blocked, or error notices to
the browser subscription you approved.

Run a per-session shell hook after a working-to-idle transition:

```sh
sessions new --tool codex --on-idle 'printf "%s: %s\n" "$SESSIONS_SESSION_NAME" "$SESSIONS_OUTCOME"'
```

A global `{"onIdle":"..."}` hook may be stored at
`~/.config/sessions/hooks.json`. Hooks receive `SESSIONS_SESSION_ID`,
`SESSIONS_SESSION_NAME`, `SESSIONS_SESSION_TOOL`, `SESSIONS_SESSION_CWD`,
`SESSIONS_FINAL_MESSAGE`, `SESSIONS_OUTCOME`, and `SESSIONS_DURATION_MS`.

## Remote access (early access)

Install Tailscale on the daemon host and your client device, then run:

```sh
sessions remote enable
sessions remote status
```

Sessions configures Tailscale Serve, verifies the HTTPS health endpoint, and
prints a QR code. Terminal data is not relayed by Sessions. Tailscale HTTPS issues
a certificate whose machine/tailnet name appears in public Certificate
Transparency logs. Run `sessions remote disable` to remove Sessions' Serve route.

Never bind the daemon to `0.0.0.0`; the binary refuses wildcard listeners.

## Troubleshooting

Start with:

```sh
sessions doctor
sessions status <id>
```

Daemon logs on macOS are in
`~/Library/Logs/sessions/tech.somewhere.sessions.dev.daemon.log`. If the web UI cannot
authenticate, run `sessions token`. See [installation troubleshooting](docs/INSTALL.md#troubleshooting)
and the [runbooks](docs/RUNBOOKS.md).

## Development

The Go runtime is in `runtime/`; Sessions.app is in `src-tauri/`. The frozen
TypeScript daemon under `runtime/testdata/node-runtime/` remains only as
compatibility and mini-cutover evidence.

```sh
make -C runtime binaries
make -C runtime binaries-noui  # fast Go-only iteration
cd runtime && go test ./...
```

Tracked, non-interactive work uses lanes:

```sh
sessions run --name checks --cwd "$PWD" -- sh -lc 'cd runtime && go test ./...'
sessions lanes
```

See [architecture](ARCHITECTURE.md), [Go port constraints](runtime/ARCHITECTURE.md),
and [release instructions](docs/RELEASE.md).
