# LEDGER lane notes

## Result

Implemented the native lane ledger in `prettygo/internal/ledger` and wired it
into the Go daemon/session lifecycle.

- The database defaults to
  `~/Library/Application Support/pretty-PTY/ledger/lanes.sqlite3`; tests and
  scratch runs can set `PRETTY_LEDGER_PATH`. The ledger directory/database are
  owner-only (0700/0600), with a shared sticky scratch root such as `/tmp` left
  untouched. SQLite runs through `modernc.org/sqlite` with WAL,
  `synchronous=FULL`, a 5-second busy timeout, one configured connection per
  store, explicit transactions, unique event IDs, and append-only
  UPDATE/DELETE triggers.
- `Store.Boundaries()` exposes only `RecordCreated` and `RecordUserKill`.
  `Store.Observations()` is a different concrete capability and cannot write
  either boundary/tombstone. Session creation commits `created` before the
  launcher is invoked; a commit error aborts launch. User kill commits the
  tombstone before the KILL frame; a commit error returns HTTP 500 and aborts
  the kill.
- All specified event types have typed writers. The Go state registry records
  launch, readiness, provider binding, attachment, human input/provider
  activity, runner loss/exit, reaping, and daemon reattachment/restart facts.
  Activity is coalesced and its payload contains only the source enum.
- The `created` payload contains name/tool/cwd, lane/provider UUIDs, and only a
  reconstructed provider resume argv. Claude follows the normative TS
  `--session-id|--resume <uuid>` forms and stores `claude --resume <uuid>`;
  Codex follows `resume <uuid>`, `--resume <uuid>`, and `--resume=<uuid>` and
  stores `codex resume <uuid>`. Arbitrary args, prompts, environment, terminal
  bytes, and kill reasons have no ledger payload path; non-canonical argv is
  rejected by the writer.
- Deterministic folding and runtime classification produce `live-managed`,
  `closed`, `unexpectedly-lost`, and `external`, with
  `closed-but-running`, `never-became-ready`, `resume-source-missing`, and
  `provider-unbound` anomalies. A user-kill bit is monotonic, so later lost,
  attached, or reopened observations never resurrect a tombstoned lane.
- Recovery plans contain only unexpectedly-lost lanes with safe
  create-with-resume recipes, rank solely by human-input/provider-event time,
  and retain missing resume sources as blocked entries.

All acceptance state stayed under Go `t.TempDir()` paths. No default Pretty
state, launchd service, or real daemon was touched.

## Write-ahead and crash acceptance

Run from `prettygo/`:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/state -run '^TestLedger'
=== RUN   TestLedgerWriteAheadBoundariesAreCommittedBeforeLaunchAndKill
    ledger_integration_test.go:138: lane=73159791-b1e2-4c46-b404-f7d26eaab071 launch_saw_committed_created=true kill_saw_committed_tombstone=true lifecycle_events=8
