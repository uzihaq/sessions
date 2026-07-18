# pretty-PTY — STATE (2026-07-18, post Go-rewrite)

## Reality
- **The product is the Go rewrite** on branch `go-rewrite` (~38k Go LOC, 18 pkgs green, race-clean, fuzz-hardened, opus-audit-cleared). Committed + pushed. `pty-runner-architecture` = old TS branch (superseded).
- **Daily driver = THIS MacBook.** Installed launchd service `tech.pretty-pty.dev.daemon` (dev label), http://localhost:8787, `pretty` on PATH (~/.local/bin/pretty). Durable soak-d2 shell survives every restart.
- **Mac mini (100.86.76.84) = PRODUCTION, still OLD node daemon, UNTOUCHED.** Cutover to Go is a LATER joint step (rehearsed, reversible, interop-proven: Go daemon adopts node runners).
- **Cron is OFF** (user steer: keep life easy, don't chase edge cases/guards). No autonomous loop.

## Shipped (Go)
- Single static binary (no npm/node/install-scripts); daemon+runner+CLI+ledger+watchers+mirror; embedded UI; cross-compiles Linux.
- Reliability: lane ledger (recover/adopt/collision-guard/provenance), mass-kill guard, periodic re-discovery, sessions-sacred.
- STRUCTURED CONTRACTS (big win): Codex app-server (JSON-RPC, streaming, tokens, dual-view attach, model catalog) + Claude `claude -p` stream-json (subscription-billed, multi-turn) — both SIDE BY SIDE with PTY fallback. Scraping demoted to fallback.
- CLI/UX shipped incl: `--` passthrough fix, complete `--help`, `run --wait`, unified `sessions --mine`, recover cleanup, `pretty search` (covers exited sessions), lane `--description`.
- Distribution: hosted onboarding site LIVE (pretty-pty.somewhere.site); brew formula/release script; pretty Claude skill (skills/pretty/SKILL.md + ~/.claude/skills/pretty/).

## Live vs not
- Local (MacBook): FULLY USABLE NOW (CLI + web UI localhost:8787).
- Hosted site: onboarding pages LIVE; drive-your-daemon APP SHELL BUILT but NOT deployed (pending user go).
- Remote access: NOT enabled (`pretty remote enable` built/Tailscale but off; daemon localhost-only).

## PENDING USER DECISIONS (only real blockers)
1. Permission default — keep skip-perms (user's use) vs constrain-by-default + loud --dangerous flag (public build).
2. Deploy hosted app + `pretty remote enable` → phone access (~15 min, user's go, public-facing).
3. Mini cutover — swap node->Go together when dogfooded enough.
4. Product name — considering "somewhere PTY"/rebrand. Keep CLI command `pretty` regardless (muscle memory + skill). Decide before public launch.

## Roadmap (docs/WHY.md = rationale + PROMOTE flags)
- Search: substring (done) -> FTS5 ranked (NEXT, confirmed free: modernc sqlite has FTS5) -> semantic embeddings (EARN-IT only; local model for privacy).
- Fleet: view + move shipped; central/fleet search + customer VM (needs Linux/systemd runner) deferred.

## Build/deploy
- Build: cd prettygo && export PATH=$PATH:/opt/homebrew/bin && make binaries
- Update daemon: launchctl kickstart -k gui/$(id -u)/tech.pretty-pty.dev.daemon (verify soak-d2 survives; count runners via metadata not bare pgrep).
- Lanes via codex worktrees; gate (build+vet+suite+gated-integration, re-run acceptance myself) -> merge -> update daemon.
