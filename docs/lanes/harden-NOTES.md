# CUTHARDEN lane notes

## Outcome

Findings #3 and #1 from `docs/CUTOVER_AUDIT_2026-07-17.md` are closed.

- Reconnect recovery no longer exhausts its last delay while metadata or the
  runner plist still exists. An exited/stale registry entry re-arms instead of
  terminating the chain; an already-active replacement session still stops
  the obsolete timer.
- `prettyd` now runs startup discovery and the same guarded discovery path on
  a serialized periodic loop. The default is 30 seconds. Set
  `PRETTYD_DISCOVERY_INTERVAL` with Go duration syntax (for example, `10s`) to
  tune it; invalid and non-positive values retain the 30-second default.
- Periodic and startup discovery share `DiscoverWithOptions`, including the
  mass-kill guard, live-PID conservation, PID-reuse check, attachment retries,
  artifact cleanup, and ledger reconciliation.
- Old valid `metadata + plist` pairs with no socket are now classifiable when
  their recorded PID is genuinely dead. They enter the same guarded candidate
  set; unreadable/invalid metadata, live matching processes, recent plists,
  and any session with persistent `.events` remain untouched.
- Live-process matching now also recognizes the recorded provider command.
  This matters for the Go runner, whose metadata PID is the PTY child
  (`bash`, `claude`, etc.), not a `runner.js` process.
- Interop now covers a real authenticated Claude provider across Go-daemon
  restart, five simultaneous real runner adoptions, and four dead artifacts
  beside two live runners through both refused and forced guard paths. The
  original Node-runner/Go-daemon cutover and Go-runner/Node-daemon regression
  remain in the suite.

The authenticated provider test is opt-in so routine test runs do not consume
provider quota: set `PRETTY_INTEROP_REAL_CLAUDE=1`. The successful run below
used Claude Code 2.1.212 on this machine. Its fixture removes inherited
`CLAUDECODE`/child-bridge variables so the subprocess owns a real local JSONL
rather than becoming a nested child of the test's parent Claude session.

## Finding #3 proof: reconnect reschedule and periodic guarded discovery

The periodic regression closes a daemon-side connection while its modeled
runner process remains alive and attachable. Reattachment completes in 20 ms,
well below the legacy one-second reconnect timer, proving the periodic pass did
the recovery without a daemon restart. The second regression makes the final
reconnect delay fail twice and proves that the same terminal delay repeats for
a third, successful attempt.

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/session -run 'Test(ReconnectRepeatsFinalBackoffUntilLiveRunnerReappears|PeriodicDiscoveryReattachesAfterDaemonSideSocketBlipWithoutReapingLiveRunner|MassKillGuardRefusesDiscoverySweepBeforeBootout|DiscoveryPreservesUnreachableLivePID)$'
=== RUN   TestPeriodicDiscoveryReattachesAfterDaemonSideSocketBlipWithoutReapingLiveRunner
    manager_test.go:349: periodic discovery reattached 556415a9-139a-4cf6-a975-a2167084e617 after 1 attach attempt(s); reaps=0
--- PASS: TestPeriodicDiscoveryReattachesAfterDaemonSideSocketBlipWithoutReapingLiveRunner (0.02s)
=== RUN   TestReconnectRepeatsFinalBackoffUntilLiveRunnerReappears
    manager_test.go:398: terminal reconnect backoff repeated through 3 attempts
