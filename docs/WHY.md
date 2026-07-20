# WHY — feature rationale & promote log

> Agent entry point: [`AGENTS.md`](../AGENTS.md).

**Practice (adopted 2026-07-17):** every feature gets a line here answering *why it exists* — the real user pain or decision that drove it, not just what it does. This is the memory of the product's reasoning over time. When a feature ships, mark it **PROMOTE?** so we remember to announce/market the ones worth telling people about. Board tasks link here; this is the durable record.

Format: `FEATURE — WHY (the pain/decision) — [status] — PROMOTE: yes/no/later`

## Reliability / the rewrite
- **Go single-binary rewrite** — npm/node-gyp install friction + node-pty compile-on-install were the scariest, most failure-prone onboarding step; a static binary deletes it entirely. Also: Linux/VM future, MB-scale runners. — shipped — PROMOTE: **yes** (the trust + "no install scripts" story)
- **Lane ledger (recover/adopt)** — the fleet was lost to a mass-wipe THREE times; recovery was manual archaeology. Now it's one command. — shipped — PROMOTE: **yes** (never-lose-your-sessions is a headline)
- **Collision guard** — user hit it live: reopening a moved session "took over the line" (two drivers on one conversation). — shipped — PROMOTE: later
- **Codex app-server contract** — driving Codex by scraping its TUI is structurally fragile (stuck sends, prompt hijacks); the app-server gives a real JSON-RPC contract + attachable GUI. Reliability becomes structural, not scraped. — shipped — PROMOTE: **yes**
- **Claude `-p` structured path** — same idea for Claude, subscription-billed, side-by-side with the watchable PTY path. — shipped — PROMOTE: **yes**

## Orchestration / daily-use
- **`pretty lanes/sessions --mine` (provenance)** — agents forget which lanes they spawned (context compaction) and leak them; querying the ledger instead of remembering fixes it. — shipped — PROMOTE: later (agent-builder audience)
- **CLI fixes (`--` passthrough, complete `--help`, `run --wait`)** — real dogfood bugs: child commands lost their flags, half the commands were undiscoverable. — shipped — PROMOTE: no (table stakes)
- **`pretty search`** — you can't find text in a chat once it scrolls off screen, though it's all on disk. Search should be a command. — shipped (exact substring/regex) — PROMOTE: **yes** (obvious, universally-wanted)
- **`pretty search --ranked` (FTS5)** — exact substring is precise but dumb; ranked recall (BM25 + stemming email/emails + phrase/boolean) is what "smart search" feels like, at ~zero cost (modernc sqlite ships FTS5). Kept opt-in so the exact-substring default that finds punctuation literals like `{{first_name}}` is never lost. — shipped 2026-07-18 — PROMOTE: **yes**
- **Lane `--description` (+ first-message fallback)** — at cleanup you can't tell WHY a lane exists → hard to know what's safe to kill. Give each lane a purpose. — shipped — PROMOTE: later
- **Remote UX: daemon UI auto-adopts its own origin** — over Tailscale the daemon serves its own UI at a non-8787 origin; the UI used to force manual endpoint entry. Now it health-probes the origin and, if it IS prettyd, asks only for a token. Doubles as the STRONGER security posture (same-origin UI, not mutable hosted JS — see Remote security below). — shipped 2026-07-18 — PROMOTE: **yes**
- **`pretty lan enable` (same-WiFi, no Tailscale)** — binding loopback-only made "install Tailscale" look like a product requirement when it's only needed cross-network. Any device on the same WiFi (phone, iPad, ANOTHER computer) can now connect with one command: opt-in second listener on the LAN IP, persisted across restarts, QR (endpoint-only — token stays out of the QR; the same-origin UI 401-prompts for it). Explicit opt-in by design: loopback→LAN is a real surface change the user must choose once. Access ladder: Mac = zero setup → home WiFi = one command → anywhere = Tailscale. — shipped 2026-07-18 — PROMOTE: **yes** (kills the "you HAVE to install Tailscale" objection)
- **Native app direction — decision note 2026-07-18; sequence reaffirmed 2026-07-19** — the app answers three problems at once: no browser scare-bar on LAN, secure credential storage plus a signed immutable client, and a future place for embedded tailnet connectivity. ARCHITECTURE PRINCIPLE: the app is a WINDOW and package manager; the daemon remains a separate OS service, and runners remain below it. Quitting or updating the app must never kill sessions. The product name is **Sessions** (user decision 2026-07-19). Sessions.app v1 now ships tray status, scoped windows, and that lifetime boundary. v2 bundles the signed Go runtime, installs/upgrades launchd, adds a signed updater, notarization, and coded post-update adoption checks. USER ORDER: ship macOS first, then Android; do not cut over the mini yet. Android is a paired Tauri 2 client with FCM/widgets, not a daemon host; iOS follows later. PWA rung SKIPPED. — v1 shipped 2026-07-19; v2 immediate — PROMOTE: **yes** when distributable

