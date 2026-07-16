# Durable commit-wait proof

## Outcome

`pretty wait <id> --until commit` now snapshots git `HEAD`, treats
`fs.watch(<gitdir>/logs/HEAD)` only as a low-latency wake hint, and asks git
for truth after every hint and every five-second fallback poll. A changed
commit satisfies the wait even when it is not descended from the baseline;
that case reports `history_rewritten: true`.

The existing `pretty wait <id>` idle branch is unchanged. Commit predicates
run through a separate handler map so another `--until` condition can be
added without entering the idle loop.

## Daemon independence

The initial session-list request resolves both the session id and cwd in one
call. If that request cannot reach prettyd, the CLI reads runner metadata from
`~/.local/state/pretty-PTY/runners` (or the configured state directory). A
supplied `--cwd` remains available when no matching metadata exists. After
startup, all predicate checks are local `git -C <cwd>` commands.

## Scripted proof

The reproducible test is `prettyd/scripts/test-wait-commit.cjs`. It creates an
isolated repository and runner-metadata directory, points the CLI at an unused
local port, and covers:

1. metadata fallback plus a commit made after two seconds;
2. a missing `logs/HEAD` with reflogs disabled, forcing the five-second poll;
3. timeout exit code 2; and
4. `--cwd` override with immediate non-git exit code 1; and
5. reset to a non-descendant of the baseline with rewrite detection.

Observed run:

```text
$ cd prettyd
$ node -c bin/pretty.cjs
$ node scripts/test-wait-commit.cjs
commit wake: 2044ms -> 7293e9fe2afe622aea22c1bbc78a8639377c7a03
poll fallback: 5107ms -> 22228f411ee9cb13a3cd2ba198bdf9459addc9c4
timeout: exit 2
non-git cwd: exit 1
force reset: 5097ms -> history_rewritten=true
5 scripted scenarios passed
```

No live daemon or live runner was queried, created, signaled, restarted, or
killed. The proof used only scratch files and processes, then removed them.
