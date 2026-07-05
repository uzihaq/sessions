# pretty-PTY Current State

Last verified: 2026-07-05 on branch `docs-roadmap`.

This file is for agents without repo access. The live work queue is the somewhere task board project `pretty-pty`. At verification time it had 6 active tasks: 1 in progress and 5 open.

## What Is Live

pretty-PTY is a local-first "better tmux" for Claude Code, Codex, and shell sessions. It consists of:

- `prettyd`: Node + TypeScript daemon on port `8787`, using `node-pty`, `ws`, `@xterm/headless`, and `web-push`.
- `pretty`: CLI shipped from `prettyd/bin/pretty.cjs`.
- `frontend`: React 18 + Vite + TypeScript + Zustand + xterm.js web UI.
- `src-tauri`: optional Tauri desktop wrapper.

The daemon owns no PTYs directly. Each session is a launchd-owned runner with state under `~/.local/state/pretty-PTY/runners/` and a plist under `~/Library/LaunchAgents/tech.pretty-pty.runner.<id>.plist`. This is the core survival model: runners continue across daemon restarts and hot reloads.

## Runtime Architecture

Session files per runner:

- `<id>.sock`: Unix socket, mode `0600`, used by `prettyd` to talk to the runner.
- `<id>.json`: metadata: command, args, cwd, pid, dimensions, timestamps.
- `<id>.events`: append-only persistent output log, capped and restored on runner restart.
- `<id>.log`: launchd stdout/stderr log.

Runner behavior:

- Spawns the PTY command (`claude`, `codex`, shell, or custom command).
- Mirrors output into an in-memory event log, xterm-headless, and persistent `.events` log.
- Replays persisted output after reboot, but does not snapshot process state. Claude can continue through its own `~/.claude/projects` persistence; a shell restarts as a fresh process with old scrollback visible.
- On clean PTY exit or `pretty kill`, persistent events are deleted. On launchd/system SIGTERM, events are kept for replay.

Daemon behavior:

- Refuses `0.0.0.0` / all-interface binds. Use `127.0.0.1` or a specific tailnet IP via `PRETTYD_HOST`.
- Starts listening before runner discovery; `/api/health` reports `discovering` and `sessionsLoaded`.
- Reattaches to runner sockets and backfills its local log with `REPLAY_REQ(0)`.
- Schedules bounded reconnect attempts if a runner socket drops unexpectedly.
- Does not reap an unreachable runner if the pid still appears alive. "Sessions are sacred" is implemented in discovery.

## Protocols And APIs

Runner protocol:

- Binary length-prefixed frames over Unix socket.
- Current runner protocol version: `1`.
- Frames include `HELLO`, `OUTPUT`, `EXIT`, `SNAPSHOT_RES`, `REPLAY_DONE`, `INPUT`, `RESIZE`, `SNAPSHOT_REQ`, `REPLAY_REQ`, and `KILL`.
- Protocol mismatches are logged, but the daemon still attaches to preserve live sessions.

Browser/CLI protocol:

- Current WebSocket protocol version: `2`.
- Browser uses `/ws?mux=1`: one multiplexed WebSocket per window with `sessionId`-tagged frames.
- CLI still uses single-session `/ws?sessionId=<id>` for `attach` and `tail -f`.
- Server messages include `hello`, `output`, `gap`, `exit`, `error`, `pong`, and `claudeEvent`.
- Replay is bounded and backpressure-aware; the WS layer yields when send buffers get large.
- Browser mux has reconnect backoff, app-level ping/pong, stale connection detection, phone-unlock reconnect, and bounded input/resize outbox.

HTTP routes:

