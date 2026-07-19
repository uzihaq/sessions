# pretty-PTY — STATE / ORCHESTRATOR HANDOFF (2026-07-19)

> **New orchestrator (Codex or returning Claude): start here, then read `AGENTS.md`.**
> This file + `AGENTS.md` + `docs/WHY.md` + the somewhere board = everything the previous
> orchestrator knew that isn't obvious from the code. Rehydrate from these, not from memory.

## How to rehydrate context (the durable-context contract)
1. `AGENTS.md` (repo root) — the router: what pretty is, repo map, working rules, gate commands.
2. `docs/WHY.md` — every feature's rationale + every decision this week, dated. The reasoning record.
3. `docs/CODEBASE.md` + `docs/CLI.md` (generated) — the deep map + real command reference.
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
- Product = the Go rewrite on branch **`go-rewrite`** (HEAD d8bb068). MacBook = dev (launchd
  `tech.pretty-pty.dev.daemon`, localhost:8787). Mac mini (100.86.76.84) = prod, still OLD node daemon,
  **UNTOUCHED** — cutover is a JOINT step, now planned as the mini's first Pretty.app install (see below).
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
code-signing · **Pretty.app v1** (Tauri: menu-bar status, scoped windows, quit never kills sessions).
Onboarding site refreshed + live (pretty-pty.somewhere.site). Preview shell at pretty-pty-preview.

## NEXT: Pretty.app v2 = the release vehicle (the immediate work)
The app IS the product package. v2 makes "one update updates everything, nothing lost":
1. Bundle signed daemon+runner+CLI inside the .app; first-run installs/upgrades the launchd service.
2. Tauri updater feed: signed version manifest as a static file on somewhere (metadata only — no data plane).
3. **Notarization**: build already uses Developer ID + hardened runtime; needs Apple creds
   (APPLE_ID + app-specific password from appleid.apple.com, or App Store Connect API key). Required
   before anyone DOWNLOADS the app (vs building it). USER ACTION: create the app-specific password.
4. Post-update health ritual as CODE: daemon back? sessions adopted? counts match pre-update? → then "updated".
Then: **mini cutover = its first Pretty.app install** (Go daemon adopts node runners — interop-proven:
`TestNodeRunnerUnderGoDaemonCutover`). Channels: MacBook dev → mini early-release (updates like a
customer) → customers stable.

## Roadmap after v2 (see board + WHY.md)
Central/fleet search · semantic search (local embeddings, only if FTS insufficient) · session sharing
(after pairing ladder — its foundation now exists) · diff viewer (parked) · Android app (Tauri2 + FCM;
push machinery ready) · always-on VM (the somewhere paid tier). Monetization: pretty FREE, paid = somewhere
platform; pretty is top-of-funnel. **Prompt queuing = REJECTED. PWA = SKIPPED.**

## OPEN USER DECISIONS (blockers only)
1. **Product name** — "Somewhere Sessions" vs "pretty by Somewhere". Renames the app in one config line.
2. **Public-build permission default** — keep skip-perms (owner default) vs constrain-by-default.
3. **When to do the mini cutover** (joint; via the app per the plan above).
4. **Notarization creds** (user creates the app-specific password when ready to distribute).

## Build / run
- Build (auto-signs): `cd prettygo && export PATH=$PATH:/opt/homebrew/bin && make binaries`
- Reload dev daemon: `launchctl kickstart -k gui/$(id -u)/tech.pretty-pty.dev.daemon` (then verify soak-d2).
- Build the app: `cd <repo> && npm install && npx tauri build`
  → `src-tauri/target/release/bundle/macos/Pretty-PTY.app`
- Gate a lane: from its worktree `prettygo/`: `GOFLAGS=-buildvcs=false go build ./... && go vet ./... &&
  go test ./...` then `bash scripts/gen-cli-docs.sh` if the CLI changed.
