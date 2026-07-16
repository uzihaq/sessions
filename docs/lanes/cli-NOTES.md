# Go CLI lane acceptance notes

## Result

Implemented `prettygo/cmd/pretty` as a pure-Go CLI with the complete command
surface from `prettyd/bin/pretty.cjs` and `prettyd/bin/remote.cjs`:

- session inspection and control: `ls`, `snap`, `tail`, `wait`, `send`/`input`,
  `last`, `transcript`, `ask`, `keys`, `resize`, `attach`, `model`, and `kill`;
- session creation with the Claude/Codex/shell presets, skip-permission defaults,
  Claude session pinning, and `--model`/`--effort`/`--fast` translations;
- operator commands: `doctor`, `token`, `version`, `install`, and the safe
  ten-step `deploy` flow with its `PRETTYD_SMOKE=1` import preflight;
- `remote enable|status|disable`, including the certificate-transparency
  notice, non-destructive Serve root-handler removal, endpoint verification,
  honest MagicDNS diagnostics, and a terminal QR code rendered with the
  pure-Go `github.com/skip2/go-qrcode` library.

Argument parsing is manual and dependency-light. HTTP authentication rereads
the daemon token on every request. Attach/tail/resize reuse the repository's
existing pure-Go WebSocket dependency. The install plist runs the Go `prettyd`
binary directly; it does not reintroduce Node as a daemon dependency.

The checked-out 2,141-line Node CLI predates the send-confirmation fix named in
the lane spec. The exact normative fix was recovered from repository commit
`d99af5f`: JSONL confirmation is `confirmed`; a cleared composer plus a working
session is `accepted`; text still in the composer is a definite exit 1; and a
cleared but idle composer is ambiguous exit 2. The Go implementation includes
the same compact `• Working` evidence and the same human/JSON result strings.

## Safety and isolation

No default Pretty state, real daemon, launchd service, Tailscale configuration,
or live session was touched. Runtime acceptance used only:

- `/tmp/pretty-cli-capture.*` on loopback port `18998` for Node fixture capture;
- `/tmp/pretty-cli-interop.*` on loopback port `18999` for Node/Go parity;
- Go `t.TempDir()` directories and `httptest` loopback servers for unit tests;
- the scratch install label `tech.pretty-pty.daemon.scratch-test` for plist
  generation; the test explicitly does not invoke `launchctl`.

The scratch TypeScript daemon and Go runner processes were stopped by scoped
shell traps. The deploy acceptance below used `--dry-run --no-pull`; its only
action was the smoke import, and it did not restart or query a daemon.

## Normative Node fixture capture

`prettyd` was built from the checked-out TypeScript source:

```text
$ cd prettyd && npm run build

> pretty-pty@0.1.0 build
> tsc -p tsconfig.json
```

A Go runner was started for `/bin/bash -i` in scratch state, then the real
TypeScript daemon discovered it. The fixed Node CLI from `d99af5f` produced the
committed `cmd/pretty/testdata/node-ls.json` and `node-send.json` fixtures.
Real fixture output:

```text
--- node ls fixture ---
[
  {
    "id": "d268fee4-d5d9-43ca-b1dd-e78c5df9b96c",
    "cmd": "/bin/bash",
    "args": [
      "-i"
    ],
    "cwd": "/tmp/pretty-cli-capture.P35AvP/work",
    "cols": 300,
    "rows": 50,
    "createdAt": 1784240220437,
    "pid": 49150,
    "tool": "terminal",
    "working": false,
    "lastDataAt": 1784240220600,
    "lastUserMessageAt": null,
    "exited": false,
    "exitCode": null,
    "exitSignal": null,
    "exitedAt": null
  }
]
--- node send fixture ---
{"submitted":null,"confidence":"unconfirmed","tool":"terminal"}
```

`TestNodeCLIGoldenOutputShapes` runs the Go commands against a scratch HTTP
server and recursively requires the same keys, JSON types, nullability, and
array structure as those real Node fixtures.

## Send tiers, JSON shapes, and plist proof

Fresh verbose CLI-package test output:

