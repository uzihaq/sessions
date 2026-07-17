# BKFIX lane notes

Date: 2026-07-17  
Branch: `go-bkfix`  
Result: PASS

## Named failure and reproduction

The failing test is `TestPeriodicServiceRunsOnlyWhenEnabled`. The incremental
candidate, `TestPushRawTranscriptManifestAndIncrementalSkip`, did not fail.

The package first passed 100 isolated repetitions:

```text
$ CGO_ENABLED=0 go test ./internal/backup -count=100
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup  9.846s
```

Twenty pre-fix full suites also passed, confirming that this was rare and
load-sensitive. The spec's stronger reproduction made it fail: 1,000 backup
package repetitions while `go test ./internal/mirror -count=100` ran as a CPU
hammer. The mirror hammer exited zero, while backup exited one with:

```text
--- FAIL: TestPeriodicServiceRunsOnlyWhenEnabled (0.06s)
    testing.go:1464: TempDir RemoveAll cleanup: unlinkat .../TestPeriodicServiceRunsOnlyWhenEnabled.../001: directory not empty
FAIL
FAIL  github.com/uzihaq/pretty-pty/prettygo/internal/backup
```

At the same time, the periodic goroutine logged attempts to finish its config
save after the test's temporary directory was being removed:

```text
periodic session backup: replace backup config: rename .../.backup-*.tmp .../backup.json: no such file or directory
```

The requested pre-fix race invocation also reproduced the same named failure:

```text
$ go test ./internal/backup -race -count=20
--- FAIL: TestPeriodicServiceRunsOnlyWhenEnabled (0.06s)
    testing.go:1464: TempDir RemoveAll cleanup: unlinkat .../TestPeriodicServiceRunsOnlyWhenEnabled.../001: directory not empty
FAIL
FAIL  github.com/uzihaq/pretty-pty/prettygo/internal/backup  2.441s
```

It emitted no `WARNING: DATA RACE`; the fault was a product lifecycle race,
not an unsynchronized Go-memory access and not a loose test timeout.

## Diagnosis

`Service.Close` called `stopPeriodic`, which closed the timer goroutine's stop
channel and returned immediately. Closing that channel could wake the loop, but
it could not interrupt or join a `Push` that had already won the ticker select.
The enabled-behavior assertion observed the HTTP request and the test returned;
then `Close` returned while that same push was still persisting `backup.json`.
`t.TempDir` cleanup consequently raced the product goroutine's temporary-file
rename.

This is product behavior: daemon shutdown or periodic reload could likewise
return while an old backup request and config write remained in flight. No
transcript mutation occurred in the reproducer, and the size-plus-mtime cache
was not involved in the failing path.

## Fix and regression

- Each periodic worker now owns a cancelable context and a `done` channel.
- Reload and Close serialize worker replacement, cancel the old worker, and
  wait for its completion before returning. Close is terminal, so a concurrent
  reload cannot start a new worker afterward.
- The worker checks cancellation before beginning another tick. Expected
  context-cancellation errors during shutdown are not logged.
- `TestPeriodicServiceCloseCancelsAndWaitsForInFlightPush` uses a blocking,
  in-process HTTP transport. It waits on the observable request-start event,
  calls Close, and asserts that the request context was canceled before Close
  returned. There is no sleep, skipped test, or weakened assertion.

Focused output:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/backup -run 'TestPeriodicService(RunsOnlyWhenEnabled|CloseCancelsAndWaitsForInFlightPush)$'
=== RUN   TestPeriodicServiceRunsOnlyWhenEnabled
--- PASS: TestPeriodicServiceRunsOnlyWhenEnabled (0.07s)
=== RUN   TestPeriodicServiceCloseCancelsAndWaitsForInFlightPush
--- PASS: TestPeriodicServiceCloseCancelsAndWaitsForInFlightPush (0.01s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup  0.277s
```

The post-fix version also passed the stronger reproduction shape:

```text
post-fix backup count=1000 exit=0 mirror count=100 exit=0
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup  105.845s
```

## Acceptance gates

Build and vet both exited zero:

```text
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
```

The requested race gate passed all 20 repetitions:

```text
$ CGO_ENABLED=0 go test -race ./internal/backup -count=20
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup  3.727s
```

Ten consecutive uncached full suites passed:

```text
$ for bkfix_run in {1..10}; do CGO_ENABLED=0 go test ./... -count=1; done
full-suite run 01 PASS (8s)
full-suite run 02 PASS (6s)
full-suite run 03 PASS (6s)
full-suite run 04 PASS (5s)
full-suite run 05 PASS (5s)
full-suite run 06 PASS (6s)
full-suite run 07 PASS (6s)
full-suite run 08 PASS (6s)
full-suite run 09 PASS (6s)
full-suite run 10 PASS (6s)
```

All backup network tests used loopback `httptest` servers or the in-process
transport; no real somewhere endpoint or user transcript was accessed. No
commit was created.
