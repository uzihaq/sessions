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
- **Native app direction (Tauri/iOS/Android) — decision note 2026-07-18** — the app is the answer to three problems at once: (1) no browser "Not Secure" scare on LAN http; (2) keychain token storage + signed immutable client (closes the mutable-hosted-JS trust gap); (3) can EMBED tsnet/libtailscale so "install Tailscale" disappears as a user-visible step — bolting Tailscale into the daemon is pointless, bolting it into the client app is where it pays. Tauri deps already in frontend. — roadmap — PROMOTE: yes when built

## Distribution
- **Hosted onboarding site (pretty-pty.somewhere.site)** — the "what we never do" trust contract + guided setup. — live — PROMOTE: yes
- **Hosted app shell (drive-from-anywhere)** — built, NOT deployed (pending user go). — PROMOTE: yes when live

## Deferred (why we're NOT doing it yet)
- **Customer-owned VM / Linux runner** — "much later" per user; needs systemd runner backend.
- **JSON casing normalization** — the inconsistency is real but a broad rename breaks the frontend; not worth it now.
- **Permission-default reversal** — codex says constrain-by-default for safety; user explicitly wants skip-perms for their trusted orchestration. PENDING USER DECISION for the public build.
- **More fuzzing/guards** — every package is fuzzed; stop chasing invented edge cases (user steer 2026-07-17: keep life easy).

## Search roadmap (added 2026-07-17, user-requested)
- **`pretty search` (keyword, one daemon)** — you can't find text once it scrolls off. — building — PROMOTE: yes
- **Central / fleet search (keyword, all machines)** — one search across mini + MacBook + VMs; fan `/api/search` across configured daemons + merge. The "central place to search." — roadmap — PROMOTE: yes
- **FTS5 ranked search (NO model — recommended stop)** — SQLite full-text search (already have SQLite): BM25 relevance ranking + stemming (email/emails, personalize/personalization) + phrase/boolean. This is what "smart search" feels like for personal recall, at ~zero added cost. Do this AFTER substring; likely sufficient. — **shipped 2026-07-18** (`--ranked`, opt-in) — PROMOTE: yes

## Remote security (codex audit 2026-07-18 — decision record)
Verdict: **keep Tailscale Serve as the only remote transport.** It's the best primitive (private reachability + E2E-encrypted transport + no Pretty data plane + tiny code), not the only one. Full analysis in scratchpad `remote-security-verdict.md`.
- **The real trust gap is mutable hosted JS, not the network.** "No Pretty data plane" is true; "cryptographically impossible for us to see data" is NOT, while a mutable `pretty-pty.somewhere.site` build serves the UI. → Prefer the daemon-served **same-origin** UI for remote (shipped above). Signed/reproducible releases become the code-trust boundary later.
- **Origin allowlist is NOT a second factor** — it only limits browser pages; doesn't stop curl or a leaked token. Don't market it as auth.
- **`/api/health/deep` is unauthenticated** (leaks session IDs/PIDs/dims). Tailnet-only today = not urgent; MUST authenticate before any public ingress. — deferred (not chasing now)
- **Token-hardening ladder (do BEFORE adding any new ingress):** one-time pairing tickets → per-device keys → short-lived session tokens → `pretty devices list/revoke` → no permanent token in WS URLs. — roadmap — PROMOTE: yes (never-a-shared-secret story)
- **Don't build a custom relay; don't default Funnel.** If phone-VPN friction proves real, add opt-in Tailscale Funnel AFTER the token ladder — never on by default. — deferred
- **Semantic search (LOCAL embeddings) — ONLY IF FTS proves insufficient in real use** — find by meaning with ZERO shared vocabulary. Genuinely narrower payoff than it sounds (you usually remember some words). If earned: LOCAL embedding model only (cloud embed API breaks "we never see your data"), opt-in, incremental, off critical path. Don't build speculatively (user steer: keep it simple). — deferred-until-needed — PROMOTE: yes if built (private semantic recall differentiator)
