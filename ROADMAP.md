# pretty-PTY — ROADMAP (2026-07-16)

**Product**: long-lived Claude/Codex/shell lanes, watchable + drivable from a browser, that survive everything — distributed as `npm i -g pretty-pty`. Differentiator = the trust contract: dumb pipe, zero LLM calls, no relay, MIT, "we never see your data" by architecture. Monetization later via the somewhere-backed fabric (customer-owned VM) — not in v1.

## v0.1 launch gate (order)
1. Review+merge lane branches: `pretty-wait`, `localhost-auth`, `readme-v01` (on the dev machine)
2. Release rehearsal on a clean account (tarball → install → walkthrough followed literally) — NEVER on the prod mini
3. Auth posture: loopback exempt (localhost-auth branch), token for remote; delete the `open` escape-hatch as DEFAULT for new installs
4. npm publish `pretty-pty@0.1.0` (explicit user go) + link setup/connect from the landing page
   Launch story: LOCAL is the headline; remote/phone = "early access" (pending final user confirm)

## After launch (dependency-ordered)
1. **Lane ledger** — board tsk_64772bd2, full spec there. The recovery/ownership substrate. FIRST.
2. `pretty adopt` (explicit adoption of external conversations) — trivial once ledger lands
3. Wake-on-condition: `wait --until commit` (branch exists) → `--until-idle-stable` (codex-authoritative, claude-heuristic) → `status --json` + explicit verdict channel. Observation only — never interpretation.
4. **Fleet epic** — board tsk_f4039d1a: see lanes across machines (frontend aggregation of multiple daemons) → `pretty move` (= resume-elsewhere: conversation + workspace + recipe; ledger tombstones make it safe) → somewhere VM as just-another-machine (customer-owned; Linux/systemd runner backend becomes the prerequisite)
5. App-server contract INSIDE real codex sessions (reliable send + watchable + reattachable — the right shape; headless `spawn` was the wrong one). Claude has no local app-server equivalent (verified) — claude stays PTY+JSONL until an SDK contract path is justified.

## Never
- LLM calls / routing intelligence / relays in pretty. Orchestration lives in the calling agent.
- Auto-adoption of external sessions. Auto-kill of anything possibly alive.
- Dev work on the production machine.

## somewhere tie-ins (value ladder)
- **Session backup to YOUR somewhere account (opt-in):** conversations are just files (JSONL/rollouts) → periodic push to sw.fs under the user's own account. Would have made the 2026-07-16 incident a non-event. Framing matters for trust: *your* account, *your* data, explicit opt-in (E2E encryption later); pretty still never sees/relays anything — the daemon pushes directly to the user's somewhere.
- **somewhere MCP pulls session histories:** once backed up, any agent with the user's somewhere MCP can recall past lane transcripts from anywhere — cross-machine memory, and a real onboarding hook into somewhere. Backup doubles as the fleet-migration transport (tsk_f4039d1a phase 2/3).
- Ladder: free local pretty → opt-in somewhere backup → fleet/VM. Each rung justifies giving the client away.

## Fly/VM notes (decided 2026-07-16)
- **Wake-on-send:** Fly's proxy auto-starts a suspended machine on incoming request → pretty's send-confirmation queue IS the "hold message, wake machine" mechanism. Claude remote control CANNOT wake a suspended VM (outbound tunnel, dead while suspended) → pretty is the wake path; remote-control tunnel re-establishes after wake. Prefer Fly SUSPEND (RAM snapshot, processes survive) over STOP (needs supervised relaunch + resume recipe = the lane ledger).
- **VM architecture:** machine runs prettyd (systemd-supervised; Linux runner backend required). Auth layers separated: pretty bearer token (built; hosted connect page does the handoff) + agent creds (claude/codex login) live ONLY on the VM — pretty never proxies/validates them, but `pretty doctor` surfaces auth-expiry as a 🟡 needs-you notification. Trust holds ONLY if the VM is customer-owned (their fly account / somewhere-provisioned into their ownership); us hosting their creds = the deferred fully-managed business.
- **Language:** TS/Node everywhere today (right call: velocity, node-pty, audience already has Node). Venture-scale version: port daemon+runner+CLI to Go (single static binary via brew — kills install tax + npm supply-chain surface; cheap Linux/Windows; ~MB-scale runners matter for VM economics), keep React frontend. A distribution/economics play for the fleet phase, NOT a launch blocker.
