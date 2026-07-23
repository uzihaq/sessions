# sessionsd HTTP API contract

This document records the behavior of the normative TypeScript implementation,
principally `runtime/testdata/node-runtime/src/http.ts`. It describes observed compatibility behavior,
including quirks; it is not a redesign.

## Listener and common behavior

- The default listener is `127.0.0.1:8787`. `SESSIONS_HOST` and
  `SESSIONS_PORT` override it. The server refuses `0.0.0.0`, `::`, `::0`, and
  `*` with process exit status 2.
- All JSON replies are compact `JSON.stringify` output with
  `Content-Type: application/json`. Except for static-file replies and the
  plain-text snapshot success response, every reply also sets:
  - `Vary: Origin`
  - `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`
  - `Access-Control-Allow-Headers: content-type, authorization`
  - `Access-Control-Allow-Origin: <request Origin>` only when the Origin is
    allowed as described below.
- Every `OPTIONS` request, regardless of path, returns 204 before auth or route
  matching. `send()` supplies `{}`, but Node suppresses the body for 204.
- JSON bodies are limited to 2 MiB. An empty body decodes as `{}`. Invalid JSON
  and an oversized body become the route's documented error response.
- A method/path combination not matched below reaches `404
  {"error":"not found","path":"<pathname>"}` after auth. Thus a wrong method
  on an API path normally requires auth before returning 404.
- An uncaught handler error is converted by `server.ts` to 500
  `{"error":"<message>"}`. That outer error path does not add the normal CORS
  headers.

## Authentication

`GET /api/health`, `GET /api/health/deep`, every `OPTIONS` request, and static
GETs are exempt. Every other HTTP route requires either:

- `Authorization: Bearer <token>`, or
- `?token=<token>`.

The token comparison is constant-time after an equal-length check. The token is
64 lowercase hex characters stored in `~/.local/state/sessions/token`; it is
created lazily on the first protected request if no valid token exists. A
present `~/.local/state/sessions/open` file bypasses token auth. Failed auth is
`401 {"error":"unauthorized"}`.

## Origin and CORS rules

An absent `Origin` is allowed. A present value must parse as a URL and satisfy
one of these rules:

1. its serialized origin is `https://sessions.somewhere.tech` or the platform's
   canonical redirect target `https://sessions.somewhere.site`;
2. its hostname is exactly `127.0.0.1`, `localhost`, or `::1`; or
3. its hostname is exactly the configured bind host.

Scheme and port are unrestricted for the hostname rules. The two hosted values
are serialized-origin matches, so another scheme or port fails. For HTTP, a
disallowed or malformed Origin does **not** reject the request; it merely omits
`Access-Control-Allow-Origin`, leaving browser CORS enforcement to block access.
The WebSocket rule is stricter; see `ws.md`.

## Shared object schemas

### `SessionInfo`

The session create response and each member of a session list have these JSON
fields. Optional fields are omitted when their value is `undefined`.

| Field | JSON type | Meaning |
| --- | --- | --- |
| `id` | string | daemon-generated UUID |
| `name` | string, optional | trimmed caller label |
| `cmd` | string | launched command |
| `args` | string[] | effective arguments, including daemon-injected tool defaults |
| `cwd` | string | working directory |
| `profile` | string, optional | Claude or Codex login profile name |
| `config_dir` | string, optional | private profile root used for conversation resolution |
| `worktree_path` | string, optional | Sessions-created worktree path recorded in the ledger |
| `branch` | string, optional | Sessions-created branch checked out in `worktree_path` |
| `base` | string, optional | ref the Sessions-created branch started from and must merge into before cleanup |
| `source_repo` | string, optional | source checkout from which Sessions created the worktree |
| `cols` | number | current PTY columns |
| `rows` | number | current PTY rows |
| `createdAt` | number | Unix epoch milliseconds reported by the runner |
| `pid` | number | PTY child PID |
| `tool` | `"claude-code" \| "codex" \| "terminal"` | classification derived from `cmd` |
| `working` | boolean | current activity classification |
| `lastDataAt` | number | Unix epoch milliseconds of latest PTY output |
| `lastUserMessageAt` | number or null | latest real structured user-message time |
| `exited` | boolean | whether an EXIT frame was received |
| `exitCode` | number or null | PTY exit code |
| `exitSignal` | string or null | PTY exit signal as a string |
| `exitedAt` | number or null | Unix epoch milliseconds when EXIT was received |
| `claudeCustomTitle` | string, optional | latest Claude `custom-title` value |
| `claudeAiTitle` | string, optional | latest Claude `ai-title` value |
| `onIdle` | string, optional | trimmed per-session idle hook command |
| `model` | string, optional | model parsed from effective arguments |
| `effort` | string, optional | effort parsed from effective arguments |
| `fast` | boolean, optional | present as `true` for Codex priority service tier; otherwise omitted |

