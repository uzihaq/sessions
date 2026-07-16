# pretty-PTY architecture

> A web UI + CLI for running long-lived Claude / Codex / shell sessions
> on macOS, accessible from a phone via Tailscale, surviving daemon
> restarts and OS reboots.

This doc walks the entire app top-to-bottom: process layout, on-disk
state, network protocols, frontend rendering pipeline, and where each
phase of the original plan lives in the code today. The last section is
an honest critique of the gaps.

> This deep dive was originally written during pre-v0.1 development. Its
> process and protocol descriptions remain useful, but status and critique
> notes may be historical; the current source and README define v0.1 behavior.

---

## 1. Process layout — the four kinds of process

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         macOS user session                              │
│                                                                         │
│  ┌──────────────┐      ┌──────────────┐                                 │
│  │  vite :5273  │ ───► │ prettyd :8787│ ◄── HTTP/WS clients (browser,   │
│  │  (frontend   │      │  (router)    │     `pretty` CLI on :8787)      │
│  │   dev srv)   │      └──────┬───────┘                                 │
│  └──────────────┘             │ Unix sockets                            │
│                               ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  launchd (per-user, gui/<uid> domain)                        │       │
│  │     ├─ tech.pretty-pty.runner.<id-1>.plist                   │       │
│  │     │     └─ runner #1 ─── owns PTY for /opt/homebrew/bin/claude     │
│  │     ├─ tech.pretty-pty.runner.<id-2>.plist                   │       │
│  │     │     └─ runner #2 ─── owns PTY for /bin/bash (~/some-project)   │
│  │     └─ ...                                                   │       │
│  └──────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

Four roles, in lifetime order (longest-lived first):

| process | lifetime | dies on | source |
|---|---|---|---|
| **runner** (one per session) | long-lived; survives prettyd reload, Mac reboot | `pretty kill`, PTY child exits | `prettyd/src/runner.ts` |
| **prettyd** | session-ish; restarts on every code edit (`tsx watch`) | manual stop, code error, machine reboot | `prettyd/src/server.ts` |
| **vite** (dev only) | session-ish | manual stop, code error | `frontend/vite.config.ts` |
| **browser tab** / `pretty` CLI invocation | per-request / per-page-load | tab close, command end | `frontend/src/`, `prettyd/bin/pretty.cjs` |

Critically: **runners are detached from prettyd**. When you edit
`prettyd/src/sessions.ts` and `tsx watch` reloads prettyd, every runner
keeps running. When prettyd comes back, it scans the runners' Unix
sockets and reattaches to all of them. From a user's perspective, the
session looks unchanged.

Runners are managed by **launchd**, not by prettyd directly. prettyd
writes a per-session plist into `~/Library/LaunchAgents/` and calls
`launchctl bootstrap`; launchd starts the runner. On Mac reboot, launchd
auto-starts every plist (RunAtLoad=true), so runners come back without
prettyd needing to be running yet.

---

## 2. The seven persistent file layouts

Two state directories matter:

### `~/.local/state/pretty-PTY/runners/`

One file group per session, all named after the session UUID:

| file | mode | written by | purpose |
|---|---|---|---|
| `<id>.sock` | 0600 | runner | Unix socket — prettyd ↔ runner protocol |
| `<id>.json` | 0600 | runner | session metadata (cmd, args, cwd, pid, createdAt). prettyd reads this on discovery |
| `<id>.events` | 0644 | runner | append-only persistent event log (see §6). Survives `launchctl bootout` / Mac reboot. Deleted only on `pretty kill` or PTY natural exit |
| `<id>.log` | 0644 | launchd | runner's stdout+stderr (errors go here, useful for debugging "why didn't this runner start") |

### `~/Library/LaunchAgents/`

One plist per session: `tech.pretty-pty.runner.<id>.plist`. Written by
prettyd during `createSession`. Read by launchd at user login. Removed
by prettyd in the EXIT handler and on session kill.

