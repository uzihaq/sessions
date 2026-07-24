# Sessions — STATE / ORCHESTRATOR HANDOFF (2026-07-23)

> **New orchestrator (Codex or returning Claude): start here, then read `AGENTS.md`.**
> This file + `AGENTS.md` + `docs/WHY.md` + the somewhere board = everything the previous
> orchestrator knew that isn't obvious from the code. Rehydrate from these, not from memory.

## How to rehydrate context (the durable-context contract)
1. `AGENTS.md` (repo root) — the router: what sessions is, repo map, working rules, gate commands.
2. `docs/WHY.md` — every feature's rationale + every decision this week, dated. The reasoning record.
3. `docs/NATIVE_APP.md` + `docs/CODEBASE.md` + `docs/CLI.md` (generated) — package contract,
   deep map, and real command reference.
4. somewhere project **sessions** board — task `ROADMAP: sessions direction` carries dated STATUS
   comments; also PHILOSOPHY task, "Feature gaps" task, the EPICs. Read the newest ROADMAP comment first.
5. `git log --oneline` — the week's work is legible commit-by-commit.
**The contract:** whoever orchestrates keeps STATE.md + the board's ROADMAP comment + WHY.md current at
each merge. The next orchestrator (Codex now, Claude later) reads those and is caught up. No chat-history
transfer needed — the durable record IS the handoff.

## Orchestration model (IMPORTANT for the Codex handoff)
- **The orchestrator must NOT run as a sessions session.** It rebuilds + reloads the very daemon that would
  host it — a daemon restart during `make binaries`/kickstart would sever an in-sessions orchestrator. Run
  the orchestrator as a plain terminal `codex` at the repo root (or Codex cloud). It reads AGENTS.md.
- **Build/worker lanes** are spawned via `sessions new --tool codex --cwd <worktree>` in git worktrees off
  `main`, one feature per lane, with a written spec. Pattern (used all week):
  worktree add from `main` → spawn codex lane → send spec → gate the result YOURSELF (build+vet+test, re-run
  acceptance; skipped tests are NOT passes) → merge --no-ff → `make binaries` → kickstart dev daemon →
  verify **soak-d2 survives** → push → remove worktree + kill lane. Never merge on the lane's word alone.

## Current reality
- Product = the Go runtime plus Sessions.app on branch **`main`**. On 2026-07-22 the user explicitly authorized the
  verified retirement of the MacBook-local legacy service: `tech.pretty-pty.dev.daemon` was booted out, its exact
  Pretty UI process was terminated, and a direct process audit found no live legacy runner processes. Its LaunchAgent
  plist and historical state were preserved, so the stop is recoverable. The signed source Sessions.app has now been
  installed and exercised across that MacBook boundary: its managed daemon owns localhost:8787, a real Claude session
  created its runner socket successfully, and the same session survived a second immutable runtime/app update before
  the smoke lane was deliberately stopped and removed. The Mini then entered
  its joint cutover and its 19 important lanes were preserved/resumed under
  Sessions. The first 0.2.1 launch on the Mini correctly rolled its daemon back
  to 0.2.0 after the old 20-second lifecycle deadline expired while runner
  discovery was still active. **USER GREEN LIGHT 2026-07-23:** the signed 0.2.2
  updater then passed the runner-free MacBook and went public. The Mini cask
  upgraded to the 0.2.2 app; its new daemon ran for the full 102-second
  readiness budget while all nine exact runner PIDs stayed alive, then safely
  rolled only the daemon back to 0.2.0. That observation exposed the missing
  successful-attach replay cost: each runner may add a ten-second initial
  replay after HELLO. The corrected public 0.2.3 update then passed on the
  runner-free MacBook and completed on the Mini. Mini discovery progressed
  from one to eight to all nine live sessions in under 30 seconds; all nine
  exact session IDs and original runner PIDs were preserved. The app, managed
  CLI, and daemon report 0.2.3. The live runners still execute from their
  immutable 0.2.0 runtime by design, so that runtime must not be removed until
  those processes exit.
