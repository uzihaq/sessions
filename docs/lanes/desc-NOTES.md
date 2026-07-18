# DESC lane notes

Date: 2026-07-17

## Result

- Added `--description PURPOSE` and the `--desc` alias to `pretty new` and
  `pretty run`. Values are trimmed, empty purposes are rejected, and `run`
  continues to preserve every child argument after its first `--` separator.
- Added `description` and `description_source` to runner metadata, session API
  state, and CLI JSON. Explicit descriptions use source `explicit`, survive
  runner startup/discovery, and are part of the immutable ledger `created`
  payload and folded lane state.
- When no explicit purpose exists, the manager captures the first submitted
  input at the discrete Enter boundary, removes terminal escape sequences,
  folds whitespace, and keeps at most 80 Unicode characters. It updates runner
  metadata with source `first-message` and appends a typed
  `description_derived` ledger fact so retained closed records keep their
  cleanup context. Both the in-memory update and ledger fold refuse to replace
  an explicit description.
- Added a truncated `DESC` column to `pretty sessions`, `pretty lanes`, and
  `pretty ls`. This includes the unified `pretty sessions --mine` cleanup view.
  `pretty status` prints the full description, and JSON list/status output
  includes the description plus its source when known.
- Runner environment propagation keeps descriptions intact when the runner
  rewrites its canonical metadata file during startup.

## Tests

- CLI tests cover both flag spellings for both creation commands and prove that
  a child `--description` after `pretty run --` is not consumed.
- Session/ledger tests prove explicit metadata plus `created`-event persistence,
  first-message fallback persistence with `description_source=first-message`,
  ANSI/bracketed-paste cleanup, and explicit-over-fallback precedence.
- Cleanup-view tests cover human `sessions --mine`, `lanes`, `ls`, and full
  `status` output, plus JSON output for every list command and status.

## Verification

Run from `prettygo/`:

```text
CGO_ENABLED=0 go build ./...
PASS

CGO_ENABLED=0 go vet ./...
PASS

CGO_ENABLED=0 go test -count=1 ./...
PASS
```

No commit was created; all changes remain scratch worktree changes.
