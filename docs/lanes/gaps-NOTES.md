# Lane: GAPS — exhaustive TypeScript/Go route parity

## Result

The complete `prettyd/src/http.ts` + `prettyd/src/ws.ts` sweep contains 19 route rows (17 HTTP/static/preflight rows and two WebSocket modes). Four HTTP routes were absent from `prettygo/internal/api` before this lane:

- `GET /api/directories`
- `GET /api/fs/list`
- `GET /api/claude-sessions`
- `POST /api/sessions/:id/upload`

All four are implemented. The two gaps beyond the spec's known pair were `/api/directories` and `/api/sessions/:id/upload`.

`SessionInfo` below means the normative TS object with fields `id`, optional `name`, `cmd`, `args`, `cwd`, `cols`, `rows`, `createdAt`, `pid`, `tool`, `working`, `lastDataAt`, `lastUserMessageAt`, `exited`, `exitCode`, `exitSignal`, `exitedAt`, and optional `claudeCustomTitle`, `claudeAiTitle`, `onIdle`, `model`, `effort`, and `fast`.

Every authenticated HTTP row also accepts the TS `token=<string>` query alternative to `Authorization: Bearer <token>`; it is written explicitly in the query column. Health, static assets, and preflight are unauthenticated. WebSockets use `token=<string>` unless auth-open mode is enabled.

## Complete route table

| Method / transport | TS path | TS query parameters | Normative success shape | Go before lane | Go after lane |
|---|---|---|---|---|---|
| `OPTIONS` | any path | none | `204`, no body; CORS method/header metadata | ported | ported |
| `GET` | any static/SPA path other than exact `/api`, prefixes `/api/`, or prefix `/ws` | arbitrary query ignored | file bytes with content type, or SPA `index.html` | ported | ported |
| `GET` | `/api/health` | none | `{ok:boolean,name:string,version:string,listen:{host:string,port:number},discovering:boolean,sessionsLoaded:number}` | ported | ported |
| `GET` | `/api/health/deep` | none | `{ok:boolean,name:string,version:string,discovering:boolean,sessionsLoaded:number,uptimeSec:number,sessions:object[]}` | ported | ported |
| `GET` | `/api/push/vapid` | `token` | `{publicKey:string}` | ported | ported |
| `POST` | `/api/push/subscribe` | `token` | `{ok:true}`; body is the push subscription object | ported | ported |
| `POST` | `/api/push/unsubscribe` | `token` | `{ok:true}`; body `{endpoint:string}` | ported | ported |
| `GET` | `/api/sessions` | `include_exited=1`, `token` | `{sessions:SessionInfo[]}` | ported | ported |
| `GET` | `/api/directories` | `token` | `{directories:{path:string,label:string,kind:'home'\|'common'\|'project'}[]}` | **missing** | **implemented** |
| `GET` | `/api/fs/list` | `path=<absolute>` (default `$HOME` when absent), `token` | `{path:string,parent:string\|null,entries:{name:string,kind:'dir'\|'file'\|'symlink'\|'other',hidden:boolean}[]}` | **missing** | **implemented** |
| `POST` | `/api/sessions` | `token` | `SessionInfo`; body is `CreateSessionRequest` | ported | ported |
| `DELETE` | `/api/sessions/:id` | `token` | `{ok:boolean}` | ported | ported |
| `GET` | `/api/sessions/:id/snapshot` | `cols=<number>`, `token` | `text/plain`; `X-Pretty-Seq: <number>` | ported | ported |
| `GET` | `/api/claude-sessions` | `token` | `{sessions:{sessionId:string,cwd:string,modifiedAt:number,firstUserMessage:string,sizeBytes:number}[]}` newest-first | **missing** | **implemented** |
| `GET` | `/api/sessions/:id/events` | `since=<number>`, `tail=<number>`, `before=<number>`, `token` | `{events:object[],nextIndex:number,totalCount:number,startIndex:number,endIndex:number}` | ported | ported |
| `POST` | `/api/sessions/:id/input` | `token` | `{ok:boolean}`; body `{data:string}` | ported | ported |
| `POST` | `/api/sessions/:id/upload` | `token` | `{path:string,size:number}`; raw body, optional `X-Pretty-Filename`, 25 MiB cap | **missing** | **implemented** |
| WebSocket upgrade (`GET`) | `/ws` single-session mode | required `sessionId`; optional `lastSeq`, `claudeEventsSince`, `token`; selected when `mux != 1` | protocol-2 `hello`, `output`, `gap`, `claudeEvent`, `exit`, `error`, `pong` frames; accepts input/resize/ping and raw text/binary input | ported | ported |
| WebSocket upgrade (`GET`) | `/ws` mux mode | required `mux=1`; `token` | tagged protocol-2 frames plus `snapshot`, `events`, `inputAck`, `rpcError`, `pong`; accepts attach/detach/snapshot/events/input/resize/ping messages | ported | ported |

