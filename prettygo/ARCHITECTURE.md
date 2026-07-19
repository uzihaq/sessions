# prettygo — the shipped runtime (daemon + runner + CLI)

The port is complete and this is the current product runtime. The native app
bundles these binaries; standalone archives remain available for headless and
developer use. Pure Go keeps cross-compilation predictable, runners small, and
the runtime independent of npm, install scripts, and node-gyp.

## Non-negotiable pins (every lane obeys)
1. **The compatibility contract is stable.** The HTTP/WS API, runner Unix-socket frame protocol, state layout, and runner launchd label scheme stay compatible. `prettyd/src/*.ts` is retained as read-only mini-cutover and rollback evidence, not as the home for new product work.
2. **Interop remains proven:** Go runners are attachable by the TypeScript daemon and vice versa — same `~/.local/state/pretty-PTY/` layout (`{id}.sock/.json/.events/.log`), frame protocol, and `tech.pretty-pty.runner.<id>` plists.
3. **Pure Go, CGO_ENABLED=0.** creack/pty for PTYs, coder/websocket for WS, modernc.org/sqlite (NOT mattn — no cgo) for the ledger. A cross-compilable static binary is the whole point.
4. **The lane ledger is built-in from day one** (board tsk_64772bd2): write-ahead `created` before launch, tombstone before kill, `pretty recover --reopen`.
5. Dumb pipe: zero LLM calls, observation never interpretation. Sessions are sacred: no code path may mass-remove runners without an explicit forced flag (the mass-kill guard is IN the design here).

## Module layout
module github.com/uzihaq/pretty-pty/prettygo
  cmd/prettyd/   — daemon main
  cmd/runner/    — runner main
  cmd/pretty/    — CLI main
  internal/proto/    — runner frame protocol (shared)
  internal/mirror/   — terminal emulation, snapshot, serialize, reflow
  internal/state/    — state-dir layout, discovery
  internal/ledger/   — lane ledger (sqlite)
  internal/watch/    — claude JSONL + codex rollout watchers/resolver
  internal/api/      — HTTP/WS handlers