- Binaries are **signed** with the user's Developer ID (identity hash in `~/.config/sessions/sign-identity`;
  build script signs all 3 darwin binaries every `make binaries`). Stable TCC identity → file dialogs
  asked once, not per build.
- **Sessions 0.2.3 is public under `Somewhere-Tech/sessions`.** The public app
  artifacts are notarized/stapled/
  Gatekeeper-accepted, the signed updater manifest is live at
  `https://sessions.somewhere.tech/releases/latest.json`, and
  `somewhere-tech/homebrew-tap` serves both the `sessions` runtime formula and
  `sessions-app` cask.
- Cron is OFF. soak-d2 is the sacred durable session (survives every reload; verify it lives after any
  daemon restart).

## Shipped this week (merged on the former `go-rewrite` product branch, live, gate-verified)
FTS5 ranked search (`--ranked`) · same-origin UI auto-adopt · `sessions lan enable` (same-WiFi, no
Tailscale) · `sessions remote enable` (Tailscale Serve) · **QR pairing** (`sessions pair` + `sessions devices`
— scan once, per-device revocable tokens) · **encrypted backup** (`sessions backup --encrypt`, XChaCha20
before upload, recovery phrase) · **account profiles** (`--profile`, multi-login via
CLAUDE_CONFIG_DIR/CODEX_HOME) · **`sessions new --worktree`** (+ worktrees list/clean) · **push
notifications** (done/waiting/lost, `sessions notify`) · docs-from-source suite · teaching errors ·
code-signing · **Sessions.app v1** (Tauri: menu-bar status, scoped windows, quit never kills sessions).
Onboarding site refreshed + live (sessions.somewhere.tech). The manual-entry preview shell is superseded,
not a product surface.

## SHIPPED: Sessions.app v2 distribution
The app IS the product package. v2 makes "one update updates everything, nothing lost":
1. **SHIPPED IN CODE:** bundle signed daemon+runner+CLI inside Sessions.app; verify and copy them to
   immutable versioned runtime directories; first-run installs/upgrades `tech.somewhere.sessions.daemon`.
2. **SHIPPED IN CODE:** record the live-session baseline, wait for health+discovery, verify every ID,
   and roll back to the previous plist/runtime on failure. Real scratch launchd coverage exercises it.
3. **SHIPPED:** Tauri's signed updater is wired to
   `https://sessions.somewhere.tech/releases/latest.json`; the app exposes an explicit check/install/relaunch
   flow, the public key is pinned, and release tooling produces a signed immutable GitHub artifact plus manifest.
   The first live manifest was published only after its corresponding immutable artifact was public.
4. **SHIPPED:** v0.1.0 uses Developer ID + hardened runtime, passed Apple notarization, carries a stapled ticket,
   and is accepted by Gatekeeper. The updater archive signature and live manifest signature match exactly.
**USER SEQUENCE LOCKED 2026-07-19; COMPLETED THROUGH MINI 2026-07-23:**
macOS shipped first, then the Mini completed its joint Node-to-Go cutover
(interop-proven by `TestNodeRunnerUnderGoDaemonCutover` and the preserved live
runner baseline). Android is next.

## NOW: build Windows and Android paired clients
**Immediate:** Windows is now in source as a client-only Tauri target with a
native `Find machines` first-run flow and Windows-hosted NSIS plus portable
preview builds.
It connects directly to approved Mac daemons over Tailscale/LAN and does not
host a daemon or runner. Android remains active next work
(Tauri2 paired client + FCM; push machinery ready). Later:
semantic search (local embeddings, only if FTS insufficient) · session sharing
(pairing foundation exists) · diff viewer (parked) · iOS · always-on VM. Monetization: Sessions and its runtime FREE,
paid = somewhere platform; Sessions is top-of-funnel. **Prompt queuing = REJECTED. PWA = SKIPPED.**

