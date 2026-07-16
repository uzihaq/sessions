# INTEG2 lane notes

## Result

Merged `go-ledger` into `go-integrate-ledger` and resolved the overlap around
`session.Manager` as the composition root.

- `prettygo/internal/ledger` was adopted unchanged. The integration adds no
  ledger API changes; `git diff --exit-code go-ledger -- prettygo/internal/ledger`
  exits 0.
- `cmd/prettyd` opens the ledger once and supplies its boundary writer,
  observation writer, and read surface to `session.Manager`. The manager owns
  creation and kill write-ahead ordering, lifecycle observations, startup
  restart emission, and post-discovery reconciliation.
- `state.Registry` now exposes ledger-agnostic launch lifecycle callbacks.
  `RecordCreated` commits before metadata/plist/runner launch; launch-started,
  runner-ready, provider-bound, attached, exit, and reap facts are emitted by
  manager-owned callbacks.
- Kill composition is `mass-kill guard -> user-kill tombstone commit -> runner
  kill`. Guard refusal returns before any tombstone. A failed tombstone aborts
  the runner kill and surfaces through the API as an error.
- HTTP and WebSocket input now route through the manager, so successful human
  input records coalesced activity. `recordClaudeLocked` remains the sole
  structured-event mutation point and now also extracts the provider activity
  timestamp into the event delivered to the manager.
- Manager startup emits `daemon_restart` for ledger-known lanes. Successful
  discovery then emits `runner_lost` for non-closed, ledger-known lanes that
  are absent from the discovered registry. This is only the requested
  reconciliation event stub; it does not launch recovery commands.
- Dependency resolution keeps the CLI/session dependencies and adds the
  ledger's pure-Go SQLite dependency. `go mod tidy` produced the final
  `go.mod`/`go.sum` union.

## Composition acceptance

Run from `prettygo/`:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/session -run 'Test(MassKillGuardThenTombstoneThenRunnerKillComposition|StartupRestartThenDiscoveryReconcilesAbsentLedgerLane|ProviderActivityTimestampFlowsFromRecordClaudeLocked)$'
=== RUN   TestMassKillGuardThenTombstoneThenRunnerKillComposition
--- PASS: TestMassKillGuardThenTombstoneThenRunnerKillComposition (0.02s)
=== RUN   TestStartupRestartThenDiscoveryReconcilesAbsentLedgerLane
--- PASS: TestStartupRestartThenDiscoveryReconcilesAbsentLedgerLane (0.00s)
=== RUN   TestProviderActivityTimestampFlowsFromRecordClaudeLocked
--- PASS: TestProviderActivityTimestampFlowsFromRecordClaudeLocked (0.01s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	0.420s
```

The mass-kill test creates four live lanes with a limit of three, proves the
unforced sweep leaves all four alive with zero user-kill tombstones, then
forces the sweep and has each runner inspect the real SQLite ledger before
accepting its kill. The startup test proves exact `daemon_restart` then
`runner_lost` order for a known active lane absent from discovery. The activity
test proves the timestamp parsed inside `recordClaudeLocked` reaches the
provider activity row.

The ledger branch's original write-ahead/error tests were preserved and moved
to the manager-owned composition:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/state -run '^TestLedger'
=== RUN   TestLedgerWriteAheadBoundariesAreCommittedBeforeLaunchAndKill
    ledger_integration_test.go:146: lane=168d9a06-c15b-48b5-ad16-bcd61bc348bf launch_saw_committed_created=true kill_saw_committed_tombstone=true lifecycle_events=8
--- PASS: TestLedgerWriteAheadBoundariesAreCommittedBeforeLaunchAndKill (0.02s)
=== RUN   TestLedgerBoundaryErrorsAbortTheirSideEffects
=== RUN   TestLedgerBoundaryErrorsAbortTheirSideEffects/created_failure_aborts_launch
=== RUN   TestLedgerBoundaryErrorsAbortTheirSideEffects/tombstone_failure_aborts_kill
--- PASS: TestLedgerBoundaryErrorsAbortTheirSideEffects (0.00s)
    --- PASS: TestLedgerBoundaryErrorsAbortTheirSideEffects/created_failure_aborts_launch (0.00s)
    --- PASS: TestLedgerBoundaryErrorsAbortTheirSideEffects/tombstone_failure_aborts_kill (0.00s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	0.390s
```

## Required gates

Run from `prettygo/` after the final edits:

```text
$ CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go test -count=1 ./...
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.479s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	2.447s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.004s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	0.409s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.997s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.430s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.527s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.210s
```

No commit was created; the merge is left resolved for reviewer commit.
