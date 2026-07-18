# APIFUZZ lane notes

Date: 2026-07-17

Scope: `prettygo/internal/api`, exercised only with scratch directories, in-memory fake runners, and `httptest`. The installed daemon on `:8787` was not used. No commit was made.

## Product bugs fixed

1. **Static-file symlink traversal escape.** The static handler checked only the lexical absolute path and then used `os.Stat`/`os.Open`, so a symlink below `WebDir` could serve an arbitrary regular file outside `WebDir` without authentication. Fixed by opening the configured directory with `os.OpenRoot`, checking the canonical target, and serving only root-confined file descriptors. Permanent seed: `TestStaticSymlinkCannotEscapeWebRoot` (`/escape.txt` -> an outside secret).
2. **Upload symlink traversal escape.** A pre-existing `~/.local/state/pretty-PTY/uploads` symlink could redirect an upload outside the user's home. Fixed by canonical containment validation plus `os.OpenRoot(home).MkdirAll/WriteFile`, which keeps the operation confined even if a path component changes concurrently. Permanent seed: `TestUploadSymlinkCannotEscapeHome` with filename `../../escape.txt` and an outside-target upload-directory symlink.
3. **Oversized-upload hang / unbounded read.** After detecting byte `25 MiB + 1`, the handler called an unbounded `io.Copy` on the remainder. A client that never ended its body could pin the handler indefinitely. The handler now stops after the bounded oversize probe and returns 413. Permanent seed: `TestOversizedUploadStopsAtLimit`, whose body has additional readable data and asserts exactly `maxUploadBody+1` bytes were consumed.
4. **Ambiguous/malformed JSON accepted.** Shared JSON parsing accepted the first valid JSON value and ignored trailing garbage or subsequent values; Go's decoder also silently replaced invalid UTF-8. The parser now performs one capped read, rejects invalid UTF-8, requires exactly one JSON value, and preserves the 2 MiB cap. Permanent seeds in `TestJSONBodiesRejectMalformedAndAmbiguousInput`: truncated JSON, wrong type/huge negative integer, trailing garbage, multiple values, invalid UTF-8, and depth 10,001 nesting.

`GET /api/fs/list` was also moved to root-confined opens. Stable `..` and symlink escapes are rejected before opening, a non-existent tail behind a symlink is canonicalized through its nearest existing ancestor, and child symlinks outside home are reported as symlinks without statting their targets. Existing in-home absolute symlinks retain their documented file/directory classification.

## Adversarial coverage added

- `FuzzRequestRouting` drives the complete handler with mutated method, URL/path/query, body bytes, remote peer, Authorization, Origin, upload filename, and WebSocket-upgrade key.
- Initial corpus covers health/static routing, malformed create/input JSON, huge/negative/non-numeric event indices, encoded static traversal, filesystem traversal, upload filename traversal, garbage and valid external auth, evil and hosted origins, and malformed WS upgrades.
- Every fuzz execution asserts a valid HTTP status, bounded body consumption, safe ACAO echo behavior, valid JSON plus `Vary: Origin` for JSON responses, and safe cleanup of successful scratch uploads.
- `TestMalformedWebSocketUpgradesReturn4xx` covers missing, incomplete, wrong-version, invalid-key, and wrong-upgrade handshake shapes.
- `TestConcurrentSessionHandlers` uses the real session registry with in-memory fake runners: 8 workers x 4 rounds concurrently create, list, snapshot, read events, input, and kill sessions. Status invariants are asserted; the test is included in the race run.

## Gate evidence

From `prettygo/`:

### CGO-disabled build and vet

```text
$ CGO_ENABLED=0 go build ./...
(no output; exit 0)

$ CGO_ENABLED=0 go vet ./...
(no output; exit 0)
```

### API race suite

```text
$ go test ./internal/api -race -count=1
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	7.182s
```

### Required 45-second fuzz run

```text
$ go test ./internal/api -run '^$' -fuzz '^FuzzRequestRouting$' -fuzztime=45s
fuzz: elapsed: 0s, gathering baseline coverage: 0/186 completed
fuzz: elapsed: 0s, gathering baseline coverage: 186/186 completed, now fuzzing with 11 workers
fuzz: elapsed: 3s, execs: 81181 (27058/sec), new interesting: 48 (total: 234)
fuzz: elapsed: 6s, execs: 117132 (11981/sec), new interesting: 64 (total: 250)
fuzz: elapsed: 9s, execs: 129256 (4041/sec), new interesting: 65 (total: 251)
fuzz: elapsed: 12s, execs: 235153 (35308/sec), new interesting: 69 (total: 255)
fuzz: elapsed: 15s, execs: 331995 (32278/sec), new interesting: 75 (total: 261)
fuzz: elapsed: 18s, execs: 483066 (50358/sec), new interesting: 88 (total: 274)
fuzz: elapsed: 21s, execs: 598501 (38481/sec), new interesting: 109 (total: 295)
fuzz: elapsed: 24s, execs: 637607 (13034/sec), new interesting: 137 (total: 323)
fuzz: elapsed: 27s, execs: 664316 (8903/sec), new interesting: 162 (total: 348)
fuzz: elapsed: 30s, execs: 725194 (20293/sec), new interesting: 171 (total: 357)
fuzz: elapsed: 33s, execs: 780957 (18586/sec), new interesting: 178 (total: 364)
fuzz: elapsed: 36s, execs: 835697 (18247/sec), new interesting: 185 (total: 371)
fuzz: elapsed: 39s, execs: 1366520 (176917/sec), new interesting: 202 (total: 388)
fuzz: elapsed: 42s, execs: 1411327 (14939/sec), new interesting: 223 (total: 409)
fuzz: elapsed: 45s, execs: 1463687 (17452/sec), new interesting: 255 (total: 441)
fuzz: elapsed: 46s, execs: 1463687 (0/sec), new interesting: 255 (total: 441)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/api	46.361s
```

### Full suite

```text
$ go test ./... -count=1
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api
ok  github.com/uzihaq/pretty-pty/prettygo/internal/backup
ok  github.com/uzihaq/pretty-pty/prettygo/internal/claudep
ok  github.com/uzihaq/pretty-pty/prettygo/internal/codexapp
ok  github.com/uzihaq/pretty-pty/prettygo/internal/integrations
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger
ok  github.com/uzihaq/pretty-pty/prettygo/internal/migrate
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state
ok  github.com/uzihaq/pretty-pty/prettygo/internal/verdict
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets
```

Packages marked `[no test files]` also completed successfully. Full command exit status: 0.
