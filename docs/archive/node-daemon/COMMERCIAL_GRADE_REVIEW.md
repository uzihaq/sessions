# pretty-PTY Commercial Readiness Review

Date: 2026-06-30

Scope: non-security review only. This is a code-level review of whether the current implementation is ready to operate like a commercial product, with emphasis on performance, reliability, debuggability, lifecycle management, and maintainability.

## Verdict

pretty-PTY is a strong internal tool and the architecture is directionally good: PTY ownership is isolated in per-session runner processes, the browser uses one multiplexed WebSocket, frontend live terminals are bounded, and the current terminal renderer path already tries WebGL, then canvas, then DOM.

It is not commercial-grade yet. The main gap is not the feature idea. The gap is operational hardness around long-lived sessions: old sessions can keep stale launchd/process behavior after fixes, hot paths do synchronous work, backpressure is mostly ignored, and the product has too little built-in telemetry to explain "blank terminal", "slow typing", or "session feels old" without shell archaeology.

## What the prior investigation got wrong or overstated

1. "The DOM renderer is the fix" is outdated for current code.
   - Current frontend dynamically imports `@xterm/addon-webgl` and `@xterm/addon-canvas`, then loads WebGL with canvas fallback: `frontend/src/hooks/useTerminal.ts:135-185`.
   - Current code also coalesces PTY output into one `term.write()` per animation frame: `frontend/src/hooks/useTerminal.ts:236-250`.
   - So DOM renderer may have been a historical issue, but it is not the current primary explanation unless WebGL/canvas fail at runtime.

2. "All browser fixes were irrelevant" is too strong.
   - The severe startup/typing issue was caused by macOS process class for runner/Claude processes, and `ProcessType=Interactive` is the correct class for new runner plists: `prettyd/src/launchd.ts:76-80`.
   - But browser-side rendering, snapshot polling, and output batching are still real product concerns at 240+ columns and 100+ rows. They are just not the root cause of the 39-second blank start.

3. "New plist fix means the fleet is fixed" is false for existing sessions.
   - Plist generation now writes `ProcessType=Interactive`: `prettyd/src/launchd.ts:76-80`.
   - Existing launchd jobs can remain running with old spawn behavior until relaunched. The code has no reconciler that compares live launchd job state, runner argv, runner code version, plist contents, and expected policy.

## What is already good

1. The core process model is sensible.
   - Runners own the PTY and survive daemon reloads: `prettyd/src/runner.ts:78-82`.
   - prettyd reconnects to existing runner sockets after listen, so the UI is not blocked by runner discovery: `prettyd/src/server.ts:44-56`.

2. The frontend avoids the old "one socket per tab" failure mode.
   - The mux manager uses one WebSocket per server and tags frames by session: `frontend/src/lib/wsMux.ts:85-94`.

3. The active terminal path has the right renderer direction.
   - WebGL/canvas renderer fallback exists: `frontend/src/hooks/useTerminal.ts:165-185`.
   - Output is batched before writing to xterm: `frontend/src/hooks/useTerminal.ts:236-250`.

4. TypeScript gates currently pass.
   - `npm --prefix prettyd run typecheck` passed.
   - `npm --prefix frontend run typecheck` passed.
   - `npm --prefix frontend run test:markdown` passed: 13 passed, 0 failed.

## Blocking gaps before commercial use

### 1. No lifecycle reconciler for long-lived sessions

The application now depends on launchd process metadata, runner program path, built `dist/runner.js` freshness, per-runner socket state, and Claude child process state. There is no product-level reconciliation loop that tells the user "this session is old, background-classed, running via tsx, or running stale code."

Evidence:
- New runner launch arguments are selected by a freshness heuristic and can still fall back to `tsx`: `prettyd/src/sessions.ts:160-184`.
- The create-session path explicitly allows a 60-second boot budget because `tsx` fallback can add 20-40 seconds: `prettyd/src/sessions.ts:273-298`.
- Existing jobs are reattached conservatively, but not upgraded or diagnosed: `prettyd/src/sessions.ts:521-530`.

Commercial fix:
- Add `/api/health/deep` and `pretty doctor`.
- For each session report: plist ProcessType, live launchd spawn type if available, runner argv, runner build hash or mtime, child PID/cmd, PTY size, event-log size, current renderer reported by the browser, and whether restart/recreate is required.
- Add a visible stale-session badge in the UI when a session is running with outdated launchd policy or runner code.

### 2. Startup has no phase timings

The 39-second blank terminal was only understandable after manual timing. The product should know where session startup time went.