Unmatched authenticated API paths/methods retain the TS fallback shape `404 {error:'not found',path:string}`.

## Implementation notes

- `/api/fs/list` matches the TS boundary: the requested path must be absolute; requested path and `$HOME` are both symlink-resolved; canonical paths outside home are rejected with `403`; missing paths fall back through canonical normalization before `stat`; entries report `dir`/`file`/`symlink`/`other`, hidden status, and dir-first case-insensitive sorting. Its tests reject both `..` and an in-home symlink pointing outside the fixture home.
- `/api/directories` preserves the fixed common-directory order, project markers (`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), de-duplication, tildified labels, and TS scan caps.
- `/api/claude-sessions` is implemented in `internal/watch`, sharing the resolver's call-time `ClaudeProjectsDir`. It reads only the fixture `$HOME/.claude/projects`, scans only regular `.jsonl` files, reads at most the first 16 KiB for the preview, returns the exact five fields, and sorts newest-first.
- `/api/sessions/:id/upload` uses the TS basename/sanitization and extension behavior, writes mode `0600` under `$HOME/.local/state/pretty-PTY/uploads`, returns the absolute path and byte count, and rejects bodies over 25 MiB.
- The new table-driven API test uses a fixture `HOME`; it does not inspect the real `~/.claude` or upload directory.

## Real gate output

Focused added-route table and traversal tests:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/api -run 'Test(AddedRouteShapeTable|FSListRejectsTraversal)$'
=== RUN   TestAddedRouteShapeTable
=== RUN   TestAddedRouteShapeTable/GET_/api/directories
=== RUN   TestAddedRouteShapeTable/GET_/api/fs/list
=== RUN   TestAddedRouteShapeTable/GET_/api/claude-sessions
=== RUN   TestAddedRouteShapeTable/POST_/api/sessions/:id/upload
--- PASS: TestAddedRouteShapeTable (0.01s)
    --- PASS: TestAddedRouteShapeTable/GET_/api/directories (0.00s)
    --- PASS: TestAddedRouteShapeTable/GET_/api/fs/list (0.00s)
    --- PASS: TestAddedRouteShapeTable/GET_/api/claude-sessions (0.00s)
    --- PASS: TestAddedRouteShapeTable/POST_/api/sessions/:id/upload (0.00s)
=== RUN   TestFSListRejectsTraversal
=== RUN   TestFSListRejectsTraversal/dot-dot_escape
=== RUN   TestFSListRejectsTraversal/symlink_escape
--- PASS: TestFSListRejectsTraversal (0.00s)
    --- PASS: TestFSListRejectsTraversal/dot-dot_escape (0.00s)
    --- PASS: TestFSListRejectsTraversal/symlink_escape (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api  0.276s
```

Pinned build and vet:

```text
$ CGO_ENABLED=0 go build ./...
(no output; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no output; exit 0)
```

Uncached full suite:

```text
$ CGO_ENABLED=0 go test -count=1 ./...
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.432s
?    github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd  [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/cmd/runner  [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api  1.790s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger  1.926s
?    github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper  [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror  0.506s
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness  [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto  0.839s
?    github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest  [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session  1.683s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state  1.405s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch  1.379s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets  1.188s
```

Parity harness:

The first invocation found the lane checkout's absent ignored frontend dependency link and stopped before daemon launch:

```text
$ node prettygo/parity/run.mjs
Error: spawn /Users/uzair/pretty-PTY-gaps/frontend/node_modules/.bin/vite ENOENT
```

After temporarily linking the already-installed frontend dependencies from the source checkout, the isolated harness completed; the link was removed afterward and both harness scratch roots were removed:

```text
$ node prettygo/parity/run.mjs
{"httpIdentical":true,"wsIdentical":false,"frontendPassed":true}
```

The required HTTP verdict is green. The regenerated `prettygo/parity/artifacts/report.json` also shows `/api/fs/list` changing from `404` to `200`, `failedResponses: []`, and `consoleErrors: []`; the browser also called `/api/claude-sessions` without a failed response. The harness's WS verdict remains its pre-existing `false` because the captured asynchronous frame order/count differs between daemons; it was already `false` in the pre-lane artifact and is outside this HTTP route-gap sweep.

No commit was created.
