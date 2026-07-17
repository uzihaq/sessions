# CUTOVER lane notes

## Outcome

The node-to-Go daemon cutover boundary is proven in the previously untested
direction. A real Node `prettyd/dist/runner.js` owns `bash -i`; a real compiled
Go daemon discovers it from the shared scratch state directory, lists it over
HTTP, sends input, observes the shell-expanded marker in the daemon snapshot,
shuts down without killing the runner, restarts, rediscovers the same runner,
and completes a second round trip. The already-known Go-runner under the
TypeScript daemon direction is covered as a real-process regression.

Both runners and daemons reported protocol v1. No HELLO, frame, replay, state
metadata, or snapshot mismatch surfaced, so no daemon compatibility shim was
needed.

Implemented:

- `prettygo/internal/interop/cutover_test.go`: bidirectional compiled-process
  interop, canonical `RUNNER_*` launch environment, isolated short Unix-socket
  paths, dynamic non-8787 ports, API discovery, expanded-marker round trips,
  daemon shutdown survival, and node-runner reattachment after Go restart.
- `scripts/cutover.sh`: default/read-only dry run, explicit `--execute`
  authority, bind-host/port parameterization, read-only arm64/plist preflight,
  runner baseline, exact node-plist backup, rendered Go plist pointing at both
  Go daemon and `PRETTYD_RUNNER`, launchd swap, health/discovery/count gate, and
  automatic node restoration after a post-stop failure.
- `scripts/rollback.sh`: default/read-only rollback preview and explicit
  execution through the same guarded engine; exact node-plist restoration,
  health/discovery/count verification, and socket-count fallback when the Go
  daemon is unavailable.
- `docs/CUTOVER.md`: preflight, fresh mini backup, staging, dry run, live swap,
  preserved Node-runner round trip, rollback, post-cutover observation, and
  `pretty recover`/`--reopen` safety-net procedure.

No mini command was run. The live mini address was never contacted, the soak
daemon on port 8787 was never queried or signaled, no launchd mutation was run,
and no commit was created. Manual script proof used scratch port 18787 and
scratch state under `/tmp`; its processes exited and the port was confirmed
closed afterward.

## Decisive interop proof

```text
$ cd prettygo
$ CGO_ENABLED=0 go test -count=1 -v ./internal/interop
=== RUN   TestNodeRunnerUnderGoDaemonCutover
    cutover_test.go:97: scratch node-to-go state: /tmp/pc-1522144115
    cutover_test.go:134: node runner discovered by Go daemon: id=fd304dd3-a82d-48d6-9001-e3bcb83ddc6f first=NODE_TO_GO_26648 after_restart=NODE_TO_GO_REATTACHED_11458
--- PASS: TestNodeRunnerUnderGoDaemonCutover (0.71s)
=== RUN   TestGoRunnerUnderNodeDaemonRegression
    cutover_test.go:139: scratch go-to-node state: /tmp/pc-3825987702
    cutover_test.go:167: Go runner discovered by node daemon: id=586d89c2-f2ef-425d-ad76-4c59d6a05966 marker=GO_TO_NODE_13444
--- PASS: TestGoRunnerUnderNodeDaemonRegression (0.55s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop  3.350s
```

The markers contain Bash `$RANDOM` expansions. The literal input therefore
cannot satisfy the numeric snapshot regex; the PTY had to execute and return
the command.

## Full CGO-disabled suite

```text
$ cd prettygo
$ CGO_ENABLED=0 go test -count=1 ./...
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty              1.227s
?    github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd            [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/cmd/runner             [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api           3.264s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/interop       3.940s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger        2.716s
?    github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror        1.472s
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto         0.469s
?    github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/recovery      0.677s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session       1.261s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state         1.616s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/verdict       1.836s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/waitcond      4.286s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch         2.141s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets     1.848s
```

```text
$ CGO_ENABLED=0 go vet ./...
[clean]
```

## Darwin arm64 build proof

The three binaries were built to a disposable local directory with
`CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath`.