Evidence:
- Health only reports ok/version/discovery/session count: `prettyd/src/http.ts:49-56`.
- Session create waits for a socket, then throws one broad timeout error: `prettyd/src/sessions.ts:273-298`.

Commercial fix:
- Track and expose startup phases: HTTP create received, plist written, launchctl bootstrap returned, socket appeared, runner hello received, PTY spawned, first PTY output, first Claude logo/prompt heuristic.
- Return those timings from session create and show them in the blank terminal view while waiting.

### 3. Runner output hot path does synchronous disk and terminal work

Every PTY output chunk goes through in-memory logging, headless xterm parsing, synchronous disk append, and socket broadcast in one callback.

Evidence:
- `pty.onData` calls `term.write(data)`, then `persistent.append(...)`, then broadcasts: `prettyd/src/runner.ts:148-156`.
- `PersistentLog.append()` uses `fs.writeSync`: `prettyd/src/persistentLog.ts:76-88`.
- When the 16 MB soft cap is exceeded, trim synchronously reads the whole file and rewrites the kept tail: `prettyd/src/persistentLog.ts:94-127`.

Commercial fix:
- Move persistent writes behind a bounded async writer with flush guarantees on clean shutdown.
- Put trim/compaction outside the keystroke path.
- Add per-session metrics for output chunks, append latency, trim count, max append duration, and dropped/backpressured frames.

### 4. Daemon duplicates terminal mirrors and serializes them periodically

Each runner already owns an xterm-headless mirror. prettyd creates another headless mirror per session and feeds every output into it too.

Evidence:
- Runner creates a headless terminal and serialize addon: `prettyd/src/runner.ts:78-82`.
- prettyd creates a second mirror on registration: `prettyd/src/sessions.ts:317-328`.
- Every runner output also writes into the daemon mirror: `prettyd/src/sessions.ts:433-446`.
- Every 800 ms, every Claude session serializes the mirror to detect "working": `prettyd/src/sessions.ts:75-99`.

Live observation:
- Read-only snapshot calls on the largest active terminals returned 127-204 KB and took roughly 31-44 ms each from the mini. That is acceptable on demand, but expensive as recurring background work across many sessions.

Commercial fix:
- Pick one owner for terminal mirrors.
- Replace serialize-based working detection with event-driven Claude JSONL state plus a lower-frequency fallback.
- If snapshots remain daemon-side, make snapshot timing visible and rate-limit active polling.

### 5. Backpressure is not handled end to end

The system sends data to WebSocket clients and Unix socket clients without using high-water marks or send callbacks as flow-control signals.

Evidence:
- `ws.send(JSON.stringify(msg))` ignores callback, error, and `bufferedAmount`: `prettyd/src/ws.ts:10-12`.
- Replay sends every available output event synchronously in a loop: `prettyd/src/ws.ts:75-85`.
- Live output sends directly on every PTY event: `prettyd/src/ws.ts:100-108`.
- Browser mux `send()` does not check WebSocket `bufferedAmount`: `frontend/src/lib/wsMux.ts:97-110`.
- Runner writes to each Unix socket client without checking the `write()` return value: `prettyd/src/runner.ts:140-146`.

Commercial fix:
- Add per-client output queues with byte caps.
- Coalesce or drop stale output for hidden/inactive sessions.
- Disconnect clients that exceed backpressure budgets.
- Expose buffered bytes in health/doctor output.

### 6. Remote message dispatch uses timing heuristics that can mutate the PTY

The Remote view retries Enter if JSONL confirmation is delayed. That may be practical for an internal tool, but it is risky product behavior because a delayed confirmation can send extra input bytes into an interactive program.

Evidence:
- Auto retry offsets are 2s, 4.5s, and 8s: `frontend/src/hooks/useDispatch.ts:107-115`.
- The retry callback sends a bare `\r` while the message is still pending: `frontend/src/hooks/useDispatch.ts:562-574`.
- Sending a message schedules those retry watchers after recording local pending state: `frontend/src/hooks/useDispatch.ts:604-654`.

Commercial fix:
- Replace implicit Enter retries with protocol-level send acknowledgement when possible.
- At minimum, make auto-retry visible, cancelable, and limited to Claude prompt states verified by JSONL/TUI state.

### 7. Grid mode does not scale like a product surface

Every grid cell polls Claude events every 2 seconds. Grid-cell keystrokes are HTTP POSTs per key, not the mux WebSocket.

Evidence:
- Per-cell event poll: `frontend/src/components/GridView.tsx:124-145`.
- Per-keystroke HTTP POST from grid cell: `frontend/src/components/GridView.tsx:181-190`.

