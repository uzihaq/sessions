# pretty-PTY — STATE (verified 2026-07-16)

Machine roles (DECIDED 2026-07-16, after 3rd mass session loss):
- **Mac mini = PRODUCTION ONLY.** launchd daemon `tech.pretty-pty.daemon` runs `node prettyd/dist/server.js`, binds 100.86.76.84:8787, serves API + built UI single-origin. ~35 live lanes. NO pretty development, NO test daemons, NO rehearsals here — ever.
- **MacBook = development.** Clone from GitHub, own daemon/state, lanes break things freely.
- Ops brain: a Claude tmux session on the mini (conversation ce1c91ab; migration runbook in docs/RUNBOOKS.md).

Sources of truth: **code = GitHub (uzihaq/pretty-pty)** — everything committed+pushed incl. lane branches; **work queue = somewhere board `pretty-pty`**; **conversations = ~/.claude/projects + ~/.codex/sessions** (a lane = conversation + workspace + resume recipe — proven recoverable).

## Deployed & live (main = pty-runner-architecture)
- Send confirm-or-fail; bounded tail-load history + paging; terminal snapshot-prefill
- Notifications: 🟢 done / 🟡 needs-you / 🔴 error classifier + final-message summary; hooks env PRETTY_OUTCOME/FINAL_MESSAGE/DURATION_MS; global ~/.config/pretty/hooks.json
- Agent controls: `pretty new --model/--effort/--fast` (validated vs live catalog), `pretty model`; skip-perms default on every entry path (CLI + daemon guard); codex update-prompt suppressed
- npm package REAL: tarball embeds frontend (web/) + MIT LICENSE; `pretty install` hardened; `pretty doctor` node-pty preflight
- `pretty remote enable/status/disable` (tailscale serve wrapper; honest MagicDNS handling; QR → hosted connect)
- `pretty deploy`: pull → npm install BOTH dirs → build → PRETTYD_SMOKE import-preflight → guarded kickstart + runner-survival check (kills the dep-crash class)
- Codex history: resolver 64KiB first-line (16KiB truncation was the real bug) + createdAt-date + full-scan fallback; watcher BACKFILL on attach (byte-offset handoff)
- Hosted site v2 LIVE at **pretty-pty.somewhere.site** (platform migrated domains; .tech 308s → .site; daemon allowlists BOTH): index / setup / connect (fragment #endpoint+token, scrubbed) / docs. sw.js cache version build-stamped.

## Branches
- Parked (deliberate): `codex-app-server` (contract client foundation, smoke-proven), `appserver-spawn` (built; NOT shipping — headless spawn judged wrong product shape; contract belongs IN real sessions)
- Lane output, UNREVIEWED: `pretty-wait` (wait --until commit), `localhost-auth` (loopback auth exemption), `readme-v01` (user-first README)

## Incident 2026-07-16 (3rd mass loss) + response
All runner plists/sockets/metadata wiped in one sweep (~48 lanes); daemon fine. Killer unconfirmed; prime suspect = a rehearsal lane booting the packaged daemon. Recovery: mined conversation stores + surviving idle-sentinels (they carry lane NAMES — how PM/RAILTIME came back); ~35 lanes resumed. Systemic fixes designed, on the board: **lane ledger** (tsk_64772bd2 — SQLite outside failure domain, write-ahead kill tombstones, `pretty recover --reopen`, 4-way owned/external/closed/lost classification, `pretty adopt`) and the **mass-kill guard**. Build on the MacBook.

Principles (non-negotiable): sessions are sacred; pretty is a dumb pipe (zero LLM calls — observation, never interpretation); no orchestration intelligence in pretty (lives in calling agents); worktrees only; deploys only via `pretty deploy`.
