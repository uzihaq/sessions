# FIXUPS lane notes

Date: 2026-07-16
Branch: `go-fixups`

## Implemented

- Runner resolution now accepts only absolute existing executable files, checks both co-located `runner` and `runner-<GOOS>-<GOARCH>`, and never falls back to a bare relative program name. Session creation fails before writing runner metadata or a launchd plist when resolution fails.
- `pretty new --name` is covered from CLI POST serialization through API creation, runner metadata, `pretty ls`, reconnect, and daemon-start discovery. The optional name is persisted compatibly in the existing runner metadata JSON and is preserved by the Go runner on restart.
- `pretty ls --json` now indents the raw sessions array instead of decoding into Go maps, preserving the daemon's property order. The Node fixture is an exact byte golden rather than shape-only coverage.
- `TestWorkingEdgeWritesSentinelAndHookEnvironment` now waits until the output observer has received the bytes and drives classifier ticks synchronously. Its sentinel, hook environment, working=true, and working=false assertions are unchanged.

## CGO-disabled gates

All commands ran from `prettygo/` with `CGO_ENABLED=0`.

```text
$ CGO_ENABLED=0 go build ./...   # repeated 3 times
build run 01: PASS
build run 02: PASS
build run 03: PASS

$ CGO_ENABLED=0 go vet ./...     # repeated 3 times
vet run 01: PASS
vet run 02: PASS
vet run 03: PASS

$ CGO_ENABLED=0 go test ./... -count=1   # 10 consecutive runs
full-suite run 01: PASS
full-suite run 02: PASS
full-suite run 03: PASS
full-suite run 04: PASS
full-suite run 05: PASS
full-suite run 06: PASS
full-suite run 07: PASS
full-suite run 08: PASS
full-suite run 09: PASS
full-suite run 10: PASS
```

One uncached full-suite run was also retained verbatim before the 10-run proof:

```text
$ CGO_ENABLED=0 go test ./... -count=1
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty          0.417s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd        [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner         [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api       2.800s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger    2.562s
?   github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror    1.103s
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto     0.875s
?   github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session   1.470s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state     1.605s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch     2.567s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets 1.900s
```

## Live scratch acceptance

No default Pretty state directory and no pre-existing daemon were used. The acceptance binaries, `HOME`, runner state, working directory, port, logs, and launchd plist were all under `/tmp/pretty-fixups.qGmfKe`; the one scratch session was killed and its launchd label was confirmed absent. The scratch directory was retained for inspection.

The Go daemon was intentionally started as `prettyd-darwin-arm64` beside only `runner-darwin-arm64`, with no `PRETTYD_RUNNER` override. A session was created with the built Go CLI, the daemon was restarted to exercise discovery, and then the scratch TypeScript daemon attached to the same Go runner. Both CLIs were run against that scratch TypeScript daemon.

```text
scratch_root=/tmp/pretty-fixups.qGmfKe
scratch_port=50174
co_located_runner=/tmp/pretty-fixups.qGmfKe/bin/runner-darwin-arm64
created_session=b441c0df-51b4-4831-9fd8-ac9063458b38
go_ls_text:
ID        NAME               TOOL      CWD                             STATE  AGE  LAST-USER  PID
b441c0df  fixups acceptance  terminal  /tmp/pretty-fixups.qGmfKe/work  idle   0s   -          88649
metadata_name=fixups acceptance
plist_runner=runner-darwin-arm64
name_after_go_daemon_restart=fixups acceptance
ts_daemon_node_ls_json=[
  {
    "id": "b441c0df-51b4-4831-9fd8-ac9063458b38",
    "cmd": "/bin/sh",
    "args": [
      "-c",
      "while :; do sleep 1; done"
    ],
    "cwd": "/tmp/pretty-fixups.qGmfKe/work",
    "cols": 300,
    "rows": 50,
    "createdAt": 1784248745106,
    "pid": 88649,
    "tool": "terminal",
    "working": false,
    "lastDataAt": 1784248745776,
    "lastUserMessageAt": null,
    "exited": false,
    "exitCode": null,
    "exitSignal": null,
    "exitedAt": null
  }
]
go_cli_vs_node_cli_json=BYTE_IDENTICAL
scratch_launchd_label=absent_after_kill
scratch_acceptance=PASS
```

The loud-failure path used a second scratch `HOME`, state directory, port, and daemon binary under `/tmp/pretty-fixups-no-runner.Y7Wi6y`. No runner binary was co-located and no override was supplied:

```text
scratch_root=/tmp/pretty-fixups-no-runner.Y7Wi6y
{"error":"runner executable unavailable: set PRETTYD_RUNNER to an absolute path to an existing executable"}

http_status=400
runner_state_files=0
launch_agent_files=0
missing_runner_acceptance=PASS
```

No commit was created.
