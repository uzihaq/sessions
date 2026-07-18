# SEARCH lane notes

Date: 2026-07-17

## Result

- Added authenticated `GET /api/search?q=...` to the Go daemon. The handler
  accepts `session`, `role`, `tool`, `regex`, and `limit` query parameters and
  returns `{matches, total}` with the required match fields.
- Added `pretty search <query>` with `--session`, `--role`, `--tool`,
  `--regex`, `-n`, and command-local `--json`. Requests go through the daemon,
  including when `--host` and `--port` select a remote instance.
- Search uses the existing integration history store. That store collects both
  live and persisted runner metadata, resolves Claude JSONL and Codex rollout
  files through the existing watch-backed resolver path, and normalizes Codex
  records through `watch.NormalizeCodexRolloutLine`. Conversation parsing was
  not reimplemented in the search package.
- The search-specific history listing avoids parsing every transcript merely
  to count its messages. Candidate transcripts are read through the same
  normalizer with a 64 MiB per-file bound.
- Default matching is a Unicode-aware, case-insensitive literal substring.
  `--regex` uses a Go regular expression. Each normalized message yields at
  most one result.
- Results default to 100 matches. `-n` selects a cap from 1 through 1000.
  Snippets keep up to 96 runes of context on either side, cap source content at
  240 runes, collapse line breaks for terminal display, add ellipses when
  clipped, and mark the matching span as `[[match]]`.
- Human output groups matches by session and includes its short id, name, tool,
  role, timestamp, and snippet. JSON output includes full text and uses an
  empty array rather than `null` when nothing matches.

## Tests

`internal/search/search_test.go` seeds two fake normalized conversations and
covers:

- case-insensitive substring matches across sessions;
- regex matching;
- session-prefix, role, and tool filters;
- the requested match cap;
- centered, highlighted, clipped snippets;
- the 64 MiB bounded-read request to the history source;
- empty JSON shape, validation errors, and cancellation.

`internal/api/search_handlers_test.go` writes persisted Claude and Codex
fixtures, then proves the HTTP route discovers them through the real resolvers
and normalized history reader. It covers combined filters, regex, limits,
timestamps, invalid parameters, and method rejection.

`cmd/pretty/search_test.go` proves all CLI flags are encoded into the daemon
request, human results are grouped by session, command-local `--json` has the
required shape, and invalid arguments fail before a request.

`internal/integrations/history_test.go` additionally proves a byte limit stops
the normalized reader before a later message.

## Verification

Run from `prettygo/`:

```text
$ CGO_ENABLED=0 go build ./...
[exit 0]

$ CGO_ENABLED=0 go vet ./...
[exit 0]

$ CGO_ENABLED=0 go test ./... -count=1
ok github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
ok github.com/uzihaq/pretty-pty/prettygo/internal/api
ok github.com/uzihaq/pretty-pty/prettygo/internal/integrations
ok github.com/uzihaq/pretty-pty/prettygo/internal/search
ok github.com/uzihaq/pretty-pty/prettygo/internal/watch
... all remaining packages passed
[exit 0]
```

The focused search/integration/API/CLI command also passed independently:

```text
$ CGO_ENABLED=0 go test ./internal/search ./internal/integrations ./internal/api ./cmd/pretty -count=1
ok github.com/uzihaq/pretty-pty/prettygo/internal/search
ok github.com/uzihaq/pretty-pty/prettygo/internal/integrations
ok github.com/uzihaq/pretty-pty/prettygo/internal/api
ok github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
```

## Real local daemon run

Built `cmd/prettyd` and `cmd/pretty` with `CGO_ENABLED=0`, then started the
compiled daemon on `127.0.0.1:18878` with an isolated scratch HOME, runner
state, ledger, and web directory under `/tmp/pretty-search-real.ZV97qJ`.
Persisted runner metadata named `scratch-search-proof` pointed at a scratch
Claude JSONL containing the phrase `cobalt hummingbird` in user and assistant
turns.

Human substring search, limited by an eight-character session prefix:

```text
$ pretty --host 127.0.0.1 --port 18878 search 'cobalt hummingbird' --session 99999999
99999999  scratch-search-proof  claude
  user  2026-07-17T20:00:00Z
    Please remember the local proof phrase [[cobalt hummingbird]] for search.
  assistant  2026-07-17T20:00:02Z
    Recorded [[COBALT HUMMINGBIRD]] in this scratch conversation.
```

Daemon-side regex plus role/tool filters and JSON output:

```text
$ pretty --host 127.0.0.1 --port 18878 --json search 'COBALT[[:space:]]+HUMMINGBIRD' --regex --role assistant --tool claude -n 5
{
  "matches": [
    {
      "session_id": "99999999-1111-4222-8333-444444444444",
      "name": "scratch-search-proof",
      "tool": "claude",
      "role": "assistant",
      "timestamp": "2026-07-17T20:00:02Z",
      "text": "Recorded COBALT HUMMINGBIRD in this scratch conversation.",
      "snippet": "Recorded [[COBALT HUMMINGBIRD]] in this scratch conversation."
    }
  ],
  "total": 1
}
```

The daemon was stopped with SIGINT and logged a clean shutdown. No commit was
created; implementation, tests, and these notes remain scratch worktree
changes. The supplied `docs/lanes/search-SPEC.md` remains unmodified.