---

## 3. The session lifecycle, end-to-end

```
                      ┌────────────────────────────────────────┐
                      │   USER (browser or `pretty new ...`)   │
                      └───────────────────┬────────────────────┘
                                          │ POST /api/sessions
                                          ▼
                              prettyd.createSession()
                                          │
                                          │ writes ~/Library/LaunchAgents/<label>.plist
                                          │ shells out: launchctl bootstrap gui/<uid> <plist>
                                          ▼
                       launchd starts: node runner.ts/runner.js
                                          │
                                          │ runner: spawn(cmd, args) via node-pty
                                          │ runner: bind Unix socket at <id>.sock
                                          │ runner: write <id>.json + open <id>.events
                                          ▼
                              prettyd polls for <id>.sock to exist
                                          │
                                          │ prettyd: connect to socket
                                          │ prettyd: receive HELLO frame from runner
                                          │ prettyd: REPLAY_REQ(0) — backfill local EventLog mirror
                                          ▼
                      session is registered, returned to caller as SessionInfo
                                          │
                                          │
            ┌─────────────────────────────┼───────────────────────────────┐
            │                             │                               │
            ▼                             ▼                               ▼
    Browser opens WS at         pretty CLI hits              `pretty wait` polls
   /ws?sessionId=<id>           /api/sessions/<id>/snapshot   /api/sessions every 250ms
            │                             │                               │
            │ vite proxies to             │ prettyd asks runner via       │ reads SessionInfo.lastDataAt
            │ ws://prettyd/ws             │ SNAPSHOT_REQ frame            │
            ▼                             ▼                               ▼
    prettyd subscribes to       runner: serialize.serialize()    waits for (now - lastDataAt) ≥ idle
    SessionInternal.emitter     → SNAPSHOT_RES frame
       'output' / 'exit'        → returned over HTTP as text/plain
            │
            │ live frames get serialized as
            │ {type:'output', seq, data}
            ▼
       browser writes
       to xterm + parses
       for Pretty cards
```

### Termination paths

There are exactly **three** ways a session ends, and they have different
consequences for the persistent event log:

| trigger | runner sees | persistent log | session ID reusable? |
|---|---|---|---|
| `pretty kill <id>` | KILL frame on socket → `pty.kill()` → `pty.onExit` | **deleted** | no (the .json/.sock are gone) |
| Program inside the PTY exits (Ctrl-D in cat, `/exit` in claude) | `pty.onExit` directly | **deleted** | no |
| Mac reboot, logout, or `launchctl bootout` (system shutdown) | SIGTERM → `cleanupAndExit` with `sessionEnded=false` | **kept** | yes — launchd's `RunAtLoad` brings the runner back at next login |

The discriminator inside the runner is the `sessionEnded` boolean. It's
set inside `pty.onExit` (cases 1+2) and stays false on SIGTERM (case 3).

---

## 4. The runner ↔ prettyd protocol

A length-prefixed binary frame format on a per-session Unix socket. One
frame per write, no framing assumptions across writes. Defined in
`prettyd/src/runnerProtocol.ts`.

```
┌────────────┬─────────┬─────────────────────────────────────┐
│ length (4) │ type(1) │ payload (length-1 bytes)            │
└────────────┴─────────┴─────────────────────────────────────┘
   uint32 BE    enum
```

Frame types:

