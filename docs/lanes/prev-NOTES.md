# CONTRACT lane acceptance notes

## Delivered files

```text
prettygo/CONTRACT/fixtures/README.md
prettygo/CONTRACT/fixtures/events.hex.txt
prettygo/CONTRACT/fixtures/http-health-deep.json
prettygo/CONTRACT/fixtures/http-health.json
prettygo/CONTRACT/fixtures/http-sessions-empty.json
prettygo/CONTRACT/fixtures/http-unauthorized.json
prettygo/CONTRACT/fixtures/runner.json
prettygo/CONTRACT/http-api.md
prettygo/CONTRACT/runner-protocol.md
prettygo/CONTRACT/state-dir.md
prettygo/CONTRACT/ws.md
```

No Go implementation was added: `SPEC.md` defines this lane's deliverable as
normative contract documentation and fixtures under `prettygo/CONTRACT/`.

## Source verification map

| Deliverable | Verified against normative source |
| --- | --- |
| `http-api.md` | Every exact and regex route, common reply behavior, status branch, JSON/body limit, static serving, auth gate, and upload path in `prettyd/src/http.ts`; token/origin/open behavior in `prettyd/src/config.ts`; response types/defaults in `prettyd/src/types.ts`, `prettyd/src/sessions.ts`, `prettyd/src/directories.ts`, `prettyd/src/claudeSessionScanner.ts`, and `prettyd/src/push.ts`; browser request/response expectations in `frontend/src/api/prettyd.ts`. |
| `ws.md` | Upgrade/auth/mode/replay logic and every send/receive branch in `prettyd/src/ws.ts`; both message unions and protocol version in `prettyd/src/types.ts`; actual mux routing, RPC correlation, reconnect, and keepalive behavior in `frontend/src/lib/wsMux.ts`; terminal consumption in `frontend/src/hooks/useTerminal.ts`; duplicated frontend shapes in `frontend/src/types/index.ts`; single-session CLI consumption in `prettyd/bin/pretty.cjs`. |
| `runner-protocol.md` | Frame constants, maximum, encoder/parser, JSON structs, and sequence encoding in `prettyd/src/runnerProtocol.ts`; runner handling and handshake order in `prettyd/src/runner.ts`; daemon sends/FIFO snapshot handling in `prettyd/src/runnerClient.ts`; registration and replay wait in `prettyd/src/sessions.ts`; disk record parser/writer/cap/trim in `prettyd/src/persistentLog.ts`; in-memory gap/sequence behavior in `prettyd/src/eventLog.ts`. |
| `state-dir.md` | All hard-coded and environment-selected paths in `prettyd/src/config.ts`, `prettyd/src/sessions.ts`, `prettyd/src/runner.ts`, `prettyd/src/http.ts`, and `prettyd/src/push.ts`; exact metadata writer in `runner.ts`; plist label/template/bootstrap/bootout/orphan rules in `prettyd/src/launchd.ts`; daemon listen-before-discovery order in `prettyd/src/server.ts`. Source behavior was followed where comments and code differ (notably the default `runners/` subdirectory and `.log` not being unlinked). |
| fixtures | `runner.json` keys were compared in order with `SessionMeta`; `events.hex.txt` was reverse-decoded and parsed using the `.events` algorithm; every JSON fixture was parsed; HTTP bodies/statuses were captured from freshly built `prettyd/dist/server.js` under isolated HOME and runner state. |

## Inventory proof

The verifier extracted HTTP method/path conditions (including the five regex
session paths), all discriminated WS `type` values, all runner `FrameType`
constants, and the `SessionMeta` interface keys directly from source, then
required them in the documents/fixture:

```text
$ node --input-type=module <inventory verifier>
HTTP method/path inventory: 15/15 documented
WS message inventory: 16/16 documented (input, resize, attach, detach, snapshot, events, ping, hello, output, gap, exit, error, rpcError, inputAck, pong, claudeEvent)
runner frame inventory: 10/10 documented (HELLO, OUTPUT, EXIT, SNAPSHOT_RES, REPLAY_DONE, INPUT, RESIZE, SNAPSHOT_REQ, REPLAY_REQ, KILL)
runner metadata fixture keys: exact (id, cmd, args, cwd, cols, rows, createdAt, pid, sockPath)
```

`OPTIONS` and unauthenticated static GET handling are documented separately
because they are generic dispatch paths rather than named API route conditions.

The direct source inventory was:

```text
GET    /api/health
GET    /api/health/deep
GET    /api/push/vapid
POST   /api/push/subscribe
POST   /api/push/unsubscribe
GET    /api/sessions
GET    /api/directories
GET    /api/fs/list
POST   /api/sessions
DELETE /api/sessions/:id
GET    /api/sessions/:id/snapshot
GET    /api/claude-sessions
GET    /api/sessions/:id/events
POST   /api/sessions/:id/input
POST   /api/sessions/:id/upload
```

