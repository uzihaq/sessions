# Sessions roadmap

The native application is now the product package. The Go daemon, runner, and
CLI remain the runtime inside that package. React powers the signed native
client; the daemon-served interactive browser UI is now a deprecated
compatibility surface, not a product direction. If a browser surface survives,
it will be read-only status/viewing rather than terminal or agent control.

## Shipped: Sessions.app for macOS

Sessions.app proves the lifetime boundary: it provides tray status and scoped
windows, while quitting the app leaves the daemon and every runner alive. Its
release build now bundles the signed Go runtime and implements idempotent
launchd installation, session-baseline rollback, and the signed updater flow.
Sessions 0.1.0 shipped publicly on 2026-07-21:

1. The app and nested runtime are Developer ID signed, notarized, stapled, and Gatekeeper accepted.
2. GitHub tag `v0.1.0` publishes the native app, updater, and checksummed macOS/Linux runtime archives.
3. Somewhere serves the byte-verified signed updater manifest, and the public Homebrew tap serves the app cask and runtime formula.

The native conversation surface now treats structured provider history as its
UI boundary. Codex app-server sessions display streaming answers, progress,
plans, reasoning summaries, tool and command activity, file diffs, context
usage, and safe interruption while retaining Terminal as a fallback. See
[`runtime/internal/codexapp/history.go`](runtime/internal/codexapp/history.go)
and [`frontend/src/components/RemoteView.tsx`](frontend/src/components/RemoteView.tsx).

The MacBook remains the development and release-verification channel. The
signed 0.2.3 updater path passed there from the previous public version. The
same public command then upgraded the Mini while preserving all nine exact
session IDs and runner PIDs. The app, managed CLI, and daemon now report 0.2.3;
the already-running 0.2.0 runners intentionally retain their immutable runtime
until they exit.

See [`docs/NATIVE_APP.md`](docs/NATIVE_APP.md) for the package and lifetime
contract.

## Now: Android paired client

Sessions 0.2.3 is public. It includes a fail-closed
`sessions update [--check]` path for the native Mac package and scales the
daemon handoff deadline without weakening live-ID verification or rollback.
The command has no URL or key override, accepts no downgrade, requires the
pinned Minisign key and exact immutable GitHub release path, validates
Developer ID plus Gatekeeper, swaps the app atomically on the same disk,
removes its temporary rollback copy, and reopens only the UI. The app continues
to check for updates on launch and every six hours, with an in-app badge and
one native notification per version.

Mini dogfood proved the 0.2.2 budget still omitted the successful attach's
ten-second initial replay. Its app became 0.2.2, the new daemon ran for the
full 102-second gate, every runner stayed alive, then only the daemon rolled
back to 0.2.0 with all nine exact session IDs restored. The 0.2.3 patch budgets
the observed HELLO plus replay path at 15 seconds per baseline runner, from a
30-second base and with the same five-minute cap. The corrected public update
completed on both the runner-free MacBook and the Mini. On the Mini, discovery
progressed from one to eight to all nine live sessions in under 30 seconds,
without changing any runner PID, and the signed app passed Developer ID,
notarization, and Gatekeeper checks.

The 0.2.1 release closed the search, Mini-feedback, and tailnet-approval issues
found during cutover dogfood. The 0.2 line adds a polished Today journal
with local usage and session/lane evidence plus an opt-in, cached Codex-or-Claude daily recap; a native Connections
center for loopback port, same-Wi-Fi LAN, Tailscale Serve, and one-time device pairing; and automatic signed-update
discovery with an in-app badge and once-per-version native notification. Connections also promotes the optional
Somewhere platform and reports whether its CLI is absent, current, or updateable without mutating the user's global
install. Search now adds explicit query-only AI planning through the selected pre-authenticated Codex or Claude CLI,
Claude/Codex and user/agent/operations filters, provider-colored results, persistent query state, and a read-only,
message-anchored history viewer that does not accidentally resume a session. Planning allows one active model call,
caches identical requests, and transcript views page at 500 original message positions. Tabs and Grid are grouped
beneath Sessions, and the Somewhere card uses
the product logo as a direct link. Model calls remain explicit, Codex is recommended, the CLI chooses its default model, recap effort is
set to the lowest supported provider setting, provider input is hard-capped at 32 KiB and excludes transcripts and
durable session IDs; AI search input is capped at 4 KiB and contains only the user's query. Update install remains
explicit (`runtime/internal/agentcall/agentcall.go`, `runtime/internal/smartsearch/service.go`,
`frontend/src/components/SearchView.tsx`, `src-tauri/src/lib.rs`).

Claude launches now have typed global defaults plus per-session overrides for
Remote Control, permission mode, model, effort, Chrome, Remote Control naming,
and the Somewhere MCP. The daemon resolves these settings for every client and
does not modify Claude's own configuration. Somewhere MCP auth stays owned by
the Somewhere CLI; an equivalent existing registration is adopted instead of
duplicated.

