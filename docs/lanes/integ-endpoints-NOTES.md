# INTEG-ENDPOINTS lane notes

## Delivered

- Added the authenticated, schema-versioned recall contract:
  - `GET /api/history`
  - `GET /api/history/:id?format=json|text`
  - `GET /api/history/:id/raw`
- History uses live sessions plus durable runner metadata and the existing
  backup/watch resolution rules. Claude canonical events are reduced to text
  turns; Codex rollout lines go through `internal/watch.NormalizeCodexRolloutLine`
  before reduction. Tool-only and lifecycle-only records do not inflate
  `message_count`.
- Added an append-only `<state-dir>/errors.jsonl` recorder with mode `0600`,
  durable monotonic `seq`, restart recovery, structured machine/session
  metadata, and `GET /api/errors?since=<seq>` paging through `nextSeq`.
- Integration polling attaches a read-only observer to live sessions. Nonzero
  or signaled exits emit `runner_exit`; unexpected connection loss emits
  `runner_lost`. Exited sessions in the daemon grace window are also
  reconciled. Caught recall filesystem/read failures emit `daemon_error`.
- Added the thin `pretty recall` list/normalized/raw client. The versioned HTTP
  shapes remain the integration contract.
- Added the complete consumer contract and example responses in
  `docs/INTEGRATIONS.md`. Nothing in this lane calls somewhere APIs or builds a
  somewhere MCP tool.

## Contract coverage

`internal/api/integrations_handlers_test.go` proves through `httptest`:

- normal route auth applies;
- `/api/history` returns the exact schema-versioned recall metadata fields;
- one fixture Claude conversation produces the asserted two-message normalized
  transcript, deterministic text form, and byte-identical raw response;
- two emitted errors return in append order with `nextSeq=2`, and `since=1`
  returns only sequence 2;
- `errors.jsonl` has two JSONL records and mode `0600`;
- a fake runner's exit code 17 emits exactly one `runner_exit` event;
- a tracked `runner_lost` terminal event is retained after the registry removes
  the live session.

`internal/integrations` tests additionally prove Codex watcher normalization,
message counting, and sequence continuation after reopening an existing error
log. `cmd/pretty/recall_test.go` proves list, JSON, text, and raw CLI forwarding.

## Real scratch-daemon acceptance

The daemon and CLI were built into
`/tmp/pretty-integ-endpoints.7fHY8Z`. The daemon used scratch-only HOME and
state, loopback port `18797`, and exact PID `8081`:

```text
SCRATCH_PID=8081
2026/07/17 00:07:35 prettyd listening on http://127.0.0.1:18797
```

An external-style request with `X-Forwarded-For` and no token was rejected;
the same request with the scratch daemon's generated bearer token succeeded:

```text
UNAUTHORIZED_STATUS=401
HISTORY_LIST=
{"schemaVersion":1,"sessions":[{"id":"22222222-3333-4444-8555-666666666666","name":"scratch acceptance","tool":"claude","message_count":2,"conversation_available":true}]}
TRANSCRIPT_JSON=
{"schemaVersion":1,"session":{"id":"22222222-3333-4444-8555-666666666666","message_count":2},"messages":[{"role":"user","text":"Scratch recall question","timestamp":"2026-07-16T17:01:00Z"},{"role":"assistant","text":"Scratch recall answer","timestamp":"2026-07-16T17:01:02Z"}]}
```

The text response included the version header and stable content:

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
X-Pretty-Schema-Version: 1

[user 2026-07-16T17:01:00Z]
Scratch recall question

[assistant 2026-07-16T17:01:02Z]
Scratch recall answer
```

The raw endpoint returned exact fixture bytes:

```text
RAW_SHA256=
48a99a376470ba02de86fec785dc905c24da00e1d56312e317361400557fd47f  -
```

Two deliberate scratch-file permission failures exercised the daemon's real
caught-error emission path. After restoring the fixture permission, the feed
and paging output were:

```text
CAUGHT_ERROR_1_STATUS=500
CAUGHT_ERROR_2_STATUS=500
ERROR_FEED_TWO_EVENTS=
{"schemaVersion":1,"errors":[{"seq":1,"kind":"daemon_error","session_id":null,"summary":"history transcript failed","machine":"MacBook-Pro-9.local"},{"seq":2,"kind":"daemon_error","session_id":null,"summary":"history transcript failed","machine":"MacBook-Pro-9.local"}],"nextSeq":2}
ERROR_FEED_SINCE_1=
{"schemaVersion":1,"errors":[{"seq":2,"kind":"daemon_error","summary":"history transcript failed"}],"nextSeq":2}
ERROR_LOG_MODE_AND_LINES=
600
2
```

The scratch CLI consumed the same endpoint successfully. The daemon was then
stopped only with `kill -TERM 8081`; its terminal output was:

```text
2026/07/17 00:08:19 prettyd: terminated received, shutting down
```

PID, port, and both exact scratch launchd labels were verified absent after
acceptance. The environment blocked direct recursive removal, so the exact
validated scratch root was moved recoverably to
`/Users/uzair/.Trash/pretty-integ-endpoints.7fHY8Z`.

No request was sent to `100.86.76.84`, no process or request touched port
`:8787`, and no process was killed by binary name.

## Final gates

Run from `prettygo/` on 2026-07-16 (America/Los_Angeles):

```text
$ CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go test ./... -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty              1.786s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api           5.104s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/backup        2.501s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/integrations  0.996s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/interop       7.705s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger        3.711s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror        0.251s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto         1.770s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/recovery      2.187s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session       2.741s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state         2.938s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/verdict       3.042s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/waitcond      8.951s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch         2.848s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets     2.623s
```

Lane-owned race proof:

```text
$ CGO_ENABLED=1 go test -race ./internal/integrations -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/internal/integrations  1.323s

$ CGO_ENABLED=1 go test -race ./internal/api -run 'TestHistoryRoutes|TestErrorsRoute' -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api  1.844s

$ CGO_ENABLED=1 go test -race ./cmd/pretty -run '^TestRecallCLIIsThinViewOfIntegrationEndpoints$' -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  1.498s
```

One preceding full-suite attempt and one broad race attempt encountered the
pre-existing `TestDaemonScratchLaunchdBootstrapHealthBootout` timing flake: macOS
briefly continued to report that test's exact scratch launchd label in
`SIGTERMed` state after bootout. Each exact scratch label was booted out and
verified absent; no binary-name kill was used. The clean full-suite rerun above
is the final gate result.

Final hygiene was also clean: `go mod tidy -diff`, `git diff --check`, the
owned-file trailing-whitespace scan, and `gofmt -l` all produced no diff/output.

No commit was created.