| type | dir | payload | when |
|---|---|---|---|
| `0x20 HELLO` | runner→prettyd | JSON `{id, cmd, args, cwd, cols, rows, createdAt, pid, currentSeq}` | first frame on every connect |
| `0x21 OUTPUT` | runner→prettyd | 4-byte BE seq + utf8 chunk | every PTY chunk + every replayed event |
| `0x22 EXIT` | runner→prettyd | JSON `{code, signal, seq}` | program inside PTY exited |
| `0x23 SNAPSHOT_RES` | runner→prettyd | utf8 serialized xterm buffer | reply to `SNAPSHOT_REQ` |
| `0x24 REPLAY_DONE` | runner→prettyd | empty | end-of-replay sentinel |
| `0x10 INPUT` | prettyd→runner | utf8 input bytes | every WS `{type:'input',data}` from a client |
| `0x11 RESIZE` | prettyd→runner | JSON `{cols, rows}` | window/term resize |
| `0x12 SNAPSHOT_REQ` | prettyd→runner | empty | `GET /api/sessions/:id/snapshot` |
| `0x13 REPLAY_REQ` | prettyd→runner | 4-byte BE afterSeq | prettyd backfills its EventLog mirror after connect |
| `0x14 KILL` | prettyd→runner | empty | `pretty kill <id>` |

Order guarantee: replayed OUTPUT frames precede REPLAY_DONE. Live OUTPUT
frames after REPLAY_DONE have monotonically increasing seqs, possibly
larger than what was replayed. There's no interleaving because runner
code runs in a single event loop.

---

## 5. The browser-side WebSocket protocol

Defined in `prettyd/src/types.ts` (mirrored client-side in
`frontend/src/types/index.ts`). vite's dev proxy forwards
`ws://localhost:5273/ws` to `ws://localhost:8787/ws`.

Server → client (JSON text frames):
```ts
| { type: 'hello'; protocol: 2; session: SessionInfo; currentSeq; resumedFromSeq }
| { type: 'output'; seq; data }
| { type: 'gap'; oldestAvailableSeq; currentSeq }   // EventLog ring eviction
| { type: 'exit'; code; signal; seq }
| { type: 'error'; message }
```

Client → server:
```ts
| { type: 'input'; data }
| { type: 'resize'; cols; rows }
```

Every output is sequenced. The browser persists `lastSeq` per session
in `localStorage` (`pretty-pty:lastSeq:<id>`). On WS reconnect (phone
unlock, network blip), the client opens
`/ws?sessionId=<id>&lastSeq=<N>`; prettyd consults its local EventLog
mirror and replays everything > N. If the requested seq is below the
oldest still in the buffer, prettyd sends a `gap` event and the client
clears xterm before replaying.

There are two separate event logs in the system:

```
runner (authoritative, persistent)            prettyd (mirror, in-memory)
  │                                             │
  ├─ in-memory EventLog (4MB ring buffer)        ├─ EventLog (4MB ring buffer)
  └─ on-disk PersistentLog (16MB cap, rotates)   │     populated on connect via REPLAY_REQ(0)
                                                  │     then appended on every OUTPUT frame
                                                  │
                                                  │   Used for fast WS replay without per-client
                                                  │   socket round-trips to the runner.
```

---

## 6. The on-disk persistent log format

`prettyd/src/persistentLog.ts`. Append-only. Each record:

```
┌────────────┬─────────┬──────────────────┐
│ recLen (4) │ seq (4) │ utf8 payload     │
└────────────┴─────────┴──────────────────┘
   uint32 BE   uint32 BE
   recLen counts seq + payload (seq is fixed 4 bytes)
```

Properties:

- **Append-only** — every PTY chunk is written once, never modified in
  place. `fs.writeSync` to an `'a+'` fd: atomic per-call append, no
  buffer.
- **Crash-recoverable** — `restoreFrom()` reads forward and stops on the
  first truncated record. A hard crash mid-write loses at most the
  current chunk (microseconds of output).
- **Bounded** — when the file exceeds `SOFT_CAP_BYTES` (16MB), an
  in-place trim keeps the most-recent ~`TARGET_AFTER_TRIM_BYTES` (8MB)
  by atomically rewriting the file via `tmp + rename`.
- **Replay rebuilds xterm-headless** — on runner startup, every record
  is fed back through `term.write(data)`. ANSI escapes apply normally:
  cursor moves, colors, clears all replay correctly. The visible buffer
  state is exactly what it was before shutdown.

