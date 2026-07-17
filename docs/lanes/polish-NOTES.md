# Lane: POLISH-1 notes

## Outcome

- `make -C prettygo binaries` now requires and explicitly prepends
  `frontend/node_modules/.bin`, then builds through
  `npm --prefix frontend run build`. A clean environment with no global `tsc`
  completed the frontend build and all nine Go binaries.
- `make -C prettygo binaries-noui` skips npm, frontend staging, and the
  `embedui` tag for fast Go-only iteration. It was exercised into a disposable
  output directory so it did not replace the final embedded-UI daemon.
- The generated launchd plist now defaults to the distinct
  `tech.pretty-pty.dev.daemon` label and carries absolute daemon/runner paths,
  host, port, `RunAtLoad=true`, and `KeepAlive=true`.
- `pretty install` defaults to that same safe label, accepts an explicit
  `PRETTYD_DAEMON_LABEL`, locates both release names (`prettyd`, `runner`) and
  build-output names (`prettyd-darwin-arm64`, `runner-darwin-arm64`), atomically
  writes a mode-0600 plist, reloads only its configured label, rejects a port
  already owned by another process, waits for health 200, and prints the URL.
- `pretty uninstall` boots out and removes only its configured plist, preserves
  state/logs, and succeeds when repeated.
- Added a no-launchctl plist/config test plus a unique scratch-label integration
  test that performs bootstrap, health 200, `pretty uninstall`, a second
  idempotent uninstall, and cleanup.

The pre-existing `frontend/node_modules` symlink pointed outside this lane to an
empty directory. Only the symlink inside this workspace was removed; a locked
`npm --prefix frontend ci` created the ignored local dependency tree. No files
in the other checkout were modified.

## Clean-PATH `make binaries` transcript

The final build ran under `env -i` with
`PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`. That PATH contains
Node/npm/Go/Git/Make but no global `tsc`:

```text
clean PATH check: tsc not found (expected)
bash ./scripts/build-binaries.sh
> building frontend via npm (frontend/node_modules/.bin)

> pretty-pty-frontend@0.1.0 build
> tsc -b && vite build && node scripts/stamp-sw.mjs

vite v5.4.21 building for production...
transforming...
✓ 95 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                            3.44 kB │ gzip:   1.53 kB
dist/assets/xterm-DYP7pi_n.css             4.15 kB │ gzip:   1.67 kB
dist/assets/index-B3DexLnc.css            71.59 kB │ gzip:  12.36 kB
dist/assets/index-Btfm_Iy6.js              0.27 kB │ gzip:   0.17 kB
dist/assets/index-CLSJ4cO9.js              2.33 kB │ gzip:   0.86 kB
dist/assets/core-DhEqZVGG.js               2.44 kB │ gzip:   0.98 kB
dist/assets/addon-serialize-CsFQTvP_.js   16.05 kB │ gzip:   5.18 kB
dist/assets/addon-canvas-2tScJBkJ.js      94.96 kB │ gzip:  24.50 kB
dist/assets/addon-webgl-Ce_JuRoB.js      101.15 kB │ gzip:  25.93 kB
dist/assets/xterm-DQboTQhM.js            292.15 kB │ gzip:  72.71 kB
dist/assets/index-COZU94Sy.js            336.77 kB │ gzip: 108.20 kB
✓ built in 1.05s
[stamp-sw] no placeholder (already stamped?)
> building pretty-darwin-arm64 (version c4698bd-dirty)
> building prettyd-darwin-arm64 (version c4698bd-dirty)
> building runner-darwin-arm64 (version c4698bd-dirty)
> building pretty-linux-arm64 (version c4698bd-dirty)
> building prettyd-linux-arm64 (version c4698bd-dirty)
> building runner-linux-arm64 (version c4698bd-dirty)
> building pretty-linux-amd64 (version c4698bd-dirty)
> building prettyd-linux-amd64 (version c4698bd-dirty)
> building runner-linux-amd64 (version c4698bd-dirty)
> wrote /Users/uzair/pretty-PTY-polish/prettygo/dist-go/tech.pretty-pty.dev.daemon-darwin-arm64.plist
> binaries available in /Users/uzair/pretty-PTY-polish/prettygo/dist-go
```

Exit status: 0.

## `binaries-noui`

The target ran with a disposable `DIST_GO_DIR` and produced all nine executable
files. Relevant output:

```text
bash ./scripts/build-binaries.sh --no-ui
> skipping frontend build and UI embedding (--no-ui)
> building pretty-darwin-arm64 (version c4698bd-dirty)
> building prettyd-darwin-arm64 (version c4698bd-dirty)
> building runner-darwin-arm64 (version c4698bd-dirty)
> building pretty-linux-arm64 (version c4698bd-dirty)
> building prettyd-linux-arm64 (version c4698bd-dirty)
> building runner-linux-arm64 (version c4698bd-dirty)
> building pretty-linux-amd64 (version c4698bd-dirty)
> building prettyd-linux-amd64 (version c4698bd-dirty)
> building runner-linux-amd64 (version c4698bd-dirty)
```

