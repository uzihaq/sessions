# FUZZ-2 notes — ledger/recovery/state adversarial hardening

Date: 2026-07-17

Scope stayed inside `prettygo/internal/ledger`, `prettygo/internal/recovery`, and
`prettygo/internal/state`. No session production files were edited. No commits
were created, no assertions were weakened, and the owned package tests contain
no `t.Skip`/`t.Skipf`/`SkipNow`.

## Product bugs found and fixed

1. **A terminal lane could become `ManagedActive` again.** A late
   `runner_ready` or `attached` observation unconditionally set
   `ManagedActive=true` after a user-kill, exit, reap, or reopen. A valid
   `reopened` event also failed to clear the bit. `Fold` now gates activation on
   all monotonic terminal facts and clears it on reopen. Regression corpus:
   `internal/ledger/testdata/fuzz/FuzzEventFold/tombstone-late-observations`.
2. **A tombstone could lose classification precedence when the created fact was
   missing/corrupt.** `ClassifyLane` checked `!Created && Running` before the
   terminal predicate, classifying the lane as `external` despite
   `UserKillRequested=true`. The fuzzer minimized this to corpus seed
   `internal/ledger/testdata/fuzz/FuzzEventFold/cef84461e8eb95eb` (`"1B0000"`).
   Terminal state now precedes external-runtime classification, remains closed,
   and cannot enter a recovery plan.
3. **Syntactically valid non-metadata was accepted by the state parser.** JSON
   such as `null` or `{}` returned a zero `RunnerMetadata` with no error.
   `parseRunnerMetadata` now requires a nonblank runner ID, so discovery skips
   these entries just like malformed/truncated JSON. Regression corpus:
   `internal/state/testdata/fuzz/FuzzRunnerMetadataParse/null-metadata`.

## Adversarial coverage added

- `FuzzEventFold` generates up to 64 events with out-of-order input, unique
  sequence positions, duplicate event IDs, unknown types, malformed or arbitrary
  payload bytes, negative/out-of-order timestamps, and tombstone/reopen/late
  observation combinations. It proves repeat determinism, input immutability,
  sequence-order independence, stable unique lane output, deterministic
  classification/planning, terminal-state monotonicity, and tombstone exclusion
  from recovery.
- `TestConcurrentObservationsAndUserKillLoseNoWrites` races 16 goroutines x 32
  observational writes with one user-kill transaction. It verifies every one of
  the 514 expected rows, event-ID uniqueness, a permanently closed fold, and an
  empty recovery plan.
- `TestRecoveryClassificationPropertiesRandomFleets` uses deterministic seed
  `0xf0225eed` for 2,000 random fleets. Every fleet includes live, tombstoned,
  orphaned, and external lanes. Classification must match the model, the plan
  must contain exactly the orphaned lanes, and appending durable `reopened`
  facts must make repeated recovery a no-op.
- `FuzzRunnerMetadataParse` covers valid, truncated, `null`, wrong-shape, and
  arbitrary metadata. It proves deterministic parsing, invalid-JSON rejection,
  and nonblank IDs on every success.
- `TestDiscoveryStressConcurrentFakeRunnersSkipsTruncatedMetadata` materializes
  96 fake runners concurrently while discovery scans. Writers expose truncated
  metadata before publishing the final document. All 96 valid runners attach;
  the permanent malformed runner is skipped and its sacred state remains.
- `TestCrashSimulationKill9WriterKeepsDatabaseValid` builds a helper, opens a
  real SQLite transaction in WAL/FULL mode, inserts without committing, and is
  forcibly killed. Both the already-open store and a fresh reopen pass
  `PRAGMA quick_check`; the committed baseline survives and the uncommitted row
  does not.

## Gate evidence

### Race

Command:

```text
go test ./internal/{ledger,recovery,state} -race -count=1
```

Output:

```text
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger   3.204s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery 6.539s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state    2.361s
```

### CGO-disabled build and vet

Commands:

```text
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
```

Both exited 0 with no output.

### Ledger fold fuzz — 45 seconds

Command:

```text
CGO_ENABLED=0 go test ./internal/ledger -run='^$' -fuzz='^FuzzEventFold$' -fuzztime=45s
```