What's NOT persisted:
- The PTY's actual process. `claude` / `bash` / etc. is started fresh
  on runner start. The user sees the rendered scrollback but the
  conversation state lives wherever the program puts it (Claude Code
  uses `~/.claude/projects/`, so a `/resume` in claude restores the
  conversation; a bash session gets a new shell).

---

## 7. The frontend, top-to-bottom

`frontend/` is a single-page React + TypeScript + Zustand app served by
vite in dev. In prod (Phase 4 deployment, future), prettyd would serve
the built bundle directly; right now vite is required.

### Component tree

```
<App>
  <header class="app-header">
    <SessionTabs />        — horizontal scrollable strip; per-session
                              icon (claude/codex/shell), working dot
    <ConnectionStatus />   — Live / Connecting / Reconnecting / Offline
  </header>
  <main class="app-main">
    <SessionView key={activeId}>  — re-mounts when active session changes
      <toolbar>
        view-toggle [Terminal | Split | Pretty]
      </toolbar>
      <body>
        <session-terminal-pane>
          <terminal-host ref={…}>   — xterm.js + FitAddon + SerializeAddon
        </session-terminal-pane>
        <session-pretty-pane>
          <pretty-scroll>
            <PrettyView blocks={parser.blocks} />
          </pretty-scroll>
          <InputBar send={…} />     — Esc/↑/↓/^C quick keys + textarea
          <StatusSidebar … />       — parser-derived working/timer/files/checklist
        </session-pretty-pane>
      </body>
    </SessionView>
  </main>
  <MobileNav />            — fixed bottom on ≤720px; swipe = prev/next session
</App>
```

### The two key hooks

#### `useTerminal(sessionId)` — `frontend/src/hooks/useTerminal.ts`

Owns one xterm.js instance + one WebSocket. Returns:

- `containerRef` — attach to the DOM node that should host xterm
- `status` — `'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'`
- `exitInfo` — `{code, signal}` once the session has ended
- `resumedFromSeq` — what seq the WS reconnect resumed from
- `getSnapshotRef.current` — `() => string`, returns SerializeAddon's serialize() (used by usePrettyParser)
- `writeTick` — bumps every time a chunk is written to xterm (drives the parser throttle)
- `sendInputRef.current` — `(data) => void`, used by InputBar

Reconnect strategy: exponential backoff (500ms → 8000ms). `visibilitychange` listener fires on phone unlock and force-reconnects if the WS is in CLOSING/CLOSED, instead of waiting for the timer.

#### `usePrettyParser({sessionId, writeTick, getSnapshotRef})` — `frontend/src/hooks/usePrettyParser.ts`

Trailing-edge throttled re-parse loop:

1. `writeTick` bumps → effect runs.
2. If a parse is already scheduled (200ms-out), do nothing.
3. Else schedule a parse at `setTimeout(... THROTTLE_MS)`.
4. When the timer fires:
   1. Read the latest serialized snapshot.
   2. Run `normalizeXtermSnapshot(raw)` to expand
      `\x1b[<N>C` (cursor-forward) into N literal spaces. Without
      this, Ink-rendered banners come out as `ClaudeCodev2.1.119`
      because the inter-word spaces were positioning escapes.
   3. `detectTool(snapshot)` → `claude-code` | `codex` | `terminal`.
   4. `parser.parse(snapshot)` → `Block[]`.
   5. `parser.extractSidebarFindings(snapshot, blocks)` → timer,
      tokens, currentTask, filesSeen, checklist.
   6. Latch sidebar values across snapshot hiccups; accumulate
      filesSeen monotonically.
   7. `setBlocks(...)`, `setSidebar(...)` → React re-renders.

The "trailing-edge" detail matters: a continuous Claude turn (constant
output) produces a parse every THROTTLE_MS (200ms) — not "never until
output stops".

### The parsers

