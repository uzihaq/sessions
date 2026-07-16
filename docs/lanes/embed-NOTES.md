# EMBED+PACKAGE lane notes

## Result

Implemented the embedded-UI and packaging lane within the assigned boundary.

- `internal/webassets` contains the optional `embed.FS`, static-file serving,
  SPA fallback, and tagged/untagged tests. The `embedui` build tag includes the
  staged production frontend; ordinary development builds compile a no-assets
  stub and continue using the existing disk-directory behavior.
- The one authorized server-wiring edit is in `internal/api/server.go`: when
  the configured disk web directory is absent, static requests fall back to
  `webassets.ServeHTTP`. An existing disk directory remains preferred.
- `make binaries` builds the production frontend, stages `frontend/dist` into
  `internal/webassets/dist`, and builds Darwin arm64, Linux arm64, and Linux
  amd64 artifacts with `CGO_ENABLED=0`, `-trimpath`, stripped symbols, and a
  `git describe --tags --always --dirty` version stamp in the linker build ID.
  The `pretty version` variable is stamped with the same value.
- The current commands are three independent `package main` programs. They
  cannot be imported into a wrapper, and turning them into importable packages
  would require editing files owned by other lanes. Per the spec's fallback,
  the output is therefore three binaries per platform: `pretty`, `prettyd`,
  and `runner`. Only `prettyd` is built with `-tags embedui`.
- The build generates
  `dist-go/tech.pretty-pty.daemon-darwin-arm64.plist` beside the binaries. It
  points directly at the built Go daemon. The template was validated only; it
  was not copied to `~/Library/LaunchAgents` and `launchctl` was never run.

## Frontend and binary build

Command, run from `prettygo/`:

```text
$ make binaries
bash ./scripts/build-binaries.sh
> building frontend

> pretty-pty-frontend@0.1.0 build
> tsc -b && vite build && node scripts/stamp-sw.mjs

vite v5.4.21 building for production...
transforming...
✓ 94 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                            3.44 kB │ gzip:   1.53 kB
dist/assets/xterm-DYP7pi_n.css             4.15 kB │ gzip:   1.67 kB
dist/assets/index-DENKUUm1.css            68.03 kB │ gzip:  11.76 kB
dist/assets/index-Btfm_Iy6.js              0.27 kB │ gzip:   0.17 kB
dist/assets/index-CLSJ4cO9.js              2.33 kB │ gzip:   0.86 kB
dist/assets/core-DhEqZVGG.js               2.44 kB │ gzip:   0.98 kB
dist/assets/addon-serialize-CsFQTvP_.js   16.05 kB │ gzip:   5.18 kB
dist/assets/addon-canvas-2tScJBkJ.js      94.96 kB │ gzip:  24.50 kB
dist/assets/addon-webgl-Ce_JuRoB.js      101.15 kB │ gzip:  25.93 kB
dist/assets/xterm-DQboTQhM.js            292.15 kB │ gzip:  72.71 kB
dist/assets/index-BWLVg507.js            332.88 kB │ gzip: 107.22 kB
✓ built in 1.06s
[stamp-sw] no placeholder (already stamped?)
> building pretty-darwin-arm64 (version 7570414-dirty)
> building prettyd-darwin-arm64 (version 7570414-dirty)
> building runner-darwin-arm64 (version 7570414-dirty)
> building pretty-linux-arm64 (version 7570414-dirty)
> building prettyd-linux-arm64 (version 7570414-dirty)
> building runner-linux-arm64 (version 7570414-dirty)
> building pretty-linux-amd64 (version 7570414-dirty)
> building prettyd-linux-amd64 (version 7570414-dirty)
> building runner-linux-amd64 (version 7570414-dirty)
> wrote /Users/uzair/pretty-PTY-embed/prettygo/dist-go/tech.pretty-pty.daemon-darwin-arm64.plist
> binaries available in /Users/uzair/pretty-PTY-embed/prettygo/dist-go
```

The staged frontend is 1.2 MB and the complete nine-binary output directory is
56 MB (`du -sh`).

## Embedded UI scratch smoke test

The final Darwin daemon was run from a fresh `/tmp` working directory with an
isolated `HOME`, isolated runner state, a dynamically selected loopback port,
and no disk frontend directory. The runner path was the scratch-built Go
runner. The daemon was stopped by its captured PID, and the scratch directory
was removed afterward.

Real output:

```text
scratch=/tmp/prettygo-embed-final.jfScNW
disk_web_dir_present=no
daemon_pid=61206 port=59590
health_status=200 health={"discovering":false,"listen":{"host":"127.0.0.1","port":59590},"name":"prettyd","ok":true,"sessionsLoaded":0,"version":"0.1.0"}
root=200|text/html; charset=utf-8 title=<title>Pretty PTY</title> bytes=3445
spa=200|text/html; charset=utf-8 title=<title>Pretty PTY</title>
daemon_log=2026/07/16 15:55:44 prettyd listening on http://127.0.0.1:59590
daemon_shutdown=clean
scratch_removed=yes
```