**SOURCE-ONLY AFTER 0.2.3:** protocol compatibility and actionable status are
explicit rather than inferred. `/api/health` publishes the accepted API-client
and runner ranges; current daemons retain protocol-0 legacy runners and
protocol-1 runners, but fail before replay on an unknown future runner
protocol. Windows/native discovery and the React client reject only an
explicitly incompatible API range. Session state now records runner version,
runner protocol, idle reason/detail/time, and last useful summary. The GUI,
`sessions status`, list SUMMARY columns, and `sessions wait --summary` consume
the same facts. Settings explains whether agents are working before an update:
current runners continue immutably, the relaunched app refreshes the daemon,
and only later-created sessions use the staged runner. Remote update remains a
future request-plus-local-approval flow, not authority granted to every paired
device.

**SOURCE-ONLY AFTER 0.2.3:** the conversation surface now uses Codex-style
authorship: timestamped right-aligned user cards, full-width provider answers,
and a single Attach composer action. Terminal Esc/history/Ctrl-C controls are
mobile-Terminal-only. Resume is named in the Sessions navigator, and ended
provider sessions open the audited resume picker with their identity
preselected. Navigator drag-and-drop persists a display-parent override through
`PUT /api/sessions/:id/display-parent`; the creator ledger remains untouched,
and the daemon rejects self/descendant cycles.

**Cloud direction locked 2026-07-22:** a Somewhere login will eventually expose backup inventory/download,
opt-in hosted transcript search, and account-wide fleet status. The always-on tier is one private Fly Machine per
user running a specialized worker, not public `sessionsd`: no public worker ingress, no Tailscale dependency, no
local daemon endpoint or credential, and no VM-to-Mac calls. A narrow Somewhere gateway carries native-client
status/conversation/terminal/scoped-file traffic over an outbound worker channel. Session transfer is initiated and
mediated by the native client; source history remains preserved. Full contract: `docs/CLOUD_VM.md`.

## Shipped in the 2026-07-20 product pass
- First-class arbitrary key/value session tags across runner metadata, CLI, API, new-session flow, inline editing,
  and explicit local default tags inherited by future sessions (always editable before start).
- Local Claude + Codex usage ingestion and SQLite aggregation with daily/weekly/monthly/session/tag/provider/model
  views, explicit reasoning-token reporting, date/provider/cost filters, honest missing-price reporting, and no
  `npx` runtime dependency. The JSON contract is schema-versioned and existing indexes migrate in place. Structured
  sessions write usage live at the manager boundary; provider-log backfill shares stable event keys and cannot count
  those turns twice.
- A polished in-app usage dashboard with saved local views and expandable cost/token drill-down, fleet-wide search
  UI over the shipped exact/regex/FTS5 backend, compact product navigation for narrow windows and phones, and
  an active-first fleet view across every configured daemon.
- A provider-neutral conversation GUI now treats Codex app-server events as the primary display contract instead of
  forcing Codex into Terminal: live answer deltas, progress commentary, reasoning summaries, plan state, commands,
  MCP/tool activity, unified file diffs, context usage, model/effort identity, and safe turn interruption. Terminal
  remains one click away and the independent runner still owns the conversation.

## Implemented in source for the next Mac release (2026-07-22; not public yet)
- A polished **Daily** journal combines authoritative local usage totals with the day's session/lane hierarchy plus
  locally observed Claude/Codex conversations that still live outside Sessions. It streams only provider logs that
  contributed usage that day, excludes copied child-agent fork snapshots, and labels outside work explicitly; no
  transcript is imported. Written synthesis is opt-in (`off` by default), recommends the user's
  already-authenticated Codex CLI, supports Claude, and lets the selected CLI choose its default model. Each manual
  call requests the lowest supported reasoning effort (Codex ephemeral/read-only with user configuration and rules
  ignored; Claude tool-disabled and session-less), sends at most 32 KiB of compact metadata rather than transcripts
  or durable session IDs, and saves the Markdown locally as a durable per-day journal entry. Daily preloads during
  app startup, keeps a complete loading frame visible, exposes saved-day history, and marks a saved recap stale
  instead of hiding it when local facts later change
  (`runtime/internal/recap/service.go`, `frontend/src/components/DailyView.tsx`,
  `frontend/src/lib/dailyCache.ts`).
