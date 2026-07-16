# Go runner delivery notes

Implemented `prettygo/cmd/runner` plus the shared runner protocol and state
packages. The runner uses `github.com/creack/pty`, defaults to a 300x50 PTY,
speaks protocol v1, writes the TypeScript-compatible metadata/event/log file
group, replays persisted output, accepts reconnecting daemon clients, and
preserves `.events` on SIGTERM while deleting live state after a permanent PTY
exit. The reusable proof is `prettygo/scripts/interop.sh`.

## Safety/isolation

All runtime validation used only these disposable locations:

- runner state: `/tmp/gorunner-state`
- isolated home (including the daemon auth token and launchd scan):
  `/tmp/gorunner-home`
- PTY cwd: `/tmp/gorunner-work`
- daemon port: loopback `127.0.0.1:8898`

The proof checks that port 8898 is unused before starting. It starts and stops
only the PIDs it creates. It never starts against the default Pretty state
directory or the real home directory.

## Build, test, and vet proof

The required TypeScript daemon artifact was built from the existing source:

```text
$ cd prettyd && npm run build

> pretty-pty@0.1.0 build
> tsc -p tsconfig.json
```

Final Go verification, run from `prettygo/`:

```text
$ CGO_ENABLED=0 /opt/homebrew/bin/go test ./...
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	(cached)
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	(cached)
go_test_status=0

$ CGO_ENABLED=0 /opt/homebrew/bin/go vet ./...
go_vet_status=0

$ CGO_ENABLED=0 /opt/homebrew/bin/go build -o /tmp/prettygo-runner-final ./cmd/runner
go_build_status=0
$ file /tmp/prettygo-runner-final
/tmp/prettygo-runner-final: Mach-O 64-bit executable arm64

$ bash -n scripts/interop.sh
interop_script_syntax_status=0
$ git diff --check
git_diff_check_status=0
```

The unit tests include fragmented socket reads, exact OUTPUT-frame bytes,
invalid frame bounds, exact `.events` record bytes, truncated-tail recovery,
and replay-ring sequence/cap behavior. A race-enabled run also passed:

```text
$ /opt/homebrew/bin/go test -race ./...
?   	github.com/uzihaq/pretty-pty/prettygo/cmd/runner	[no test files]
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/proto	1.587s
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/state	1.352s
```

## Real TypeScript-daemon interoperability proof

Command, run from `prettygo/`:

```text
$ ./scripts/interop.sh
```

Real output from the final run (the bearer token is intentionally never
printed):

```text
$ CGO_ENABLED=0 /opt/homebrew/bin/go build -o /tmp/prettygo-runner-interop ./cmd/runner
session_id=f6ef865e-a827-4a65-87c5-445c0c6afb7a
marker=INTEROP_10233
runner_pid=12990
$ ls -l /tmp/gorunner-state
total 16
-rw-r--r--@ 1 uzair  wheel  225 Jul 16 12:54 f6ef865e-a827-4a65-87c5-445c0c6afb7a.events
-rw-------@ 1 uzair  wheel  283 Jul 16 12:54 f6ef865e-a827-4a65-87c5-445c0c6afb7a.json
-rw-r--r--@ 1 uzair  wheel    0 Jul 16 12:54 f6ef865e-a827-4a65-87c5-445c0c6afb7a.log
srw-------@ 1 uzair  wheel    0 Jul 16 12:54 f6ef865e-a827-4a65-87c5-445c0c6afb7a.sock
$ HOME=/tmp/gorunner-home PRETTYD_STATE_DIR=/tmp/gorunner-state PRETTYD_PORT=8898 node prettyd/dist/server.js
daemon_pid=13004
{"ok":true,"name":"prettyd","version":"0.1.0","listen":{"host":"127.0.0.1","port":8898},"discovering":false,"sessionsLoaded":1}
$ curl -H "Authorization: Bearer <scratch-token>" http://127.0.0.1:8898/api/sessions
{"sessions":[{"id":"f6ef865e-a827-4a65-87c5-445c0c6afb7a","cmd":"/bin/bash","args":["-i"],"cwd":"/tmp/gorunner-work","cols":300,"rows":50,"createdAt":1784231698430,"pid":13002,"tool":"terminal","working":false,"lastDataAt":1784231698576,"lastUserMessageAt":null,"exited":false,"exitCode":null,"exitSignal":null,"exitedAt":null}]}
$ curl -X POST .../api/sessions/<id>/input --data {"data":"echo INTEROP_<random>\\r"}
{"ok":true}
$ curl .../snapshot | grep -o "INTEROP_[0-9]*" | tail -1
INTEROP_10233
$ existing TypeScript PersistentLog.restoreFrom(<go-events-file>)
ts_restore_events=7 ts_restore_marker=yes
$ kill -TERM <daemon-pid>; test -S /tmp/gorunner-state/<id>.sock
runner_survived_daemon_disconnect=yes
$ restart the same isolated TS daemon and rediscover the runner
sessions_after_reattach={"sessions":[{"id":"f6ef865e-a827-4a65-87c5-445c0c6afb7a","cmd":"/bin/bash","args":["-i"],"cwd":"/tmp/gorunner-work","cols":300,"rows":50,"createdAt":1784231698430,"pid":13002,"tool":"terminal","working":false,"lastDataAt":1784231698834,"lastUserMessageAt":null,"exited":false,"exitCode":null,"exitSignal":null,"exitedAt":null}]}
snapshot_replay_after_reattach=INTEROP_10233
$ curl -X DELETE .../api/sessions/<id>
{"ok":true}
exit_record={"sessions":[{"id":"f6ef865e-a827-4a65-87c5-445c0c6afb7a","cmd":"/bin/bash","args":["-i"],"cwd":"/tmp/gorunner-work","cols":300,"rows":50,"createdAt":1784231698430,"pid":13002,"tool":"terminal","working":false,"lastDataAt":1784231698834,"lastUserMessageAt":null,"exited":true,"exitCode":0,"exitSignal":"1","exitedAt":1784231698934}]}
sessions_after_kill={"sessions":[]}
runner_exit_status=0
$ find /tmp/gorunner-state -maxdepth 1 -type f -o -type s
/tmp/gorunner-state/f6ef865e-a827-4a65-87c5-445c0c6afb7a.log
$ tail -n 5 /tmp/gorunner-daemon.out
prettyd listening on http://127.0.0.1:8898
```

This proves discovery/attachment by the existing TypeScript daemon, input to
the Go-owned PTY, marker recovery through the daemon snapshot, TypeScript
decoding of the Go `.events` file, survival and replay across daemon
disconnect/restart, the HTTP kill path, TS-compatible exit status, clean runner
exit, and permanent-state cleanup after the normative 30-second grace period.