## Fixture proof

The hex rows were isolated, reversed with `xxd -r`, and decoded with the same
big-endian length/sequence loop as `PersistentLog.restoreFrom`:

```text
$ sed -n '/^0000/p' prettygo/CONTRACT/fixtures/events.hex.txt | xxd -r > /tmp/pretty-contract-events.bin
$ xxd -g 1 /tmp/pretty-contract-events.bin
00000000: 00 00 00 08 00 00 00 01 68 69 0d 0a 00 00 00 10  ........hi......
00000010: 00 00 00 02 1b 5b 33 31 6d 72 65 64 1b 5b 30 6d  .....[31mred.[0m
00000020: 00 00 00 07 00 00 00 2a ce bb 0a                 .......*...
$ node --input-type=module <events decoder>
[{"length":8,"seq":1,"data":"hi\r\n"},{"length":16,"seq":2,"data":"\u001b[31mred\u001b[0m"},{"length":7,"seq":42,"data":"λ\n"}]
$ node --input-type=module <parse every fixtures/*.json>
fixture JSON: ok
```

## Real TypeScript daemon capture

First the normative TypeScript was built:

```text
$ npm --prefix prettyd run build

> pretty-pty@0.1.0 build
> tsc -p tsconfig.json

[exit 0]
```

The daemon was then run only with scratch paths. Setting `HOME` was necessary
because auth/push/upload/idle paths do not honor `PRETTYD_STATE_DIR`:

```text
$ HOME=/tmp/pretty-contract.E3YvK7/home \
  PRETTYD_STATE_DIR=/tmp/pretty-contract.E3YvK7/runners \
  PRETTYD_HOST=127.0.0.1 PRETTYD_PORT=8899 \
  PRETTYD_WEB_DIR=/tmp/pretty-contract.E3YvK7/no-web \
  node prettyd/dist/server.js
prettyd listening on http://127.0.0.1:8899
```

No session-create request was made, so launchd and real runners were never
invoked. Captured responses:

```text
GET /api/health -> 200
{"ok":true,"name":"prettyd","version":"0.1.0","listen":{"host":"127.0.0.1","port":8899},"discovering":false,"sessionsLoaded":0}

GET /api/health/deep -> 200
{"ok":true,"name":"prettyd","version":"0.1.0","discovering":false,"sessionsLoaded":0,"uptimeSec":13,"sessions":[]}

unauthenticated GET /api/sessions -> 401
{"error":"unauthorized"}

Bearer-authenticated GET /api/sessions -> 200
{"sessions":[]}

Bearer-authenticated GET /api/fs/list?path=relative -> 400
{"error":"path must be absolute"}

OPTIONS /api/sessions, Origin: https://pretty-pty.somewhere.site -> 204
Access-Control-Allow-Origin: https://pretty-pty.somewhere.site

GET /api/health, Origin: https://evil.example -> 200
(no Access-Control-Allow-Origin header)
```

Only the following scratch state was produced; permissions confirm the root and
token modes:

```text
/tmp/pretty-contract.E3YvK7/home/.local/state/pretty-PTY
/tmp/pretty-contract.E3YvK7/home/.local/state/pretty-PTY/token
/tmp/pretty-contract.E3YvK7/runners
drwx------ /tmp/pretty-contract.E3YvK7/home/.local/state/pretty-PTY
-rw------- /tmp/pretty-contract.E3YvK7/home/.local/state/pretty-PTY/token
```

The process was stopped cleanly:

```text
^Cprettyd: SIGINT received, shutting down
```

## Go and hygiene checks

`prettygo/go.mod` is present but this CONTRACT lane contains no `.go` packages
yet. Running from the module root proves build has no failures and vet has no
applicable package. The final conditional gate exited 0:

```text
$ cd prettygo
$ PKGS=$(/opt/homebrew/bin/go list ./...); if [[ -n "$PKGS" ]]; then CGO_ENABLED=0 /opt/homebrew/bin/go build $PKGS && CGO_ENABLED=0 /opt/homebrew/bin/go vet $PKGS; else echo 'go build/vet: not applicable; go list ./... matched no packages'; fi
go: warning: "./..." matched no packages
go build/vet: not applicable; go list ./... matched no packages
[exit 0]
```

`/opt/homebrew/bin/go version` reported:

```text
go version go1.26.5 darwin/arm64
```

Final whitespace and worktree checks are recorded after the documents were
written:

```text
$ if rg -n '[[:blank:]]+$' NOTES.md prettygo/CONTRACT; then exit 1; else echo 'trailing whitespace: none'; fi
trailing whitespace: none
$ git diff --check
git diff --check: clean
$ git status --short
?? NOTES.md
?? SPEC.md
?? frontend/node_modules
?? prettyd/node_modules
?? prettygo/CONTRACT/
```

`SPEC.md` and both dependency directories were already untracked at the initial
status check and were not modified. No commit was made.
