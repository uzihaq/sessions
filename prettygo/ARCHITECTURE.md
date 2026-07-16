# prettygo — the Go port (daemon + runner + CLI)
WHY: single static binary (brew install / download-and-run, NO npm, NO install scripts, NO node-gyp — the approve-scripts problem disappears), Linux/systemd for the VM phase, ~MB runners for VM economics, smaller supply-chain surface.

## Non-negotiable pins (every lane obeys)
1. **The TS source is normative.** The existing HTTP/WS API, runner unix-socket frame protocol, state-dir layout, and launchd label scheme are THE contract. The React frontend must work against the Go daemon UNCHANGED. prettyd/src/*.ts is read-only reference.
2. **Interop-first migration:** Go runner must be attachable by the TS daemon and vice versa — same `~/.local/state/pretty-PTY/` layout ({id}.sock/.json/.events/.log), same frame protocol, same `tech.pretty-pty.runner.<id>` plists. Pieces swap in one at a time; parity is testable per-piece.
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
