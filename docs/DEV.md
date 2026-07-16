# Development ground rules (post-incident, 2026-07-16)
1. **Prod mini is hands-off.** No repo edits, no lanes, no test daemons, no `pretty install`, no launchctl, no rehearsals on it. Code reaches prod ONLY via `pretty deploy` (deliberate, from the ops tmux session).
2. Dev happens on the MacBook clone. Every agent lane works in an isolated git worktree with node_modules symlinked.
3. ANY test daemon MUST set `PRETTYD_STATE_DIR` + `PRETTYD_PORT` to scratch values. Booting a daemon with default state = how the fleet got wiped.
4. Never touch `tech.pretty-pty.*` launchd labels outside `pretty install`/`pretty deploy`.
5. `pretty kill` is the only sanctioned way to close a lane. Mass operations require the (pending) forced flag.
6. Lanes self-prove: acceptance output in NOTES.md is real command output; the reviewer re-runs it. No claimed-but-unrun results.