## Embedded UI proof

The freshly built Darwin daemon ran on isolated port 18787 with scratch runner
state and a scratch ledger, then shut down cleanly:

```text
2026/07/16 23:18:17 prettyd listening on http://127.0.0.1:18787
GET / -> HTTP 200
GET /api/health -> HTTP 200
<title>Pretty PTY</title>
{"discovering":false,"listen":{"host":"127.0.0.1","port":18787},"name":"prettyd","ok":true,"sessionsLoaded":0,"version":"0.1.0"}
2026/07/16 23:18:26 prettyd: interrupt received, shutting down
```

## Plist and launchd tests

Focused test output:

```text
=== RUN   TestDaemonScratchLaunchdBootstrapHealthBootout
    admin_launchd_darwin_test.go:150: scratch lifecycle passed: label=tech.pretty-pty.dev.daemon.scratch.93243.1784269335447515000 health=200 uninstall=clean+idempotent
--- PASS: TestDaemonScratchLaunchdBootstrapHealthBootout (0.15s)
=== RUN   TestDaemonInstallConfigAndPlistWithoutLaunchctl
    main_test.go:402: default dev plist label=tech.pretty-pty.dev.daemon mode=0600 (launchctl not invoked)
--- PASS: TestDaemonInstallConfigAndPlistWithoutLaunchctl (0.00s)
=== RUN   TestDaemonLabelIsConfigurableAndValidated
--- PASS: TestDaemonLabelIsConfigurableAndValidated (0.00s)
=== RUN   TestLocateInstallBinaryFindsBuildOutputSuffix
--- PASS: TestLocateInstallBinaryFindsBuildOutputSuffix (0.00s)
=== RUN   TestInstallRejectsAnOccupiedDaemonPort
--- PASS: TestInstallRejectsAnOccupiedDaemonPort (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.580s
```

The generated build plist also passed native inspection:

```text
prettygo/dist-go/tech.pretty-pty.dev.daemon-darwin-arm64.plist: OK
Label: tech.pretty-pty.dev.daemon
Program: /Users/uzair/pretty-PTY-polish/prettygo/dist-go/prettyd-darwin-arm64
Runner: /Users/uzair/pretty-PTY-polish/prettygo/dist-go/runner-darwin-arm64
Port: 8787
RunAtLoad: true
KeepAlive: true
```

## MacBook daily-driver install

Port 8787 was unexpectedly occupied by a healthy, zero-session manual daemon
from `/Users/uzair/pretty-PTY/prettygo`. It was outside this lane and was left
untouched. The new dev LaunchAgent was therefore installed on free port 18788.
Running install twice produced:

```text
$ PRETTYD_PORT=18788 pretty-darwin-arm64 install  # first install
wrote plist: /Users/uzair/Library/LaunchAgents/tech.pretty-pty.dev.daemon.plist

prettyd development daemon registered, started, and healthy.
  Label: tech.pretty-pty.dev.daemon
  URL:   http://127.0.0.1:18788
  Logs:  /Users/uzair/Library/Logs/pretty-pty/tech.pretty-pty.dev.daemon.log

$ PRETTYD_PORT=18788 pretty-darwin-arm64 install  # idempotent reinstall
wrote plist: /Users/uzair/Library/LaunchAgents/tech.pretty-pty.dev.daemon.plist

prettyd development daemon registered, started, and healthy.
  Label: tech.pretty-pty.dev.daemon
  URL:   http://127.0.0.1:18788
  Logs:  /Users/uzair/Library/Logs/pretty-pty/tech.pretty-pty.dev.daemon.log
```

Installed-state verification:

```text
/Users/uzair/Library/LaunchAgents/tech.pretty-pty.dev.daemon.plist: OK
Label: tech.pretty-pty.dev.daemon
ProgramArguments:0: /Users/uzair/pretty-PTY-polish/prettygo/dist-go/prettyd-darwin-arm64
EnvironmentVariables:PRETTYD_RUNNER: /Users/uzair/pretty-PTY-polish/prettygo/dist-go/runner-darwin-arm64
EnvironmentVariables:PRETTYD_PORT: 18788
RunAtLoad: true
KeepAlive: true
state = running
pid = 93546
GET / -> HTTP 200
GET /api/health -> HTTP 200
<title>Pretty PTY</title>
```

Use `PRETTYD_PORT=18788 pretty ...` or `pretty --port 18788 ...` for this dev
daemon while the unrelated listener remains on 8787.

## Final CGO-disabled gates

```text
$ CGO_ENABLED=0 go build ./...
PASS: CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
PASS: CGO_ENABLED=0 go vet ./...
$ CGO_ENABLED=0 go test ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.828s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/verdict  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch  (cached)
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets  (cached)
$ git diff --check
PASS: git diff --check
```

No commit was created. No command targeted the production launchd service, and
no mini host was contacted.