Carried verbatim from pretty-tmux. `frontend/src/parsers/{claudeCode,codex,terminal,detect,types}.ts` plus the dependency `frontend/src/lib/parser.ts` (677 lines, well-tuned).

Each parser implements a stateless `ToolParser` interface:

```ts
interface ToolParser {
  id: string;
  name: string;
  icon: string;
  detect(raw: string): boolean;
  parse(raw: string): Block[];
  workingState(raw: string): WorkingState;
  extractSidebarFindings?(raw: string, blocks: Block[]): SidebarFindings;
  pollInterval(working: boolean): number;
}
```

`detectTool()` checks claudeCode, codex, terminal in order — terminal
always matches, so there's always a parser. `redetectIfStale` reroutes
mid-session (e.g. user exits claude, drops to a shell).

---

## 8. The CLI (`pretty`)

`prettyd/bin/pretty.cjs`. Single Node script, listed as `bin` in
`prettyd/package.json` and symlinked onto PATH via `npm link`.

Talks to prettyd over loopback HTTP using only the standard `http`
module — no extra dependencies on the CLI side. WS is only used for
`pretty attach` and `pretty tail -f` (loaded from prettyd/node_modules
at runtime).

The interesting subcommand is `pretty wait`: it polls
`GET /api/sessions` every 250ms, reads `SessionInfo.lastDataAt`, and
returns when `(now - lastDataAt) ≥ idleMs`. This is the agent-loop
primitive — the missing piece that lets a script do `send → wait → tail`
without subscribing to the WS.

Exit codes:
- `0` — success / idle / session gone
- `1` — user error or `wait` timed out
- `2` — transport / unknown error

---

## 9. How everything talks during a typical Claude turn

```
T+0    Browser is showing Pretty view of an idle Claude session
       (active tab "uzair", green dot dim, parser=claude-code).

T+0    User types "fix the bug in foo.ts" into InputBar, hits Enter.
       │
       ▼ InputBar calls term.sendInputRef.current("fix the bug…\r")
       │ which is wired to ws.send({type:'input', data})
       │
T+0+ε  prettyd's WS handler receives the input,
       calls writeInput(sessionId, data) → session.client.send(data)
       which writes an INPUT frame to the runner socket.
       │
T+0+ε  Runner receives INPUT frame, calls pty.write(data).
       │ The PTY child (claude) reads from stdin.
       │
T+0+1ms claude starts emitting tokens:
       ┌─ ⏺ Searching for "foo.ts"…
       └─ ✻ Thinking… (2s · ↓ 200 tokens · esc to interrupt)
       │
       │ Each chunk fires pty.onData(data) inside the runner:
       │   1. log.push(data) → assigns seq, appends to in-memory ring
       │   2. recentBytes += data.length → working flag goes true
       │   3. term.write(data) → xterm-headless mirror updates
       │   4. persistent.append(seq, data) → ~/.local/state/.../<id>.events
       │   5. broadcastFrame(encodeOutput(seq, data)) → out the socket
       │
T+0+2ms prettyd's RunnerClient receives OUTPUT frames.
       │ For each: log.pushAt(seq, data) → emitter.emit('output', ev)
       │ The session's recentBytes counter ticks up too
       │ → SessionInfo.working flips to true.
       │
T+0+2ms prettyd's WS handler sees emitter 'output',
       sends {type:'output', seq, data} JSON to the browser.
       │
T+0+5ms The browser:
       ├─ writes the chunk to xterm (visible on Terminal view)
       ├─ bumps writeTick (triggers re-parse via usePrettyParser)
       └─ persists lastSeq to localStorage
       │
T+0+200ms (Throttled re-parse fires)
       ├─ getSnapshotRef.current() → SerializeAddon → ANSI text
       ├─ normalizeXtermSnapshot() → expand cursor-forward to spaces
       ├─ detectTool() → claude-code (banner is in the buffer)
       ├─ parser.parse() → Block[] including a thinking_active block
       ├─ extractSidebarFindings() → {timer:"2s", tokens:"200"}
       └─ React re-renders Pretty view + StatusSidebar

…minutes later, claude finishes, emits ⏺ message + ❯ prompt…

T+N    SessionInfo.working flips to false (recentBytes decay below threshold)
       └─ tab strip's working dot stops pulsing
       └─ pretty wait <id> --idle 2s returns
```

