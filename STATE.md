# Sessions — STATE / ORCHESTRATOR HANDOFF (2026-07-22)

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
  the smoke lane was deliberately stopped and removed. Mac mini
  (100.86.76.84) = prod, still OLD node daemon, **UNTOUCHED** — its cutover is a separate JOINT step, now
  planned as the mini's first Sessions.app install (see below).
- Binaries are **signed** with the user's Developer ID (identity hash in `~/.config/sessions/sign-identity`;
  build script signs all 3 darwin binaries every `make binaries`). Stable TCC identity → file dialogs
  asked once, not per build.
- **Sessions 0.1.0 is public and shipped under `Somewhere-Tech/sessions`.** Tag `v0.1.0` points to `b297052`; the repository and 13-asset
  GitHub release are public, Sessions.app is notarized/stapled/Gatekeeper-accepted, the signed updater manifest
  is live at `https://sessions.somewhere.tech/releases/latest.json`, and `somewhere-tech/homebrew-tap` serves both the
  `sessions` runtime formula and `sessions-app` cask.
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
**USER SEQUENCE LOCKED 2026-07-19:** ship the macOS app first, then build Android. Do not cut over the
mini yet. Its later first Sessions.app install remains the joint Node-to-Go cutover (interop-proven by
`TestNodeRunnerUnderGoDaemonCutover`) after the app has shipped and been exercised.

## NEXT: exercise the Mac 0.2 source build, then Android (see board + WHY.md)
**Immediate:** test and release the Mac 0.2 product pass below, then build the Android app
(Tauri2 paired client + FCM; push machinery ready). Later:
semantic search (local embeddings, only if FTS insufficient) · session sharing
(pairing foundation exists) · diff viewer (parked) · iOS · always-on VM. Monetization: Sessions and its runtime FREE,
paid = somewhere platform; Sessions is top-of-funnel. **Prompt queuing = REJECTED. PWA = SKIPPED.**

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
- A polished **Today** journal combines authoritative local usage totals with the day's session/lane hierarchy plus
  locally observed Claude/Codex conversations that still live outside Sessions. It streams only provider logs that
  contributed usage that day, excludes copied child-agent fork snapshots, and labels outside work explicitly; no
  transcript is imported. Written synthesis is opt-in (`off` by default), recommends the user's
  already-authenticated Codex CLI, supports Claude, and lets the selected CLI choose its default model. Each manual
  call requests the lowest supported reasoning effort (Codex ephemeral/read-only with user configuration and rules
  ignored; Claude tool-disabled and session-less), sends at most 32 KiB of compact metadata rather than transcripts
  or durable session IDs, and caches the Markdown locally by day/input/provider
  (`runtime/internal/recap/service.go`, `frontend/src/components/TodayView.tsx`).
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
- **Search polish and explicit AI planning** adds Claude/Codex plus User/Agent filters, provider-colored badges,
  navigation-persistent query state, and a read-only session history viewer. AI mode makes one query-only call through
  the user's selected pre-authenticated CLI (Codex default, Claude optional), then applies the generated FTS5 query to
  the local index; transcripts, snippets, session IDs, and index contents are not sent. Ranked, exact, and regex modes
  remain model-free (`runtime/internal/smartsearch/service.go`, `frontend/src/components/SearchView.tsx`). The frontend
  also converts missing Today, Usage, AI-search, and history routes into an explicit old-runtime/update message instead
  of exposing a raw `sessionsd 404` response. Model planning is serialized, identical requests are cached, and the
  read-only viewer renders only a bounded tail preview so neither repeated clicks nor giant transcripts can create an
  unbounded cost or memory path.
- **Interactive browser control is deprecated by product decision.** Sessions.app is the Mac control and terminal
  surface; Android will be the first remote native client. The currently served SPA remains a compatibility artifact
  until it is reduced or removed, and must not be promoted as a browser terminal. A future browser surface, if any,
  is read-only status/viewing only.
- The signed updater now checks quietly on launch and every six hours, shows an in-app badge, and sends at most one
  native notification per available version. Installation remains an explicit user action; relaunch still replaces
  only the UI while launchd and every runner remain alive.
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

## OPEN USER DECISIONS (blockers only)
None for the observed mini cutover. The product default preserves the existing bypass-permissions behavior, but it is
now visible and changeable globally or per session. The cutover remains a separate, jointly observed operation; this
source change does not touch the mini.

## Build / run
- Build (auto-signs): `cd runtime && export PATH=$PATH:/opt/homebrew/bin && make binaries`
- Reload dev daemon: `launchctl kickstart -k gui/$(id -u)/tech.somewhere.sessions.dev.daemon` (then verify soak-d2).
- Bootstrap a development checkout once: `cd <repo> && npm run bootstrap`
- Build the app: `cd <repo> && npm run tauri:build`
  → `src-tauri/target/release/bundle/macos/Sessions.app`
- Gate a lane: from its worktree `runtime/`: `GOFLAGS=-buildvcs=false go build ./... && go vet ./... &&
  go test ./...` then `bash scripts/gen-cli-docs.sh` if the CLI changed.
