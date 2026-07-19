# Agent guide

This is the entry point for agents working in this repository. Every factual
claim in documentation must be checked against the implementation and cite the
relevant source path; if prose and code disagree, the code wins.

## What Pretty is

- Pretty is a local runtime for durable Claude Code, Codex, shell, and headless command sessions.
- The current product is three Go binaries: `pretty`, `prettyd`, and `runner` (`prettygo/cmd/`).
- A runner owns either a PTY, a headless pipe, or a structured provider conversation so daemon reloads do not kill the work (`prettygo/cmd/runner/`).
- The daemon exposes the local web UI and HTTP/WebSocket API; the CLI is an API client (`prettygo/internal/api/`, `prettygo/cmd/pretty/`).
- Pretty.app is the primary package: a Tauri window, tray, installer, and updater around the independent Go service (`src-tauri/`, `docs/NATIVE_APP.md`).
- Access is loopback by default, opt-in on the LAN, and opt-in over Tailscale Serve (`prettygo/cmd/pretty/lan.go`, `prettygo/cmd/pretty/remote.go`).

## Repository map

- `prettygo/` — the product: Go daemon, CLI, runner, contracts, and internal packages.
- `prettyd/` — the superseded TypeScript daemon; retain it only as mini-cutover, rollback, and protocol-compatibility evidence.
- `frontend/` — the React web UI embedded in release builds by `prettygo/scripts/build-binaries.sh`.
- `docs/` — rationale, operations, release notes, and source-derived references.
- `skills/pretty/` — the distributable Pretty agent skill.
- `site/` — the hosted onboarding site; it is not the daemon-served application.
- `src-tauri/` — Pretty.app, the primary macOS package and future Android client; it manages but never owns daemon or runner lifetime.
- `scripts/` and `Formula/` — repository automation and Homebrew packaging.

## Route questions to the right truth

- Current status and deployment reality: [`STATE.md`](STATE.md).
- Product rationale and durable decisions: [`docs/WHY.md`](docs/WHY.md).
- Native package and process-lifetime contract: [`docs/NATIVE_APP.md`](docs/NATIVE_APP.md).
- Wire and compatibility promises: [`prettygo/CONTRACT/`](prettygo/CONTRACT/).
- Implementation orientation: [`docs/CODEBASE.md`](docs/CODEBASE.md).
- Generated command reference: [`docs/CLI.md`](docs/CLI.md); regenerate it instead of editing it.
- Planning and philosophy: `ROADMAP.md` and board material. They do not override `STATE.md` or source.

## Working rules

1. **Sessions are sacred.** Never kill, replace, mass-clean, or adopt a session you do not own. The ledger's provenance and mass-kill guard live in `prettygo/internal/ledger/` and `prettygo/internal/session/manager.go`.
2. **Never touch the Mac mini.** `100.86.76.84` still runs the old production daemon and remains untouched until the user explicitly performs cutover (`STATE.md`).
3. **Isolate development.** Use a worktree and branch. For a scratch daemon, set both `PRETTYD_STATE_DIR` and `PRETTYD_PORT` so it cannot collide with daily-driver state (`docs/DEV.md`).
4. **Reload only the dev daemon.** Its label is `tech.pretty-pty.dev.daemon`. After a reload, compare `pretty ls` before and after and verify the durable `soak-d2` session still exists; count runner metadata, not bare `pgrep` output (`STATE.md`).
5. **Write ahead of destructive action.** Creation and kill intent are ledgered before process launch or termination (`prettygo/internal/session/manager.go`, `prettygo/internal/ledger/store.go`). Preserve that ordering.
6. **Keep errors instructional.** Say what failed and give the safe next command or action; do not hide an ambiguous recovery, resolver, or network failure behind a silent fallback (`prettygo/cmd/pretty/help.go`, `prettygo/internal/recovery/`, `prettygo/internal/watch/`).
7. **Verify acceptance yourself.** Run the complete gate in the worktree, inspect the diff, and report actual output. Do not imply a check passed if it did not run.
8. **Keep protocol changes compatible.** Read `prettygo/CONTRACT/` before changing frames, HELLO/replay behavior, state files, or Node-runner adoption.
9. **Keep the native shell above the service.** Pretty.app may install, update, and inspect `prettyd`; quitting or updating the app must never terminate the daemon or a runner (`docs/NATIVE_APP.md`).
10. **Do not use the retired Node deploy path.** `pretty deploy` is intentionally non-mutating on the Go product. Mac app release work follows `docs/RELEASE.md`; the mini remains untouched.

## Build, test, and gate commands

Run the gate from your worktree's `prettygo/` directory:

```sh
cd <your-worktree>/prettygo && export PATH=$PATH:/opt/homebrew/bin
go build ./... && go vet ./... && go test ./...
bash scripts/gen-cli-docs.sh   # when CLI surface or docs changed; output must be committed unchanged
git diff --stat go-rewrite..HEAD
```

Build distributable binaries and the embedded UI:

```sh
cd prettygo && export PATH=$PATH:/opt/homebrew/bin && make binaries
```

Reload the MacBook development daemon only when the task calls for it:

```sh
launchctl kickstart -k gui/$(id -u)/tech.pretty-pty.dev.daemon
```
