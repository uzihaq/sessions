# DEFLAKE lane acceptance notes

## Result

`TestPrettyWaitCLIEndToEnd` was flaky because of a **test-side timing
assumption**, not a product race. The test started its commit and force-reset
goroutines before launching the CLI and assumed a one-second sleep was enough
for the subprocess to start, fail its daemon probe, resolve scratch metadata,
and snapshot `HEAD`. Under full-suite load the mutation could run first, so the
CLI legitimately captured the already-mutated commit as its baseline and then
timed out waiting for another change. The product path already has the required
ordering: `NewCommit` snapshots `HEAD`; `commitCondition.Wait` synchronously
registers the parent-directory watcher; and the loop immediately rechecks
`HEAD` before selecting on fsnotify hints or the five-second ticker.

The E2E test now puts a scratch `git` wrapper first on only the CLI
subprocess's `PATH`. The wrapper runs the real baseline command and writes a
scratch marker after `git rev-parse --verify HEAD` completes. The test waits for
that observable marker before making the real commit or reset, and it asserts
that the CLI reported the exact expected baseline. Timeouts and result
assertions were not weakened.

Two focused product-ordering regressions were added:

- `TestCommitRechecksAfterWatcherRegistration` lands the commit before watcher
  registration, gives the wait only 500 ms (well below the five-second poll),
  and proves the immediate post-registration predicate check closes the lost
  event window.
- `TestCommitFiveSecondPollFallback` makes watcher registration fail by using a
  nonexistent scratch parent, then proves the unchanged real five-second poll
  independently observes the commit.

## Watcher and CLI audit

- Baseline snapshot: `NewCommit` reads worktree-aware `HEAD` using
  `git -C <cwd> rev-parse --verify HEAD` and then resolves the absolute gitdir.
- Subscribe/recheck: `commitCondition.Wait` calls `watchParent` first;
  `watchParent` completes `fsnotify.NewWatcher` and `watcher.Add` synchronously.
  Only after it returns does `Wait` call `condition.check` at the top of the
  loop. A change anywhere between baseline capture and subscription is
  therefore found by the recheck.
- Coalescing: the one-element wake channel intentionally collapses bursts.
  Notifications carry no truth; every consumed hint causes a fresh Git/file
  read. Dropping a redundant hint cannot lose the predicate state.
- Fallback: commit waits retain an independent `time.NewTicker(5 *
  time.Second)`. The forced watcher-failure test observed the change after
  5.053 s, proving the fallback fires and supplies liveness.
- CLI path: `cmdWaitUntil` constructs commit conditions (capturing baselines)
  and then `WaitAny` starts each wait. Each condition independently performs
  subscribe-then-recheck, so sequential condition construction and goroutine
  scheduling do not reopen a lost-event window.

## Safety and ownership

All commands used `CGO_ENABLED=0` and scratch-only state:

```text
HOME=/tmp/pretty-deflake-gates.66CpHI/home
PRETTYD_STATE_DIR=/tmp/pretty-deflake-gates.66CpHI/runners
```

The E2E itself uses `t.TempDir()` for `HOME`, runner metadata, Git repositories,
the Git wrapper, and handshake markers. It deliberately probes loopback port 1
for the unavailable-daemon fallback. No launchd command was run, and the
default Pretty state directory and running daemon were never read or mutated.

Changes stayed inside the wait lane's ownership: tests under
`prettygo/internal/waitcond/` plus this lane notes file. Product code and CLI
code were audited but not changed. No commit was created.

## Focused regression output

Real output from the deterministic E2E, ordering regression, and real poll
fallback:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/waitcond -run 'TestCommit(RechecksAfterWatcherRegistration|FiveSecondPollFallback)|TestPrettyWaitCLIEndToEnd'
=== RUN   TestPrettyWaitCLIEndToEnd
=== RUN   TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset
    cli_e2e_test.go:54: commit JSON: {"session":"commit-fallback-session","cwd":"/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestPrettyWaitCLIEndToEndcommit_metadata_fallback_timeout_and_f913419291/001","baseline":"f114ee5514b376dd342badbb92341c601c65829e","commit":"a8d2d10a82d2a4d1b01371ca1b650aa39ce913f0","subject":"CLI real commit","elapsed_ms":39,"history_rewritten":false}
    cli_e2e_test.go:67: timeout exit=2 JSON: {"ok":false,"reason":"timeout","elapsed_ms":121,"conditions":1}
    cli_e2e_test.go:88: force-reset JSON: {"session":"commit-fallback-session","cwd":"/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestPrettyWaitCLIEndToEndcommit_metadata_fallback_timeout_and_f913419291/001","baseline":"a8d2d10a82d2a4d1b01371ca1b650aa39ce913f0","commit":"f114ee5514b376dd342badbb92341c601c65829e","subject":"initial","elapsed_ms":49,"history_rewritten":true}
=== RUN   TestPrettyWaitCLIEndToEnd/any_returns_second_session
    cli_e2e_test.go:117: --any JSON: {"session":"second-session","cwd":"/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestPrettyWaitCLIEndToEndany_returns_second_session1241110710/001","file":"/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestPrettyWaitCLIEndToEndany_returns_second_session1241110710/001/second.log","contains":"SECOND WON","elapsed_ms":88}
=== RUN   TestPrettyWaitCLIEndToEnd/idle_stable_labels_structured_evidence
    cli_e2e_test.go:155: idle-stable JSON: {"session":"idle-session","cwd":"/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestPrettyWaitCLIEndToEndidle_stable_labels_structured_evidence1851746332/001","idle_stable_ms":80,"elapsed_ms":81,"source":"structured"}
--- PASS: TestPrettyWaitCLIEndToEnd (1.80s)
    --- PASS: TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset (0.92s)
    --- PASS: TestPrettyWaitCLIEndToEnd/any_returns_second_session (0.10s)
    --- PASS: TestPrettyWaitCLIEndToEnd/idle_stable_labels_structured_evidence (0.10s)
=== RUN   TestCommitRechecksAfterWatcherRegistration
--- PASS: TestCommitRechecksAfterWatcherRegistration (0.15s)
=== RUN   TestCommitFiveSecondPollFallback
    waitcond_test.go:97: poll-only commit observed after 5.053s (fallback=5s)
--- PASS: TestCommitFiveSecondPollFallback (5.11s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond  7.479s
```

## `CGO_ENABLED=0` gates

Build and vet both exited zero:

```text
$ CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go build ./...: PASS
$ CGO_ENABLED=0 go vet ./...
CGO_ENABLED=0 go vet ./...: PASS
```

The required full suite ran ten consecutive times with `-count=1` in one
script; these are the real per-run results:

```text
$ for deflake_run in {1..10}; do
>   deflake_started=$SECONDS
>   if deflake_output=$(go test -count=1 ./... 2>&1); then
>     printf 'full-suite run %02d PASS (%ds)\n' "$deflake_run" "$((SECONDS-deflake_started))"
>   else
>     printf 'full-suite run %02d FAIL (%ds)\n%s\n' "$deflake_run" "$((SECONDS-deflake_started))" "$deflake_output"
>     exit 1
>   fi
> done
full-suite run 01 PASS (14s)
full-suite run 02 PASS (10s)
full-suite run 03 PASS (10s)
full-suite run 04 PASS (11s)
full-suite run 05 PASS (10s)
full-suite run 06 PASS (10s)
full-suite run 07 PASS (11s)
full-suite run 08 PASS (10s)
full-suite run 09 PASS (10s)
full-suite run 10 PASS (10s)
```