---

## 10. Reboot survival end-to-end

This is what makes pretty-PTY usable for real work.

```
[User typing in claude session, mid-conversation]
       │
       ▼
[Mac reboots — power outage, Cmd+Ctrl+Eject, software update, …]
       │   Everything dies: prettyd, vite, all runners, all PTYs.
       │   What's left on disk:
       │     ~/Library/LaunchAgents/tech.pretty-pty.runner.<id>.plist
       │     ~/.local/state/pretty-PTY/runners/<id>.events  (16MB cap)
       │     ~/.local/state/pretty-PTY/runners/<id>.json    (will be rewritten)
       ▼
[Mac boots back up, user logs in]
       │   launchd reads ~/Library/LaunchAgents/, finds the runner plists.
       │   For each plist with RunAtLoad=true, launchd spawns the program:
       │     node /Users/uzair/pretty-PTY/prettyd/dist/runner.js
       │       (or via tsx in dev — same process, just a script-loader shim)
       ▼
[Each runner starts]
       1. Reads RUNNER_* env vars (set by the plist).
       2. Unlinks any stale .sock from previous run (safety).
       3. Spawns a fresh PTY: spawn(cmd, args, {cols, rows, cwd, env}).
       4. Opens xterm-headless at the same cols×rows as before.
       5. PersistentLog.restoreFrom(<id>.events) → reads every record.
       6. For each record: log.pushAt(seq, data); term.write(data).
       7. Writes a "[pretty-pty: replayed N events]" banner.
       8. Binds Unix socket at <id>.sock; writes <id>.json metadata.
       9. Now waiting for prettyd to connect.
       │
       ▼
[User starts prettyd manually OR a future plist auto-starts it]
       │   prettyd calls discoverRunners():
       │     1. cleanupOrphanPlists() — bootouts plists with no state files
       │     2. For each .sock in the state dir:
       │        a. RunnerClient.connect() with 2s timeout
       │        b. on success: register session in the in-memory map
       │        c. REPLAY_REQ(0) → backfill local EventLog mirror
       │        d. on failure: unlink .sock + .json, bootout the plist
       │   Once discovery finishes, prettyd starts listening on :8787.
       │
       ▼
[User opens the web UI / runs `pretty ls`]
       │   `pretty ls` shows the same session ids as before reboot.
       │   The UI tabs reappear. Click one → SessionView opens →
       │   useTerminal opens WS → prettyd replays from local EventLog →
       │   browser sees the rendered scrollback INCLUDING the
       │   "[replayed N events]" banner.
       │
       ▼
[User types `/resume` inside claude]
       │   Claude itself reads ~/.claude/projects/<...> and restores
       │   the actual conversation state. The user is back where they
       │   were before the reboot.
```

The critical detail: **the PTY is a fresh process**. We persist the
*visible buffer*, not the program's runtime state. For Claude Code that
works because Claude has its own conversation persistence; for a bash
session it means you see your old terminal history but type into a fresh
shell. (Documenting this clearly is itself a gap — currently there's no
in-app explanation of "your prompt is fresh.")

---

## 11. Critique — what's good, what's wrong, what's missing

### What I think is right

- **Runner-as-process is the correct seam.** Once the PTY moved out of
  prettyd's address space, every restart story collapsed into "scan a
  directory, reattach via Unix socket." Replacing prettyd, hot-reloading
  prettyd, OS rebooting — same code path.
