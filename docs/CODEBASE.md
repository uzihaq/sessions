# Codebase guide

This guide describes the current Go product from its implementation. Paths are
relative to the repository root, and the cited files are the place to re-check
each claim when behavior changes. Protocol compatibility requirements live in
[`runtime/CONTRACT/`](../runtime/CONTRACT/), while deployment reality lives in
[`STATE.md`](../STATE.md).

## Native application

`src-tauri/` is the primary macOS client and release package. It uses Tauri 2
around the shared React build. `src-tauri/src/lib.rs` owns native window and
tray behavior: scoped server/tool/session windows, persisted window geometry,
local status polling, native LAN/remote/pairing commands, configurable daemon
port state, Somewhere CLI version/update discovery, and lifecycle status exposed
to the frontend. The Somewhere command is read-only; its card only copies
explicit install/update/docs commands (`frontend/src/components/SomewhereCard.tsx`).
`scripts/build-app-runtime.sh` builds and signs the three arm64 Go binaries,
while `src-tauri/src/lifecycle.rs` verifies their manifest, stages immutable
runtime versions, installs `tech.somewhere.sessions.daemon`, waits for health
and discovery, verifies the live-session baseline, and rolls back on failure.
The signed app-bundle updater is configured in `src-tauri/tauri.conf.json` and
exposed through the native-only settings flow in
`frontend/src/lib/tauriBridge.ts`; the bridge serializes update discovery and
delivers once-per-version native notifications. `frontend/src/components/TodayView.tsx`
renders the local work journal and opt-in recap, while
`frontend/src/components/ConnectionsView.tsx` presents loopback, LAN, Tailscale,
pairing, and safe port migration. `frontend/src/components/SearchView.tsx`
fans exact, regex, ranked, or explicitly submitted AI-planned searches across
the configured fleet, persists the query and provider/speaker filters locally,
and opens a byte- and message-bounded history tail in a read-only viewer rather
than resuming it. Provider badges
reuse the Claude and Codex product icons through
`frontend/src/components/ProviderBadge.tsx`. `scripts/release-app.sh` validates the
version, signing key, notarization credentials, nested signatures, stapling,
Gatekeeper assessment, and renders the static Tauri manifest. Its release
contract lives in [`NATIVE_APP.md`](NATIVE_APP.md).

The desktop workspace begins in `frontend/src/App.tsx`. `ProductSidebar.tsx`
owns the permanent Home/Sessions/Today/Search/Fleet/Usage/Settings rail;
`HomeView.tsx` summarizes the operational inbox; and `SessionNavigator.tsx`
builds the manager/child tree from normalized `SessionInfo` provenance fields.
`FleetView.tsx` independently polls every configured daemon, uses the optional
`system.os`/`system.arch` health metadata to choose a platform mark, and keeps
older daemons compatible with a conservative client-side fallback. The
Somewhere VM remains a clearly disabled coming-soon machine card rather than a
fake live endpoint.
The navigator never derives parentage from cwd or timestamps. Manager pins and
open-tab IDs are bounded local UI preferences; the main list explicitly requests
exited sessions so completed children and ended parents remain visible. Creator kind, parent ID,
ancestry, and provenance status remain daemon/ledger truth. `SessionView.tsx`
owns the Conversation/Terminal/Details switch. `SessionDetails.tsx` renders
runtime, workspace, recovery, relationship, usage, and destructive controls;
closing `SessionTabs.tsx` only closes a view. `SessionHistoryView.tsx` is the
explicit exited-session path: it fetches the bounded history preview and never
mounts xterm or a live WebSocket. Grid and mobile navigation receive only active
sessions, while the full navigator retains lineage history. `NewSessionDialog.tsx` handles two
different flows: a global recent-workspace launcher and a delegated child
launcher. The latter sends its parent via the trusted HTTP creator header, then
uses wait-ready plus the composer's bracketed-paste/separate-Enter input contract
for an optional initial task. Profiles inherit only while the child keeps the
same provider; switching providers visibly resets to that provider's default login.
A newly created profile never receives task input during its provider login flow.
`SettingsView.tsx` provides native light/dark appearance, working agent/recap
preferences with rollback and stale-request protection, profile visibility,
signed update checks/install, Connections, and the existing encrypted
Somewhere backup surface, with unimplemented platform services labeled Coming
soon.

