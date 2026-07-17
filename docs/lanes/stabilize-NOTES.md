# STABILIZE lane notes

Date: 2026-07-16
Branch: `go-stabilize`

## Result

The suite is deterministic under the reproduced load. Every observed failure was a **test-side timing or lifecycle bug**; no product data race was found. Assertions were preserved, no sleeps were lengthened, and no skip was added.

The final required gates passed:

- `CGO_ENABLED=0 go test ./... -count=1`: 10 consecutive uncached runs.
- `CGO_ENABLED=0 go test ./... -race -count=1`: 2 consecutive runs.
- The exact high-contention reproductions passed after the fixes: 48 concurrent session packages, 24 concurrent wait-condition packages, and 12 concurrent full suites.
- `rg -n 'time\\.Sleep' . --glob '*_test.go'`: no matches.
- `CGO_ENABLED=0 go vet ./...`, `CGO_ENABLED=0 go build ./...`, and `git diff --check`: green.

No commit was created.

## Flake diagnoses and fixes

### `TestWorkingEdgeWritesSentinelAndHookEnvironment` — test publication race

This was the named `internal/session` load flake. It reproduced once in 48 concurrent package runs:

~~~text
$ 48 PID-tracked concurrent invocations of: CGO_ENABLED=0 go test ./internal/session -count=1
--- FAIL: TestWorkingEdgeWritesSentinelAndHookEnvironment (0.24s)
    manager_test.go:391: hook environment = ""
2026/07/16 20:49:29 [discover] runner 00000000-0000-4000-8000-000000000099 unreachable but pid 1234 alive — leaving it alone
FAIL
FAIL	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.071s
FAIL
~~~

The product intentionally launches the idle hook asynchronously. The test's hook used shell redirection directly to `hook.txt`; the shell creates/truncates that file before `printf` fills it. The old polling helper treated existence as completion, so under load it could read the valid intermediate empty file. This is a test publication race, not a product race.

The fixture now writes `hook.txt.tmp` and atomically renames it to `hook.txt` only after the full environment payload is present. The test registers a filesystem watcher before triggering the idle edge and waits for that published file. It also waits on the runtime's actual output-observed signal before driving classifier ticks. The original sentinel, working-state, hook-field, outcome, duration, and mode assertions are unchanged.

### `TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset` — test handshake deadline

This reproduced consistently in the 24-way wait-condition load and in concurrent full suites:

~~~text
$ 24 PID-tracked concurrent invocations of: CGO_ENABLED=0 go test ./internal/waitcond -count=1
--- FAIL: TestPrettyWaitCLIEndToEnd (5.77s)
    --- FAIL: TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset (5.07s)
        cli_e2e_test.go:32: CLI did not capture its Git baseline; stdout= stderr=