- **launchd, not custom supervision.** I considered writing a
  pretty-PTY supervisor process. launchd already does plist
  discovery, RunAtLoad, env var injection, stdio redirection — and
  it's the OS's job to babysit per-user agents. Per-session plists keep
  prettyd stateless about which sessions exist between restarts.
- **Append-only log over SQLite.** Every per-session event stream is
  inherently append-only with monotonic seq. SQLite would be ~5MB extra
  binary, an init step, transaction overhead. The flat file with a
  4-byte length prefix decodes in ~50 lines and corrupts gracefully
  (truncation at EOF).
- **The runner ↔ prettyd protocol is dumb on purpose.** No request
  IDs, no async multiplexing — just a pipe of frames. Multiple WS
  clients per session don't need it because each gets its own
  prettyd-side EventLog mirror anyway.
- **`pretty wait` was the right primitive.** Without it, agent scripts
  that say "send a prompt, wait for Claude, read the answer" had to do
  WS bookkeeping. With it, that's three CLI lines.

### What I'd flag as gaps

#### High-severity

1. **No authentication on prettyd at all.** The bind guard refuses
   `0.0.0.0` without `PRETTYD_ALLOW_ANY=1`, and the user's setup is
   "prettyd on loopback, vite on Tailscale IP" — so the perimeter is
   Tailscale's identity check. Anyone on the user's tailnet who can
   reach `vite:5273` can reach `prettyd:8787` via the proxy and spawn
   shells. For a single-user tailnet that's fine; the moment a second
   device joins, it's a vulnerability. **There's no path for
   per-session ACLs**, no token rotation, no audit log. We discussed
   adding a token; user reverted because it was theater on a
   single-user tailnet. Honest answer: the threat model is "trust
   Tailscale, period."