The native process is a management plane, not the owner of session work. Its
installer writes and kickstarts the per-user daemon service, but launchd owns
that service afterward and independently supervised runners stay alive through
app quits, daemon reloads, and app upgrades. Android follows the
macOS release as a paired client and does not host the Go runtime.

## Process model

The runtime ships three binaries. `sessionsd` opens the ledger, restores discoverable
runners, starts the API, and periodically rediscovers sessions
(`runtime/cmd/sessionsd/main.go`). `sessions-runner` is the durable per-session process:
it can own an interactive PTY, a pipe-backed headless lane, a Codex app-server
conversation, or a Claude `-p` conversation (`runtime/cmd/sessions-runner/main.go`,
`runtime/cmd/sessions-runner/codex_app.go`, `runtime/cmd/sessions-runner/claude_p.go`). `sessions`
is the human- and agent-facing HTTP client; its command registry and help are a
single table in `runtime/cmd/sessions/help.go`, and dispatch resolves through that
registry in `runtime/cmd/sessions/app.go`.

The runner, not the daemon, owns the work. For PTY sessions it persists framed
events, serves the local runner socket, sends HELLO before any client request,
and replays history atomically (`runtime/cmd/sessions-runner/main.go`,
`runtime/internal/proto/proto.go`). That separation is why a daemon reload can
reattach to a living session instead of restarting it.

## Command binaries

### `cmd/sessionsd`

The daemon validates its bind address, refuses wildcard hosts, opens the
append-only ledger, restores LAN settings for normal installs, and starts discovery before serving
HTTP. An explicitly isolated `SESSIONS_STATE_DIR` scratch daemon does not restore the user's LAN listener
(`runtime/cmd/sessionsd/main.go`). Its assembly point makes the ownership
boundaries visible: session state is delegated to `internal/session`, runner
plumbing to `internal/state`, and transport to `internal/api`.

### `cmd/sessions-runner`

The runner is a durable session host selected by session kind. Ordinary tools
get a PTY, lanes get noninteractive pipes and an exit manifest, and structured
providers get their own event streams (`runtime/cmd/sessions-runner/main.go`,
`runtime/cmd/sessions-runner/codex_app.go`, `runtime/cmd/sessions-runner/claude_p.go`). A PTY
runner ignores terminal hangup/interrupt signals, preserves explicit
termination, and waits for its post-exit client grace period before cleanup
(`runtime/cmd/sessions-runner/main.go`).

### `cmd/sessions`

The CLI talks to the daemon API and centralizes command discovery, aliases, and
usage in `runtime/cmd/sessions/help.go`. Lifecycle commands are split into focused
files such as `runtime/cmd/sessions/commands.go`, `runtime/cmd/sessions/run.go`, and
`runtime/cmd/sessions/recover.go`; `runtime/cmd/sessions/app.go` owns global flags
and dispatch. `sessions docs` renders the complete offline Markdown reference,
and [`CLI.md`](CLI.md) is generated by that command, so both track the executable
command table rather than a copied list.

## Internal packages

There are 22 production packages under `runtime/internal/`. The neighboring
`runtime/internal/interop/` directory is a compatibility test fixture, not a
production package (`runtime/internal/interop/cutover_test.go`).

### `api`