```text
/tmp/pretty-cutover-arm64.gcnXiR/pretty-darwin-arm64:  Mach-O 64-bit executable arm64
/tmp/pretty-cutover-arm64.gcnXiR/prettyd-darwin-arm64: Mach-O 64-bit executable arm64
/tmp/pretty-cutover-arm64.gcnXiR/runner-darwin-arm64:  Mach-O 64-bit executable arm64
331449f09bd0f884dda0357be1677fe8cd0034e12a788d16a1480c89461a4542  /tmp/pretty-cutover-arm64.gcnXiR/pretty-darwin-arm64
b4e2fc04824b452044dabded5d5f4051b0f25d7b39dafdf92dfb5a954dfedab8  /tmp/pretty-cutover-arm64.gcnXiR/prettyd-darwin-arm64
560e8814d29c18919ec7fe23725fb2ff4ab312df396c92ef5c2ab3759b243795  /tmp/pretty-cutover-arm64.gcnXiR/runner-darwin-arm64
```

## Local scratch dry-run output

A compiled Go runner was started directly for `bash -i` in an isolated state
directory. A compiled Go daemon discovered it on `127.0.0.1:18787`. A valid
scratch node plist was supplied so the script's read-only binary/plist guards
were real. Neither script received `--execute`.

```text
$ HOME=<scratch> PRETTYD_HOST=127.0.0.1 PRETTYD_PORT=<scratch> ... bash scripts/cutover.sh --dry-run
pretty cutover
mode: DRY-RUN (default; no files, processes, or launchd state will change)
api: http://127.0.0.1:18787
plist: /tmp/pc-dry-final.YYFItM/tech.pretty-pty.daemon.plist
node backup: /tmp/pc-dry-final.YYFItM/node-backup-final.plist
[preflight] validating staged darwin-arm64 binaries
[read] waiting for healthy daemon with completed discovery
[guard] runner baseline = 1
[plan] validate darwin-arm64 Go daemon and runner binaries
[plan] smoke-load /tmp/pc-dry.MN8Y8j/prettyd with PRETTYD_SMOKE=1
[plan] copy the exact node plist to /tmp/pc-dry-final.YYFItM/node-backup-final.plist (refuse overwrite)
[plan] render and lint a Go plist with PRETTYD_HOST=127.0.0.1, PRETTYD_PORT=18787, PRETTYD_RUNNER=/tmp/pc-dry.MN8Y8j/runner
[plan] launchctl bootout gui/501/tech.pretty-pty.daemon
[plan] atomically install the Go plist, bootstrap, and kickstart gui/501/tech.pretty-pty.daemon
[plan] wait for health 200, discovery=false, and session count >= 1
[plan] automatically restore the node plist if activation or runner-count verification fails
DRY-RUN PASS: read-only checks complete; runner baseline = 1; no changes made.
```

```text
$ HOME=<scratch> PRETTYD_HOST=127.0.0.1 PRETTYD_PORT=<scratch> ... bash scripts/rollback.sh --dry-run
pretty rollback
mode: DRY-RUN (default; no files, processes, or launchd state will change)
api: http://127.0.0.1:18787
plist: /tmp/pc-dry-final.YYFItM/tech.pretty-pty.daemon.plist
node backup: /tmp/pc-dry-final.YYFItM/node-backup-final.plist
[preflight] validating exact node plist backup
[read] waiting for healthy daemon with completed discovery
[guard] runner baseline = 1
[plan] validate the saved node plist at /tmp/pc-dry-final.YYFItM/node-backup-final.plist
[plan] launchctl bootout gui/501/tech.pretty-pty.daemon (an already-stopped Go daemon is allowed)
[plan] atomically restore the exact node plist, bootstrap, and kickstart gui/501/tech.pretty-pty.daemon
[plan] wait for health 200, discovery=false, and session count >= 1
DRY-RUN PASS: read-only checks complete; runner baseline = 1; no changes made.
```

Post-run isolation check:

```text
scratch_port_18787=closed
scratch_processes[/tmp/pc-dry-final.YYFItM]=none
scratch_processes[/tmp/pc-dry.MN8Y8j]=none
```

## Remaining live-only gates

The following are deliberately not claimed here because the lane instructions
forbid contacting or mutating the mini:

- mini reachability;
- a fresh backup on the mini's established backup volume;
- staged binary installation on the mini;
- the live `--execute` swap, preserved production-runner marker, UI checks,
  observation window, or rollback drill.

Those steps are explicit stop conditions and commands in `docs/CUTOVER.md`.

## Other static gates

```text
$ npm --prefix prettyd run build
> pretty-pty@0.1.0 build
> tsc -p tsconfig.json

$ bash -n scripts/cutover.sh scripts/rollback.sh
[clean]

$ git diff --check
[clean]
```
