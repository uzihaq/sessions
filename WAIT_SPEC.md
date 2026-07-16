# Durable `pretty wait <id> --until commit` (the wake-on-condition primitive)
Work ONLY in /Users/uzair/pretty-PTY-wait. Files: prettyd/bin/pretty.cjs (extend cmdWait) + a test script. Gate: node -c bin/pretty.cjs + test passes. No commit. Never touch the live daemon.

WHY: power users orchestrating many agent lanes poll git by hand all day ("wake me when the lane commits"). Design principles (from an architectural review, follow them):
- OBSERVATION ONLY: pure git facts. No model calls, no daemon dependency for the predicate — the wait must keep working across daemon restarts because it asks GIT for truth, not the daemon.
- Predicate: "the lane's branch resolves to a commit different from the baseline recorded at wait-start." Snapshot baseline → watch → recheck pattern.

BUILD `pretty wait <id> --until commit [--timeout T] [--json]`:
1. Resolve the session (existing resolveSessionId) → get its cwd from the daemon (one API call at start; if the daemon is down, allow --cwd override or read the runner metadata json directly from ~/.local/state/pretty-PTY/runners — prefer that fallback so the wait works daemon-down).
2. Baseline: in that cwd, record HEAD sha (git rev-parse HEAD) and the checked-out ref. Handle worktree .git-file indirection (use `git -C <cwd>` always — git handles worktrees natively).
3. Watch loop: fs.watch on <gitdir>/logs/HEAD (reflog append = any HEAD movement incl. commit) as a WAKE HINT only; on every hint AND on a 5s fallback poll, ask git for truth: rev-parse HEAD != baseline → satisfied. Never trust fs events alone (packed-refs, atomic renames). Detect and report force-push/reset (new sha not descendant: git merge-base --is-ancestor baseline new) — still counts as satisfied but flag "history-rewritten" in output.
4. On satisfied: print (or --json emit) { session, cwd, baseline, commit: newSha, subject: git log -1 --format=%s, elapsed_ms, history_rewritten } and exit 0. Timeout → exit 2 with a clear message. cwd not a git repo → exit 1 immediately with a clear message.
5. Keep the EXISTING `pretty wait <id>` idle behavior untouched; --until commit is a new mode. Structure so future --until predicates slot in.
PROVE (WAIT_NOTES.md): scripted test — init a scratch git repo, start `pretty wait` against a scratch session (create one shell session via the live daemon READ/CREATE ONLY: `pretty new --tool shell --cwd <scratchrepo>`, kill it at the end) or bypass the daemon with --cwd; make a commit from another process after 2s; assert the wait exits 0 with the right sha in <10s; also test timeout path (exit 2) and force-reset detection. node -c clean. Do NOT commit.