`api` serves health, authenticated API/WebSocket routes, LAN controls, daily
recap settings/generation, and the
SPA (`runtime/internal/api/server.go`, `runtime/internal/api/ws.go`). Loopback
peers bypass token authentication unless a forwarding header makes the peer
ambiguous; non-loopback clients use the configured bearer or query token unless
the explicit `open` sentinel enables the compatibility escape hatch
(`runtime/internal/api/auth.go`, `runtime/internal/api/server.go`).
QR pairing lives here too: single-use five-minute tickets are claimed by an
unauthenticated, rate-limited `POST /api/pair/claim`, which mints per-device
tokens stored as SHA-256 hashes with list/revoke management
(`runtime/internal/api/pair.go`); device tokens authorize anywhere the master
token does.
Daily recap routes combine local usage totals with compact factual activity
from both managed lanes and locally observed, still-outside Claude/Codex
conversations. The latter are streamed only from provider logs that contributed
usage in the selected day; child-agent context snapshots are excluded. Only
optional narrative generation is delegated to `internal/recap`
(`runtime/internal/api/recap_handlers.go`).
Smart-feature settings and natural-language search planning live at
`GET/PUT /api/ai/settings` and `POST /api/search/plan`; the planner receives
only the user's bounded query, while the existing `/api/search` route applies
the generated FTS5 query locally (`runtime/internal/api/search_handlers.go`).
Browser-origin checks are a separate CORS and WebSocket boundary, not a second
authentication factor.

Claude launch defaults live at `GET/PUT /api/claude/settings` and are resolved
inside the session manager before the runner boundary
(`runtime/internal/api/claude_settings_handlers.go`,
`runtime/internal/session/claude_defaults.go`). Remote Control, permission
mode, model, effort, Chrome, Remote Control naming, and the Somewhere MCP are
typed rather than free-form startup commands. Explicit per-session choices win;
`inherit` leaves Claude authoritative. Sessions never rewrites Claude's files.
The Somewhere resolver recognizes the canonical HTTP registration or local
`somewhere mcp` adapter, avoids an equivalent duplicate, and fails on a
same-name/different-target conflict without copying a token into runner state.

### `agentcall`

`agentcall` is the shared one-shot boundary for explicitly requested AI
features (`runtime/internal/agentcall/agentcall.go`). It invokes the user's
already-authenticated Codex or Claude CLI in a temporary directory, strips
provider API-key environment variables, disables tools and persistence, and
does not hardcode a model. Codex runs ephemeral/read-only with user config and
rules ignored; its supported isolation features are preflighted so an older CLI
fails with an update/provider instruction rather than weakening the boundary.
Claude runs in safe mode with Chrome, slash commands, settings sources, tools,
MCP, and persistence disabled.

### `backup`

`backup` implements opt-in transcript uploads using the user's configured
somewhere credentials; its config records the token path rather than copying a
token (`runtime/internal/backup/config.go`, `runtime/internal/backup/push.go`).
Pushes are serialized, and scheduled work only runs when the feature is enabled
(`runtime/internal/backup/service.go`). With `--encrypt`, transcripts and the
manifest are sealed locally with XChaCha20-Poly1305 before upload — the key
stays on the machine (0600, recovery phrase printed once) so the destination
can never read them; enabling encryption busts the incremental cache so prior
plaintext re-uploads encrypted (`runtime/internal/backup/encrypt.go`).

### `claudep`

`claudep` drives structured Claude turns through `claude -p` with stream-JSON,
using a new session ID for the first turn and `--resume` thereafter
(`runtime/internal/claudep/client.go`). It removes `ANTHROPIC_API_KEY` from the
child environment and validates provider events before persisting normalized
history (`runtime/internal/claudep/events.go`,
`runtime/internal/claudep/history.go`).

### `codexapp`

`codexapp` speaks the Codex app-server JSON-RPC contract and persists provider
thread IDs across turns (`runtime/internal/codexapp/client.go`,
`runtime/internal/codexapp/transport.go`). It permits one active turn per
conversation and normalizes app-server events into stored history; model IDs
are checked against the provider catalog rather than guessed
(`runtime/internal/codexapp/history.go`, `runtime/internal/codexapp/models.go`).

