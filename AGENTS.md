# Agent guide

This is the entry point for agents working in this repository. Every factual
claim in documentation must be checked against the implementation and cite the
relevant source path; if prose and code disagree, the code wins.

## What Sessions is

- Sessions is a native product for durable Claude Code, Codex, shell, and headless command sessions; its local runtime commands retain the `sessions` name.
- The native product bundles three Go runtime binaries: `sessions`, `sessionsd`, and `sessions-runner` (`runtime/cmd/`).
- A runner owns either a PTY, a headless pipe, or a structured provider conversation so daemon reloads do not kill the work (`runtime/cmd/sessions-runner/`).
- The daemon exposes the HTTP/WebSocket API and still embeds a transitional SPA; interactive browser control is deprecated, while the CLI and signed native clients remain API clients (`runtime/internal/api/`, `runtime/cmd/sessions/`).
- Sessions.app is the primary package: a Tauri window, tray, installer, and updater around the independent Go service (`src-tauri/`, `docs/NATIVE_APP.md`).
- Access is loopback by default, opt-in on the LAN, and opt-in over Tailscale Serve (`runtime/cmd/sessions/lan.go`, `runtime/cmd/sessions/remote.go`).

## Repository map

- `runtime/` — the product: Go daemon, CLI, runner, contracts, and internal packages.
- `runtime/testdata/node-runtime/` — the superseded TypeScript daemon; retain it only as mini-cutover and protocol-compatibility evidence.
- `frontend/` — the React UI used by Sessions.app and still embedded in standalone daemon builds for transitional compatibility; do not expand the deprecated interactive browser surface.
- `docs/` — rationale, operations, release notes, and source-derived references.
- `skills/sessions/` — the distributable Sessions agent skill.
- `site/` — the hosted onboarding site; it is not the daemon-served application.
- `src-tauri/` — Sessions.app, the primary macOS package and future Android client; it manages but never owns daemon or runner lifetime.
- `scripts/` and `Formula/` — repository automation and Homebrew packaging.

## Route questions to the right truth

- Current status and deployment reality: [`STATE.md`](STATE.md).
- Product rationale and durable decisions: [`docs/WHY.md`](docs/WHY.md).
- Native package and process-lifetime contract: [`docs/NATIVE_APP.md`](docs/NATIVE_APP.md).
- Hosted worker security and product boundary: [`docs/CLOUD_VM.md`](docs/CLOUD_VM.md).
- Sessions-owned outbound traffic and future support grants: [`docs/NETWORK_SECURITY.md`](docs/NETWORK_SECURITY.md).
- Wire and compatibility promises: [`runtime/CONTRACT/`](runtime/CONTRACT/).
- Implementation orientation: [`docs/CODEBASE.md`](docs/CODEBASE.md).
- Generated command reference: [`docs/CLI.md`](docs/CLI.md); regenerate it instead of editing it.
- Planning and philosophy: `ROADMAP.md` and board material. They do not override `STATE.md` or source.

## Working rules

1. **Sessions are sacred.** Never kill, replace, mass-clean, or adopt a session you do not own. The ledger's provenance and mass-kill guard live in `runtime/internal/ledger/` and `runtime/internal/session/manager.go`.
2. **Preserve the Mac Mini runners.** Its public 0.2.3 update completed with all
   nine exact session IDs and runner PIDs preserved after 0.2.2 safely exposed
   the Mini replay-budget gap (`STATE.md`). The app/daemon may be updated and
   verified; important runner processes must not be stopped, replaced, or
   recreated. The live runners still use their immutable 0.2.0 runtime, which
   must not be removed until those processes exit.
3. **Isolate development.** Use a worktree and branch. For a scratch daemon, set both `SESSIONS_STATE_DIR` and `SESSIONS_PORT` so it cannot collide with daily-driver state (`docs/DEV.md`).
4. **Reload only the dev daemon.** Its label is `tech.somewhere.sessions.dev.daemon`. After a reload, compare `sessions ls` before and after and verify the durable `soak-d2` session still exists; count runner metadata, not bare `pgrep` output (`STATE.md`).
5. **Write ahead of destructive action.** Creation and kill intent are ledgered before process launch or termination (`runtime/internal/session/manager.go`, `runtime/internal/ledger/store.go`). Preserve that ordering.
6. **Keep errors instructional.** Say what failed and give the safe next command or action; do not hide an ambiguous recovery, resolver, or network failure behind a silent fallback (`runtime/cmd/sessions/help.go`, `runtime/internal/recovery/`, `runtime/internal/watch/`).
7. **Verify acceptance yourself.** Run the complete gate in the worktree, inspect the diff, and report actual output. Do not imply a check passed if it did not run.
8. **Keep protocol changes compatible.** Read `runtime/CONTRACT/` before changing frames, HELLO/replay behavior, state files, or Node-runner adoption.
9. **Keep the native shell above the service.** Sessions.app may install, update, and inspect `sessionsd`; quitting or updating the app must never terminate the daemon or a runner (`docs/NATIVE_APP.md`).
10. **Do not use the retired Node deploy path.** `sessions deploy` is intentionally non-mutating on the Go product. Mac app release and Mini completion work follows `docs/RELEASE.md`.
11. **Report product failures as an agent, not as a log dumper.** Run `sessions --json support --diagnostics`, add the sanitized failing command shape/action, exit code, expected result, and sanitized exact error, then ask the user before opening or submitting a ticket. Never attach transcripts, terminal output, paths, identifiers, credentials, environment, private source, raw logs, or crash files (`runtime/cmd/sessions/support.go`).

## Build, test, and gate commands

Run the gate from your worktree's `runtime/` directory:

```sh
cd <your-worktree>/runtime && export PATH=$PATH:/opt/homebrew/bin
go build ./... && go vet ./... && go test ./...
bash scripts/gen-cli-docs.sh   # when CLI surface or docs changed; output must be committed unchanged
git diff --stat main..HEAD
```

Build distributable binaries and the embedded UI:

```sh
cd runtime && export PATH=$PATH:/opt/homebrew/bin && make binaries
```

Reload the MacBook development daemon only when the task calls for it:

```sh
launchctl kickstart -k gui/$(id -u)/tech.somewhere.sessions.dev.daemon
```