Exited sessions remain in the daemon map for 30 seconds. They are omitted from
the default list but can be requested with `include_exited=1` during that grace
period.

### Standard error bodies

Error strings originating from Node, the filesystem, JSON parsing, launchd, or
session creation are passed through as strings. Consumers must not depend on
such platform-dependent text. The literal error bodies listed per route are
stable source literals.

## Routes

### `GET /api/health`

No auth. Returns 200:

```json
{
  "ok": true,
  "name": "sessionsd",
  "version": "0.1.0",
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "system": { "os": "darwin", "arch": "arm64" },
  "discovering": false,
  "sessionsLoaded": 0
}
```

`host`, `port`, `system`, `discovering`, and the count vary. `system.os` uses
Go's stable platform names (`darwin`, `windows`, `linux`, and so on) so native
clients can choose a machine icon without guessing from a hostname. The count
includes exited sessions still in their 30-second grace period.

### `GET /api/health/deep`

No auth. Returns 200:

```json
{
  "ok": true,
  "name": "sessionsd",
  "version": "0.1.0",
  "discovering": false,
  "sessionsLoaded": 1,
  "uptimeSec": 12,
  "sessions": [
    {
      "id": "<id>",
      "tool": "terminal",
      "cols": 300,
      "rows": 50,
      "pid": 12345,
      "working": false,
      "exited": false,
      "claudeEvents": 0,
      "lastDataAgeMs": 42
    }
  ]
}
```

`uptimeSec` is rounded `process.uptime()`. `claudeEvents` is the absolute count
including events evicted from the in-memory front. `lastDataAgeMs` is computed
at request time.

### `GET /api/push/vapid`

Auth required. Returns `200 {"publicKey":"<base64url string>"}`. It lazily
loads or generates VAPID keys. Failure returns `500 {"error":"<message>"}`.

### `POST /api/push/subscribe`

Auth required. JSON body:

```json
{
  "endpoint": "https://push.example/subscription",
  "expirationTime": null,
  "keys": { "p256dh": "<non-empty string>", "auth": "<non-empty string>" }
}
```

`expirationTime` may be omitted, null, or a number. All other shown fields are
required and non-empty strings. A subscription with the same endpoint replaces
the old record. Success is `200 {"ok":true}`. Invalid input, invalid JSON, or an
oversized body is `400 {"error":"<message>"}`; invalid shape specifically uses
`"invalid push subscription"`.

### `POST /api/push/unsubscribe`

Auth required. Body is `{"endpoint":"<non-empty string>"}`. It removes every
stored record with that endpoint; absence is still success. Responses:

- `200 {"ok":true}`
- `400 {"error":"endpoint is required"}` for missing, empty, or non-string
  endpoint
- `400 {"error":"<message>"}` for JSON/body errors

### `GET /api/sessions`

Auth required. Query `include_exited=1` is the only value that includes exited
sessions. Other values and duplicates do not. Returns 200:

```json
{"sessions":[/* SessionInfo objects */]}
```

The order is the daemon map's insertion order; the route does not sort.

### `POST /api/sessions`

Auth required. Every request field is optional:

| Field | JSON type | Source behavior/default |
| --- | --- | --- |
| `cmd` | string | `$SHELL`, else `/bin/bash` |
| `args` | string[] | `[]`; Claude/Codex full-access defaults may be appended |
| `cwd` | string | `$HOME`, else OS home; must exist and be a directory |
| `cols` | number | 300 |
| `rows` | number | 50 |
| `env` | object of string values | caller environment after filtering reserved/injection keys |
| `name` | string | trimmed; empty becomes absent |
| `profile` | string | optional `[a-z0-9-]{1,32}` Claude/Codex login profile; rejected for shell sessions |
| `worktree` | boolean | when true, create an isolated Git worktree and use it as `cwd` |
| `base` | string | optional worktree base ref; requires `worktree`; defaults to the source checkout's current branch |
| `onIdle` | string | trimmed; empty becomes absent |
| `waitReady` | boolean | only literal `true` waits for readiness, capped at 30 seconds |

`RUNNER_*`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, and
`LD_PRELOAD` caller keys are stripped. Known Claude/Codex commands receive
default full-access arguments unless any explicit mode flag is already present.
Success is 201 with a bare `SessionInfo` object, not an envelope. Any caught
failure is `400 {"error":"<message>"}`. Creating a session invokes launchd;
there is no non-launchd create path in the normative implementation.