## Distribution
- **Hosted onboarding site (pretty-pty.somewhere.site)** — the "what we never do" trust contract + guided setup. — live — PROMOTE: yes
- **Hosted app shell (drive-from-anywhere)** — deployed to pretty-pty-preview.somewhere.site 2026-07-18; manual endpoint/token UX REJECTED by user — superseded by QR pairing + native app. — PROMOTE: no (superseded)

## Monetization & the somewhere funnel (decision 2026-07-18)
- **Sessions is FREE; monetization flows through the somewhere platform.** Give Sessions and its `pretty` runtime away; the paid surface (e.g. the always-on VM, fleet phase 3) comes with a somewhere platform tier. Sessions is TOP-OF-FUNNEL for somewhere — nearly every user should learn about somewhere through using it (onboarding site, backup-to-somewhere, VM upsell are the natural touchpoints). Matches the market read (local core free everywhere; paid = hosted convenience/team) with our twist: the "cloud tier" IS the somewhere platform, not a Sessions-specific relay. Never token markup; never a required cloud.

## Backup ladder (user-requested 2026-07-18)
- **`pretty backup` (to the user's OWN somewhere project)** — transcripts are the user's most valuable artifact and live on one disk; the daemon pushes them DIRECTLY to the user's own somewhere account (no relay, incremental, manifest). — **already shipped** (internal/backup, enable/now/status) — PROMOTE: yes (and it's a somewhere-funnel touchpoint)
- **Client-side encrypted backup (`--encrypt`) — "maximum security"** — transcripts and manifests are sealed locally with XChaCha20-Poly1305 before upload; the key stays on the machine and a recovery phrase is printed once, so even somewhere cannot read the backup. — shipped 2026-07-19 — PROMOTE: **yes**

## Deferred (why we're NOT doing it yet)
- **Customer-owned VM / Linux runner** — "much later" per user; needs systemd runner backend.
- **JSON casing normalization** — the inconsistency is real but a broad rename breaks the frontend; not worth it now.
- **Permission-default reversal** — codex says constrain-by-default for safety; user explicitly wants skip-perms for their trusted orchestration. PENDING USER DECISION for the public build.
- **More fuzzing/guards** — every package is fuzzed; stop chasing invented edge cases (user steer 2026-07-17: keep life easy).