### `integrations`

`integrations` is a stable local contract for reading live or persisted provider
history; it does not call a model service (`runtime/internal/integrations/history.go`).
Its normal transcript and raw contracts remain complete for deliberate
integrations, while the native viewer uses `TranscriptPreview` to cap both the
tail byte window and rendered message count.
It also keeps append-only integration failures and records lost or nonzero
runner exits (`runtime/internal/integrations/errors.go`).

### `lan`

`lan` chooses the primary private IPv4 address associated with the default
route, excluding loopback, link-local, and Tailscale's carrier-grade NAT range
(`runtime/internal/lan/network.go`). Failure messages guide the user to connect
Wi-Fi or Ethernet, and its routing/address cases are pinned in
`runtime/internal/lan/network_test.go`.

### `ledger`

`ledger` is an append-only SQLite event log for lane identity, provenance, and
recovery; it deliberately excludes prompts and terminal bytes
(`runtime/internal/ledger/types.go`, `runtime/internal/ledger/store.go`). A
fold derives `live-managed`, `closed`, `unexpectedly-lost`, or `external` state
from those events and exposes safe resume recipes (`runtime/internal/ledger/fold.go`).
The store enables WAL and synchronous-full durability and blocks update/delete
with database triggers.

### `migrate`

`migrate` moves a provider conversation and its safe resume recipe, not a live
process or arbitrary worktree contents (`runtime/internal/migrate/types.go`,
`runtime/internal/migrate/source.go`). Receivers validate the recipe and refuse
to overwrite an existing destination (`runtime/internal/migrate/receive.go`);
workspace transfer policy is isolated in `runtime/internal/migrate/workspace.go`.
The current transfer preserves the source and copies a point-in-time provider
file; it does not yet carry the full Sessions ledger, tags, lineage, profile
credentials, usage database, or PTY history. The checksum-verified,
client-mediated cloud envelope and artifact boundary are specified in
`docs/CLOUD_VM.md`.

### `mirror`

`mirror` is the daemon's concurrent headless terminal emulator. It applies PTY
output into a viewport, serializes terminal state, drains terminal replies, and
reflows scrollback when dimensions change (`runtime/internal/mirror/mirror.go`,
`runtime/internal/mirror/reflow.go`). Defaults and scrollback bounds are owned
by this package rather than by API clients.

### `proto`

`proto` defines the framed runner protocol and the daemon-side socket client
(`runtime/internal/proto/proto.go`, `runtime/internal/proto/client.go`). Version
1 requires server-first HELLO, bounds frame size, and distinguishes replay from
live traffic; semantic runner capabilities are exposed through
`runtime/internal/proto/runner.go`. Structured provider events use the protocol's
extension frame instead of masquerading as terminal output.

### `recap`

`recap` owns the explicitly opt-in daily narrative call and its private local
cache (`runtime/internal/recap/service.go`). It accepts already-aggregated usage
and compact `session.DailyActivity` facts, aliases durable session IDs, bounds
activity count and text size, avoids full transcripts, and runs either the
pre-authenticated Codex CLI in an ephemeral read-only sandbox with user
configuration and rules ignored, or Claude with tools and session persistence
disabled through the shared `internal/agentcall` boundary. Sessions does not
supply a model override; each CLI chooses its default while the service requests
its lowest supported reasoning effort. The
provider-safe JSON is passed over stdin, hard-capped at 32 KiB, and never placed
in a visible composer. Documents are keyed by date and cached by the factual
input digest plus provider; this package never calculates usage totals or owns
provider credentials.

### `recovery`

`recovery` reconciles ledger state with live runners and provider files without
mutating anything while it builds a report (`runtime/internal/recovery/report.go`).
Reopen operations only use validated safe recipes and avoid creating duplicate
live ownership (`runtime/internal/recovery/mutate.go`). Adoption requires an
explicit, unambiguous provider artifact (`runtime/internal/recovery/adopt.go`).