Profile directories are created mode `0700` below
`<UserStateRoot>/profiles/<tool>/<name>`. A profiled Claude launch receives
`CLAUDE_CONFIG_DIR`; a profiled Codex launch receives `CODEX_HOME`. Unprofiled
launches receive neither variable. The daemon records `profile` and
`config_dir` in runner metadata and the created ledger payload, then uses the
same root for watcher, transcript, search, backup, and recovery resolution
([`internal/session/profiles.go`](../internal/session/profiles.go),
[`internal/state/registry.go`](../internal/state/registry.go),
[`internal/backup/sessions.go`](../internal/backup/sessions.go)).

### `GET /api/profiles`

Auth required. Returns profile directories by tool and name, including their
path, currently active sessions, and last-used Unix milliseconds:

```json
{"profiles":[{"tool":"claude","name":"work","path":"/Users/me/.local/state/sessions/profiles/claude/work","sessions":[],"last_used":1784491200000}]}
```

Sessions exposes no profile deletion route because these directories contain
provider credentials. Listing is implemented by
[`internal/api/profiles_handlers.go`](../internal/api/profiles_handlers.go) and
[`internal/session/profiles.go`](../internal/session/profiles.go).

The optional worktree request and response fields are a backward-compatible Go
extension implemented by [`internal/state/types.go`](../internal/state/types.go)
and [`internal/session/worktrees.go`](../internal/session/worktrees.go).

### `GET /api/worktrees`

Auth required. Returns worktrees created by Sessions according to ledger
provenance, never arbitrary Git worktrees. Each result includes `session`,
`session_name`, `worktree_path`, `branch`, `base`, `source_repo`, `tree_state`,
`dirty`, `merged_into_base`, `session_state`, `exists`, and an optional
`inspection_error`:

```json
{"worktrees":[]}
```

The route is implemented in
[`internal/api/worktrees_handlers.go`](../internal/api/worktrees_handlers.go);
Git inspection and ledger filtering live in
[`internal/session/worktrees.go`](../internal/session/worktrees.go).

### `POST /api/worktrees/clean`

Auth required. Body is `{"dry_run":true|false}`. Cleanup considers only
Sessions-created worktrees and removes one only when its session is durably
exited, its tree is clean, and its branch is fully merged into its recorded
base. It uses non-forced Git removal and branch deletion; all ineligible or
refused operations return `action:"skipped"` with a `reason`. Dry-run returns
`action:"would-remove"` without changing the repository. Success is:

```json
{"results":[],"dry_run":true}
```

There is no force option, and session kill does not call this route
([`internal/session/worktrees.go`](../internal/session/worktrees.go),
[`internal/session/manager.go`](../internal/session/manager.go)).

### `DELETE /api/sessions/:id`

Auth required. Sends a runner KILL frame but leaves removal to the runner EXIT
path. Responses:

- known map entry: `200 {"ok":true}`
- unknown entry: `404 {"ok":false}`

### `GET /api/sessions/:id/snapshot`

Auth required. Optional `cols=N` is converted with `Number`, truncated through a
32-bit integer operation, and clamped to at least zero. A positive value asks
the daemon for ANSI-aware reflow; non-positive/invalid values select the
canonical snapshot.

Success is 200 with `Content-Type: text/plain; charset=utf-8`, the serialized
xterm buffer as the body, and `X-Sessions-Seq: <decimal sequence>`. If an allowed
Origin was present it also sets that ACAO value and
`Access-Control-Expose-Headers: X-Sessions-Seq`. The success path does not set
`Vary` or the common allow-method/header fields. Unknown session is
`404 {"error":"unknown session","id":"<id>"}`.

### `GET /api/sessions/:id/events`

Auth required. The event values are passthrough structured Claude records (and
normalized Codex records) represented as arbitrary JSON objects. Returns 200:

```json
{
  "events": [],
  "nextIndex": 0,
  "totalCount": 0,
  "startIndex": 0,
  "endIndex": 0
}
```

All indices are absolute. Let `base` be the number evicted from the front and
`len` the retained count; `total = base + len`.

- `before=n`, when finite and non-negative, caps the exclusive end to `n`.
- `since=n`, when finite and non-negative, moves the start to `n`, bounded by
  the selected end.
- `tail=n`, when finite and positive, moves the start to at most the last
  `floor(n)` entries before the selected end. It composes with `since` by taking
  the later start.
- Invalid, negative, and (for `tail`) zero values are ignored.
- `nextIndex` and `totalCount` are always `total`, even for a window ending
  before the current end. `startIndex`/`endIndex` describe the returned window.