- `GET /api/health`, `GET /api/health/deep`
- `GET/POST /api/sessions`
- `DELETE /api/sessions/:id`
- `GET /api/sessions/:id/snapshot?cols=N`
- `POST /api/sessions/:id/input`
- `POST /api/sessions/:id/upload`
- `GET /api/sessions/:id/events?since=N&tail=N`
- `GET /api/claude-sessions`
- `GET /api/directories`
- `GET /api/fs/list?path=<home-subpath>`
- `GET /api/push/vapid`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`

The daemon can serve static frontend files from `frontend/dist` or `PRETTYD_WEB_DIR`. In dev, use Vite on port `5273`.

## Security State

Shipped:

- Origin allowlist for HTTP CORS and WebSocket upgrades. Browser origins are allowed for loopback or the configured bind host; malformed/cross-site origins are rejected.
- Token auth for all API routes except health and for all WS upgrades.
- CLI reads `~/.local/state/pretty-PTY/token` and sends `Authorization: Bearer <token>`.
- Browser stores per-server tokens in localStorage and appends WS `?token=`.
- `~/.local/state/pretty-PTY/open` disables token auth for trusted-network operation while keeping origin checks.

Current operating direction from the brief and board: auth exists but is disabled in the trusted tailnet via the `open` flag. Re-enable token auth before public, relay, hosted, or non-trusted exposure.

## Structured Events

Claude:

- New Claude sessions are pinned with `--session-id <uuid>`; resumed sessions use `--resume <uuid>`.
- The daemon tails `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, re-resolves across rotations, de-dupes by event UUID, and emits structured `claudeEvent` frames.
- `SessionInfo.lastUserMessageAt`, Claude titles, Remote view messages, CLI `last`, `transcript`, and `ask` all use these structured events.

Codex:

- Current code tails Codex rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- It normalizes Codex rollout items into the same Claude-shaped event stream and derives working state from Codex `task_started` / `task_complete` events when seen.
- This is Codex Pretty parity for new sessions, not the future `codex app-server` contract.

Known bug from the board: existing or reattached Codex sessions can render empty and `pretty last` / `pretty transcript` can return no messages. The tracked fixes involve watcher attachment for reattached sessions and widening rollout resolution beyond today/yesterday.

## Frontend State

The app has:

- Session tabs, draggable order, close controls, and mobile bottom navigation.
- Desktop grid view for many sessions.
- Terminal view backed by xterm.js, lazy-loaded only when needed.
- Pretty/Remote view for Claude sessions, backed by structured JSONL events.
- Session LRU cap: only the active session plus a small recent set stay mounted to avoid memory growth.
- Server selector for multiple prettyd hosts, including tokens and `http`/`https`.
- Auth banner for 401 responses.
- Settings popover with text size, Tauri autostart, push toggle, and server selector.
- Push code is present but activation requires secure-context HTTPS and daemon/static-serving setup.

Important mismatch: backend emits normalized Codex events, but the visible Pretty/Remote toggle is currently gated to Claude sessions. Codex may be useful through CLI/event paths while the browser still forces Terminal for Codex.

## CLI State

`pretty` supports full IDs or unique prefixes.

Commands:

- `ls [-a|--include-exited]`
- `snap <id> [--raw]`
- `tail <id> [-f] [-n N]`
- `wait <id> [--idle Ns] [--timeout Ns]`
- `send <id> [--timeout Ns] [--no-wait] [--file path] <text...>`
- `input <id> ...` alias for `send`
- `last <id> [--role user|assistant] [-n N]`
- `transcript <id>`
- `ask <id> [--timeout Ns] [--idle Ns] [--wait-timeout Ns] <text...>`
- `keys <id> <esc|up|down|left|right|^c|^d|enter|tab>`
- `new --tool <claude|codex|shell> [--cwd P] [--no-skip-perms] [extra args]`
- `new [--cwd P] [--cmd C] [args...]`
- `kill <id> [<id>...]`
- `attach <id>`
- `doctor`
- `token`
- `install`

Send reliability today:

- CLI `send` writes text, waits briefly, sends Enter, then confirms by watching structured events for Claude/Codex.
- It re-presses Enter only if a snapshot proves the text is still in the composer.
- `--no-wait` returns to fire-and-forget behavior.
- This is still TUI input plus confirmation, not protocol-level submission. The roadmap replaces this with Codex app-server first.

