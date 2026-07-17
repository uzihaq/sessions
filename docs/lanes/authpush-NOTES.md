# AUTHPUSH lane notes

Date: 2026-07-16

## Result

- Auth stays loopback-exempt and fail-closed for non-loopback peers. Bearer and query tokens work, the `open` file remains the explicit escape hatch, and any `X-Forwarded-For` header defeats the loopback exemption.
- The daemon now generates its 64-character token while the API server is constructed, even when `open` exists, so a fresh daemon makes `pretty token` usable without first receiving a remote request. Existing valid token files are repaired to mode `0600`.
- The WebSocket upgrade uses the same authorization gate. The acceptance test proves an XFF-marked connection is rejected without a token and upgraded with the query token.
- The CLI token helper is isolated in `cmd/pretty/token.go` and prints the daemon token verbatim.
- Push routes generate/persist VAPID keys, persist subscriptions, and remove subscriptions. Mock push endpoints receive real `POST` requests with VAPID authorization and `aes128gcm` bodies.
- The push acceptance tests decrypt the received RFC 8291 payload with the test subscription private key. They prove the working-to-idle 🟢/🟡/🔴 titles and the 🔴 lane-death notification, rather than only checking that an opaque request arrived.

## Safety

- No real daemon was launched.
- No request was made to `100.86.76.84` or to port `8787`.
- HTTP and WebSocket tests used `httptest` loopback listeners on OS-assigned ephemeral ports.
- State, VAPID keys, subscriptions, tokens, runner metadata, and binaries used by tests were confined to Go test temporary directories.
- No daemon or runner process was killed.

## Focused acceptance output

Command:

```text
CGO_ENABLED=0 go test ./internal/api ./cmd/pretty -run 'Test(AuthAndOriginMatrix|TokenCreationAndJSONBodyLimit|WebSocketSingleMuxAndHandshakePolicy|PushRoutesPersistAndRemoveSubscriptions|WorkingToIdleSendsEncryptedPushToMock|WorkingToIdleNotificationShapes|LaneDeathSendsEncryptedPushToMock|TokenCommandPrintsDaemonToken)$' -count=1 -v -timeout=30s
```

Output:

```text
=== RUN   TestPushRoutesPersistAndRemoveSubscriptions
--- PASS: TestPushRoutesPersistAndRemoveSubscriptions (0.00s)
=== RUN   TestWorkingToIdleSendsEncryptedPushToMock
--- PASS: TestWorkingToIdleSendsEncryptedPushToMock (0.08s)
=== RUN   TestWorkingToIdleNotificationShapes
=== RUN   TestWorkingToIdleNotificationShapes/done
=== RUN   TestWorkingToIdleNotificationShapes/blocked
=== RUN   TestWorkingToIdleNotificationShapes/error
--- PASS: TestWorkingToIdleNotificationShapes (0.10s)
    --- PASS: TestWorkingToIdleNotificationShapes/done (0.03s)
    --- PASS: TestWorkingToIdleNotificationShapes/blocked (0.03s)
    --- PASS: TestWorkingToIdleNotificationShapes/error (0.03s)
=== RUN   TestLaneDeathSendsEncryptedPushToMock
--- PASS: TestLaneDeathSendsEncryptedPushToMock (0.01s)
=== RUN   TestAuthAndOriginMatrix
=== RUN   TestAuthAndOriginMatrix/no_token
=== RUN   TestAuthAndOriginMatrix/bearer_token
=== RUN   TestAuthAndOriginMatrix/query_token
=== RUN   TestAuthAndOriginMatrix/loopback_exempt
=== RUN   TestAuthAndOriginMatrix/xff_defeats_exemption
=== RUN   TestAuthAndOriginMatrix/evil_origin_not_echoed
=== RUN   TestAuthAndOriginMatrix/hosted_site_allowed
=== RUN   TestAuthAndOriginMatrix/hosted_tech_allowed
=== RUN   TestAuthAndOriginMatrix/open_escape_hatch
--- PASS: TestAuthAndOriginMatrix (0.00s)
    --- PASS: TestAuthAndOriginMatrix/no_token (0.00s)
    --- PASS: TestAuthAndOriginMatrix/bearer_token (0.00s)
    --- PASS: TestAuthAndOriginMatrix/query_token (0.00s)
    --- PASS: TestAuthAndOriginMatrix/loopback_exempt (0.00s)
    --- PASS: TestAuthAndOriginMatrix/xff_defeats_exemption (0.00s)
    --- PASS: TestAuthAndOriginMatrix/evil_origin_not_echoed (0.00s)
    --- PASS: TestAuthAndOriginMatrix/hosted_site_allowed (0.00s)
    --- PASS: TestAuthAndOriginMatrix/hosted_tech_allowed (0.00s)
    --- PASS: TestAuthAndOriginMatrix/open_escape_hatch (0.00s)
=== RUN   TestTokenCreationAndJSONBodyLimit
--- PASS: TestTokenCreationAndJSONBodyLimit (0.01s)
=== RUN   TestWebSocketSingleMuxAndHandshakePolicy
--- PASS: TestWebSocketSingleMuxAndHandshakePolicy (0.00s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	0.451s
=== RUN   TestTokenCommandPrintsDaemonToken
--- PASS: TestTokenCommandPrintsDaemonToken (0.00s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.670s
```

## Gates

```text
$ CGO_ENABLED=0 go build ./...
(no output; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no output; exit 0)
```

Full-suite command:

```text
CGO_ENABLED=0 go test ./... -count=1
```

Full-suite output:

```text
ok  	github.com/uzihaq/pretty-pty/prettygo/cmd/pretty	0.797s
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	4.058s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/backup	0.823s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/interop	4.354s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/ledger	3.345s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.207s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	1.536s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/recovery	1.764s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/session	1.934s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	2.080s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/verdict	2.265s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/waitcond	4.477s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	2.525s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/webassets	1.918s
```

No commit was created.
