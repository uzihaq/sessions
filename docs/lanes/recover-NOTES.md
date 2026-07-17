# RECOVER+ADOPT lane notes

## Result

Implemented ledger reconciliation, recovery, reopening, and explicit adoption
for the Go daemon and CLI.

- `internal/recovery` folds the append-only ledger and reconciles every known
  lane against manager-visible sessions, runner metadata, a bounded Unix-socket
  HELLO probe, read-only `launchctl print` status, and Claude/Codex conversation
  resolution. Reports contain the four required classes, anomalies, probe
  evidence, separate human/provider activity timestamps, a human-preferred tie
  break, and a recency-ranked safe recovery plan.
- `GET /api/recovery` serves the report. `POST /api/recovery/reopen` serializes
  recovery mutations, refuses missing/unbound recipes, skips a provider UUID
  that is already live, creates all other lost lanes through the manager's
  normal write-ahead boundary, and appends `reopened` facts. Once appended, the
  source lane folds to `closed`, making a subsequent reopen a no-op.
- `pretty recover` prints name, tool, cwd, last activity, and the minimal resume
  recipe. `pretty recover --reopen` invokes the server-side idempotent mutation
  and reports every reopened, skipped, blocked, or failed lane.
- `pretty adopt <path-or-uuid>` resolves only an explicit Claude JSONL or Codex
  rollout. UUID lookup uses the existing watch resolvers; ambiguous/missing
  sources and provider-unbound files are refused. The manager still writes the
  required pre-launch `created` event, then adoption appends auditable
  `created` and `provider_bound` facts with `actor=adopt`. A live copy of the
  same provider UUID is refused.
- Runtime-only runners with metadata plus HELLO/launchd evidence classify as
  `external`; conversation files alone are never auto-adopted.

The lane sheet named `cmd/pretty/commands.go` as the dispatch location, but the
current checkout's dispatch switch is in `cmd/pretty/app.go`. The only change
there is the two required `recover`/`adopt` case registrations; command logic is
contained in the two owned new files.

## Scratch isolation

All new acceptance state is rooted under `t.TempDir()`. Tests override `HOME`
and `PRETTY_LEDGER_PATH`, use scratch runner/LaunchAgent/conversation paths, and
use only the in-memory fake launcher. The end-to-end CLI tests replace `PATH`
with an empty temporary directory so `launchctl` cannot be found or invoked.
No default Pretty state directory or running daemon is consulted or mutated.

## Acceptance output

Run from `prettygo/`:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./cmd/pretty -run '^(TestRecoverCLIEndToEndAgainstScratchManager|TestAdoptCLIExplicitlyBindsScratchCodexConversation)$'
=== RUN   TestRecoverCLIEndToEndAgainstScratchManager
    recover_acceptance_test.go:99: scratch CLI plan_orphan=true first_reopen_launches=4 second_reopen="no unexpectedly-lost lanes" launchctl_path_excluded=true
--- PASS: TestRecoverCLIEndToEndAgainstScratchManager (0.03s)
=== RUN   TestAdoptCLIExplicitlyBindsScratchCodexConversation
    recover_acceptance_test.go:169: scratch adopt lane=af5300ff-097d-49bc-8277-e8496dd44582 launches=1 actor_created=true actor_bound=true duplicate_refused=true
--- PASS: TestAdoptCLIExplicitlyBindsScratchCodexConversation (0.01s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.534s
```

The first test creates three lanes through the real manager with a fake
launcher, tombstones one through `RequestKill`, deletes the orphan's runner
metadata and emits `runner_lost`, and leaves one live. It exercises the actual
HTTP routes through `pretty recover`, reopens exactly the orphan, then proves a
second `--reopen` makes no launch.

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/recovery
=== RUN   TestScratchRecoveryScenarioClassifiesAndReopensExactlyTheOrphan
    recovery_test.go:109: classes closed=closed orphan=unexpectedly-lost live=live-managed plan=1 reopened=b791191c-7c4d-4b55-bc95-bbede61b98a9 launches=4 second_outcomes=0
--- PASS: TestScratchRecoveryScenarioClassifiesAndReopensExactlyTheOrphan (0.03s)
=== RUN   TestExplicitAdoptResolvesCodexPathAndWritesAdoptActors
    recovery_test.go:175: adopt path=/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestExplicitAdoptResolvesCodexPathAndWritesAdoptActors2123318988/001/.codex/sessions/2026/07/16/rollout-2026-07-16T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl provider=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee cwd=/var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T/TestExplicitAdoptResolvesCodexPathAndWritesAdoptActors2123318988/001/workspace lane=451e61ac-6612-4304-8aff-159f51bf3b92 actor_created=true actor_bound=true
--- PASS: TestExplicitAdoptResolvesCodexPathAndWritesAdoptActors (0.01s)
=== RUN   TestRealityProbesClassifyRuntimeOnlyRunnerAsExternal
    recovery_test.go:216: external=external metadata=true socket=true hello=true launchd_loaded=true launchd_running=false
--- PASS: TestRealityProbesClassifyRuntimeOnlyRunnerAsExternal (0.00s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	0.564s
```

## Required gates

Both commands exited 0 with no output:

```text
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
```

```text
$ CGO_ENABLED=0 go test -count=1 ./...
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	1.751s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	2.265s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	2.416s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.068s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.785s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.410s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	2.191s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.912s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.099s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	0.925s
```

No commit was created.