## Competitive-gap roadmap (promoted by user 2026-07-18; research: board task "Feature gaps vs the field")
- **Push on done/waiting/lost** — 6 competitors converged on it; the ledger means you can walk away and push closes the loop. Daemon event wiring, encrypted browser push, cooldowns, and `pretty notify` toggles are shipped. Android FCM delivery is the next native-client rung. — daemon shipped 2026-07-19; Android delivery next — PROMOTE: **yes**
- **`pretty new --worktree` (worktree-per-task)** — 5/5 orchestrators auto-create worktree+branch per session; we do it by hand for every codex lane. Pretty now creates and records isolated worktrees, while cleanup remains opt-in and refuses live, dirty, or unmerged work ([daemon implementation](../prettygo/internal/session/worktrees.go), [CLI](../prettygo/cmd/pretty/worktrees.go)). — shipped 2026-07-19 — PROMOTE: **yes**
- **Diff viewer** — "agent done → what changed" shouldn't require leaving pretty. Cheap unified tier first; inline-comments-to-agent tier later. — roadmap — PROMOTE: later
- **Prompt queuing** — REJECTED by user 2026-07-19 ("everything already does it") — not building.
- **Session sharing** — deferred until after the QR-pairing/per-device-key ladder (its natural foundation).
- **Account profiles (multi-login)** — running two Anthropic (or OpenAI) logins on one Mac is fiddly because both fight over `~/.claude`. `pretty new --profile work` now creates a private per-tool config root, injects only `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, records the choice durably, and threads it through live watching plus transcript/search/backup resolution ([profile lifecycle](../prettygo/internal/session/profiles.go), [runner launch and metadata](../prettygo/internal/state/registry.go), [conversation resolution](../prettygo/internal/backup/sessions.go)). First use stays the provider's own login flow; Pretty never handles credentials. Session-move-between-logins remains deferred (user: "might be too complicated"). — shipped 2026-07-19 — PROMOTE: **yes** (nobody else does multi-plan cleanly)
- **Code-signing (Developer ID)** — unsigned rebuilds get a fresh macOS TCC identity and repeat file-access prompts. All Darwin Go binaries and Sessions.app now use the user's Developer ID plus hardened runtime; notarization remains the distribution gate. — signing shipped 2026-07-19 — PROMOTE: no (table stakes)

## Search roadmap (added 2026-07-17, user-requested)
- **`pretty search` (keyword, one daemon)** — you can't find text once it scrolls off. — building — PROMOTE: yes
- **Central / fleet search (keyword, all machines)** — one search across mini + MacBook + VMs; fan `/api/search` across configured daemons + merge. The "central place to search." — roadmap — PROMOTE: yes
- **FTS5 ranked search (NO model — recommended stop)** — SQLite full-text search (already have SQLite): BM25 relevance ranking + stemming (email/emails, personalize/personalization) + phrase/boolean. This is what "smart search" feels like for personal recall, at ~zero added cost. Do this AFTER substring; likely sufficient. — **shipped 2026-07-18** (`--ranked`, opt-in) — PROMOTE: yes

## Remote security (codex audit 2026-07-18 — decision record)
Verdict: **keep Tailscale Serve as the only remote transport.** It's the best primitive (private reachability + E2E-encrypted transport + no Pretty data plane + tiny code), not the only one. Full analysis in scratchpad `remote-security-verdict.md`.
- **The real trust gap is mutable hosted JS, not the network.** "No Pretty data plane" is true; "cryptographically impossible for us to see data" is NOT, while a mutable `pretty-pty.somewhere.site` build serves the UI. → Prefer the daemon-served **same-origin** UI for remote (shipped above). Signed/reproducible releases become the code-trust boundary later.
- **Origin allowlist is NOT a second factor** — it only limits browser pages; doesn't stop curl or a leaked token. Don't market it as auth.
- **`/api/health/deep` is unauthenticated** (leaks session IDs/PIDs/dims). Tailnet-only today = not urgent; MUST authenticate before any public ingress. — deferred (not chasing now)
- **Token-hardening ladder (do BEFORE adding any new ingress):** one-time pairing tickets → per-device keys → short-lived session tokens → `pretty devices list/revoke` → no permanent token in WS URLs. — RUNG 1 SHIPPED 2026-07-19: **`pretty pair` QR one-time pairing** (single-use 5-min tickets, per-device tokens stored hashed, rate-limited claim, `pretty devices`/`revoke`, frontend claims via scrubbed fragment — scan once, zero typing; the fix for the rejected manual endpoint/token UX AND the security rung). Remaining rungs (short-lived session tokens, WS ticket auth) — roadmap. — PROMOTE: **yes** (never-a-shared-secret story)
- **Don't build a custom relay; don't default Funnel.** If phone-VPN friction proves real, add opt-in Tailscale Funnel AFTER the token ladder — never on by default. — deferred
- **Semantic search (LOCAL embeddings) — ONLY IF FTS proves insufficient in real use** — find by meaning with ZERO shared vocabulary. Genuinely narrower payoff than it sounds (you usually remember some words). If earned: LOCAL embedding model only (cloud embed API breaks "we never see your data"), opt-in, incremental, off critical path. Don't build speculatively (user steer: keep it simple). — deferred-until-needed — PROMOTE: yes if built (private semantic recall differentiator)
