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
- [ ] Phase 2 — persistence (session IDs, seq numbers, replay, recovery)
- [ ] Phase 3 — Pretty parser layer (Claude/Codex parsers feed cards/sidebar)
- [ ] Phase 4 — launchd production mode (`com.uzair.prettyd.plist`)
- [ ] Phase 5 — remove tmux (archive `~/pretty-tmux/`)

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
