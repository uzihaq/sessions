# WHY — feature rationale & promote log

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
- **`pretty search`** — you can't find text in a chat once it scrolls off screen, though it's all on disk. Search should be a command. — BUILDING — PROMOTE: **yes** (obvious, universally-wanted)
- **Lane `--description` (+ first-message fallback)** — at cleanup you can't tell WHY a lane exists → hard to know what's safe to kill. Give each lane a purpose. — BUILDING — PROMOTE: later

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
- **FTS5 ranked search (NO model — recommended stop)** — SQLite full-text search (already have SQLite): BM25 relevance ranking + stemming (email/emails, personalize/personalization) + phrase/boolean. This is what "smart search" feels like for personal recall, at ~zero added cost. Do this AFTER substring; likely sufficient. — roadmap — PROMOTE: yes
- **Semantic search (LOCAL embeddings) — ONLY IF FTS proves insufficient in real use** — find by meaning with ZERO shared vocabulary. Genuinely narrower payoff than it sounds (you usually remember some words). If earned: LOCAL embedding model only (cloud embed API breaks "we never see your data"), opt-in, incremental, off critical path. Don't build speculatively (user steer: keep it simple). — deferred-until-needed — PROMOTE: yes if built (private semantic recall differentiator)