Unknown session is `404 {"error":"unknown session","id":"<id>"}`.

### `POST /api/sessions/:id/input`

Auth required. Body is `{"data":"<raw UTF-8 terminal bytes>"}`. A missing or
null `data` becomes the empty string. Responses:

- live known session: `200 {"ok":true}`
- unknown or exited session: `404 {"ok":false}`
- JSON/body/runtime error: `400 {"error":"<message>"}`

### `POST /api/sessions/:id/upload`

Auth required. The request body is raw bytes, not JSON. Optional header
`X-Sessions-Filename` defaults to `file`; `Content-Type` is accepted but not used
in the saved name or response. The filename is reduced to its basename,
characters outside `[A-Za-z0-9_. -]` become `_`, and the result is limited to
96 characters. The stored name is `<stem>-<first 8 chars of random UUID><ext>`.

The destination is the fixed `~/.local/state/sessions/uploads/` directory,
not the runner `SESSIONS_STATE_DIR`. Responses:

- `200 {"path":"<absolute path>","size":<byte count>}`
- `404 {"error":"unknown session","id":"<id>"}` before reading the body
- `413 {"error":"file too large","max":26214400}` once the body exceeds 25
  MiB; the remainder is drained and no file is written
- `500 {"error":"<message>"}` for filesystem/read errors

### `GET /api/claude-sessions`

Auth required. Scans `~/.claude/projects/*/*.jsonl`, skips unreadable entries,
and sorts newest first. Returns 200:

```json
{
  "sessions": [
    {
      "sessionId": "<filename without .jsonl>",
      "cwd": "/decoded/project/path",
      "modifiedAt": 1750000000000,
      "firstUserMessage": "first user text, whitespace folded, max 200 chars",
      "sizeBytes": 1234
    }
  ]
}
```

The cwd decoder replaces every `-` in the project directory name with `/`, a
deliberately lossy mapping. An absent projects directory yields an empty list.

### `GET /api/resumable-conversations`

Auth required. This is the provider-neutral successor to
`GET /api/claude-sessions`. It scans the local Claude and Codex stores,
deduplicates resumed Codex rollout files by provider conversation identity,
and returns newest first:

```json
{
  "sessions": [
    {
      "sessionId": "<provider conversation UUID>",
      "tool": "claude",
      "origin": "Claude Code",
      "cwd": "/absolute/workspace",
      "modifiedAt": 1750000000000,
      "firstUserMessage": "bounded local preview",
      "sizeBytes": 1234
    }
  ]
}
```

`tool` is `claude` or `codex`. The endpoint is read-only and does not copy a
transcript. A native client may pass the chosen `sessionId` to the existing
`POST /api/recovery/adopt` boundary; the recovery layer still applies its live,
moved, collision, and explicit-provider guards before creating a Sessions
lane. The legacy Claude-only route retains its original response shape.

### `GET /api/directories`

Auth required. Returns `200 {"directories":[...]}`. Each entry is:

```json
{"path":"/absolute/path","label":"~/sessions/path","kind":"home"}
```

`kind` is `home`, `common`, or `project`. The source adds the home directory,
existing common child names, then project-shaped children containing one of
`.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`. Duplicates
and nonexistent paths are skipped; the result is capped approximately (not
strictly) around 50 by the outer scan logic.

### `GET /api/fs/list`

Auth required. Optional query `path` defaults to the OS home directory. It must
be absolute. The path and home are realpath-resolved when possible, and the
canonical path must equal the canonical home or be below it.

Success is 200:

```json
{
  "path": "/canonical/absolute/directory",
  "parent": "/canonical/absolute",
  "entries": [
    {"name":"child","kind":"dir","hidden":false}
  ]
}
```

`parent` is null only at the canonical home. Entry `kind` is `dir`, `file`,
`symlink`, or `other`; symlinks to readable directories/files are reported by
their target kind, while an unresolved symlink remains `symlink`. Entries sort
directories first, then locale-alphabetically with base sensitivity.

Errors:

- relative input: `400 {"error":"path must be absolute"}`
- outside home: `403 {"error":"path outside home directory","path":"<canonical>"}`
- non-directory: `400 {"error":"not a directory","path":"<canonical>"}`
- caught filesystem error: status 404 for `ENOENT`, 403 for `EACCES`, otherwise
  500, with `{"error":"<message>","code":"<errno code>"}`. Because nonexistent
  input first falls back to `path.resolve`, the eventual `statSync` normally
  supplies the `ENOENT` 404.

## Go runtime extensions: smart search