- The native resume picker discovers both Claude and Codex provider conversations and binds a selected idle
  conversation through the audited recovery/adopt boundary. It never copies history, hides identities already open
  in Sessions, and requires the user to stop writing from the original app before resuming the same provider
  identity in Sessions.
- A native **Connections** center exposes the real access ladder: this Mac, same-Wi-Fi LAN, and tailnet-only
  Tailscale Serve. It creates single-use device pairing links, explains the Certificate Transparency tradeoff,
  and can safely change the installed daemon's loopback port. Port migration captures the live-runner baseline,
  verifies re-adoption on the new port, and restores the old service even if an unrelated process races onto the
  requested port. An optional Somewhere card links to `somewhere.tech`, detects the local Somewhere CLI version,
  checks for an available npm release, and offers copyable install/update/docs commands without auto-installing or
  changing the global CLI (`src-tauri/src/lib.rs`, `frontend/src/components/SomewhereCard.tsx`).
- **Transcript-aware retrieval and explicit AI planning** was dogfooded against the 387 MB PM Claude lane rather than
  a toy transcript. The persistent FTS5 index now reads the complete source once, treats ordinary multi-word input as
  recall-oriented token alternatives unless the user asks for Boolean, phrase, or proximity syntax, and returns
  best-first message anchors with relevance, context, session/workspace/machine metadata, and user/assistant/handoff
  roles. Filters cover provider, session/lane name, workspace, date, speaker, and relevance-versus-timeline ordering.
  The Search reader opens the exact clicked message and can page through an anchored context window, everything after
  it, user requests only, a selected request-to-request range, or the complete transcript without losing the query.
  Every response spans at most 500 original message positions, verifies the content-derived bookmark on first open,
  and omits full result bodies until opened. Index refreshes are serialized/cancelable, use actual source-file
  fingerprints, and purge unavailable history. Claude `Agent`, Codex `spawn_agent`, and session-control relays are
  searchable as typed delegation/handoff/status operations; automation ticks remain distinct from founder requests.
  Smart mode makes one query-only call through the user's
  selected pre-authenticated CLI (Codex default, Claude optional), then applies the generated FTS5 expression locally;
  transcripts, snippets, session IDs, and index contents are not sent. Exact and regex modes remain model-free
  (`runtime/internal/search`, `runtime/internal/integrations/history.go`,
  `runtime/internal/smartsearch/service.go`, `frontend/src/components/SearchView.tsx`).
- Sessions-owned outbound traffic is now an explicit security boundary:
  local operation sends no telemetry or session data to Somewhere; every
  data-bearing outbound feature must name its destination/payload/trigger,
  require visible opt-in, remain bounded and revocable, and never silently
  create a general tunnel. **SOURCE-ONLY AFTER 0.2.3:** Settings → Help &
  feedback and `sessions support [--diagnostics]` open fixed public feedback/
  bug or private security destinations and can copy a user-reviewed diagnostic
  preview. Nothing is submitted or uploaded automatically; the preview
  excludes session content, IDs, paths, credentials, environment, and logs.
  Because Sessions is agent-native, the JSON form includes a stable agent
  contract: what safe fields to capture, the machine-readable command, and an
  explicit user-approval requirement. Intake forms distinguish agent-originated
  reports from direct user reports.
  Live support access remains unimplemented and requires a separate narrow
  grant (`runtime/cmd/sessions/support.go`,
  `frontend/src/components/SettingsView.tsx`, `docs/NETWORK_SECURITY.md`).
- **Interactive browser control is deprecated by product decision.** Sessions.app is the Mac control and terminal
  surface; Android will be the first remote native client. The currently served SPA remains a compatibility artifact
  until it is reduced or removed, and must not be promoted as a browser terminal. A future browser surface, if any,
  is read-only status/viewing only.
- The signed updater now checks quietly on launch and every six hours, shows an in-app badge, and sends at most one
  native notification per available version. Installation remains an explicit user action; relaunch still replaces
  only the UI while launchd and every runner remain alive.
