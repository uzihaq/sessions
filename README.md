# pretty-PTY

A PTY-first runtime for running Claude Code (and any TUI) from a phone or
laptop, with a beautiful UI layered on top of a real terminal stream.

## Architecture

```
frontend/   Vite + React + Zustand + xterm.js (UI)
prettyd/    Node + node-pty + ws (daemon — owns the sessions)
```

The terminal stream is the source of truth. Pretty cards/sidebar are
**derived** from that stream by parsers, never an alternative path.

## Phase status

- [x] **Phase 1** — PTY daemon prototype (node-pty + ws + xterm.js, no cards yet)
- [x] **Phase 2** — persistence (session IDs, seq numbers, replay, recovery)
- [x] **Phase 3** — Pretty parser layer (Claude/Codex parsers feed cards/sidebar)
- [x] **Phase 3.1** — parser/snapshot smoke harness, soft-wrap parity check
- [ ] Phase 4 — launchd production mode (`com.uzair.prettyd.plist`)
- [ ] Phase 5 — remove tmux (archive `~/pretty-tmux/`)

### Phase 3 notes

The xterm `SerializeAddon` is the per-session ANSI transcript — bounded by
xterm's scrollback (5000 lines), naturally consistent with reconnect/replay
because the terminal is the source of truth. `usePrettyParser` reads the
serialized snapshot on a 200ms throttle, runs `parsers/detect.ts` (cached
per session, re-detected when the cached parser's signal disappears) and
exposes structured `Block[]` + `SidebarFindings` to the React tree.

The Pretty pane is **derived UI only**:

- `SessionView` renders a Terminal / Split / Pretty toggle (default Split,
  Terminal-only on phones). xterm stays mounted in every mode so a parser
  hiccup never takes the raw terminal away.
- Block components (`PrettyView.tsx`) and `StatusSidebar` are intentionally
  minimal — they consume the `Block` / `SidebarFindings` types from
  `parsers/types.ts` but don't pull in the full pretty-tmux markdown / diff
  / copy-button stack. That's a Phase 3+ polish task.

Verify locally:

```sh
cd frontend
npm run typecheck      # parsers no longer excluded; full strict TS
npm run test:parsers   # esbuild-bundled parser fixtures
npm run test:serialize # parser fed real xterm SerializeAddon snapshots
npm run build          # vite production build
```

### Phase 3.1 notes

`scripts/serialize-smoke.cjs` runs Claude-shaped transcripts through a real
`@xterm/headless` Terminal + `@xterm/addon-serialize`, then feeds the
serialized snapshot to `detectTool` / `parser.parse`. It complements
`parser-smoke.cjs`, which uses hand-crafted ANSI fixtures: this one proves
the parser handles the *exact shape* `useTerminal` produces (`\r\n` line
endings, trailing cursor-positioning CSI, soft-wrapped lines joined with
no separator, chunked PTY-style writes).

**Soft-wrap parity with `tmux capture-pane -J`:** investigated and confirmed
no mitigation is needed. SerializeAddon's row separator is `""` (empty) when
a row was naturally wrapped to the next, and `\r\n` when there was a real
newline — the same join behavior `capture-pane -J` produces. The
`soft-wrapped long claude_message` case in `serialize-smoke.cjs` enforces
this: a long line wrapped across multiple rows in a 40-col terminal must
come back as one `claude_message` block with no interior `\n`. The parser is
also already robust to `\r` in line endings via the `.trimEnd()` calls in
`parseClaudeMessage` and friends.

**Markdown rendering for `claude_message`:** intentionally not added in 3.1.
Claude Code already renders markdown to ANSI (bold via SGR, code colors via
256-color escapes, etc.) before writing to the PTY, so the existing Anser
path in `PrettyView`'s `AnsiText` already produces the styled output Claude
intended. Layering a markdown pass on top would risk double-rendering and
requires a new dependency (`marked` is not installed). Re-evaluate once we
have a real corpus of `claude_message` content where literal `**` / fenced
blocks survive into the snapshot.

## Dev

```sh
# one-shot install
(cd prettyd && npm install) && (cd frontend && npm install)

# run both
npm run dev
```

Then open http://localhost:5273. Vite proxies `/api` and `/ws` to `prettyd`
on port 8787.

Ports are chosen to coexist with the legacy `pretty-tmux` install
(`:3001` relay, `:5173` vite) until Phase 5.

| service        | pretty-tmux | pretty-PTY |
| -------------- | ----------- | ---------- |
| backend daemon | 3001 relay  | 8787 prettyd |
| frontend (vite)| 5173        | 5273       |

## Origin

Forked spiritually (not by branch) from `~/pretty-tmux/`. The tmux + relay +
polling architecture is being replaced by `prettyd` + per-session
`node-pty` runners + WebSocket replay.
