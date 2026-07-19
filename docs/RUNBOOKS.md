# Runbooks
## Deploy to prod (mini)
`pretty deploy` — pulls, npm-installs BOTH dirs, builds, PRETTYD_SMOKE import-preflight, guarded kickstart, verifies runner survival. Never kickstart by hand after a package.json change.

## Fleet recovery
A lane = conversation + workspace + a validated resume recipe. The shipped
ledger and recovery package are the source of truth
(`prettygo/internal/ledger/fold.go`, `prettygo/internal/recovery/report.go`).

1. Run `pretty recover` for a read-only reconciliation of ledger, runner, and
   provider state.
2. Run `pretty recover --reopen` only for entries whose safe recipe should be
   relaunched. Recovery refuses duplicate live ownership
   (`prettygo/internal/recovery/mutate.go`).
3. Use `pretty adopt` with an explicit provider file or conversation UUID when
   an artifact is not in the ledger; ambiguous adoption is rejected
   (`prettygo/internal/recovery/adopt.go`).
4. Treat old event logs and provider JSONL as last-resort evidence, not as an
   invitation to hand-build parallel resumptions. Never run two live drivers for
   the same provider conversation (`prettygo/internal/session/manager.go`).

## Move the ops chat (mini → MacBook)
1. On mini: `rsync -a ~/.claude/projects/-Users-uzair-pretty-PTY/ macbook:~/.claude/projects/-Users-uzair-pretty-PTY/` (includes the conversation JSONLs AND the memory/ folder).
2. On MacBook: clone the repo at the SAME path (~/pretty-PTY) so the project-dir encoding matches; `cd ~/pretty-PTY && claude --resume ce1c91ab-3a7c-4eff-8f0a-ad8aa966cad6` in tmux.
3. Verify the resumed session responds with full context, THEN stop the mini copy (quit that claude; never run both against the same conversation simultaneously for long).
4. Snapshots: ~/Documents/claude-backups/ holds dated copies.

## Project backup to somewhere
Full-history backup: `git bundle create pretty-PTY-all.bundle --all`, tar with untracked docs, then raw-bytes upload (never via agent context / fs_write base64):
`PUT https://api.somewhere.tech/v1/fs/pretty-pty/backups/<name>.tgz` with `Authorization: Bearer <smt_ token from ~/.somewhere/config.json>`, body = file bytes. Verify with fs_stat. Files are private by default. Latest: /backups/pretty-PTY-backup-20260716.tgz (all branches + ASSESSMENT/CODEX_CONTROLS). Restore: download → `git clone <bundle>`. This same PUT endpoint is the primitive for the roadmap's opt-in session-history backup.