- The runtime CLI now exposes `sessions update [--check]` without accepting a
  URL, key, destination, downgrade, or unsigned checksum override. It fetches
  only the fixed Somewhere metadata route (including its exact deployed
  `sessions.somewhere.site` redirect), requires an immutable
  `github.com/somewhere-tech/sessions/releases/download/v<version>/Sessions.app.tar.gz`
  path, verifies the pinned Minisign signature, rejects traversal/link archive
  entries, and validates Developer ID, team, bundle identity, version, and
  Gatekeeper before an atomic same-disk app swap. The temporary rollback app is
  removed after post-install verification. Only an exact installed Sessions UI
  process is stopped/reopened; `sessionsd` and runners are never signaled.
  Native lifecycle readiness now starts at 30 seconds and adds 15 seconds per
  baseline runner (capped at five minutes), covering a successful attach's
  two-second HELLO wait plus ten-second initial replay window and normal
  overhead. The live-ID baseline and rollback requirements remain unchanged.
- The native Connections surface now operates the already-shipped direct Somewhere backup flow: it detects the CLI,
  accepts an existing Somewhere project, enables local XChaCha encryption, presents the recovery phrase, reports
  backup status, and can push immediately. Fleet also previews the coming one-user private Fly worker shape. Account
  library, hosted search, central cloud usage, password-wrapped key recovery, and VM provisioning are intentionally
  visible as **Coming soon** until the Somewhere Sessions account slot and worker lifecycle APIs exist.
- Fleet now follows the supplied machine-card mockup instead of a box-and-arrow
  topology diagram. Each current daemon reports its Go OS/architecture in the
  lightweight health response, and the native client renders a Mac, Windows,
  Linux, or generic host mark from that value. The signed application bundle
  temporarily uses the existing Somewhere mark as its macOS/Windows icon
  (`runtime/internal/api/server.go`, `frontend/src/components/FleetView.tsx`,
  `src-tauri/icons/`).
- **SOURCE-ONLY AFTER 0.2.3:** Fleet is also the consumer-facing place to add a
  machine. Its `Find machines` action reuses the native tailnet discovery and
  explicit host approval flow instead of sending users into Settings. The
  current computer is visually primary; an unreachable machine fades as one
  unit, while the unprovisioned Somewhere VM is a deliberately muted
  placeholder. Health versions are compared to the current computer and
  older/newer/different builds receive an advisory without being blocked:
  compatibility is a protocol range, not lockstep application versions.
  Nearby-Wi-Fi Bonjour discovery is visible as **Coming soon** until the
  service advertisement, verification, and macOS Local Network permission
  behavior are implemented deliberately.
- **SOURCE-ONLY AFTER 0.2.3:** Windows is a first-class client-only native
  target. Platform configuration skips the macOS Go-runtime bundler, produces
  an NSIS current-user installer, and leaves updater artifacts disabled for the
  unsigned preview channel. The first-run screen removes the synthetic
  localhost entry, discovers verified Sessions machines through the local
  Tailscale client, requests host approval, and persists the normal revocable
  device credential. Windows-aware Tailscale lookup and support links are
  implemented; public release still requires Windows code signing and a
  signed-updater channel (`src-tauri/tauri.windows.conf.json`,
  `.github/workflows/windows-preview.yml`,
  `frontend/src/components/ConnectScreen.tsx`).
- The native React shell is now organized as an **agent operations inbox** (`frontend/src/components/ProductSidebar.tsx`,
  `SessionNavigator.tsx`, `HomeView.tsx`, `SessionDetails.tsx`, `SettingsView.tsx`). The Sessions navigator consumes
  daemon ledger provenance rather than inferring parentage, supports five local manager pins, nests real children,
  retains exited sessions, collapses finished children, and exposes complete status/provider/machine/project/date filtering. The tab strip
  contains only sessions the user opened; tab close is view-only, while process termination is isolated in Details.
  Exited sessions render bounded read-only history without opening a WebSocket/terminal, and a finished intermediate
  child is never collapsed while it still has a live descendant. Grid and the mobile quick switcher receive live rows only.
  Global New Session is task-and-recent-workspace first. Delegate sends `X-Sessions-Creator-Session`, inherits the
  parent context (including the profile only when the provider still matches), waits for provider readiness, and sends
  one initial request as bracketed paste plus a separate Enter through the existing input API—there is
  no hidden prompt queue. Conversation keeps Terminal as the escape hatch and now exposes Context and Delegate beside
  the composer. Light and dark themes were visually checked against the supplied mockups. Inline child lifecycle cards
  and explicit model selection are labeled/recorded as **Coming soon**, not implied by the current UI.
  A brand-new provider profile opens its login flow without wait-ready or task injection; the launcher keeps the request
  visible for manual sending after authentication.
