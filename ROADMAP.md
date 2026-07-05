# pretty-PTY Roadmap

Last verified: 2026-07-05.

This file is a strategic handoff for agents that do not have repo access. The live work queue is the somewhere task board project `pretty-pty`; treat that board as canonical for task status, ownership, and priority. This roadmap explains direction and sequencing.

## Product Direction

pretty-PTY is a web UI, CLI (`pretty`), and macOS launchd daemon (`prettyd`) for running long-lived Claude Code, Codex, and shell terminal sessions that can be driven from a browser or CLI. Runners are launchd-owned so sessions survive daemon restarts. The operating rule is: sessions are sacred. Never auto-kill anything that might still be alive.

V1 positioning is "a better tmux":

- Ships as npm: CLI plus daemon.
- UI is served by the daemon as a localhost webpage.
- Local-first: no Tailscale requirement, no hosted backend requirement.
- Localhost needs no auth. Token auth exists, but the current trusted-tailnet operating mode uses `~/.local/state/pretty-PTY/open` to disable token auth while keeping origin checks.
- Tailscale, relay, hosted access, and "reach it from your phone" are optional v2 surfaces, not V1 requirements.

The core product risk is send reliability. Today, sends still drive TUIs through terminal input bytes, with confirmation layered on top using snapshots and structured logs. That is better than blind typing, but still depends on moving TUI surfaces: update prompts, pickers, trust dialogs, and other off-path screens can intercept input silently.

The strategic fix is to drive contracts, not pixels.

## Phase 1: Shippable V1 Better Tmux

Goal: make the local-first product dependable enough that an agent or human can keep many sessions open and use `pretty` as the daily orchestration surface.

Must finish or keep green:

- Runner survival: launchd-owned per-session runners; daemon restart, watch reload, and crash recovery must not lose live sessions.
- Browser stability: one multiplexed WebSocket per window, bounded replay, stale-socket detection, and no silent dropped input during reconnect.
- CLI loops: prefix IDs, `pretty send --file`, confirmed `send`, `wait`, `last`, `transcript`, `ask`, `doctor`, `token`, and `install`.
- Structured views: Claude JSONL-backed Pretty/Remote view and Codex rollout parity for new sessions.
- Security posture: localhost by default, origin/CSWSH checks, token auth available, explicit `open` escape hatch only for trusted-network use.
- Deployment hygiene: deploy is `git pull` plus `npm install` in both `prettyd/` and `frontend/` plus build. Pull-only deploys can crash when a dependency was added.

Current live queue on the somewhere `pretty-pty` board:

- In progress: `Completion hooks: pretty new --on-idle / --wait-ready / --name`.
- Open: Codex reattach/existing-session parity bug.
- Open: finish push activation on single-origin HTTPS.
- Open: deploy path must install new dependencies.
- Open: auto-file daemon/session errors as somewhere tasks.
- Open: re-enable token auth before wider exposure.

## Phase 2: App-Server Reliability Spine

Goal: replace pixel/TUI submission for Codex with a protocol-level contract.

Codex goes first. The confirmed viable spike is `codex app-server --listen` with JSON-RPC:

- `turn/start` submits work and returns an acknowledgement.
- Structured events stream out of the app-server.
- The standard TUI can attach to the same session using `codex --remote`.
- pretty-PTY already renders sessions from structured events, so the live Pretty view does not need to scrape the TUI.
- The raw terminal becomes an optional cockpit tab for setup screens, pickers, and manual recovery.

Work is happening on branch `codex-app-server` in a foundation stage. The merge target should preserve the current runner model: sessions remain launchd-owned, reconnectable, and never automatically reaped on ambiguity.

Success criteria:

- Submitting to Codex returns an explicit ack or a typed failure, never "maybe Enter worked."
- Event stream drives the Pretty/Remote view without terminal parsing.
- Existing `pretty ask`, `send`, `last`, `transcript`, and `wait` become contract-backed for Codex.
- The cockpit TUI can still attach for manual control without stealing session ownership.
- Failure states create actionable diagnostics and, eventually, somewhere tasks.

## Phase 3: Claude Contract Path

Goal: give Claude Code the same contract-backed reliability.

Claude is separate and more work. The planned path is the Claude Agent SDK rather than continued TUI scraping. The existing Claude JSONL watcher remains useful as a read path, but submission should move away from bracketed paste plus Enter when a supported contract exists.

Success criteria:

- Claude sends have protocol-level receipt.
- Tool, approval, idle, completion, error, and token-usage events are typed.
- Pretty/Remote remains event-first.
- Terminal cockpit is still available for prompts that genuinely require a TUI.

## Phase 4: somewhere Fabric V2

Goal: turn sessions into nodes on an event bus and use somewhere primitives for durable orchestration.

Map session hooks to somewhere:

- `idle` / `complete`: trigger task handoffs, webhooks, push/email, and queued follow-up work.
- `needs-approval`: notify a human or route to an approval lane.
- `error`: auto-file a task with logs, session id, cwd, tool, version, and dedupe key.
- `message`: publish inter-agent messages on realtime.
- `token-usage`: record cost and capacity data.
- Shared memory: record/recall plus database tables for fleet context.
- Scheduling: cron/queue for delayed checks and recurring orchestration.

Claude x Codex synergy:

- Dispatcher lane routes work by strength: Codex for fast bulk edits and mechanical code changes; Claude for judgment, review, product taste, and ambiguous tradeoffs.
- Propose -> verify loops use one model to implement and the other to critique or test.
- Handoffs are durable tasks, not chat history fragments.
- Error -> task -> fix loops should close without a human manually copying logs into the board.

## Non-Goals Until The Spine Is Reliable

- Do not make relay/hosted/mobile reach the center of the product before send reliability is contract-backed.
- Do not add broad platform dependencies for V1.
- Do not auto-kill or clean up runners unless death is proven.
- Do not treat terminal pixels as the long-term source of truth for agent control.

