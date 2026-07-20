# Codebase guide

This guide describes the current Go product from its implementation. Paths are
relative to the repository root, and the cited files are the place to re-check
each claim when behavior changes. Protocol compatibility requirements live in
[`prettygo/CONTRACT/`](../prettygo/CONTRACT/), while deployment reality lives in
[`STATE.md`](../STATE.md).

## Native application

`src-tauri/` is the primary macOS client and release package. It uses Tauri 2
around the shared React build. `src-tauri/src/lib.rs` owns native window and
tray behavior: scoped server/tool/session windows, persisted window geometry,
local status polling, and lifecycle status exposed to the frontend.
`scripts/build-app-runtime.sh` builds and signs the three arm64 Go binaries,
while `src-tauri/src/lifecycle.rs` verifies their manifest, stages immutable
runtime versions, installs `tech.somewhere.sessions.daemon`, waits for health
and discovery, verifies the live-session baseline, and rolls back on failure.
The app-bundle updater itself remains the next release layer; its contract lives
in [`NATIVE_APP.md`](NATIVE_APP.md).

The native process is a management plane, not the owner of session work. Its
installer writes and kickstarts the per-user daemon service, but launchd owns
that service afterward and independently supervised runners stay alive through
app quits, daemon reloads, and app upgrades. Android follows the
macOS release as a paired client and does not host the Go runtime.

## Process model

The runtime ships three binaries. `prettyd` opens the ledger, restores discoverable
runners, starts the API, and periodically rediscovers sessions
(`prettygo/cmd/prettyd/main.go`). `runner` is the durable per-session process:
it can own an interactive PTY, a pipe-backed headless lane, a Codex app-server
conversation, or a Claude `-p` conversation (`prettygo/cmd/runner/main.go`,
`prettygo/cmd/runner/codex_app.go`, `prettygo/cmd/runner/claude_p.go`). `pretty`
is the human- and agent-facing HTTP client; its command registry and help are a
single table in `prettygo/cmd/pretty/help.go`, and dispatch resolves through that
registry in `prettygo/cmd/pretty/app.go`.

The runner, not the daemon, owns the work. For PTY sessions it persists framed
events, serves the local runner socket, sends HELLO before any client request,
and replays history atomically (`prettygo/cmd/runner/main.go`,
`prettygo/internal/proto/proto.go`). That separation is why a daemon reload can
reattach to a living session instead of restarting it.

## Command binaries

### `cmd/prettyd`

The daemon validates its bind address, refuses wildcard hosts, opens the
append-only ledger, restores LAN settings, and starts discovery before serving
HTTP (`prettygo/cmd/prettyd/main.go`). Its assembly point makes the ownership
boundaries visible: session state is delegated to `internal/session`, runner
plumbing to `internal/state`, and transport to `internal/api`.

### `cmd/runner`

The runner is a durable session host selected by session kind. Ordinary tools
get a PTY, lanes get noninteractive pipes and an exit manifest, and structured
providers get their own event streams (`prettygo/cmd/runner/main.go`,
`prettygo/cmd/runner/codex_app.go`, `prettygo/cmd/runner/claude_p.go`). A PTY
runner ignores terminal hangup/interrupt signals, preserves explicit
termination, and waits for its post-exit client grace period before cleanup
(`prettygo/cmd/runner/main.go`).

### `cmd/pretty`

The CLI talks to the daemon API and centralizes command discovery, aliases, and
usage in `prettygo/cmd/pretty/help.go`. Lifecycle commands are split into focused
files such as `prettygo/cmd/pretty/commands.go`, `prettygo/cmd/pretty/run.go`, and
`prettygo/cmd/pretty/recover.go`; `prettygo/cmd/pretty/app.go` owns global flags
and dispatch. [`CLI.md`](CLI.md) is generated from the built binary's help, so it
tracks this executable command table rather than a copied list.

## Internal packages

There are 18 production packages under `prettygo/internal/`. The neighboring
`prettygo/internal/interop/` directory is a compatibility test fixture, not a
production package (`prettygo/internal/interop/cutover_test.go`).

### `api`

`api` serves health, authenticated API/WebSocket routes, LAN controls, and the
SPA (`prettygo/internal/api/server.go`, `prettygo/internal/api/ws.go`). Loopback
peers bypass token authentication unless a forwarding header makes the peer
ambiguous; non-loopback clients use the configured bearer or query token unless
the explicit `open` sentinel enables the compatibility escape hatch
(`prettygo/internal/api/auth.go`, `prettygo/internal/api/server.go`).
QR pairing lives here too: single-use five-minute tickets are claimed by an
unauthenticated, rate-limited `POST /api/pair/claim`, which mints per-device
tokens stored as SHA-256 hashes with list/revoke management
(`prettygo/internal/api/pair.go`); device tokens authorize anywhere the master
token does.
Browser-origin checks are a separate CORS and WebSocket boundary, not a second
authentication factor.