This proves both the required `/` response and SPA fallback came from the
embedded production UI rather than `frontend/dist` or a sidecar `web`
directory.

## Binary format, static-link, version, and size evidence

`file(1)` reports both Linux architectures as statically linked. Darwin's
Mach-O format does not label the binaries "statically linked"; Go build
metadata records `CGO_ENABLED=0`, `GOOS=darwin`, `GOARCH=arm64`, `-trimpath`,
and `-tags=embedui` for the daemon.

```text
$ file dist-go/pretty-* dist-go/prettyd-* dist-go/runner-*
dist-go/pretty-darwin-arm64:  Mach-O 64-bit executable arm64
dist-go/pretty-linux-amd64:   ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, Go BuildID=pretty-pty/7570414-dirty/pretty/linux/amd64, BuildID[sha1]=54ff8d235591dc0e9d32c44c21f8d9d2200f0e4e, stripped
dist-go/pretty-linux-arm64:   ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, Go BuildID=pretty-pty/7570414-dirty/pretty/linux/arm64, BuildID[sha1]=47ce0b296761a075f88903a6d0c30e16044c0c49, stripped
dist-go/prettyd-darwin-arm64: Mach-O 64-bit executable arm64
dist-go/prettyd-linux-amd64:  ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, Go BuildID=pretty-pty/7570414-dirty/prettyd/linux/amd64, BuildID[sha1]=e398523caeb04d949fbdf2bb2c6e5bba831cfc3d, stripped
dist-go/prettyd-linux-arm64:  ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, Go BuildID=pretty-pty/7570414-dirty/prettyd/linux/arm64, BuildID[sha1]=0c87dfecadcb79d2d05cef0c3cf4c4716a1580c5, stripped
dist-go/runner-darwin-arm64:  Mach-O 64-bit executable arm64
dist-go/runner-linux-amd64:   ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, Go BuildID=pretty-pty/7570414-dirty/runner/linux/amd64, BuildID[sha1]=c9c337d1fddb58986efbb3531728cd8487af4cd2, stripped
dist-go/runner-linux-arm64:   ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, Go BuildID=pretty-pty/7570414-dirty/runner/linux/arm64, BuildID[sha1]=c6bcca69cd14875b755345fa20d7fcfa6890f305, stripped
```

Exact byte sizes:

```text
$ wc -c dist-go/pretty-* dist-go/prettyd-* dist-go/runner-*
 6729842 dist-go/pretty-darwin-arm64
 7119010 dist-go/pretty-linux-amd64
 6684834 dist-go/pretty-linux-arm64
 9185202 dist-go/prettyd-darwin-arm64
 9601186 dist-go/prettyd-linux-amd64
 9044130 dist-go/prettyd-linux-arm64
 3422274 dist-go/runner-darwin-arm64
 3551394 dist-go/runner-linux-amd64
 3408034 dist-go/runner-linux-arm64
 58745906 total
```

The link-time version stamp matches `git describe`:

```text
$ git describe --tags --always --dirty
7570414-dirty
$ ./dist-go/pretty-darwin-arm64 version
7570414-dirty
$ go tool buildid dist-go/prettyd-darwin-arm64
pretty-pty/7570414-dirty/prettyd/darwin/arm64
$ go tool buildid dist-go/runner-darwin-arm64
pretty-pty/7570414-dirty/runner/darwin/arm64
```

## Launchd template proof

```text
$ plutil -lint dist-go/tech.pretty-pty.daemon-darwin-arm64.plist
dist-go/tech.pretty-pty.daemon-darwin-arm64.plist: OK
$ /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' dist-go/tech.pretty-pty.daemon-darwin-arm64.plist
/Users/uzair/pretty-PTY-embed/prettygo/dist-go/prettyd-darwin-arm64
```

No plist was installed and no launchd service was loaded.

## Go verification

Both development mode and the embedded build were tested across the entire Go
module:

```text
$ CGO_ENABLED=0 go test -count=1 ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.528s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api  2.513s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror  0.707s
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto  1.196s
?   github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  2.059s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state  2.287s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch  1.852s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets  1.686s

$ CGO_ENABLED=0 go test -count=1 -tags embedui ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.570s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api  2.300s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror  1.447s
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness  [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto  1.782s
?   github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  1.122s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state  0.741s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch  1.653s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets  2.024s
```

Additional final gates:

```text
$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr; exit 0)
$ CGO_ENABLED=0 go vet -tags embedui ./...
(no stdout/stderr; exit 0)
$ go mod tidy -diff
(no stdout/stderr; exit 0)
$ git diff --check
(no stdout/stderr; exit 0)
```

No commit was created.