Commercial fix:
- Replace per-cell polling with one shared event subscription or incremental server endpoint keyed by visible sessions.
- Route grid-cell input through the mux channel or explicitly position grid input as low-fidelity only.
- Virtualize large session grids.

### 8. Snapshot polling is active-session only, but still unbudgeted

The picker detector fetches and scans a full active-session snapshot every 2 seconds while in Remote view.

Evidence:
- Active Remote view snapshot poll: `frontend/src/components/SessionView.tsx:135-156`.
- Snapshot prefill does a full fetch and bulk `term.write()` on activation: `frontend/src/hooks/useTerminal.ts:445-469`.
- Server snapshot serializes 1000 lines of scrollback from the daemon mirror: `prettyd/src/sessions.ts:635-654`.

Commercial fix:
- Add timing budgets and cancellation.
- Prefer a small "screen only" endpoint for picker detection instead of full scrollback.
- Emit picker state from the PTY parser/server side if it becomes a core feature.

### 9. Persistent logs lack event timestamps

The persistent on-disk format stores sequence and payload, but not event timestamps. That makes postmortems weaker: after a slow session, the product cannot reconstruct exactly when output chunks happened.

Evidence:
- File format has length, seq, payload only: `prettyd/src/persistentLog.ts:5-11`.
- In-memory `OutputEvent` has `ts`, but persistent records do not: `prettyd/src/eventLog.ts:10-14`.

Commercial fix:
- Version the persistent log format and include timestamp, chunk byte length, and optional source metadata.
- Provide a migration reader for old records.

### 10. Tests are useful scripts, not a product test system

There are typechecks and smoke scripts, but no integrated CI or real e2e coverage for the failures that actually hurt this app.

Evidence:
- Root scripts build/dev/install/ship only: `package.json:6-12`.
- README verification is manual commands: `README.md:90-93`.
- There is no `.github` workflow directory in this checkout.

Commercial fix:
- Add CI for frontend typecheck, markdown smoke, prettyd typecheck, and backend smoke scripts.
- Add macOS-specific integration tests for launchd plist generation and ProcessType.
- Add Playwright tests for create-session blank-screen timing and keystroke echo latency.

### 11. Product portability is still personal-machine shaped

Some code assumes this exact user/machine, which is fine for an internal tool but not for a shipped product.

Evidence:
- App path shortening hardcodes `/Users/uzair`: `frontend/src/App.tsx:374-381`.
- README and architecture are written around the current machine model and manual local operation.

Commercial fix:
- Move user/machine-specific defaults into config returned by prettyd.
- Show the daemon host, user home, and active config in the UI.

### 12. Documentation has drifted from the current architecture

The docs still contain older protocol and parser descriptions alongside newer mux/persistent-log behavior.

Evidence:
- Architecture still describes `/ws?sessionId=<id>` and localStorage lastSeq reconnect flow: `ARCHITECTURE.md:205-207`.
- It also references retired parser files and usePrettyParser details: `ARCHITECTURE.md:312-345`.
- `EventLog` comments still say persistent storage is a future phase, even though `PersistentLog` exists: `prettyd/src/eventLog.ts:7-8`.

Commercial fix:
- Update `ARCHITECTURE.md` to describe the current mux, Remote view JSONL source, persistent log, and renderer stack.
- Add an operator runbook: slow typing, blank terminal, stale session, runner not booting, WebGL fallback, discovery partial.

## Priority roadmap

### P0: make the product diagnosable

- Add `pretty doctor` and `/api/health/deep`.
- Add startup phase timings and per-keystroke echo timing hooks.
- Show stale/background/old-runner warnings in the UI.
- Add Playwright latency and create-session timing tests.

### P1: remove hot-path stalls

- Move persistent append/trim out of the PTY callback.
- Add backpressure handling on WebSocket and Unix socket writes.
- Reduce daemon mirror serialization frequency and scope.
- Add metrics for snapshot duration, append duration, queued bytes, dropped frames, and renderer mode.

### P2: harden product semantics

- Replace Remote auto-Enter retry heuristics with explicit acknowledgement/state.
- Replace grid polling with a shared stream or incremental visible-session endpoint.
- Version protocol/types across frontend and backend.
- Clean up stale docs and user-specific assumptions.

## Bottom line

If this is for one owner on one Tailnet, the app is already useful and the recent launchd fix addresses the biggest lived pain. If this is meant to be commercial-grade, the next work should not be more UI polish. It should be operational product work: lifecycle reconciliation, latency telemetry, flow control, startup instrumentation, and tests that reproduce the exact "blank terminal" and "typing is slow" failures before a user reports them.