2026/07/17 00:25:28 [reconnect] runner 60a81b05-dd3b-49fe-ab96-9a6e1000fb00 reattached after unexpected disconnect
--- PASS: TestReconnectRepeatsFinalBackoffUntilLiveRunnerReappears (0.03s)
=== RUN   TestMassKillGuardRefusesDiscoverySweepBeforeBootout
--- PASS: TestMassKillGuardRefusesDiscoverySweepBeforeBootout (0.00s)
=== RUN   TestDiscoveryPreservesUnreachableLivePID
2026/07/17 00:25:28 [discover] runner 00000000-0000-4000-8000-000000000099 unreachable but pid 1234 alive — leaving it alone
--- PASS: TestDiscoveryPreservesUnreachableLivePID (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  0.396s
```

The new reconnect tests are also race-clean:

```text
$ go test -race -count=1 ./internal/session -run 'Test(ReconnectRepeatsFinalBackoffUntilLiveRunnerReappears|PeriodicDiscoveryReattachesAfterDaemonSideSocketBlipWithoutReapingLiveRunner)$'
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  1.631s
```

## Finding #1 proof: provider, scale, orphan, and guard

This is the complete interop package with the real-provider gate enabled. The
Claude case starts a real Go runner around the authenticated `claude` binary,
gets a structured assistant marker, stops only the Go daemon, confirms the
runner/socket survived, starts a new Go daemon, verifies `pretty last` returns
the old marker, submits another turn, and verifies `pretty last` returns the
new marker.

The scale and orphan cases use real compiled Go runner processes and direct
Unix-socket attachment. Their test launcher implements a recording scratch
reaper instead of `LaunchdLauncher`, so neither the guarded nor forced path can
execute `launchctl`. The guarded pass attaches both live runners before
refusing all four dead removals; the forced pass removes exactly the four dead
metadata/plist pairs.

```text
$ CGO_ENABLED=0 PRETTY_INTEROP_REAL_CLAUDE=1 go test -count=1 -v ./internal/interop
=== RUN   TestNodeRunnerUnderGoDaemonCutover
    cutover_test.go:110: scratch node-to-go state: /tmp/pc-794964837
    cutover_test.go:147: node runner discovered by Go daemon: id=59d5f1de-854b-4a5b-8f0a-2d5e7c945809 first=NODE_TO_GO_9173 after_restart=NODE_TO_GO_REATTACHED_4990
--- PASS: TestNodeRunnerUnderGoDaemonCutover (0.55s)
=== RUN   TestGoRunnerUnderNodeDaemonRegression
    cutover_test.go:152: scratch go-to-node state: /tmp/pc-537338042
    cutover_test.go:180: Go runner discovered by node daemon: id=78e609f8-2806-41a7-8718-4c376379595a marker=GO_TO_NODE_11899
--- PASS: TestGoRunnerUnderNodeDaemonRegression (0.50s)
=== RUN   TestGoManagerAdoptsFiveScratchRunnersAtOnceWithoutReaping
    cutover_test.go:185: scratch scale state: /tmp/pc-1528019146
    cutover_test.go:216: scale discovery attached=5 live=5 reaped=0
--- PASS: TestGoManagerAdoptsFiveScratchRunnersAtOnceWithoutReaping (0.30s)
=== RUN   TestGuardedDiscoveryReapsOnlyFourDeadScratchArtifacts
    cutover_test.go:221: scratch orphan-guard state: /tmp/pc-3687043559
    cutover_test.go:289: orphan discovery guarded=4 forced_reaps=4 live_preserved=2
--- PASS: TestGuardedDiscoveryReapsOnlyFourDeadScratchArtifacts (0.13s)
=== RUN   TestRealClaudeRunnerReattachesAndReResolvesStructuredHistory
    cutover_test.go:305: scratch real-claude state: /tmp/pc-8990096
    cutover_test.go:356: real Claude structured history survived daemon restart: id=1eafe92d-b602-40e7-ade3-ab22f791f041 before=CLAUDE_BEFORE_RESTART_13A5A10F after=CLAUDE_AFTER_RESTART_69D25C4C
--- PASS: TestRealClaudeRunnerReattachesAndReResolvesStructuredHistory (7.10s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop  11.080s
```

After tightening the late-child JSONL cleanup, the final provider-only rerun
also passed and the exact `/tmp` root plus both cwd-derived Claude project
directories were verified absent afterward:

```text
$ CGO_ENABLED=0 PRETTY_INTEROP_REAL_CLAUDE=1 go test -count=1 -v ./internal/interop -run '^TestRealClaudeRunnerReattachesAndReResolvesStructuredHistory$'
=== RUN   TestRealClaudeRunnerReattachesAndReResolvesStructuredHistory
    cutover_test.go:305: scratch real-claude state: /tmp/pc-4039712128
    cutover_test.go:356: real Claude structured history survived daemon restart: id=edab90aa-1fc3-474a-9b98-113a159d099b before=CLAUDE_BEFORE_RESTART_B6B8002E after=CLAUDE_AFTER_RESTART_D3EDC92F
--- PASS: TestRealClaudeRunnerReattachesAndReResolvesStructuredHistory (11.86s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop  14.010s
```

## Required gates

Both static gates exited zero with no stdout/stderr:

```text
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
```

The uncached CGO-disabled full suite is green. The quota-consuming Claude case
is skipped in this command and is proven by the explicit interop run above.

```text
$ CGO_ENABLED=0 go test -count=1 ./...
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty              1.647s
?    github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd            [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/cmd/runner             [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api           4.204s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/backup        0.672s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/interop       4.971s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger        3.508s
?    github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror        1.375s
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto         1.728s
?    github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/recovery      2.232s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session       2.178s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state         2.644s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/verdict       2.470s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/waitcond      4.653s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch         2.152s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets     1.609s
```

## Isolation and handoff

- No command contacted the mini, port 8787, or a non-loopback address.
- No test called `launchctl`. Scratch plist filenames used IDs containing
  `scratch-scale` or `scratch-orphan`; the test reaper only removed files below
  each `/tmp/pc-*` root.
- All real runners were direct child processes and cleanup signaled only their
  exact PIDs. Daemons were stopped before runner cleanup.
- The Claude runner state, ledger, worktree, logs, and Pretty sockets were
  below one `/tmp/pc-*` root. Claude's required authenticated HOME was retained;
  the test used unique cwd-derived project directories and removed only those
  exact scratch JSONL directories during cleanup.
- A post-gate audit caught three earlier provider-iteration directories that
  Claude recreated just after its wrapper exited. No matching process remained;
  those three exact scratch directories were moved to Trash (recoverable). The
  fixture now removes through the short child-shutdown window and asserts final
  absence; its final rerun left no `/tmp` or Claude-project artifact.
- No production daemon label was bootstrapped, booted out, or signaled.
- No commit was created.