The desktop information architecture is also implemented in source as an **agent
operations inbox**. A permanent product rail opens Home, Sessions, Today,
Search, Fleet, Usage, and Settings. Sessions adds a second, lineage-aware
navigator with up to five locally pinned manager sessions, real parent/child
nesting from the daemon ledger, exited-session history, collapsed completed children, status/provider/
machine/activity rows, and deterministic status/provider/project/date filters.
Only explicitly opened sessions enter the tab strip; closing a tab does not end
the runtime. Exited rows open a bounded read-only conversation/details view and
never attach a terminal transport; Grid and mobile quick-switching remain live-
session-only. A finished intermediary stays expanded while any descendant is
live. Conversation, Terminal, and Details are separate modes, and the
dangerous end action lives only in Details. Global creation starts from a task
and recent workspace, while Delegate creates a real child through the trusted
creator header and inherits the parent workspace, machine, tags, and profile.
Profile inheritance is provider-safe: changing the delegated provider resets to
that provider's default login. An optional initial task uses the same bracketed-
paste plus separate-Enter PTY contract as the working composer. A newly created
provider profile must finish login first and never receives an automatic task.
Both dark and light themes follow the supplied native mockups. Richer inline
child result cards and explicit per-feature model selection remain **Coming
soon** rather than being presented as shipped.

The macOS release and Mini update gates are complete. Reuse the Tauri 2 client
and React UI for Android.
The next Mac source also adds Settings → Help & feedback plus
`sessions support [--diagnostics]`: fixed public feedback/bug and private
security-report destinations, an optional locally generated diagnostic preview,
and no automatic submission or upload. Live support access remains out of
scope.
The Android app is a paired client for a user's Mac daemon, not a mobile daemon
host. Native work includes FCM delivery over Sessions' existing encrypted push
path, secure credential storage, widgets, and a Quick Settings entry point.
If Tauri's Android shell proves limiting, keep the daemon protocol and use a
thin Kotlin client rather than changing the runtime boundary.

## Later

- **Session forking:** branch an existing session from a chosen point into an
  independent lane while keeping the source untouched. A fork records its
  source and fork point, makes destination machine/provider/workspace choices
  explicit, and copies only portable context. It remains distinct from Resume
  (continue the same lane) and Delegate (create a child task). This is tracked
  on the project board as `tsk_dcde9c9ad88744e0963736953e9355a7` and is not
  part of the Mac mini cutover.
- iOS client focused on APNs, widgets, and Live Activities.
- Session sharing after the pairing and per-device credential ladder.
- Standalone cross-turn diff review and inline comments back to an agent; event-level Codex diffs already render in the conversation activity feed.
- **Somewhere account (coming soon):** use the existing `somewhere login` identity to make backup setup visible in Sessions, then provide private backup inventory/download, central usage rollups, explicitly opt-in server-indexed transcript search, and account-wide machine/session status. Client-side encrypted backups remain opaque and are never advertised as hosted-searchable. Password recovery wraps the existing XChaCha archive key with an Argon2id-derived key; bcrypt is not reversible encryption.
- **Always-on worker v1 (coming soon):** one private Fly Machine and persistent volume per user, running a specialized Sessions worker with no public listener and no route or credential for any user-local daemon. The worker connects outbound to a narrow Somewhere gateway for status, structured conversations, terminal attach, scoped workspace files, and client-mediated session transfer. See [`docs/CLOUD_VM.md`](docs/CLOUD_VM.md).
  ```text
  Sessions.app / Android  --HTTPS/WSS-->  Somewhere auth + narrow gateway
                                                   ^
                                                   | outbound worker channel
                                                   |
                                  private per-user Fly Machine + volume
  specialized Sessions worker; no public ingress
  ```
- **Inline child lifecycle cards:** the navigator and Details already show trusted hierarchy and child health. A later normalized event will project child-start and child-completion ledger facts into the conversation timeline without guessing from provider text.
- **Support-ticket attachment and temporary access (coming soon):** start with
  `sessions support` creating a locally previewable, redacted diagnostic bundle
  that the user explicitly attaches to one Somewhere support ticket. Any later
  live view must be ticket-scoped, short-lived, read-only by default, revocable,
  and audited; it must never become a general reverse tunnel or reuse a master
  daemon token. See [`docs/NETWORK_SECURITY.md`](docs/NETWORK_SECURITY.md).
- Local semantic search only if FTS5 proves insufficient in real use.

## Explicitly not planned

- A relay to a user's local Mac. The planned Somewhere gateway terminates native-client traffic only for Somewhere-owned private workers; it never creates VM-to-Mac reachability.
- A required Sessions account or token markup.
- Prompt queuing; the user rejected it as redundant.
- A PWA rung before native mobile.
- An interactive terminal or agent-control surface in a browser; native clients own that trust boundary.
- Making the Tauri process own daemon or runner lifetime.
- Any mini cutover before the macOS app has shipped and been exercised.
