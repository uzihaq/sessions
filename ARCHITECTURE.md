# pretty-PTY architecture

pretty-PTY is a local PTY runtime with a browser UI and command-line client.
The production distribution is three static Go binaries; the existing
TypeScript daemon remains the normative compatibility reference during the
interop-first migration.

## Process model

```text
browser / pretty CLI
        |
        | HTTP + multiplexed WebSocket
        v
prettyd (127.0.0.1:8787, embedded React UI)
        |
        | one Unix socket per session
        v
runner <id>  -> PTY -> claude / codex / shell / arbitrary command
runner <id>  -> PTY -> ...
```

The roles are deliberately separate:

| Binary | Lifetime | Responsibility |
| --- | --- | --- |
| `pretty` | one command | API client, orchestration, diagnostics, install and remote setup |
| `prettyd` | background service | HTTP/WS, discovery, watchers, lane ledger, notifications, embedded UI |
| `runner` | one per session | owns the PTY, terminal mirror, socket, replay log, and child process |

On macOS, `pretty install` registers `prettyd` as
`tech.pretty-pty.daemon`. Each session is separately supervised under
`tech.pretty-pty.runner.<id>`. Restarting the daemon does not terminate the PTY
owners; the daemon discovers their sockets and reattaches. Session teardown is
explicit and guarded against accidental mass removal.

All production Go builds use `CGO_ENABLED=0`. The daemon embeds the built web
UI, so end users do not need Node, npm, Vite, or a separate static-file server.

## Compatibility boundary

The TypeScript implementation in `prettyd/src/` defines the external contract:

- HTTP routes and response shapes
- WebSocket protocol and replay ordering
- runner Unix-socket frame protocol
- state directory and persistent event-log formats
- launchd labels and plist behavior

The Go daemon and runner preserve those contracts so either side can be swapped
independently. Detailed executable contracts live in [`prettygo/CONTRACT/`](prettygo/CONTRACT/):

- [`http-api.md`](prettygo/CONTRACT/http-api.md)
- [`ws.md`](prettygo/CONTRACT/ws.md)
- [`runner-protocol.md`](prettygo/CONTRACT/runner-protocol.md)
- [`state-dir.md`](prettygo/CONTRACT/state-dir.md)

The React frontend talks to either daemon unchanged.

## Session lifecycle

1. A browser or `pretty new` sends `POST /api/sessions`.
2. Before launch, the daemon records the durable lane boundary when applicable.
3. The daemon writes a per-session launchd plist on macOS and starts `runner`.
4. The runner spawns the requested program in a PTY, binds `<id>.sock`, and
   writes metadata plus an append-only event log.
5. The daemon connects, receives `HELLO`, requests replay, and exposes the
   session over HTTP and WebSocket.
6. Clients receive sequenced output and can reconnect from their last sequence.
7. `pretty kill` records an explicit tombstone before terminating the selected
   session. Unexpected loss remains visible to `pretty recover`.

The terminal byte stream is the source of truth. Provider JSONL watchers add
structured Claude/Codex conversation views and activity facts without making
LLM calls or changing the underlying PTY stream.

## Runner protocol

Runner traffic uses length-prefixed binary frames over a Unix socket:

```text
uint32-be frame length | uint8 type | payload
```

Runner-to-daemon frames carry `HELLO`, sequenced `OUTPUT`, `EXIT`, snapshot
responses, and replay completion. Daemon-to-runner frames carry input, resize,
snapshot/replay requests, and explicit kill. Replay is ordered before live
output, and sequence numbers let clients detect gaps.

## Browser protocol

The browser normally opens one multiplexed WebSocket at `/ws?mux=1`. It
attaches only the sessions it needs, tags traffic by session ID, and can choose
raw output replay, structured event replay, and live streams independently.

The server emits per-session hello, output, structured provider events, gaps,
exit, and runner-loss messages. The client reconnects with its last raw and
structured sequence positions. A bounded in-memory daemon log provides fast
replay; each runner's on-disk log provides the durable source after a daemon
restart.

## State and recovery

The default runtime layout is:

```text
~/.local/state/pretty-PTY/
├── token
├── open
├── vapid.json
├── push-subscriptions.json
├── idle/<session-id>
├── uploads/
└── runners/
    ├── <id>.json
    ├── <id>.sock
    ├── <id>.events
    └── <id>.log

~/Library/LaunchAgents/
├── tech.pretty-pty.daemon.plist
└── tech.pretty-pty.runner.<id>.plist

~/Library/Application Support/pretty-PTY/ledger/lanes.sqlite3
```

`PRETTYD_STATE_DIR` relocates runner artifacts for interoperability and tests;
safe isolation also sets a scratch `HOME` because auth, push, uploads, and idle
state otherwise remain under the user's home. `PRETTY_LEDGER_PATH` separately
relocates the append-only SQLite lane ledger.

The ledger writes launch intent before process creation and a tombstone before
requested termination. It distinguishes expected exits, explicitly closed
lanes, external sessions, and unexpectedly lost lanes. `pretty recover` shows
the plan; `pretty recover --reopen` is the explicit mutation.

## Security and trust boundaries

- Default listener: `127.0.0.1:8787`.
- Wildcard binds such as `0.0.0.0` and `::` are refused.
- Protected HTTP routes use a bearer token; WebSockets use the same token in
  the connection query.
- Browser origins are restricted to loopback, the configured host, and the
  published Pretty web origins.
- Remote access is opt-in through Tailscale Serve. Pretty runs no relay.
- Browser push is opt-in and stores subscriptions locally.
- Pretty launches installed agent CLIs but contains no model client and makes
  no LLM requests.

Tailscale membership and the daemon token are security boundaries, not a
replacement for host security. The remote flow also warns before requesting a
publicly logged Tailscale HTTPS certificate.

## Notifications and hooks

The daemon observes working-to-idle transitions. It writes an idle sentinel,
can deliver an approved browser push notification, and can execute:

- a per-session `--on-idle` shell hook; and
- a global `onIdle` hook from `~/.config/pretty/hooks.json`.

Hooks receive session identity, cwd, tool, local outcome classification, final
message summary, and duration through `PRETTY_*` environment variables. Global
hooks have a 30-second limit; per-session hooks run detached.

## Distribution

`make -C prettygo binaries` builds the embedded frontend and cross-compiles:

- macOS arm64
- Linux arm64
- Linux amd64

Release archives keep `pretty`, `prettyd`, and `runner` adjacent. The Homebrew
formula installs the same layout. `pretty install` currently automates launchd
only; Linux binaries run directly or under a user-provided supervisor.

See [installation](docs/INSTALL.md), [release procedure](docs/RELEASE.md), and
the concise [Go port constraints](prettygo/ARCHITECTURE.md).

## Verification

```sh
cd prettygo && go test ./...
node prettygo/parity/run.mjs
```

The parity harness uses separate ephemeral loopback ports, scratch homes, and a
launchctl shim. It never needs the user's live daemon or runner state.