### `backup`

`backup` implements opt-in transcript uploads using the user's configured
somewhere credentials; its config records the token path rather than copying a
token (`prettygo/internal/backup/config.go`, `prettygo/internal/backup/push.go`).
Pushes are serialized, and scheduled work only runs when the feature is enabled
(`prettygo/internal/backup/service.go`). With `--encrypt`, transcripts and the
manifest are sealed locally with XChaCha20-Poly1305 before upload — the key
stays on the machine (0600, recovery phrase printed once) so the destination
can never read them; enabling encryption busts the incremental cache so prior
plaintext re-uploads encrypted (`prettygo/internal/backup/encrypt.go`).

### `claudep`

`claudep` drives structured Claude turns through `claude -p` with stream-JSON,
using a new session ID for the first turn and `--resume` thereafter
(`prettygo/internal/claudep/client.go`). It removes `ANTHROPIC_API_KEY` from the
child environment and validates provider events before persisting normalized
history (`prettygo/internal/claudep/events.go`,
`prettygo/internal/claudep/history.go`).

### `codexapp`

`codexapp` speaks the Codex app-server JSON-RPC contract and persists provider
thread IDs across turns (`prettygo/internal/codexapp/client.go`,
`prettygo/internal/codexapp/transport.go`). It permits one active turn per
conversation and normalizes app-server events into stored history; model IDs
are checked against the provider catalog rather than guessed
(`prettygo/internal/codexapp/history.go`, `prettygo/internal/codexapp/models.go`).

### `integrations`

`integrations` is a stable local contract for reading live or persisted provider
history; it does not call a model service (`prettygo/internal/integrations/history.go`).
It also keeps append-only integration failures and records lost or nonzero
runner exits (`prettygo/internal/integrations/errors.go`).

### `lan`

`lan` chooses the primary private IPv4 address associated with the default
route, excluding loopback, link-local, and Tailscale's carrier-grade NAT range
(`prettygo/internal/lan/network.go`). Failure messages guide the user to connect
Wi-Fi or Ethernet, and its routing/address cases are pinned in
`prettygo/internal/lan/network_test.go`.

### `ledger`

`ledger` is an append-only SQLite event log for lane identity, provenance, and
recovery; it deliberately excludes prompts and terminal bytes
(`prettygo/internal/ledger/types.go`, `prettygo/internal/ledger/store.go`). A
fold derives `live-managed`, `closed`, `unexpectedly-lost`, or `external` state
from those events and exposes safe resume recipes (`prettygo/internal/ledger/fold.go`).
The store enables WAL and synchronous-full durability and blocks update/delete
with database triggers.

### `migrate`

`migrate` moves a provider conversation and its safe resume recipe, not a live
process or arbitrary worktree contents (`prettygo/internal/migrate/types.go`,
`prettygo/internal/migrate/source.go`). Receivers validate the recipe and refuse
to overwrite an existing destination (`prettygo/internal/migrate/receive.go`);
workspace transfer policy is isolated in `prettygo/internal/migrate/workspace.go`.

### `mirror`

`mirror` is the daemon's concurrent headless terminal emulator. It applies PTY
output into a viewport, serializes terminal state, drains terminal replies, and
reflows scrollback when dimensions change (`prettygo/internal/mirror/mirror.go`,
`prettygo/internal/mirror/reflow.go`). Defaults and scrollback bounds are owned
by this package rather than by API clients.

### `proto`

`proto` defines the framed runner protocol and the daemon-side socket client
(`prettygo/internal/proto/proto.go`, `prettygo/internal/proto/client.go`). Version
1 requires server-first HELLO, bounds frame size, and distinguishes replay from
live traffic; semantic runner capabilities are exposed through
`prettygo/internal/proto/runner.go`. Structured provider events use the protocol's
extension frame instead of masquerading as terminal output.

### `recovery`

`recovery` reconciles ledger state with live runners and provider files without
mutating anything while it builds a report (`prettygo/internal/recovery/report.go`).
Reopen operations only use validated safe recipes and avoid creating duplicate
live ownership (`prettygo/internal/recovery/mutate.go`). Adoption requires an
explicit, unambiguous provider artifact (`prettygo/internal/recovery/adopt.go`).

### `search`