### `search`

`search` scans normalized transcripts with case-insensitive substring matching
by default and optional regular expressions (`runtime/internal/search/search.go`).
The opt-in ranked path maintains a SQLite FTS5 index and uses FTS ranking rather
than replacing literal search (`runtime/internal/search/index.go`). Transcript
reads are bounded so a malformed or giant artifact cannot consume unbounded
memory.

### `smartsearch`

`smartsearch` translates one explicit, bounded natural-language request into a
compact SQLite FTS5 query (`runtime/internal/smartsearch/service.go`). It sends
no transcripts, session IDs, result snippets, or index contents to the selected
CLI; provider and speaker filters remain deterministic API parameters. The
generated query is bounded again and then executed by `internal/search` against
the private local index. Only one planner call may run at once, and identical
provider/query plans are cached for ten minutes. Cache keys are SHA-256 digests
rather than natural-language queries, the map is capped at 128 entries, and
expiry timers remove plans even when no later lookup occurs.

### `session`

`session` coordinates high-level lifecycle, activity, models, hooks, and idle
notifications (`runtime/internal/session/manager.go`,
`runtime/internal/session/idle.go`). Structured lifecycle events are
authoritative when present; PTY output classification is the fallback
(`runtime/internal/session/classifier.go`). Creation and user-kill intent are
recorded before the corresponding process action. Its daily activity projection
selects sessions and lanes active in a local day, carries hierarchy/tags/outcome,
and uses only final structured assistant summaries for optional recap input
(`runtime/internal/session/daily_activity.go`).

### `state`

`state` owns daemon configuration, runner paths, launchd registration, and each
attached session's replay/event state (`runtime/internal/state/config.go`,
`runtime/internal/state/registry.go`, `runtime/internal/state/session.go`).
Runner artifacts have defined suffixes in `runtime/internal/state/paths.go`,
and the in-memory replay plus persisted event log are bounded. Additive daemon
settings persist notification, LAN, recap, smart-feature provider choices, and
typed Claude launch defaults
without coupling them to runner state (`runtime/internal/state/settings.go`). This is
low-level runtime state; product lifecycle policy stays in `internal/session`.

### `usage`

`usage` records live structured Claude and Codex token events at the session-manager boundary, then incrementally
indexes the local provider JSONL stores into the same private SQLite ledger without adding a Node runtime dependency.
Stable provider/turn and provider/message keys make backfill enrich rather than double-count live rows
(`runtime/internal/usage/live.go`, `runtime/internal/usage/scanner.go`,
`runtime/internal/usage/store.go`). It retains parser offsets, rebuilds an
index when parsing or pricing semantics change, and reports reasoning as a
subset of output tokens. Forked Codex child rollouts are treated as a context
snapshot followed by new child work: copied parent turns are neither rebilled
nor re-dated, and physical-log provenance cannot be replaced by an equal replay.
Aggregation exposes schema-versioned daily, weekly,
monthly, session, tag, provider, and model views; session tags are joined from
current runner metadata at query time (`runtime/internal/usage/report.go`).
Pricing is an explicit pinned `ccusage`-compatible table: recorded costs remain
distinguishable from estimates, and unknown models remain visibly unpriced
(`runtime/internal/usage/pricing.go`).

### `verdict`

`verdict` accepts explicit producer-authored JSON verdicts and never infers them
from prose or terminal output (`runtime/internal/verdict/verdict.go`). It appends
records per session, enforces increasing sequence numbers, and retrieves the
latest record (`runtime/internal/verdict/store.go`); the ledger stores only a
pointer to verdict state.

### `waitcond`

