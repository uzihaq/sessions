# INTEGRATE lane notes

## Result

Integrated the `go-daemon` API, state registry, configuration, launchd plist,
and `cmd/prettyd` work onto the merged Go tree without replacing or weakening
the interop-proven runner frame codec in `internal/proto/proto.go`.

The daemon now uses the real pieces end to end:

- `internal/proto/client.go` connects to each runner Unix socket, requires the
  server-first `HELLO`, decodes canonical `OUTPUT`/`EXIT`/`REPLAY_DONE` frames,
  and writes canonical `INPUT`/`RESIZE`/`REPLAY_REQ`/`KILL` frames.
- Sequence numbers at the socket boundary remain `uint32`, matching the
  canonical four-byte big-endian wire field. Protocol-version mismatches are
  logged but still attach, matching the TypeScript interoperability rule.
- Create writes the runner metadata and launchd plist, bootstraps the configured
  Go runner, waits for its real socket, attaches, and backfills with
  `REPLAY_REQ(0)`. Discovery attaches the same socket client and never deletes
  an unreachable session's state.
- `cmd/prettyd` uses the launchd-backed launcher. `PRETTYD_RUNNER` selects an
  explicit runner binary; otherwise a side-by-side `runner` binary is preferred.
  Clean runner exit is booted out of launchd so no stale service registration
  remains.
- Every daemon session owns an `internal/mirror.Mirror` sized from `HELLO`.
  Replay and live output feed the same mirror under the session lock. HTTP and
  WebSocket snapshots now use `SerializeANSI` or `ReflowTo`, and resize keeps
  the runner PTY and daemon mirror in lockstep.
- The daemon branch's auth/origin matrix, route lifecycle, WebSocket, config,
  and discovery tests remain present. Their snapshot expectations now assert
  the real mirror's width-aware reflow output instead of the fake runner's
  placeholder string.

## All-Go round trip

`TestGoDaemonRunnerMirrorRoundTrip` builds `cmd/runner` with `CGO_ENABLED=0`,
starts the Go HTTP daemon on an ephemeral loopback port with a scratch registry,
executes that runner for `/bin/bash -i`, creates the session through HTTP, sends
`echo E2E_$RANDOM`, polls the mirror-backed snapshot for the expanded marker,
and kills the session through HTTP before asserting the runner `EXIT` arrived.

The test uses a short `/tmp/prettygo-e2e-*` root so the UUID socket remains
under Darwin's Unix-socket path limit. State, plist, process log, built runner,
and working directory all stay under that scratch root. Cleanup shuts down only
the HTTP server and runner process created by the test, then removes the root.
It never reads or writes the default Pretty state and never starts a real user
daemon or launchd service.

Fresh verbose proof:

```text
$ CGO_ENABLED=0 go test ./internal/api -run '^TestGoDaemonRunnerMirrorRoundTrip$' -count=1 -v
=== RUN   TestGoDaemonRunnerMirrorRoundTrip
    e2e_test.go:134: round trip session=7e8545c1-60cb-4755-b737-bc1e517fa6af marker=E2E_6308 snapshot=mirror kill=ok
--- PASS: TestGoDaemonRunnerMirrorRoundTrip (0.55s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	0.835s
```

## Required gates

Run from `prettygo/` after `go clean -testcache`.

```text
$ CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go test ./...
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	1.812s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.211s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	0.553s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	0.836s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	1.854s
```

Additional concurrency proof:

```text
$ CGO_ENABLED=1 go test -race ./internal/api ./internal/proto ./internal/state
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	2.413s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	1.664s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.981s
```

Final hygiene checks:

```text
$ git diff --check
(no stdout/stderr; exit 0)
$ go mod tidy -diff
(no stdout/stderr; exit 0)
$ find /tmp -maxdepth 1 -type d -name 'prettygo-e2e-*' -print
(no stdout; no scratch directory remained)
$ pgrep -fl '/tmp/prettygo-e2e-.*/runner'
(no stdout; no test runner remained)
```

No commit was created.