`search` scans normalized transcripts with case-insensitive substring matching
by default and optional regular expressions (`prettygo/internal/search/search.go`).
The opt-in ranked path maintains a SQLite FTS5 index and uses FTS ranking rather
than replacing literal search (`prettygo/internal/search/index.go`). Transcript
reads are bounded so a malformed or giant artifact cannot consume unbounded
memory.

### `session`

`session` coordinates high-level lifecycle, activity, models, hooks, and idle
notifications (`prettygo/internal/session/manager.go`,
`prettygo/internal/session/idle.go`). Structured lifecycle events are
authoritative when present; PTY output classification is the fallback
(`prettygo/internal/session/classifier.go`). Creation and user-kill intent are
recorded before the corresponding process action.

### `state`

`state` owns daemon configuration, runner paths, launchd registration, and each
attached session's replay/event state (`prettygo/internal/state/config.go`,
`prettygo/internal/state/registry.go`, `prettygo/internal/state/session.go`).
Runner artifacts have defined suffixes in `prettygo/internal/state/paths.go`,
and the in-memory replay plus persisted event log are bounded. This is
low-level runtime state; product lifecycle policy stays in `internal/session`.

### `verdict`

`verdict` accepts explicit producer-authored JSON verdicts and never infers them
from prose or terminal output (`prettygo/internal/verdict/verdict.go`). It appends
records per session, enforces increasing sequence numbers, and retrieves the
latest record (`prettygo/internal/verdict/store.go`); the ledger stores only a
pointer to verdict state.

### `waitcond`

`waitcond` observes commit, file-content, and stable-idle conditions without
changing the target (`prettygo/internal/waitcond/waitcond.go`). Filesystem
notifications are only a wake-up hint; polling remains the liveness mechanism,
and file reads are bounded. CLI integration behavior is exercised in
`prettygo/internal/waitcond/cli_e2e_test.go`.

### `watch`

`watch` resolves and tails Claude project JSONL and Codex rollout JSONL, then
normalizes provider events for the session layer (`prettygo/internal/watch/types.go`,
`prettygo/internal/watch/codex_normalize.go`). Claude resolution prefers an
exact conversation UUID and refuses ambiguous candidates
(`prettygo/internal/watch/claude_resolver.go`); Codex resolution uses resume ID,
working directory, and creation time with a broader fallback
(`prettygo/internal/watch/codex_resolver.go`). Watchers combine filesystem hints
with polling so missed notifications do not stop progress.

### `webassets`

`webassets` provides an optional embedded frontend filesystem. Normal developer
builds expose no embedded assets (`prettygo/internal/webassets/assets_dev.go`),
while `embedui` builds embed the built SPA and provide guarded route fallback
(`prettygo/internal/webassets/assets.go`,
`prettygo/internal/webassets/assets_embedui.go`).

## Session lifecycle

1. An API create request reaches `session.Manager.Create`, which validates the
   request and records `created` in the ledger before asking the registry to
   launch anything (`prettygo/internal/api/server.go`,
   `prettygo/internal/session/manager.go`).
2. The registry writes runner metadata and its per-user launchd definition,
   starts or attaches to the runner, performs HELLO/replay, and constructs the
   daemon-side session (`prettygo/internal/state/registry.go`,
   `prettygo/internal/proto/client.go`, `prettygo/internal/state/session.go`).
3. PTY bytes are appended to the runner event file and framed over its Unix
   socket. The daemon updates the mirror and broadcasts WebSocket state; a
   structured runner sends lifecycle/content frames through the same durable
   boundary (`prettygo/cmd/runner/main.go`, `prettygo/internal/api/ws.go`).
4. A normal exit is ledgered and its launchd registration is reaped. An
   unexpected socket loss gets bounded reconnect attempts and later discovery;
   an explicit kill is ledgered before the kill request
   (`prettygo/internal/session/manager.go`,
   `prettygo/internal/state/registry.go`).

The binding check in `prettygo/internal/session/manager.go` prevents two live
sessions from resuming the same provider conversation. The runner keeps exited
state available briefly for reconnecting clients before removing its transient
socket and metadata (`prettygo/cmd/runner/main.go`).

## Lane lifecycle

`pretty run` creates a session with lane provenance and a noninteractive child
command (`prettygo/cmd/pretty/run.go`). The runner captures its stdout/stderr
through pipes and writes a manifest at exit instead of allocating a PTY
(`prettygo/cmd/runner/main.go`, `prettygo/internal/state/paths.go`). The same
write-ahead ledger and ownership checks used by sessions make the lane visible
to `pretty lanes`, `pretty recover`, and explicit adoption
(`prettygo/internal/ledger/fold.go`, `prettygo/internal/recovery/`).

