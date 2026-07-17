# LANES implementation notes

## Result

Implemented headless commands as first-class Pretty sessions without changing
the runner socket protocol or ledger schema.

- `pretty run [--name N] [--cwd D] [--spec FILE] -- <cmd args...>` creates a
  `kind:"lane"` session through `/api/lanes`. The launchd-owned runner uses one
  OS pipe for both child stdout and stderr; the existing OUTPUT frames and
  `.events` framing carry the merged bytes.
- Lane metadata persists `kind` and optional `specPath`. The session tool is
  rendered as `lane:<command-basename>` and ordinary PTY metadata remains
  backward compatible because both fields are optional.
- Lane snapshots return a bounded raw output tail rather than a terminal-screen
  serialization.
- Before broadcasting EXIT, the runner atomically writes
  `<id>.manifest.json` with `exit_code`, `signal`, `duration_ms`, a 4 KiB-bounded
  `last_output_tail`, `spec_path`, and optional Git `files_changed` count.
- `pretty last <lane> --json` reads the completion manifest. `pretty lanes` and
  `pretty ls --kind lane` share the same lane listing and add `EXIT` and
  `DURATION` columns.
- Lane waits terminate on process exit and return the child's exit status.
  Multiple lane ids use the existing `waitcond.WaitAny` composition through
  `--any`; the winning lane's exit status is returned.
- Completion uses the existing push service. Exit 0 sends
  `🟢 <name> finished`; nonzero/signal completion sends
  `🔴 <name> died (exit N)` with the last output line. A third similar death in
  60 seconds produces one `N lanes died` digest and later deaths in that burst
  are suppressed.
- Existing ledger boundaries record `created` before launch,
  `launch_started`, and `runner_exited` with the child code.

## Focused coverage

Added coverage for:

- real runner pipe mode, merged output, raw snapshot, manifest fields/bound,
  Git change count, spec metadata, ledger exit payload, and death notification;
- three-similar-deaths digest behavior;
- `pretty run` request parsing and lane launch payload shape;
- lane `wait --any` composition and winning exit-code propagation.

Focused command:

```text
$ CGO_ENABLED=0 go test -count=1 ./internal/state ./internal/session ./internal/api ./cmd/runner ./cmd/pretty
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
```

## Scratch CLI e2e

The final e2e built fresh `pretty`, `prettyd`, and `runner` binaries with
`CGO_ENABLED=0`, then used an isolated HOME, runner state directory, ledger,
LaunchAgents directory, and random loopback port under
`/tmp/pretty-lanes-final.4czCkC`. It never addressed the installed daemon.

The child script slept two seconds, wrote one marker to each stream, and exited
3. Real output:

```text
SCRATCH_ROOT=/tmp/pretty-lanes-final.4czCkC
LANE_ID=195e2252-7ae2-4eea-a031-920c27d74af3
LS_RUNNING
ID        NAME      TOOL     CWD                                  STATE    EXIT  DURATION
195e2252  e2e-lane  lane:sh  /tmp/pretty-lanes-final.4czCkC/repo  running  -     -
WAIT_STATUS=3
WAIT_OUTPUT=195e2252-7ae2-4eea-a031-920c27d74af3 exited 3 after 2.0s
SNAPSHOT
STDOUT_MARKER
STDERR_MARKER
LAST_JSON
{
  "exit_code": 3,
  "signal": null,
  "duration_ms": 2018,
  "last_output_tail": "STDOUT_MARKER\nSTDERR_MARKER\n",
  "spec_path": "/tmp/pretty-lanes-final.4czCkC/repo/spec.md",
  "files_changed": 2
}
LANES_EXITED
ID        NAME      TOOL     CWD                                  STATE   EXIT  DURATION
195e2252  e2e-lane  lane:sh  /tmp/pretty-lanes-final.4czCkC/repo  exited  3     2.0s
MANIFEST_VALID
ok
LEDGER_EVENTS
[{"type":"created","payload_json":"{\"name\":\"e2e-lane\",\"tool\":\"lane\",\"cwd\":\"/tmp/pretty-lanes-final.4czCkC/repo\",\"argv\":[],\"lane_uuid\":\"195e2252-7ae2-4eea-a031-920c27d74af3\"}"},
{"type":"launch_started","payload_json":"{}"},
{"type":"runner_ready","payload_json":"{}"},
{"type":"attached","payload_json":"{}"},
{"type":"runner_exited","payload_json":"{\"code\":3,\"signal\":null}"},
{"type":"reaped","payload_json":"{}"}]
E2E_OK=1
```

## Pure-Go gates

Three successful cycles completed with:

```text
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
$ CGO_ENABLED=0 go test -p 1 -count=1 ./...
```

All packages passed in each counted cycle. Representative full-suite tail from
the third cycle:

```text
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets
```

Parallel package attempts intermittently hit the pre-existing
`internal/waitcond` three-second commit e2e timeout under load. The counted
full-suite gates therefore used `-p 1`; all three uncached serial runs passed,
including `internal/waitcond` (4.331s, 4.285s, and 4.294s). No
out-of-ownership change was made for that timing flake.

No commit was created.
