# Runbooks
## Deploy to prod (mini)
`pretty deploy` — pulls, npm-installs BOTH dirs, builds, PRETTYD_SMOKE import-preflight, guarded kickstart, verifies runner survival. Never kickstart by hand after a package.json change.

## Fleet recovery (until the lane ledger ships)
A lane = conversation + workspace + resume recipe. If runners are wiped:
1. Names: `~/.local/state/pretty-PTY/idle/*` sentinels ({id,name,at}) survive and map names→ids; `<id>.events` raw output pins tool/cwd.
2. Conversations: `~/.claude/projects/<enc-cwd>/<uuid>.jsonl` (first line has cwd; fallback = decode dir name) and `~/.codex/sessions/Y/M/D/rollout-*-<uuid>.jsonl` (first line payload.cwd). Filter by mtime window; NEVER trust 12h — use 7d+.
3. Respawn: POST /api/sessions {cmd:"claude",args:["--dangerously-skip-permissions","--resume",uuid],cwd} or {cmd:"codex",args:["resume",uuid],cwd} (daemon injects codex bypass/update flags). Stagger ~350ms.
4. Deleted cwds: recreate the dir, then resume (conversation may still exist).

## Move the ops chat (mini → MacBook)
1. On mini: `rsync -a ~/.claude/projects/-Users-uzair-pretty-PTY/ macbook:~/.claude/projects/-Users-uzair-pretty-PTY/` (includes the conversation JSONLs AND the memory/ folder).
2. On MacBook: clone the repo at the SAME path (~/pretty-PTY) so the project-dir encoding matches; `cd ~/pretty-PTY && claude --resume ce1c91ab-3a7c-4eff-8f0a-ad8aa966cad6` in tmux.
3. Verify the resumed session responds with full context, THEN stop the mini copy (quit that claude; never run both against the same conversation simultaneously for long).
4. Snapshots: ~/Documents/claude-backups/ holds dated copies.
