# WAIT lane acceptance notes

## Result

Implemented observation-only wake conditions for the Go CLI:

- `pretty wait <id> --until commit [--timeout DUR] [--json]` snapshots the
  session worktree's `HEAD`, treats `<gitdir>/logs/HEAD` notifications as wake
  hints, retains a five-second polling fallback, and reports forward commits
  and rewritten history;
- `--until-file-contains FILE STRING` searches literal bytes with an 8 MiB read
  cap, reopens the path on every observation, and survives append, delete, and
  replacement;
- `--until-idle-stable DUR` requires an uninterrupted observed idle window and
  labels the daemon evidence as `structured` for Codex/Claude or `heuristic`
  for raw terminals;
- `--any` accepts multiple session ids, multiple conditions, or paired ids and
  conditions, cancels losing observers, and returns the first winner.

The CLI resolves cwd from the daemon first. If the daemon is unavailable, it
reads the existing runner metadata without mutation; commit/file waits then no
longer depend on daemon liveness. Exit status is 0 for satisfaction, 2 for
timeout, and 1 for invalid inputs or unavailable sessions/repositories.

## Safety and isolation

No default Pretty state directory or running daemon was read or changed.

- CLI fallback tests set `HOME` and `PRETTYD_STATE_DIR` to `t.TempDir()` and
  deliberately use loopback port 1 (daemon unavailable).
- Idle API tests use only `httptest` servers and in-memory fake runners.
- Git and file acceptance uses only Go `t.TempDir()` roots.
- Every full gate below set both `HOME` and `PRETTYD_STATE_DIR` to a fresh
  `/tmp/pretty-wait-*.XXXXXX` root. No launchd command was invoked.

## Real condition acceptance output

Fresh `CGO_ENABLED=0` output from real Git subprocesses and scratch files:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/waitcond -run 'TestCommit|TestFileContains|TestWaitAny'
=== RUN   TestCommitFiresOnRealCommit
    waitcond_test.go:34: commit wait: baseline=55a65df999b53b3a609a5067b70a3f299625f604 commit=fef34ad4e103a58ea608b85c02f8a0fc048517b1 subject="real second commit" history_rewritten=false
--- PASS: TestCommitFiresOnRealCommit (0.25s)
=== RUN   TestCommitFlagsForceResetHistoryRewrite
    waitcond_test.go:59: force reset: baseline=5bb833adcd7463f9cdf6431706af8d8ee190bdc5 commit=55a65df999b53b3a609a5067b70a3f299625f604 subject="initial" history_rewritten=true
--- PASS: TestCommitFlagsForceResetHistoryRewrite (0.20s)
=== RUN   TestFileContainsAppendAndRecreate
=== RUN   TestFileContainsAppendAndRecreate/append
    waitcond_test.go:90: append observed: session=append-session file=/var/folders/.../status.log literal="READY"
=== RUN   TestFileContainsAppendAndRecreate/delete-and-recreate
    waitcond_test.go:114: recreate observed: session=recreate-session file=/var/folders/.../status.log literal="DONE"
--- PASS: TestFileContainsAppendAndRecreate (0.26s)
    --- PASS: TestFileContainsAppendAndRecreate/append (0.10s)
    --- PASS: TestFileContainsAppendAndRecreate/delete-and-recreate (0.15s)
=== RUN   TestWaitAnyReturnsFirstSatisfiedCondition
    waitcond_test.go:169: --any winner: session=second condition=file_contains
--- PASS: TestWaitAnyReturnsFirstSatisfiedCondition (0.10s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond  1.303s
```

The end-to-end test builds `cmd/pretty` with `CGO_ENABLED=0` into a temporary
directory and executes that real binary with scratch metadata and state:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/waitcond -run TestPrettyWaitCLIEndToEnd
=== RUN   TestPrettyWaitCLIEndToEnd
=== RUN   TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset
    cli_e2e_test.go:56: commit JSON: {"session":"commit-fallback-session","cwd":"/var/folders/.../001","baseline":"eebad541a0d0f28b1e70c578118d569af651ec4c","commit":"e7f9d97027d43fa6e3dbe405f5907658e201132e","subject":"CLI real commit","elapsed_ms":816,"history_rewritten":false}
    cli_e2e_test.go:69: timeout exit=2 JSON: {"ok":false,"reason":"timeout","elapsed_ms":121,"conditions":1}
    cli_e2e_test.go:90: force-reset JSON: {"session":"commit-fallback-session","cwd":"/var/folders/.../001","baseline":"e7f9d97027d43fa6e3dbe405f5907658e201132e","commit":"eebad541a0d0f28b1e70c578118d569af651ec4c","subject":"initial","elapsed_ms":1036,"history_rewritten":true}
=== RUN   TestPrettyWaitCLIEndToEnd/any_returns_second_session
    cli_e2e_test.go:119: --any JSON: {"session":"second-session","cwd":"/var/folders/.../001","file":"/var/folders/.../001/second.log","contains":"SECOND WON","elapsed_ms":91}
=== RUN   TestPrettyWaitCLIEndToEnd/idle_stable_labels_structured_evidence
    cli_e2e_test.go:157: idle-stable JSON: {"session":"idle-session","cwd":"/var/folders/.../001","idle_stable_ms":80,"elapsed_ms":81,"source":"structured"}
--- PASS: TestPrettyWaitCLIEndToEnd (2.91s)
    --- PASS: TestPrettyWaitCLIEndToEnd/commit_metadata_fallback_timeout_and_force_reset (2.33s)
    --- PASS: TestPrettyWaitCLIEndToEnd/any_returns_second_session (0.10s)
    --- PASS: TestPrettyWaitCLIEndToEnd/idle_stable_labels_structured_evidence (0.10s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond  3.293s
```

The displayed `/var/folders/...` abbreviation only shortens ephemeral
`t.TempDir()` paths; hashes, JSON fields, values, exit status, and timings are
copied from the real run.

## CGO-disabled gates

Each command used a fresh scratch `gate_root`, with:

```text
HOME="$gate_root/home"
PRETTYD_STATE_DIR="$gate_root/runners"
CGO_ENABLED=0
```

Build and vet both exited 0 with no stdout/stderr:

```text
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
```

Fresh full-suite output:

```text
$ CGO_ENABLED=0 go test -count=1 ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.497s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api  2.567s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger  2.351s
?   github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror  0.909s
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto  1.042s
?   github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  0.905s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state  1.346s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond  6.082s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch  2.205s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets  1.923s
```
