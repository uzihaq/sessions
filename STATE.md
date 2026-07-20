# Sessions — STATE / ORCHESTRATOR HANDOFF (2026-07-19)

> **New orchestrator (Codex or returning Claude): start here, then read `AGENTS.md`.**
> This file + `AGENTS.md` + `docs/WHY.md` + the somewhere board = everything the previous
> orchestrator knew that isn't obvious from the code. Rehydrate from these, not from memory.

## How to rehydrate context (the durable-context contract)
1. `AGENTS.md` (repo root) — the router: what pretty is, repo map, working rules, gate commands.
2. `docs/WHY.md` — every feature's rationale + every decision this week, dated. The reasoning record.
3. `docs/NATIVE_APP.md` + `docs/CODEBASE.md` + `docs/CLI.md` (generated) — package contract,
   deep map, and real command reference.
4. somewhere project **pretty-pty** board — task `ROADMAP: pretty-PTY direction` carries dated STATUS
   comments; also PHILOSOPHY task, "Feature gaps" task, the EPICs. Read the newest ROADMAP comment first.
5. `git log --oneline` — the week's work is legible commit-by-commit.
**The contract:** whoever orchestrates keeps STATE.md + the board's ROADMAP comment + WHY.md current at
each merge. The next orchestrator (Codex now, Claude later) reads those and is caught up. No chat-history
transfer needed — the durable record IS the handoff.

## Orchestration model (IMPORTANT for the Codex handoff)
- **The orchestrator must NOT run as a pretty session.** It rebuilds + reloads the very daemon that would
  host it — a daemon restart during `make binaries`/kickstart would sever an in-pretty orchestrator. Run
  the orchestrator as a plain terminal `codex` at the repo root (or Codex cloud). It reads AGENTS.md.
- **Build/worker lanes** are spawned via `pretty new --tool codex --cwd <worktree>` in git worktrees off
  `go-rewrite`, one feature per lane, with a written spec. Pattern (used all week):
  worktree add → spawn codex lane → send spec → gate the result YOURSELF (build+vet+test, re-run
  acceptance; skipped tests are NOT passes) → merge --no-ff → `make binaries` → kickstart dev daemon →
  verify **soak-d2 survives** → push → remove worktree + kill lane. Never merge on the lane's word alone.

## Current reality
- Product = the Go runtime plus Sessions.app on branch **`go-rewrite`**. MacBook = dev (launchd
  `tech.pretty-pty.dev.daemon`, localhost:8787). Mac mini (100.86.76.84) = prod, still OLD node daemon,
  **UNTOUCHED** — cutover is a JOINT step, now planned as the mini's first Sessions.app install (see below).
- Binaries are **signed** with the user's Developer ID (identity hash in `~/.config/pretty/sign-identity`;
  build script signs all 3 darwin binaries every `make binaries`). Stable TCC identity → file dialogs
  asked once, not per build.
- Cron is OFF. soak-d2 is the sacred durable session (survives every reload; verify it lives after any
  daemon restart).

## Shipped this week (all merged on go-rewrite, live, gate-verified)
FTS5 ranked search (`--ranked`) · same-origin UI auto-adopt · `pretty lan enable` (same-WiFi, no
Tailscale) · `pretty remote enable` (Tailscale Serve) · **QR pairing** (`pretty pair` + `pretty devices`
— scan once, per-device revocable tokens) · **encrypted backup** (`pretty backup --encrypt`, XChaCha20
before upload, recovery phrase) · **account profiles** (`--profile`, multi-login via
CLAUDE_CONFIG_DIR/CODEX_HOME) · **`pretty new --worktree`** (+ worktrees list/clean) · **push
notifications** (done/waiting/lost, `pretty notify`) · docs-from-source suite · teaching errors ·
code-signing · **Sessions.app v1** (Tauri: menu-bar status, scoped windows, quit never kills sessions).
Onboarding site refreshed + live (pretty-pty.somewhere.site). The manual-entry preview shell is superseded,
not a product surface.

## NEXT: finish Sessions.app v2 distribution (the immediate work)
The app IS the product package. v2 makes "one update updates everything, nothing lost":
1. **SHIPPED IN CODE:** bundle signed daemon+runner+CLI inside Sessions.app; verify and copy them to
   immutable versioned runtime directories; first-run installs/upgrades `tech.somewhere.sessions.daemon`.
2. **SHIPPED IN CODE:** record the live-session baseline, wait for health+discovery, verify every ID,
   and roll back to the previous plist/runtime on failure. Real scratch launchd coverage exercises it.
3. **NEXT:** Tauri updater feed: signed version manifest as a static file on somewhere (metadata only — no data plane).
4. **Notarization**: build already uses Developer ID + hardened runtime; needs Apple creds
   (APPLE_ID + app-specific password from appleid.apple.com, or App Store Connect API key). Required
   before anyone DOWNLOADS the app (vs building it). USER ACTION: create the app-specific password.
**USER SEQUENCE LOCKED 2026-07-19:** ship the macOS app first, then build Android. Do not cut over the
mini yet. Its later first Sessions.app install remains the joint Node-to-Go cutover (interop-proven by
`TestNodeRunnerUnderGoDaemonCutover`) after the app has shipped and been exercised.

## Roadmap after v2 (see board + WHY.md)
**Immediate after macOS ships:** Android app (Tauri2 paired client + FCM; push machinery ready). Later:
central/fleet search · semantic search (local embeddings, only if FTS insufficient) · session sharing
(pairing foundation exists) · diff viewer (parked) · iOS · always-on VM. Monetization: Sessions and its runtime FREE,
paid = somewhere platform; Sessions is top-of-funnel. **Prompt queuing = REJECTED. PWA = SKIPPED.**

## OPEN USER DECISIONS (blockers only)
1. **Public-build permission default** — keep skip-perms (owner default) vs constrain-by-default.
2. **Notarization creds** (user creates the app-specific password when ready to distribute).

The mini timing is not an open implementation question: no cutover now. Revisit jointly only after the
macOS app ships.

## Build / run
- Build (auto-signs): `cd prettygo && export PATH=$PATH:/opt/homebrew/bin && make binaries`
- Reload dev daemon: `launchctl kickstart -k gui/$(id -u)/tech.pretty-pty.dev.daemon` (then verify soak-d2).
- Build the app: `cd <repo> && npm install && npx tauri build`
  → `src-tauri/target/release/bundle/macos/Sessions.app`
- Gate a lane: from its worktree `prettygo/`: `GOFLAGS=-buildvcs=false go build ./... && go vet ./... &&
  go test ./...` then `bash scripts/gen-cli-docs.sh` if the CLI changed.
