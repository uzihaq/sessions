# pretty-PTY

Run Claude Code (and any TUI — `codex`, a shell) as long-lived sessions on
your Mac, and reach them from a phone or laptop over Tailscale. Sessions
survive daemon restarts and reloads.

```
frontend/   Vite + React + Zustand + xterm.js (UI)
prettyd/    Node + node-pty + ws (daemon — owns the sessions; ships the `pretty` CLI)
src-tauri/  Tauri desktop wrapper (optional)
```

## Architecture

- **Per-session runners.** Each session is a detached runner process
  supervised by launchd (`~/Library/LaunchAgents/tech.pretty-pty.runner.<id>.plist`),
  with its socket/state under `~/.local/state/pretty-PTY/runners/`. The daemon
  reattaches to live runners over their Unix sockets on startup, so sessions
  survive a daemon restart or a `tsx watch` reload. On boot the daemon
  **listens first, then discovers runners in the background** — `/api/health`
  reports `{ discovering, sessionsLoaded }` while it reattaches.
- **One multiplexed WebSocket per window** (`/ws?mux=1`): every attached
  session's traffic is `sessionId`-tagged on a single socket (tmux-style),
  instead of one socket per session. Only the *viewed* session streams live
  PTY output / Claude events; hidden sessions attach quiescent and catch up on
  activation.
- **Two views per session:**
  - **Terminal** — raw xterm over the PTY byte stream (the source of truth).
  - **Pretty / Remote** — for Claude sessions only, *derived* from Claude's own
    JSONL transcript (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`), tailed
    by a watcher and streamed as structured `claudeEvent`s. Markdown/ANSI is
    rendered to HTML (link hrefs sanitized against `javascript:`/`data:`/`vbscript:`).

## CLI (`pretty`)

Installed on `PATH` via `npm i -g` / the package `bin`. The daemon defaults to
`127.0.0.1:8787`; if it's bound to a tailnet IP, pass `--host` (or set
`PRETTYD_HOST` once):

```sh
export PRETTYD_HOST=100.x.y.z      # then plain `pretty ls` works
```

| Command | Description |
| --- | --- |
| `pretty ls [-a\|--include-exited]` | list sessions (hides exited by default) |
| `pretty snap <id> [--raw]` | print the current screen buffer (clean text; `--raw` keeps ANSI) |
| `pretty tail <id> [-f] [-n N]` | last N lines (default 50); `-f` to follow |
| `pretty send <id> <text…>` | type text + Enter (alias: `input`) |
| `pretty keys <id> <key>` | send a special key: `esc\|up\|down\|left\|right\|^c\|^d\|enter\|tab` |
| `pretty new --tool <claude\|codex\|shell> [--cwd P] [--no-skip-perms] [args…]` | create a session (easy path) |
| `pretty new [--cwd P] [--cmd C] [args…]` | create with an explicit command |
| `pretty wait <id> [--idle Ns] [--timeout Ns]` | block until idle (defaults: idle 2s, timeout 30s) |
| `pretty kill <id> [<id>…]` | terminate one or more sessions |
| `pretty attach <id>` | raw two-way stream (Ctrl+Q to detach) |

Global flags: `--json` (machine-readable), `--host`, `--port`.

Typical agent loop:

```sh
id=$(pretty new --tool claude --cwd ~/proj)
pretty send "$id" "implement X"
pretty wait "$id"
pretty snap "$id"
```

## Dev

```sh
# one-shot install
(cd prettyd && npm install) && (cd frontend && npm install)

# run both (prettyd + vite, via concurrently)
npm run dev
```

Open the Vite URL it prints. For tailnet access set `PRETTYD_HOST` /
`VITE_HOST` to a specific `100.x.y.z` address (binding to `0.0.0.0` is
refused — Tailscale is the auth/encryption boundary).

| service        | port |
| -------------- | ---- |
| backend daemon (prettyd) | 8787 |
| frontend (vite)          | 5273 |

### Verify

```sh
cd frontend && npm run typecheck && npm run test:markdown   # incl. link-XSS cases
cd prettyd  && npm run typecheck
cd prettyd  && ./node_modules/.bin/tsx scripts/test-jsonl-resolver.mjs
cd prettyd  && ./node_modules/.bin/tsx scripts/test-claude-working.mjs
```

## Security note

`prettyd` is an unauthenticated control API for local shells. Loopback-only
(`127.0.0.1`) is fine for a personal tool; binding to a tailnet IP makes
**Tailscale membership the only access boundary** — don't expose it more
broadly. CORS is currently permissive; token auth is a planned hardening step.
