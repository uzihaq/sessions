# Lane: VERDICT+STATUS — implementation notes

## Delivered

- Added an explicit producer protocol in `prettygo/internal/verdict`. Pretty does
  not inspect terminal output, event prose, or model messages for verdicts.
- `pretty verdict emit <session-or-lane-id> --json '{...}'` accepts an inline
  document; omitting the document reads it from stdin. Unknown or duplicate
  fields, unsupported schema versions, empty required strings, malformed
  findings, non-object metadata, null collections, and trailing JSON are
  rejected.
- Accepted records are appended to
  `<runner-state-dir>/<id>.verdicts.jsonl` with a server-assigned monotonic
  `seq` and RFC 3339 `emitted_at`. The directory is never re-permissioned when
  caller-owned; the JSONL file is held at mode `0600`.
- Every accepted record appends a `type=verdict`, `actor=provider` lane-ledger
  row whose complete payload is `{}`. Verdict text, findings, metadata, and the
  JSONL path are not copied into SQLite.
- Added authenticated `GET` and `POST /api/sessions/:id/verdict`. The route also
  accepts safe ledger-only lane IDs; it does not require the lane to still be
  live in the in-memory session registry.
- `pretty verdict <id>` returns the last complete JSONL record, so three emits
  return sequence 3 rather than the first or an arbitrary record.
- `pretty status <id> --json` emits `id`, `name`, `kind`, `tool`, `state`,
  optional `exit_code`, `cwd`, Git branch/HEAD/dirty count (or `null` outside a
  repository), an optional latest-verdict summary, activity and creation times,
  and `age_ms`. Human output is the same information as a compact card.

## Real scratch acceptance output

The acceptance creates a session through the real session manager and HTTP
handler with an in-memory scratch runner. `HOME`, runner state, ledger, plist
directory, and repository are all under `testing.T.TempDir`; the Git repository
contains one modified tracked file and one untracked file. It talks only to an
`httptest` server. It does not inspect, signal, restart, or send a request to an
installed/running Pretty daemon, and it never invokes `launchctl`.

Focused command:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/verdict ./cmd/pretty -run 'TestDecodeRejectsJunk|TestLatestWinsAcrossThreeEmitsAndLedgerContainsOnlyPointers|TestStatusJSONFieldTableAgainstRealScratchSession'
=== RUN   TestDecodeRejectsJunk
--- PASS: TestDecodeRejectsJunk (0.00s)
=== RUN   TestLatestWinsAcrossThreeEmitsAndLedgerContainsOnlyPointers
    latest seq=3 verdict=pass jsonl_lines=3 ledger_pointer_payload={}
--- PASS: TestLatestWinsAcrossThreeEmitsAndLedgerContainsOnlyPointers (0.04s)
=== RUN   TestStatusJSONFieldTableAgainstRealScratchSession
    scratch session=f2a910e4-ee54-441d-be14-23280326df90 field_table=[age_ms created_at cwd git id kind last_activity_at last_verdict name state tool] git_branch=master git_head=6669ebb340d7474b48760b697f46e3f46d1deac4 dirty_count=2 verdict=pass seq=1
--- PASS: TestStatusJSONFieldTableAgainstRealScratchSession (0.10s)
PASS
```

A subsequent uncached status-only run returned this producer record:

```json
{
  "schemaVersion": 1,
  "verdict": "pass",
  "findings": [
    {
      "severity": "info",
      "title": "scratch gate"
    }
  ],
  "meta": {
    "producer": "acceptance"
  },
  "seq": 1,
  "emitted_at": "2026-07-17T01:06:18.777269Z"
}
```

Status output from that scratch session:

```json
{
  "id": "f76d1a90-47af-4b5e-887b-116fad6b3700",
  "name": "status scratch",
  "kind": "session",
  "tool": "terminal",
  "state": "idle",
  "cwd": "<testing.T.TempDir>/work",
  "git": {
    "branch": "master",
    "head": "d90b960aadde753dd19689e9f1a1a0190211f45e",
    "dirty_count": 2
  },
  "last_verdict": {
    "verdict": "pass",
    "seq": 1,
    "emitted_at": "2026-07-17T01:06:18.777269Z",
    "finding_count": 1
  },
  "last_activity_at": "2026-07-17T01:06:18.777269Z",
  "created_at": "2026-07-17T01:06:18.771Z",
  "age_ms": 31
}
```

`<testing.T.TempDir>` abbreviates only the randomized scratch prefix. The
acceptance asserts the actual absolute path before logging the field table.

## Gates

```text
$ CGO_ENABLED=0 go build ./...
(no output; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no output; exit 0)

$ CGO_ENABLED=0 go test ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger
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

No commit was created.