--- PASS: TestLedgerWriteAheadBoundariesAreCommittedBeforeLaunchAndKill (0.02s)
=== RUN   TestLedgerBoundaryErrorsAbortTheirSideEffects
=== RUN   TestLedgerBoundaryErrorsAbortTheirSideEffects/created_failure_aborts_launch
=== RUN   TestLedgerBoundaryErrorsAbortTheirSideEffects/tombstone_failure_aborts_kill
--- PASS: TestLedgerBoundaryErrorsAbortTheirSideEffects (0.00s)
    --- PASS: TestLedgerBoundaryErrorsAbortTheirSideEffects/created_failure_aborts_launch (0.00s)
    --- PASS: TestLedgerBoundaryErrorsAbortTheirSideEffects/tombstone_failure_aborts_kill (0.00s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	0.336s
```

The ledger acceptance suite includes the real helper binary built from
`internal/ledger/testhelper`. The parent waits until its SQLite write
transaction is open, sends SIGKILL, then runs `quick_check`, closes/reopens the
WAL database, and verifies that the committed baseline survived while the
uncommitted row did not.

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/ledger -run 'Test(StoreIsPrivateWALFullAndAppendOnly|ObservationCapabilityCannotWriteTombstones|SafeResumeRecipeDropsPromptsAndSecrets|ActivityIsCoalescedAndOnlyTypedSourcesAdvanceRecency|CrashSimulationKill9WriterKeepsDatabaseValid|TombstoneWinsForever|ClassificationTableAllClassesAndAnomalies|RecoveryPlanUsesOnlyActivityAndRanksMostRecentFirst)$'
=== RUN   TestTombstoneWinsForever
--- PASS: TestTombstoneWinsForever (0.00s)
=== RUN   TestClassificationTableAllClassesAndAnomalies
=== RUN   TestClassificationTableAllClassesAndAnomalies/live_managed
    fold_test.go:115: class=live-managed anomalies=[]
=== RUN   TestClassificationTableAllClassesAndAnomalies/closed
    fold_test.go:115: class=closed anomalies=[]
=== RUN   TestClassificationTableAllClassesAndAnomalies/unexpectedly_lost
    fold_test.go:115: class=unexpectedly-lost anomalies=[]
=== RUN   TestClassificationTableAllClassesAndAnomalies/external
    fold_test.go:115: class=external anomalies=[]
=== RUN   TestClassificationTableAllClassesAndAnomalies/closed_but_running
    fold_test.go:115: class=closed anomalies=[closed-but-running]
=== RUN   TestClassificationTableAllClassesAndAnomalies/never_ready_and_provider_unbound
    fold_test.go:115: class=unexpectedly-lost anomalies=[never-became-ready provider-unbound]
=== RUN   TestClassificationTableAllClassesAndAnomalies/resume_source_missing
    fold_test.go:115: class=unexpectedly-lost anomalies=[resume-source-missing]
--- PASS: TestClassificationTableAllClassesAndAnomalies (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/live_managed (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/closed (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/unexpectedly_lost (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/external (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/closed_but_running (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/never_ready_and_provider_unbound (0.00s)
    --- PASS: TestClassificationTableAllClassesAndAnomalies/resume_source_missing (0.00s)
=== RUN   TestRecoveryPlanUsesOnlyActivityAndRanksMostRecentFirst
--- PASS: TestRecoveryPlanUsesOnlyActivityAndRanksMostRecentFirst (0.00s)
=== RUN   TestStoreIsPrivateWALFullAndAppendOnly
--- PASS: TestStoreIsPrivateWALFullAndAppendOnly (0.01s)
=== RUN   TestObservationCapabilityCannotWriteTombstones
--- PASS: TestObservationCapabilityCannotWriteTombstones (0.00s)
=== RUN   TestSafeResumeRecipeDropsPromptsAndSecrets
=== RUN   TestSafeResumeRecipeDropsPromptsAndSecrets/claude_fresh_becomes_resume
=== RUN   TestSafeResumeRecipeDropsPromptsAndSecrets/codex_flag_becomes_subcommand
=== RUN   TestSafeResumeRecipeDropsPromptsAndSecrets/terminal_stores_no_argv
--- PASS: TestSafeResumeRecipeDropsPromptsAndSecrets (0.00s)
    --- PASS: TestSafeResumeRecipeDropsPromptsAndSecrets/claude_fresh_becomes_resume (0.00s)
    --- PASS: TestSafeResumeRecipeDropsPromptsAndSecrets/codex_flag_becomes_subcommand (0.00s)
    --- PASS: TestSafeResumeRecipeDropsPromptsAndSecrets/terminal_stores_no_argv (0.00s)
=== RUN   TestActivityIsCoalescedAndOnlyTypedSourcesAdvanceRecency
--- PASS: TestActivityIsCoalescedAndOnlyTypedSourcesAdvanceRecency (0.00s)
=== RUN   TestCrashSimulationKill9WriterKeepsDatabaseValid
    store_test.go:237: SIGKILL mid-transaction: quick_check=ok committed_rows=1 uncommitted_rows=0 WAL reopen=ok
--- PASS: TestCrashSimulationKill9WriterKeepsDatabaseValid (0.47s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	0.788s
```

## Required gates

The cache was cleared first with `go clean -testcache`.

```text
$ CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go test -count=1 ./...
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	1.760s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	1.879s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.142s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.783s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	0.324s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	1.425s

$ GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)
```

No commit was created.