- The Mac exercise closed four launch-path gaps. launchd runners inherit common user CLI locations such as
  `~/.local/bin` (where Claude installs), and missing commands fail immediately with an actionable message instead of a
  generic 60-second socket timeout. Dirty source runtimes are content-addressed so immutable installs cannot alias one
  another. Daemon replacement waits for launchd to finish unloading before bootstrap, with scratch-launchd coverage and
  a live preservation check. Workspace discovery no longer recursively enumerates iCloud-backed Desktop/Documents/
  Downloads folders, so opening New Session cannot wait on remote hydration.
- The supplied launcher and active-conversation mockups now drive the real packaged UI: Somewhere branding replaces the
  placeholder `S`, recent workspace and provider cards replace colored emoji balls, the stale Phase-3 empty card and
  oversized conversation watermark are gone, and conversation turns render as labeled operational blocks rather than
  chat bubbles. The default Usage report refreshes in the background after daemon connection and is shared with the
  dashboard; the packaged visual check opened Usage directly onto current totals without an indexing wait.
- **Typed Claude launch defaults are now a first-class Sessions setting.** New sessions can inherit or override Remote
  Control, permission mode, model, effort, Chrome, Remote Control naming, and the Somewhere MCP. Resolution happens in
  `sessionsd`, so GUI, CLI, and mini launches share one contract; per-session Advanced choices take precedence. Sessions
  does not rewrite Claude settings or copy Somewhere credentials. `ensure` adopts the canonical existing Somewhere MCP
  or injects `somewhere mcp`, and a same-name conflict fails closed.
- **Mini migration feedback shipped before the completed Mini update.** The canonical Somewhere
  task is `tsk_c315cf9ed402416d8c6ba5f16072bef8` on the **Sessions** project (the original report was filed against the
  legacy `pretty-pty-preview` deployment). `sessions doctor` no longer closes its PTY before the probe exits and
  recognizes native plus adopted legacy runners; CLI, daemon health, and standalone archive names receive the same
  build version; lane `files_changed` compares repo-root start/end Git-visible state and commit trees instead of
  reporting pre-existing dirt; and `sessions gc` previews old closed-record archival before an explicit `--apply`.
  Archival is an append-only visibility fact—live/discoverable runner artifacts, retained ancestry, transcripts,
  artifacts, worktrees, and recovery evidence are not deleted. Sessions.app also updates every existing managed CLI
  link through the standard command directories without replacing an unrelated executable
  (`runtime/cmd/sessions/doctor.go`, `runtime/cmd/sessions-runner/main.go`,
  `runtime/internal/session/retention.go`, `src-tauri/src/lifecycle.rs`).

## OPEN USER DECISIONS (blockers only)
None for the completed Mini update or the Android start. The product default
preserves the existing bypass-permissions behavior, but it is now visible and
changeable globally or per session.

## Build / run
- Build (auto-signs): `cd runtime && export PATH=$PATH:/opt/homebrew/bin && make binaries`
- Reload dev daemon: `launchctl kickstart -k gui/$(id -u)/tech.somewhere.sessions.dev.daemon` (then verify soak-d2).
- Bootstrap a development checkout once: `cd <repo> && npm run bootstrap`
- Build the app: `cd <repo> && npm run tauri:build`
  → `src-tauri/target/release/bundle/macos/Sessions.app`
- Gate a lane: from its worktree `runtime/`: `GOFLAGS=-buildvcs=false go build ./... && go vet ./... &&
  go test ./...` then `bash scripts/gen-cli-docs.sh` if the CLI changed.
