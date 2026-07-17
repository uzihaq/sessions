# INTEG3 lane notes

Date: 2026-07-17

## Result

- Merged `go-integ-endpoints` (`d646073`) into `go-integ3` at `09e06fd`
  with `--no-commit`.
- The incoming handler, integration-service, CLI, test, and documentation files
  merged cleanly. The only conflict was the expected constructor seam in
  `prettygo/internal/api/server.go`.
- Resolved that seam by retaining current HEAD's eager token initialization and
  push service/routes while adding the incoming integrations service and route
  dispatch.
- No commit was created; the repository remains in a resolved merge state for
  reviewer inspection and commit.

## Route seam

The resolved server retains the authpush routes:

- `GET /api/push/vapid`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`

It also initializes `integrations.Service` and dispatches the integration
routes after the existing move and backup dispatchers:

- `GET /api/history`
- `GET /api/history/{id}` in JSON or text format
- `GET /api/history/{id}/raw`
- `GET /api/errors` with `since` paging

The normal authorization gate still runs before either route family. Route
inspection found one integrations dispatcher registration and one registration
for each push path, with no dropped authpush route or duplicate route path.

## Verification

Run from `prettygo/` with CGO disabled:

```text
$ CGO_ENABLED=0 go build ./...
(no output; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no output; exit 0)

$ CGO_ENABLED=0 go test ./... -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty              2.053s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api           5.643s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/backup        1.296s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/integrations  3.266s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/interop       7.217s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger        5.159s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/migrate       3.109s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror        2.455s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto         1.676s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/recovery      0.633s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session       2.111s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state         2.943s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/verdict       2.789s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/waitcond      5.527s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch         2.935s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets     2.670s
```

Focused integration API coverage:

```text
$ CGO_ENABLED=0 go test ./internal/api -run 'TestHistoryRoutes|TestErrorsRoute' -count=1 -v
--- PASS: TestHistoryRoutesExposeStableListTranscriptTextAndRawShapes (0.00s)
--- PASS: TestErrorsRouteReturnsDurablePagingFeed (0.01s)
--- PASS: TestErrorsRouteObservesNonzeroRunnerExitOnce (0.01s)
--- PASS: TestErrorsRouteTracksRunnerLostAfterInitialPoll (0.01s)
PASS
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api  0.352s

$ CGO_ENABLED=0 go test ./internal/integrations -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/internal/integrations  0.253s
```

Existing authpush regression command:

```text
$ CGO_ENABLED=0 go test ./internal/api ./cmd/pretty -run 'Test(AuthAndOriginMatrix|TokenCreationAndJSONBodyLimit|WebSocketSingleMuxAndHandshakePolicy|PushRoutesPersistAndRemoveSubscriptions|WorkingToIdleSendsEncryptedPushToMock|WorkingToIdleNotificationShapes|LaneDeathSendsEncryptedPushToMock|TokenCommandPrintsDaemonToken)$' -count=1 -timeout=30s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api  0.915s
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty   0.499s
```
