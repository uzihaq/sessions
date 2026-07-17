# MOVE lane notes

Implemented `pretty move <session> --to <target-endpoint> [--token T] [--dry-run] [--allow-dirty]` as resume-elsewhere, not process migration.

## Behavior and contract

- The source daemon supplies live session metadata; the local append-only ledger supplies the provider UUID and minimal safe resume recipe.
- Claude JSONL and Codex rollout files are resolved through `internal/watch`, transferred to authenticated `POST /api/migrate/receive`, and installed with `0700` directories and a `0600` create-exclusive file. Repeating identical receipt is safe; a different existing conversation is never overwritten.
- The target creates a new session from the transferred resume recipe. The source is left running and the CLI prints the exact follow-up kill command.
- A Git cwd must have a branch/upstream and a remotely reachable revision. Clean moves verify the remote branch directly with `git ls-remote`. `--allow-dirty` snapshots tracked and untracked work through a temporary Git index, creates and pushes `refs/pretty/checkpoints/<session>-<time>`, and does not change the source index, worktree, or HEAD.
- The target may clone/check out the reported remote revision when the absolute Git root is absent. An existing checkout must already be at that exact revision; move refuses to mutate a mismatched existing workspace. For v1, the target must be able to reach the same Git remote. Repository bytes are never sent by move. A non-Git cwd must already exist on the target.
- The ledger enum and writer support `moved_to` and `moved_from`. A successful command durably writes source `moved_to` with the target endpoint, new lane ID, and optional checkpoint ref. No move path kills the source.

## Focused safety output

Command:

```text
go test ./internal/migrate ./internal/ledger ./internal/api ./cmd/pretty
```

Output:

```text
ok  github.com/uzihaq/pretty-pty/prettygo/internal/migrate
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
```

The migration package tests cover Claude source resolution and idempotent receipt, dated Codex receipt, refusal to overwrite different conversation bytes, additive move ledger facts, and a real local bare-remote dirty checkpoint. The checkpoint test verified the source still reported both `M tracked.txt` and `?? untracked.txt`, while the pushed checkpoint commit contained both dirty files.

## Required gates

Run from `prettygo/` on 2026-07-16:

```text
CGO_ENABLED=0 go build ./...
go vet ./...
go test ./...
```

Build and vet exited 0 with no diagnostics. Full-suite output:

```text
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger
ok  github.com/uzihaq/pretty-pty/prettygo/internal/migrate
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state
ok  github.com/uzihaq/pretty-pty/prettygo/internal/verdict
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets
```

## Real two-daemon scratch acceptance

Fresh static `pretty`, `prettyd`, and `runner` binaries were built under `/tmp/pretty-move-acceptance.4wFSS5`. Two Go daemons used separate homes, runner state, and ledgers on loopback ports `19341` and `19342`. No request or process touched port `8787` or `100.86.76.84`.

A source `/bin/bash` session named `move-acceptance` was created on daemon A with `MOVE_MARKER` in its non-Git cwd. Actual move output:

```text
moved 08da241d-6ac8-4704-92e5-aa6268fc7663 to http://127.0.0.1:19342 as 170d8e0d-a98c-4224-ac3a-befeced1a417
workspace: non-Git cwd was already present on the target
conversation: 0 bytes transferred
source still live; kill with pretty kill 08da241d-6ac8-4704-92e5-aa6268fc7663 once verified
```

Assertions and observed output:

```text
source_id=08da241d-6ac8-4704-92e5-aa6268fc7663 source_live=true
target_id=170d8e0d-a98c-4224-ac3a-befeced1a417 target_live=true
target_marker=TARGET_MARKER_OK
target_metadata=name:move-acceptance,cwd:/tmp/pretty-move-acceptance.4wFSS5/workspace,cmd:/bin/bash
source_ledger=moved_to|http://127.0.0.1:19342|170d8e0d-a98c-4224-ac3a-befeced1a417
```

Cleanup used the two exact scratch session IDs and captured daemon PIDs `6821` and `6822`. Post-cleanup verification:

```text
port 19341 closed
port 19342 closed
pid 6821 exited
pid 6822 exited
source_label_gone
target_label_gone
```
