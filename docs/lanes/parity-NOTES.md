# Lane: PARITY — results

Run completed `2026-07-16T23:04:13.246Z` with:

```sh
node prettygo/parity/run.mjs
```

Overall verdict: required HTTP response shapes are identical; WS payload shapes
are identical per message type but the complete type sequence is divergent; the
real frontend smoke against the Go daemon passed. The browser also exposed two
Go HTTP routes that are missing relative to the unchanged frontend.

## Isolation

- TypeScript daemon: ephemeral loopback port `60346`, scratch home
  `prettygo/parity/.r/ts/h`, scratch runner state `prettygo/parity/.r/ts/r`.
- Go daemon: ephemeral loopback port `60347`, scratch home
  `prettygo/parity/.r/go/h`, scratch runner state `prettygo/parity/.r/go/r`.
- Session plists were executed by `prettygo/parity/launchctl`, a scratch shim;
  no real LaunchAgent was registered.
- The frontend dist, Go binaries, TS dist, Go build cache, runtime state, and
  runner processes were scratch-only. `.scratch/` and `.r/` were removed after
  the run. Default state and real daemons were never used.

## HTTP parity

Dynamic values (UUIDs, PIDs, timestamps, sequence values, and terminal bytes)
were reduced to JSON/body types. Status and content type remained exact.
`HTTP_PARITY_MARKER` was observed in both daemon snapshots before kill.

| Endpoint/action | Verdict | Observed result |
| --- | --- | --- |
| `POST /api/sessions` | identical | `201 application/json`; bare `SessionInfo` keys and field types identical |
| `GET /api/sessions` | identical | `200 application/json`; envelope/list/member shapes identical |
| `POST /api/sessions/:id/input` | identical | `200 application/json`; `{ok: boolean}` |
| `GET /api/sessions/:id/snapshot` | identical | `200 text/plain; charset=utf-8`; string body and string `X-Pretty-Seq` |
| `GET /api/sessions/:id/events?tail=5` | identical | `200 application/json`; `events`, `nextIndex`, `totalCount`, `startIndex`, and `endIndex` shapes identical |
| `DELETE /api/sessions/:id` | identical | `200 application/json`; `{ok: boolean}` |

## WebSocket parity

The harness used the frontend's multiplexed `/ws?mux=1` protocol, attached a
live bash session with output enabled, sent one input request with a request ID,
and waited for both `inputAck` and `WS_PARITY_MARKER` output.

| Message/sequence | Verdict | Observed result |
| --- | --- | --- |
| `hello` | identical | First message on both; protocol/session/replay field names and types identical |
| `inputAck` | identical | `{type, requestId, sessionId, ok}` field types identical |
| each `output` payload | identical | `{type, seq, data, sessionId}` field types identical |
| complete type sequence | divergent | TS: `hello → output → inputAck → output → output` (5 messages, 3 output frames). Go: 11 messages with the same `hello → output → inputAck` prefix but 9 total output frames. Both delivered the marker. |

## Real frontend smoke on Go

- Served the production Vite build from the Go daemon's static handler.
- Loaded it in Puppeteer, opened **+ New session**, selected **Shell**, typed the
  cwd through the unchanged directory input, and clicked **Start**.
- Browser-observed create request: `POST /api/sessions` returned `201`.
- Typed `printf '%s%s\n' 'FRONTEND_PARITY_' 'MARKER'` through xterm.
- DOM assertion passed: `.xterm-rows` contained `FRONTEND_PARITY_MARKER`.
- Screenshot: `prettygo/parity/artifacts/go-frontend-smoke.png` (1440×900).

The browser captured these auxiliary route failures while the smoke continued
through the UI's typed-cwd path:

| Endpoint | Verdict | Observed result |
| --- | --- | --- |
| `GET /api/fs/list` | divergent | Go returned `404`; the directory picker could not auto-populate |
| `GET /api/claude-sessions` | divergent | Go returned `404` when the new-session dialog initially mounted in its default Claude mode |

## Findings

1. **WS output type sequence has different frame granularity.** The normative TS
   run emitted 3 `output` messages in the captured interaction; Go emitted 9.
   Every output payload shape matched and both streams rendered the marker, but
   the required type-sequence comparison is not identical. TS forwards each
   runner event at `prettyd/src/ws.ts:142-144` and sources chunks from
   `prettyd/src/runner.ts:236-245`; Go forwards at
   `prettygo/internal/api/ws.go:314-339` and creates one event per PTY read at
   `prettygo/cmd/runner/main.go:507-534`. Expected: TS sequence above. Actual:
   the Go sequence contains six additional `output` messages for the same
   driven command.

2. **Go is missing `GET /api/fs/list`.** Expected TS behavior is implemented at
   `prettyd/src/http.ts:289-356`: `200` with `{path,parent,entries}` for the
   scratch home. The Go router has no corresponding branch and reaches the
   generic `404 {error,path}` at `prettygo/internal/api/server.go:157-182`.
   Browser result: `404`. This prevents normal directory-picker navigation and
   auto-population; typing a valid cwd directly allowed the required smoke to
   proceed.

3. **Go is missing `GET /api/claude-sessions`.** Expected TS behavior is
   `200 {sessions:[...]}` at `prettyd/src/http.ts:411-417`. The Go router again
   falls through to `prettygo/internal/api/server.go:177-182`. Browser result:
   `404` on new-session-dialog mount.

No daemon/session/API/frontend source was changed; fixes belong to their owning
lanes.

## Evidence

- Machine-readable capture: `prettygo/parity/artifacts/report.json`
- Screenshot: `prettygo/parity/artifacts/go-frontend-smoke.png`
- Build and daemon logs: `prettygo/parity/artifacts/*.log`
- Re-runnable harness: `prettygo/parity/run.mjs`