--- FAIL: TestCommitFiresOnRealCommit (0.21s)
    waitcond_test.go:34: commit wait: baseline=eb7fd44a5337994ecb17a4a0a540e8a52336d9b4 commit=cb09edaf1ac9533d926f78379b4c902f94937aea subject="real second commit" history_rewritten=false
    waitcond_test.go:23: git [commit -m real second commit]: exit status 128
        fatal: unable to read tree 04609ae2c084b15e2756c4219f6f05f4a1c30b3c
        [master 
FAIL
FAIL	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	15.043s
FAIL
~~~

The helper polled a baseline marker every 5 ms and imposed its own 5-second deadline. Under CPU/process load, the freshly built CLI sometimes had not run its first Git baseline command before that test-only deadline. The empty stdout/stderr confirms that the product condition and repository mutation had not started. The helper now registers an fsnotify watch before starting the CLI and waits on either the baseline file event or actual command exit. There is no scheduler deadline or polling sleep in this handshake; the exact reported baseline/commit/reset assertions remain intact.

### `TestCommitFiresOnRealCommit` and related wait-condition mutators — detached test work

The same wait-condition stress also exposed `TestCommitFiresOnRealCommit`. Its goroutine updated `HEAD`, allowing the condition to return, but Git had not necessarily exited. Test cleanup could then remove the temporary repository underneath the still-running `git commit`, producing `fatal: unable to read tree`. The 100 ms sleeps in commit/reset, file append/recreate, and WaitAny tests were guesses that observers had armed; none joined the mutator.

Commit and file conditions now expose internal watch/ticker seams. Tests wait until watcher registration is observable, perform and finish the mutation synchronously, then await the result. `TestCommitRechecksAfterWatcherRegistration` uses a ticker that never fires, so it still proves the immediate recheck closes the lost-event window. `TestCommitFiveSecondPollFallback` asserts the requested interval is exactly five seconds, proves no result arrives before its manual tick, then advances the tick. `TestIdleStableResetsAndReportsEvidenceSource` uses a manual clock and asserts the exact 240 ms reset timeline. This strengthens the prior timing assertions while removing real-time scheduling from them.

### `TestGoDaemonRunnerMirrorRoundTrip` and `TestHeadlessLaneLifecycleManifestAndLedger` — scratch-launcher deadline

Twelve concurrent full suites reliably exceeded the scratch process launcher's fixed 10-second socket deadline:

~~~text
$ 12 PID-tracked concurrent invocations of: CGO_ENABLED=0 go test ./... -count=1 -parallel=128
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	8.818s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
--- FAIL: TestGoDaemonRunnerMirrorRoundTrip (10.21s)
    e2e_test.go:84: create status=400 body={"error":"runner attach timeout: dial unix /tmp/prettygo-e2e-750219765/state/runners/f6dba1a2-20ba-4cd7-8d32-fce18b6f31b6.sock: connect: no such file or directory (log: /tmp/prettygo-e2e-750219765/state/runners/f6dba1a2-20ba-4cd7-8d32-fce18b6f31b6-process.log)"}
--- FAIL: TestHeadlessLaneLifecycleManifestAndLedger (10.25s)
    lanes_handlers_test.go:79: create lane status=400 body={"error":"runner attach timeout: dial unix /tmp/pretty-lane-e2e-267088445/state/runners/31cb6a3e-317d-4b2d-8038-986c9dcd74d5.sock: connect: no such file or directory (log: /tmp/pretty-lane-e2e-267088445/state/runners/31cb6a3e-317d-4b2d-8038-986c9dcd74d5-process.log)"}
FAIL
FAIL	github.com/uzihaq/pretty-pty/prettygo/internal/api	27.044s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	28.706s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	10.545s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	6.669s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	13.720s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	9.062s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	6.388s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	18.550s
--- FAIL: TestPrettyWaitCLIEndToEnd (13.39s)
    --- FAIL: TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset (5.07s)
        cli_e2e_test.go:32: CLI did not capture its Git baseline; stdout= stderr=
FAIL
FAIL	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	36.938s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	14.534s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	21.631s
FAIL
~~~

The runner process had not exited—the helper's process-completion branch did not fire—but scheduler/process contention delayed socket creation past the test-only wall-clock cutoff. Both failures are in the shared `_test.go` launcher, not the production launcher. It now retries until one of three observable outcomes occurs: the runner attaches, the runner process exits, or the request context is canceled. The API round trip waits on session output/terminal events rather than snapshot polling; the lane test waits on its real death notification before inspecting exited state, manifest, snapshot, and ledger facts.

### Remaining sleep audit

Before the change, assertion-gating `time.Sleep` calls remained in wait-condition mutations, session/API/state/recovery polling helpers, the CLI baseline marker helper, and the real runner snapshot poll. All were removed. State/ledger/recovery helpers re-read their mutex-protected observable state while yielding; fake-runner API tests use a coalesced change notification; session tests use attachment/runtime/notification channels; filesystem publication uses fsnotify; duration behavior uses a manual clock.

~~~text
$ rg -n 'time\.Sleep' . --glob '*_test.go'
(no matches)
~~~

## Post-fix load reproductions

The exact session stress that previously produced the empty hook file:

~~~text
$ 48 PID-tracked concurrent invocations of: CGO_ENABLED=0 go test ./internal/session -count=1
session fixed load run 01 PASS
session fixed load run 02 PASS
session fixed load run 03 PASS
session fixed load run 04 PASS
session fixed load run 05 PASS
session fixed load run 06 PASS
session fixed load run 07 PASS
session fixed load run 08 PASS
session fixed load run 09 PASS
session fixed load run 10 PASS
session fixed load run 11 PASS
session fixed load run 12 PASS
session fixed load run 13 PASS
session fixed load run 14 PASS
session fixed load run 15 PASS
session fixed load run 16 PASS
session fixed load run 17 PASS
session fixed load run 18 PASS
session fixed load run 19 PASS
session fixed load run 20 PASS
session fixed load run 21 PASS
session fixed load run 22 PASS
session fixed load run 23 PASS
session fixed load run 24 PASS
session fixed load run 25 PASS
session fixed load run 26 PASS
session fixed load run 27 PASS
session fixed load run 28 PASS
session fixed load run 29 PASS
session fixed load run 30 PASS
session fixed load run 31 PASS
session fixed load run 32 PASS
session fixed load run 33 PASS
session fixed load run 34 PASS
session fixed load run 35 PASS
session fixed load run 36 PASS
session fixed load run 37 PASS
session fixed load run 38 PASS
session fixed load run 39 PASS
session fixed load run 40 PASS
session fixed load run 41 PASS
session fixed load run 42 PASS
session fixed load run 43 PASS
session fixed load run 44 PASS
session fixed load run 45 PASS
session fixed load run 46 PASS
session fixed load run 47 PASS
session fixed load run 48 PASS
~~~

The exact wait-condition stress that previously produced the CLI marker and detached Git failures:

~~~text
$ 24 PID-tracked concurrent invocations of: CGO_ENABLED=0 go test ./internal/waitcond -count=1
waitcond fixed load run 01 PASS
waitcond fixed load run 02 PASS
waitcond fixed load run 03 PASS
waitcond fixed load run 04 PASS
waitcond fixed load run 05 PASS
waitcond fixed load run 06 PASS
waitcond fixed load run 07 PASS
waitcond fixed load run 08 PASS
waitcond fixed load run 09 PASS
waitcond fixed load run 10 PASS
waitcond fixed load run 11 PASS
waitcond fixed load run 12 PASS
waitcond fixed load run 13 PASS
waitcond fixed load run 14 PASS
waitcond fixed load run 15 PASS
waitcond fixed load run 16 PASS
waitcond fixed load run 17 PASS
waitcond fixed load run 18 PASS
waitcond fixed load run 19 PASS
waitcond fixed load run 20 PASS
waitcond fixed load run 21 PASS
waitcond fixed load run 22 PASS
waitcond fixed load run 23 PASS
waitcond fixed load run 24 PASS
~~~

The exact concurrent full-suite stress that previously produced scratch runner and CLI marker timeouts:

~~~text
$ 12 PID-tracked concurrent invocations of: CGO_ENABLED=0 go test ./... -count=1 -parallel=128
concurrent fixed full-suite 01 PASS
concurrent fixed full-suite 02 PASS
concurrent fixed full-suite 03 PASS
concurrent fixed full-suite 04 PASS
concurrent fixed full-suite 05 PASS
concurrent fixed full-suite 06 PASS
concurrent fixed full-suite 07 PASS
concurrent fixed full-suite 08 PASS
concurrent fixed full-suite 09 PASS
concurrent fixed full-suite 10 PASS
concurrent fixed full-suite 11 PASS
concurrent fixed full-suite 12 PASS
~~~

## Required 10 consecutive full-suite runs

Command:

~~~text
$ for suite_run in {1..10}; do
>   printf '=== full-suite run %02d ===\n' "$suite_run"
>   CGO_ENABLED=0 go test ./... -count=1
> done
~~~

Complete real output:

~~~text
=== full-suite run 01 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.722s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.245s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.686s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.773s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.898s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.132s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.763s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.537s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.890s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.126s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.569s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.627s
=== full-suite run 02 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.761s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.207s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.490s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.678s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.538s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.456s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.859s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	0.915s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.986s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	3.683s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	1.470s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.567s
=== full-suite run 03 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.651s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.200s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.734s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.383s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	1.419s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	0.972s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.359s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.795s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.142s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.090s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.354s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.698s
=== full-suite run 04 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	1.506s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.358s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.674s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.189s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.520s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.644s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	2.215s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.983s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	0.719s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.243s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	1.293s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	2.101s
=== full-suite run 05 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	2.150s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.327s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.643s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.238s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.514s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	0.902s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.673s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	2.137s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.241s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.238s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	1.760s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	2.020s
=== full-suite run 06 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	1.089s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.068s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.258s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.181s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	1.027s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	0.554s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.275s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.406s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.753s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	3.534s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.265s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.880s
=== full-suite run 07 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.640s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.254s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.439s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.727s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.856s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.450s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	0.788s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.273s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.076s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	3.745s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.437s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.610s
=== full-suite run 08 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.627s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.005s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.617s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.184s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.353s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.389s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.931s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.564s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	0.722s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	3.546s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.130s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.649s
=== full-suite run 09 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.898s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.645s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.423s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.813s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	1.686s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	2.038s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.440s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.571s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	0.994s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.065s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.295s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.739s
=== full-suite run 10 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.629s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	3.281s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.601s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.978s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.455s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	0.655s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.610s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.906s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.740s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.214s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.467s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.703s
~~~

## Required race-detector runs

Command:

~~~text
$ for race_run in 1 2; do
>   printf '=== race run %s ===\n' "$race_run"
>   CGO_ENABLED=0 go test ./... -race -count=1
> done
~~~

Complete real output:

~~~text
=== race run 1 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	1.903s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	6.010s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	5.413s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	3.576s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	3.775s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	3.064s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	3.903s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	2.475s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	1.711s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	6.738s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	4.896s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	3.137s
=== race run 2 ===
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	2.163s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	4.971s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	4.150s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	2.908s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	2.550s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	3.240s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	4.222s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.982s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	2.478s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	5.658s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	3.245s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	2.298s
~~~

## Static checks

~~~text
$ CGO_ENABLED=0 go vet ./...
(no output; exit 0)
$ CGO_ENABLED=0 go build ./...
(no output; exit 0)
$ git diff --check
(no output; exit 0)
~~~