Output:

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/3 completed
fuzz: elapsed: 0s, gathering baseline coverage: 3/3 completed, now fuzzing with 11 workers
fuzz: elapsed: 3s, execs: 74071 (24676/sec), new interesting: 123 (total: 126)
fuzz: elapsed: 6s, execs: 74071 (0/sec), new interesting: 123 (total: 126)
fuzz: elapsed: 9s, execs: 126156 (17373/sec), new interesting: 124 (total: 127)
fuzz: elapsed: 12s, execs: 126156 (0/sec), new interesting: 124 (total: 127)
fuzz: elapsed: 15s, execs: 179281 (17709/sec), new interesting: 130 (total: 133)
fuzz: elapsed: 18s, execs: 249955 (23567/sec), new interesting: 135 (total: 138)
fuzz: elapsed: 21s, execs: 391542 (47172/sec), new interesting: 141 (total: 144)
fuzz: elapsed: 24s, execs: 571956 (60178/sec), new interesting: 149 (total: 152)
fuzz: elapsed: 27s, execs: 571956 (0/sec), new interesting: 149 (total: 152)
fuzz: elapsed: 30s, execs: 649016 (25689/sec), new interesting: 151 (total: 154)
fuzz: elapsed: 33s, execs: 793417 (48115/sec), new interesting: 158 (total: 161)
fuzz: elapsed: 36s, execs: 809643 (5409/sec), new interesting: 162 (total: 165)
fuzz: elapsed: 39s, execs: 1019417 (69930/sec), new interesting: 167 (total: 170)
fuzz: elapsed: 42s, execs: 1166858 (49141/sec), new interesting: 177 (total: 180)
fuzz: elapsed: 45s, execs: 1307656 (46959/sec), new interesting: 190 (total: 193)
fuzz: elapsed: 46s, execs: 1307656 (0/sec), new interesting: 190 (total: 193)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger  46.503s
```

### Runner metadata fuzz — 45 seconds

Command:

```text
CGO_ENABLED=0 go test ./internal/state -run='^$' -fuzz='^FuzzRunnerMetadataParse$' -fuzztime=45s
```

Output:

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/4 completed
fuzz: elapsed: 0s, gathering baseline coverage: 4/4 completed, now fuzzing with 11 workers
fuzz: elapsed: 3s, execs: 168956 (56310/sec), new interesting: 107 (total: 111)
fuzz: elapsed: 6s, execs: 310724 (47261/sec), new interesting: 154 (total: 158)
fuzz: elapsed: 9s, execs: 494729 (61337/sec), new interesting: 182 (total: 186)
fuzz: elapsed: 12s, execs: 670451 (58571/sec), new interesting: 197 (total: 201)
fuzz: elapsed: 15s, execs: 836984 (55479/sec), new interesting: 209 (total: 213)
fuzz: elapsed: 18s, execs: 956649 (39887/sec), new interesting: 216 (total: 220)
fuzz: elapsed: 21s, execs: 1130613 (58026/sec), new interesting: 225 (total: 229)
fuzz: elapsed: 24s, execs: 1313090 (60802/sec), new interesting: 238 (total: 242)
fuzz: elapsed: 27s, execs: 1495786 (60923/sec), new interesting: 248 (total: 252)
fuzz: elapsed: 30s, execs: 1672906 (59037/sec), new interesting: 261 (total: 265)
fuzz: elapsed: 33s, execs: 1861030 (62709/sec), new interesting: 274 (total: 278)
fuzz: elapsed: 36s, execs: 2008214 (49041/sec), new interesting: 281 (total: 285)
fuzz: elapsed: 39s, execs: 2105724 (32515/sec), new interesting: 285 (total: 289)
fuzz: elapsed: 42s, execs: 2203970 (32751/sec), new interesting: 287 (total: 291)
fuzz: elapsed: 45s, execs: 2302484 (32837/sec), new interesting: 290 (total: 294)
fuzz: elapsed: 45s, execs: 2302484 (0/sec), new interesting: 290 (total: 294)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state  45.594s
```

### Crash, concurrency, property, and discovery proof

Commands were run with `CGO_ENABLED=0`, `-count=1`, and `-v`.

```text
TestCrashSimulationKill9WriterKeepsDatabaseValid:
SIGKILL mid-transaction: quick_check=ok committed_rows=1 uncommitted_rows=0 WAL reopen=ok

TestConcurrentObservationsAndUserKillLoseNoWrites:
concurrent_appends=514 observers=16 tombstones=1 lost_writes=0 class=closed

TestRecoveryClassificationPropertiesRandomFleets:
seed=0xf0225eed fleets=2000 classes=4 plan=orphan-only repeated_recover=no-op

TestDiscoveryStressConcurrentFakeRunnersSkipsTruncatedMetadata:
concurrent_fake_runners=96 discovered=96 malformed_skipped=1 transient_scans=2
```