`waitcond` observes commit, file-content, and stable-idle conditions without
changing the target (`runtime/internal/waitcond/waitcond.go`). Filesystem
notifications are only a wake-up hint; polling remains the liveness mechanism,
and file reads are bounded. CLI integration behavior is exercised in
`runtime/internal/waitcond/cli_e2e_test.go`.

### `watch`

`watch` resolves and tails Claude project JSONL and Codex rollout JSONL, then
normalizes provider events for the session layer (`runtime/internal/watch/types.go`,
`runtime/internal/watch/codex_normalize.go`). Claude resolution prefers an
exact conversation UUID and refuses ambiguous candidates
(`runtime/internal/watch/claude_resolver.go`); Codex resolution uses resume ID,
working directory, and creation time with a broader fallback
(`runtime/internal/watch/codex_resolver.go`). Watchers combine filesystem hints
with polling so missed notifications do not stop progress.

### `webassets`

`webassets` provides an optional embedded frontend filesystem. Normal developer
builds expose no embedded assets (`runtime/internal/webassets/assets_dev.go`),
while `embedui` builds embed the built SPA and provide guarded route fallback
(`runtime/internal/webassets/assets.go`,
`runtime/internal/webassets/assets_embedui.go`).

## Session lifecycle

1. An API create request reaches `session.Manager.Create`, which validates the
   request and records `created` in the ledger before asking the registry to
   launch anything (`runtime/internal/api/server.go`,
   `runtime/internal/session/manager.go`).
2. The registry writes runner metadata and its per-user launchd definition,
   starts or attaches to the runner, performs HELLO/replay, and constructs the
   daemon-side session (`runtime/internal/state/registry.go`,
   `runtime/internal/proto/client.go`, `runtime/internal/state/session.go`).
3. PTY bytes are appended to the runner event file and framed over its Unix
   socket. The daemon updates the mirror and broadcasts WebSocket state; a
   structured runner sends lifecycle/content frames through the same durable
   boundary (`runtime/cmd/sessions-runner/main.go`, `runtime/internal/api/ws.go`).
4. A normal exit is ledgered and its launchd registration is reaped. An
   unexpected socket loss gets bounded reconnect attempts and later discovery;
   an explicit kill is ledgered before the kill request
   (`runtime/internal/session/manager.go`,
   `runtime/internal/state/registry.go`).

The binding check in `runtime/internal/session/manager.go` prevents two live
sessions from resuming the same provider conversation. The runner keeps exited
state available briefly for reconnecting clients before removing its transient
socket and metadata (`runtime/cmd/sessions-runner/main.go`).

## Lane lifecycle

`sessions run` creates a session with lane provenance and a noninteractive child
command (`runtime/cmd/sessions/run.go`). The runner captures its stdout/stderr
through pipes and writes a manifest at exit instead of allocating a PTY
(`runtime/cmd/sessions-runner/main.go`, `runtime/internal/state/paths.go`). The same
write-ahead ledger and ownership checks used by sessions make the lane visible
to `sessions lanes`, `sessions recover`, and explicit adoption
(`runtime/internal/ledger/fold.go`, `runtime/internal/recovery/`).

Recovery is deliberately two-step: reports are read-only, while reopen/adopt
are explicit mutations. A safe recipe can reopen provider context, but it does
not claim to resurrect process memory or uncommitted worktree bytes
(`runtime/internal/recovery/report.go`, `runtime/internal/migrate/types.go`).

## State on disk

The default state root is `~/.local/state/sessions`, with a `runners/`
subdirectory (`runtime/internal/state/config.go`). `SESSIONS_STATE_DIR` relocates
runner, token, and open-sentinel state for a scratch daemon, while user settings
stay under the default user state root; the override is mandatory for scratch
work so the daily driver's registry is not reused (`docs/DEV.md`).