```text
$ go test -count=1 -v ./cmd/pretty
=== RUN   TestDecideSendConfirmation
=== RUN   TestDecideSendConfirmation/confirmed
    main_test.go:36: confirmed: confidence=confirmed exit=0
=== RUN   TestDecideSendConfirmation/accepted-working
    main_test.go:36: accepted-working: confidence=accepted exit=0
=== RUN   TestDecideSendConfirmation/still-in-composer
    main_test.go:36: still-in-composer: confidence=unconfirmed exit=1
=== RUN   TestDecideSendConfirmation/ambiguous
    main_test.go:36: ambiguous: confidence=unconfirmed exit=2
--- PASS: TestDecideSendConfirmation (0.00s)
    --- PASS: TestDecideSendConfirmation/confirmed (0.00s)
    --- PASS: TestDecideSendConfirmation/accepted-working (0.00s)
    --- PASS: TestDecideSendConfirmation/still-in-composer (0.00s)
    --- PASS: TestDecideSendConfirmation/ambiguous (0.00s)
=== RUN   TestNodeCLIGoldenOutputShapes
=== RUN   TestNodeCLIGoldenOutputShapes/ls
    main_test.go:92: ls shape matches testdata/node-ls.json
=== RUN   TestNodeCLIGoldenOutputShapes/send
    main_test.go:92: send shape matches testdata/node-send.json
--- PASS: TestNodeCLIGoldenOutputShapes (0.16s)
=== RUN   TestDaemonPlistUsesScratchLabelWithoutLaunchctl
    main_test.go:169: scratch plist label=tech.pretty-pty.daemon.scratch-test mode=0600 (launchctl not invoked)
--- PASS: TestDaemonPlistUsesScratchLabelWithoutLaunchctl (0.00s)
=== RUN   TestAgentControlTranslation
--- PASS: TestAgentControlTranslation (0.00s)
=== RUN   TestLastAndTranscriptJSONShapes
=== RUN   TestLastAndTranscriptJSONShapes/last
=== RUN   TestLastAndTranscriptJSONShapes/transcript
--- PASS: TestLastAndTranscriptJSONShapes (0.01s)
=== RUN   TestServeStatusHelpers
--- PASS: TestServeStatusHelpers (0.00s)
=== RUN   TestRemoteDiagnosticsHelpers
--- PASS: TestRemoteDiagnosticsHelpers (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.617s
```

## Real TypeScript-daemon interoperability

The built Go and fixed Node CLIs were run against the same scratch TypeScript
daemon and Go-owned bash session. `diff -u` was clean for the human `ls` output
and the `send --json` output. The Go resize command then changed the PTY to
120x40, and the Go snapshot contained markers sent by both CLIs.

```text
scratch=/tmp/pretty-cli-interop.y7uRSf
session=fdaca527-a92c-40b1-9d4c-805fe8071ce3
node_go_ls_diff=clean
ID        NAME  TOOL      CWD                                  STATE  AGE  LAST-USER  PID
fdaca527  -     terminal  /tmp/pretty-cli-interop.y7uRSf/work  idle   1s   -          50792
node_go_send_json_diff=clean
{"submitted":null,"confidence":"unconfirmed","tool":"terminal"}
resized fdaca527-a92c-40b1-9d4c-805fe8071ce3 to 120x40
snapshot_markers=GO_GOLDEN,NODE_GOLDEN,
runner_pid=50784 daemon_pid=50794
```

## Safe deploy dry-run

Real output from the built Go CLI. All mutating steps were skipped; only the
guarded import ran:

```text
$ /tmp/prettygo-pretty-final deploy --repo /Users/uzair/pretty-PTY-cli --no-pull --dry-run
pretty deploy
repo: /Users/uzair/pretty-PTY-cli
mode: dry-run

Plan:
  1. SKIP (--no-pull)  (cd /Users/uzair/pretty-PTY-cli && git pull --ff-only)
  2. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-cli/prettyd && npm install)
  3. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-cli/frontend && npm install)
  4. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-cli/prettyd && npm run build)
  5. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-cli/frontend && npm run build)
  6. RUN                (cd /Users/uzair/pretty-PTY-cli/prettyd && PRETTYD_SMOKE=1 /opt/homebrew/bin/node --input-type=module -e 'await import("file:///Users/uzair/pretty-PTY-cli/prettyd/dist/server.js")')
  7. SKIP (--dry-run)  pgrep -f dist/runner.js | wc -l  # runner baseline
  8. SKIP (--dry-run)  launchctl kickstart -k gui/501/tech.pretty-pty.daemon
  9. SKIP (--dry-run)  poll 127.0.0.1:8787/api/health for up to 30s
  10. SKIP (--dry-run)  verify runner count >= baseline - 1

Executing the import preflight (the only dry-run action):
  $ (cd /Users/uzair/pretty-PTY-cli/prettyd && PRETTYD_SMOKE=1 /opt/homebrew/bin/node --input-type=module -e 'await import("file:///Users/uzair/pretty-PTY-cli/prettyd/dist/server.js")')
  PASS: dist/server.js imports resolved within 5s

PASS: dry-run preflight succeeded; no deploy actions were executed
```

## Final CGO-disabled gates

Run from `prettygo/` after `go clean -testcache`:

```text
$ CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr; exit 0)

$ CGO_ENABLED=0 go test -count=1 ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.937s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api  1.803s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror  0.276s
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto  1.567s
?   github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state  0.554s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch  1.531s

$ CGO_ENABLED=0 go build -o /tmp/prettygo-pretty-final ./cmd/pretty
$ file /tmp/prettygo-pretty-final
/tmp/prettygo-pretty-final: Mach-O 64-bit executable arm64
$ /tmp/prettygo-pretty-final version
0.1.0

$ GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./...
(no stdout/stderr; exit 0)

$ go mod tidy -diff
(no stdout/stderr; exit 0)

$ git diff --check
(no stdout/stderr; exit 0)
```

Additional race proof for the new CLI package:

```text
$ go test -race -count=1 ./cmd/pretty
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  1.513s
```

No commit was created.