The following authenticated routes are additive Go-runtime surfaces implemented
by `internal/api/search_handlers.go`; older `prettyd` builds return the standard
404 body for them.

### `GET /api/ai/settings`

Returns the smart-feature provider as `200 {"provider":"codex"}` or
`200 {"provider":"claude"}`. A missing setting defaults to `codex`; the default
does not itself launch a model.

### `PUT /api/ai/settings`

Accepts `{"provider":"codex"}` or `{"provider":"claude"}`, persists the
normalized choice in daemon settings, and returns it. Unknown providers or
invalid JSON return 400; persistence errors return 500. Other methods return
405.

## Go runtime extension: Claude launch defaults

### `GET /api/claude/settings`

Returns the effective typed defaults Sessions applies only to newly launched
Claude sessions:

```json
{"remoteControl":"inherit","permissionMode":"bypassPermissions","model":"","effort":"inherit","chrome":"inherit","somewhereMcp":"inherit","remoteControlNamePrefix":""}
```

Remote Control and Chrome accept `inherit`, `on`, or `off`; permission mode
accepts Claude's supported modes plus `inherit`; effort accepts `inherit`,
`low`, `medium`, `high`, `xhigh`, or `max`; Somewhere MCP accepts `inherit` or
`ensure`. Empty model and name-prefix fields preserve provider defaults.

### `PUT /api/claude/settings`

Validates and atomically persists the complete object above. The daemon never
edits Claude settings files or stores provider credentials. Unknown choices,
control characters, overlong strings, invalid JSON, and unsupported methods
return 400 or 405 as appropriate.

`POST /api/sessions` may include a `claude` object with the same fields.
Non-empty values override the persisted Sessions defaults for that launch;
explicit `inherit` defers that setting to Claude. The object is rejected for a
non-Claude command. `somewhereMcp: "ensure"` adopts an equivalent existing
registration or injects the local `somewhere mcp` stdio adapter; a conflicting
server named `somewhere` fails closed rather than being overwritten.

### `POST /api/search/plan`

Accepts `{"query":"the session where I discussed Apple signing"}`. The query
is trimmed and limited to 4 KiB, then sent as untrusted data in one tool-disabled,
customization-isolated request to the configured, already-authenticated Codex or Claude CLI. Sessions
sends no transcripts, snippets, session IDs, results, or index content. The CLI
chooses its own default model. Success returns the bounded FTS5 plan:

```json
{"provider":"codex","query":"apple AND signing"}
```

The browser applies that query through the existing local `GET /api/search`
route and keeps `role` and `tool` filters deterministic. Empty/oversized input
returns 400. Only one planner request may be active; another distinct request
returns 429 with `Retry-After: 2`. Successful plans for an identical provider
and normalized natural query are cached for ten minutes. Planner or provider
failures return 502, and other methods return 405. The handler deadline is two
minutes. Cache keys are SHA-256 digests, the cache holds at most 128 plans, and
entries are evicted on their expiry timer even without another lookup.

## Go runtime extension: bounded history preview

The existing authenticated `GET /api/history/<id>` route remains complete by
default. Native interactive viewing requests the distinct
`GET /api/history/<id>/preview?format=json` path, which reads at most the latest 2 MiB of the JSONL
artifact and returns at most its latest 400 normalized messages. The additive
response field `"truncated":true` appears when either bound removed older
content; it is omitted for a complete preview. This bound does not change the
deliberate full-history JSON/text response or `/api/history/<id>/raw` download.
The distinct path is intentional: an older runtime returns 404 instead of
silently ignoring a query parameter and sending an unbounded transcript.

## Static GETs

A GET is treated as static when its path does not start `/api/`, is not exactly
`/api`, and does not start `/ws`. Static serving is unauthenticated.

The web root is `SESSIONS_WEB_DIR` when set; otherwise it prefers
`frontend/dist` and falls back to the package's bundled `web`. Paths are URI
decoded, normalized, and constrained below that root. A readable exact file or
directory `index.html` is served; otherwise the web-root `index.html` is served
as the SPA fallback. If no web build is available, response is
`404 {"error":"web build not found","path":"<absolute web root>"}`. An invalid
decode or traversal candidate is `400 {"error":"invalid path"}`.

Success has only a 200 status and inferred `Content-Type`; it does not add the
common CORS headers. Recognized extensions are HTML, JS, CSS, JSON, SVG, PNG,
JPEG, WebP, ICO, webmanifest, WOFF/WOFF2, TTF, OTF, and WASM; everything else is
`application/octet-stream`. A stream error is a JSON `{"error":"<message>"}`
body with 500 only if headers have not already been sent.