## Branches

Current local branch: `docs-roadmap`.

Local branches present:

- `master`
- `pty-runner-architecture`
- `send-robustness`
- `mobile-push-codex`
- `desktop-settings`
- `release-hardening`
- `codex-app-server`
- `completion-hooks`
- `docs-roadmap`

Known branch meanings from the brief/board:

- `codex-app-server`: foundation work for contract-backed Codex send/events using `codex app-server --listen`.
- `completion-hooks`: in-progress work for `pretty new --on-idle`, `--wait-ready`, and `--name`.
- `send-robustness`: recent send confirmation and off-path detection work.
- `mobile-push-codex`: recent mobile lane selector, push, and Codex parity work.
- `desktop-settings`: recent desktop settings GUI work.

Do not assume a branch is merged without checking. The roadmap direction may be ahead of the current branch.

## Live Board Items

Canonical queue: somewhere task board project `pretty-pty`.

Active items verified on 2026-07-05:

- `tsk_43706f0692df4bf4aa8bd9b76ee25eec`: Completion hooks: `pretty new --on-idle / --wait-ready / --name` (`in_progress`, high, area `cli`).
- `tsk_0c96481a60f3495abef3764dbdc8fc37`: Codex parity: reattached/existing Codex sessions render empty (`open`, high, area `codex-parity`).
- `tsk_d5dde191c50d4c438fb09b8c97915e40`: Wire pretty -> somewhere: auto-file daemon/session errors as tasks (`open`, normal, area `observability`).
- `tsk_95043af621bc4f6293a40969be22b1b6`: Deploy path must npm install new prettyd deps (`open`, normal, area `deploy`).
- `tsk_a2d8b715285f452096edc7b3a3b5ad23`: Finish push activation, single-origin HTTPS (`open`, normal, area `push`).
- `tsk_85eadff02c9547efaa078181d7a967c3`: Re-enable token auth before exposing beyond trusted tailnet (`open`, low, area `security`).

## Run Locally

Install dependencies:

```sh
(cd prettyd && npm install)
(cd frontend && npm install)
```

Run dev:

```sh
npm run dev
```

Ports:

- `prettyd`: `127.0.0.1:8787`
- Vite frontend: `127.0.0.1:5273`

Useful checks:

```sh
pretty ls
pretty doctor
curl http://127.0.0.1:8787/api/health
cd frontend && npm run typecheck && npm run test:markdown
cd prettyd && npm run typecheck
cd prettyd && ./node_modules/.bin/tsx scripts/test-jsonl-resolver.mjs
cd prettyd && ./node_modules/.bin/tsx scripts/test-claude-working.mjs
```

## Install / Deploy

One-machine install:

```sh
bash scripts/install.sh
```

That installs dependencies, builds `prettyd`, installs frontend dependencies, symlinks `pretty`, and registers `prettyd` as a macOS LaunchAgent.

Manual daemon install:

```sh
cd prettyd
npm install
npm run build
pretty install
```

Deploy fact from the strategic brief:

```sh
git pull
(cd prettyd && npm install && npm run build)
(cd frontend && npm install && npm run build)
```

Both `npm install` steps matter. Pull-only deploys have already crashed the daemon when new dependencies such as `web-push` or `dompurify` were added.

This local build/deploy path is different from a somewhere.tech raw-source deploy. For pretty-PTY's installed daemon, builds are still used.

## Diagnostics

- Daemon logs: `~/Library/Logs/pretty-pty/daemon.log`.
- Runner state and logs: `~/.local/state/pretty-PTY/runners/`.
- Auth token: `~/.local/state/pretty-PTY/token`; print with `pretty token`.
- Auth escape hatch: `touch ~/.local/state/pretty-PTY/open` disables token auth; delete it to re-enable token auth.
- Health: `/api/health` and `/api/health/deep`.
- CLI health: `pretty doctor`.

When debugging runner discovery or stale sockets, preserve live sessions unless process death is proven. Do not delete plists, sockets, or event files as a cleanup reflex.