Recovery is deliberately two-step: reports are read-only, while reopen/adopt
are explicit mutations. A safe recipe can reopen provider context, but it does
not claim to resurrect process memory or uncommitted worktree bytes
(`prettygo/internal/recovery/report.go`, `prettygo/internal/migrate/types.go`).

## State on disk

The default state root is `~/.local/state/pretty-PTY`, with a `runners/`
subdirectory (`prettygo/internal/state/config.go`). `PRETTYD_STATE_DIR` relocates
runner, token, and open-sentinel state for a scratch daemon, while user settings
stay under the default user state root; the override is mandatory for scratch
work so the daily driver's registry is not reused (`docs/DEV.md`).

| State | Default location | Source |
| --- | --- | --- |
| Runner socket, metadata, frames, logs, manifests, structured histories | `~/.local/state/pretty-PTY/runners/` | `prettygo/internal/state/paths.go` |
| Daemon settings | `~/.local/state/pretty-PTY/settings.json` | `prettygo/internal/state/config.go` |
| Access token and open sentinel | `~/.local/state/pretty-PTY/token`, `~/.local/state/pretty-PTY/open` | `prettygo/internal/state/config.go` |
| Search index | `~/.local/state/pretty-PTY/search-index.db` | `prettygo/internal/api/search_handlers.go` |
| Integration errors | `~/.local/state/pretty-PTY/errors.jsonl` | `prettygo/internal/integrations/errors.go` |
| Lane ledger | `~/Library/Application Support/pretty-PTY/ledger/lanes.sqlite3` | `prettygo/internal/ledger/store.go` |
| Global idle hook | `~/.config/pretty/hooks.json` | `prettygo/internal/state/config.go` |
| Backup configuration | `~/.config/pretty/backup.json` | `prettygo/internal/backup/config.go` |
| Runner LaunchAgents on macOS | `~/Library/LaunchAgents/tech.pretty-pty.runner.<id>.plist` | `prettygo/internal/state/registry.go` |

The event log is persistent and trims toward its lower bound after crossing its
soft limit; the daemon also keeps a bounded replay window in memory
(`prettygo/internal/state/persistent.go`, `prettygo/internal/state/eventlog.go`).
Treat these files as protocol state, not as disposable caches, when implementing
compatibility or cleanup.

## Frontend assembly

`prettygo/scripts/build-binaries.sh` builds `frontend/`, copies its `dist/`
output into `prettygo/internal/webassets/dist/`, and builds `prettyd` with the
`embedui` tag. At runtime the API first uses an explicitly configured or
checkout frontend directory and otherwise falls back to the embedded filesystem
(`prettygo/internal/state/config.go`, `prettygo/internal/api/server.go`,
`prettygo/internal/webassets/assets_embedui.go`). API and WebSocket routes are
matched before the guarded SPA fallback.

## Authentication and network surfaces

The default daemon binds `127.0.0.1`; wildcard bind addresses are rejected in
`prettygo/cmd/prettyd/main.go`. A direct loopback peer can use the local API
without a token, while non-loopback traffic normally authenticates with the
token; forwarding headers disable the loopback shortcut
(`prettygo/internal/api/auth.go`). The `open` sentinel is an explicit
compatibility bypass, and static UI/health routing is distinct from
authenticated API routes (`prettygo/internal/api/server.go`).

`pretty lan enable` adds and persists a listener on the selected private network
address (`prettygo/cmd/pretty/lan.go`, `prettygo/internal/lan/network.go`).
`pretty remote enable` configures Tailscale Serve and verifies the resulting
HTTPS health endpoint (`prettygo/cmd/pretty/remote.go`). Allowed browser origins
are checked independently in `prettygo/internal/api/auth.go`; that check limits
browser callers but does not replace token authentication.

## Provider watcher model

Structured Codex and Claude runner kinds publish their own lifecycle events, so
the session manager does not start transcript-file watchers for them
(`prettygo/internal/session/manager.go`). PTY-backed Claude and Codex sessions
instead resolve provider artifacts using the session working directory,
arguments, creation time, and any explicit resume ID.

Claude lookup maps the real working directory to its project directories,
prefers an exact UUID, accepts a sole unambiguous candidate, and refuses to guess
among multiple files (`prettygo/internal/watch/claude_resolver.go`). Codex lookup
first handles a global explicit resume ID, then searches date/cwd/time candidates
and finally performs a bounded broad scan (`prettygo/internal/watch/codex_resolver.go`).
Both tailers combine polling with filesystem notification hints, and Codex
events are normalized before they enter the shared session event stream
(`prettygo/internal/watch/claude_watcher.go`,
`prettygo/internal/watch/codex_watcher.go`,
`prettygo/internal/watch/codex_normalize.go`).