2. **PTY-resume doesn't restore process state.** After reboot, the user
   sees their old scrollback but the program inside the PTY is fresh.
   This is correct behavior (we can't snapshot a Unix process), but
   nothing in the UI or CLI tells the user. They'll type into what
   looks like a live Claude conversation and get a fresh shell back.
   **Fix:** the replay banner needs to be a clearer in-UI notification:
   "this session was restored from disk; use `/resume` in Claude to
   continue your actual conversation."

3. **Runner ↔ prettyd has no auth.** The Unix socket is mode 0600
   (user-only) which is fine on a single-user system, but any process
   running as the user can connect to a runner socket and impersonate
   prettyd: send INPUT, kill, etc. Probably acceptable on a personal
   Mac; not for a shared dev box.

4. **`SessionInfo.working` is byte-rate-based, not parser-based.** Real
   Claude turns *might* hit zero-byte windows during long thinks,
   making the indicator flicker idle then re-pulse. Empirically it
   looks fine because Claude's stream is dense, but it's not robust.
   The parser-derived `isWorking` for the active tab is more accurate
   — we should consider running cheap pattern-match (regex for `✳
   Thinking`) on each runner periodically and exposing that as a
   second `working_parser` field.

#### Medium-severity

5. **Two EventLog implementations now exist.** The in-memory ring
   (`prettyd/src/eventLog.ts`) and the on-disk persistent log
   (`prettyd/src/persistentLog.ts`). They have nearly identical
   semantics. Today the runner has to write to both manually. A single
   "EventLog with optional persistence" abstraction would be cleaner
   but the current factoring is verbose-but-clear; refactor when we
   add a third backend (SQLite, S3, …).

6. **prettyd's local EventLog mirror grows independently of the
   runner's.** When prettyd restarts, it does `REPLAY_REQ(0)` which
   pulls everything the runner has. But during normal operation, the
   prettyd mirror just grows from new OUTPUT frames. If the runner's
   ring evicts old events (a `cat huge-file.txt` blasts past 4MB),
   prettyd's mirror still has those old events from before the eviction.
   That's fine — prettyd's mirror has its own 4MB cap and evicts the
   same way. But there's no integrity check that mirror == runner state.
   In practice it's been correct in every test; in theory a bug here
   would silently desync.

7. **No schema versioning on the persistent event log.** If we ever
   change the record format (add a timestamp, change utf8 to bytes),
   old `.events` files won't decode. There's no version byte in the
   format. Cheap fix: add a 4-byte magic + version header at the top
   of each file. Not done.

8. **Discovery is O(N) on prettyd startup, blocking listen.** If a
   user has 50 sessions and several have stale sockets, prettyd waits
   up to `2s × N` for connect timeouts before binding `:8787`. In
   practice: 5-10 sessions, ~100ms each, fine. But not graceful. Could
   parallelize the discovery scan or move it after `server.listen()`.

9. **No pruning of old `.log` files.** Each runner writes its stderr
   to `<id>.log`. After many session lifetimes, the directory
   accumulates dead `.log` files (the others — `.sock`/`.json`/`.events`
   — get cleaned up on session exit). A periodic sweep that nukes
   `.log` files older than 7 days would be good citizenship.

10. **No backpressure to the PTY.** If prettyd's WS clients are slow
    (say a phone on a bad network), the runner happily keeps emitting
    OUTPUT frames at full PTY rate. They queue in the runner's socket
    buffer; when full, `sock.write` returns false and we ignore the
    return. node net's default buffering handles small bursts but a
    multi-megabyte spam (`cat huge.bin`) could cause runner OOM. The
    in-memory EventLog rotates so the runner doesn't grow there, but
    the unflushed socket buffer can.

#### Low-severity / cosmetic

11. **No favicon.** 404 in console.

12. **Inactive tab parser icon is cmd-based.** A user who runs
    `claude` via a wrapper script gets a `terminal` icon. We could
    snapshot each runner once on session-list and re-classify based on
    actual buffer content — but that's a per-session round-trip on
    every `pretty ls`, and the cmd-based heuristic covers the common
    case. Documented gap.

13. **No per-tab parser state for inactive sessions.** Tabs you aren't
    attached to don't have a usePrettyParser running. Their working
    state comes from the cheap byte-rate `working` field, not from the
    parser's `isWorking`. Same tradeoff as #4.

14. **No theme toggle.** Hardcoded dark theme. Light mode CSS is
    defined (`theme-light` class on html) but there's no UI to flip it.

15. **No tab rename.** Tab labels are derived from cwd basename.
    Pretty-tmux supported double-click rename; we don't.

16. **Markdown / diff rendering deferred.** `claude_message` blocks
    show plain monospace text with ANSI colors. Pretty-tmux had marked
    + diff highlighting; we deferred those because they pulled in
    `marked` and a custom diff renderer.

### Things the spec asked for that aren't done

- **Phase 5 — remove tmux.** `~/pretty-tmux/` is still on disk. It can
  be archived; nothing in pretty-PTY links to it.
- **Reboot survival of the conversation itself**, not just the
  scrollback. (Documented as architectural.)

### Performance thumbnail

| operation | cost |
|---|---|
| createSession | ~250ms (launchctl bootstrap + socket bind + REPLAY_REQ) |
| pty.onData → broadcast → browser | <2ms end-to-end on loopback |
| usePrettyParser run (~30KB snapshot, claude-code) | 5-15ms |
| SerializeAddon.serialize() (5000-line scrollback, claude TUI) | ~3ms |
| pretty wait poll cycle | one HTTP round-trip every 250ms (~1KB body) |
| persistent.append per chunk | ~150µs (single writeSync) |
| restoreFrom 16MB log on runner start | ~30ms file read + ~250ms term.write replay |

### Simplest possible "next" upgrade

If I had to pick one thing to do next, it'd be **per-session token
auth on prettyd** with a one-time setup flow ("here's your token,
paste it into the URL on your phone"). That's the one missing piece
between "good for me alone" and "I could share this with a coworker."
Everything else is a polish item.

---

*Last updated: 2026-04-29, after Phase 4d (persistent event log).*