| State | Default location | Source |
| --- | --- | --- |
| Runner socket, metadata, frames, logs, manifests, structured histories | `~/.local/state/sessions/runners/` | `runtime/internal/state/paths.go` |
| Daemon settings | `~/.local/state/sessions/settings.json` | `runtime/internal/state/config.go` |
| Access token and open sentinel | `~/.local/state/sessions/token`, `~/.local/state/sessions/open` | `runtime/internal/state/config.go` |
| Search index | `~/.local/state/sessions/search-index.db` | `runtime/internal/api/search_handlers.go` |
| Integration errors | `~/.local/state/sessions/errors.jsonl` | `runtime/internal/integrations/errors.go` |
| Lane ledger | `~/Library/Application Support/sessions/ledger/lanes.sqlite3` | `runtime/internal/ledger/store.go` |
| Global idle hook | `~/.config/sessions/hooks.json` | `runtime/internal/state/config.go` |
| Backup configuration | `~/.config/sessions/backup.json` | `runtime/internal/backup/config.go` |
| Runner LaunchAgents on macOS | `~/Library/LaunchAgents/tech.somewhere.sessions.runner.<id>.plist` | `runtime/internal/state/registry.go` |

The event log is persistent and trims toward its lower bound after crossing its
soft limit; the daemon also keeps a bounded replay window in memory
(`runtime/internal/state/persistent.go`, `runtime/internal/state/eventlog.go`).
Treat these files as protocol state, not as disposable caches, when implementing
compatibility or cleanup.

## Frontend assembly

`runtime/scripts/build-binaries.sh` builds `frontend/`, copies its `dist/`
output into `runtime/internal/webassets/dist/`, and builds `sessionsd` with the
`embedui` tag. At runtime the API first uses an explicitly configured or
checkout frontend directory and otherwise falls back to the embedded filesystem
(`runtime/internal/state/config.go`, `runtime/internal/api/server.go`,
`runtime/internal/webassets/assets_embedui.go`). API and WebSocket routes are
matched before the guarded SPA fallback.
The served SPA is still an implemented compatibility surface, but product
direction now deprecates interactive browser terminal/control. Do not infer a
new browser feature commitment from the current embedded asset path.

## Authentication and network surfaces

The default daemon binds `127.0.0.1`; wildcard bind addresses are rejected in
`runtime/cmd/sessionsd/main.go`. A direct loopback peer can use the local API
without a token, while non-loopback traffic normally authenticates with the
token; forwarding headers disable the loopback shortcut
(`runtime/internal/api/auth.go`). The `open` sentinel is an explicit
compatibility bypass, and static UI/health routing is distinct from
authenticated API routes (`runtime/internal/api/server.go`).

`sessions lan enable` adds and persists a listener on the selected private network
address (`runtime/cmd/sessions/lan.go`, `runtime/internal/lan/network.go`).
`sessions remote enable` configures Tailscale Serve and verifies the resulting
HTTPS health endpoint (`runtime/cmd/sessions/remote.go`). Allowed browser origins
are checked independently in `runtime/internal/api/auth.go`; that check limits
browser callers but does not replace token authentication.

## Provider watcher model

Structured Codex and Claude runner kinds publish their own lifecycle events, so
the session manager does not start transcript-file watchers for them
(`runtime/internal/session/manager.go`). PTY-backed Claude and Codex sessions
instead resolve provider artifacts using the session working directory,
arguments, creation time, and any explicit resume ID.

Claude lookup maps the real working directory to its project directories,
prefers an exact UUID, accepts a sole unambiguous candidate, and refuses to guess
among multiple files (`runtime/internal/watch/claude_resolver.go`). Codex lookup
first handles a global explicit resume ID, then searches date/cwd/time candidates
and finally performs a bounded broad scan (`runtime/internal/watch/codex_resolver.go`).
Both tailers combine polling with filesystem notification hints, and Codex
events are normalized before they enter the shared session event stream
(`runtime/internal/watch/claude_watcher.go`,
`runtime/internal/watch/codex_watcher.go`,
`runtime/internal/watch/codex_normalize.go`).
