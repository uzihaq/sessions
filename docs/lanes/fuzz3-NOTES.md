# FUZZ3 notes — codexapp + claudep structured-event hardening

Date: 2026-07-17

Scope stayed inside `prettygo/internal/codexapp`,
`prettygo/internal/claudep`, and this notes file. No commit was created. Tests
used only package fakes, Go's fuzz cache, and scratch directories under `/tmp`;
no real Codex/Claude turn or installed daemon was used. No assertion was
weakened and no skip was added.

## Product bugs found and fixed

1. **A Codex notification with no `turnId` could mutate an active turn.**
   `turnState.acceptTurnID` treated the empty string as a wildcard, so an
   external event containing the active `threadId` but omitting `turnId` could
   append agent text, usage, or even complete the wrong turn. The failing
   regression reported:

   ```text
   notification without turn id mutated active turn: "untrusted"
   ```

   Recognized notifications now pass through `parseServerEvent`, which requires
   non-empty thread/turn IDs and validates nested items, timestamps, and token
   counts before state mutation. `acceptTurnID` also rejects empty IDs as
   defense in depth. Regression seed:
   `internal/codexapp/testdata/fuzz/FuzzParseServerEvent/missing-turn-id`.

2. **A malformed JSON-RPC frame terminated the entire Codex client.** A decode
   error called `Client.fail`, aborting unrelated pending calls and active
   turns. The production read loop now skips an uncorrelatable malformed frame
   and continues with later valid traffic. A deterministic regression proves a
   truncated frame followed by `turn/completed` still completes the active
   turn. Corpus seeds include
   `internal/codexapp/testdata/fuzz/FuzzDecodeJSONRPC/truncated-frame`,
   `non-utf8`, and `malformed-id`.

3. **Claude results without a session ID were accepted as authoritative.** A
   `result` record lacking `session_id` set `sawResult`, so garbage could close
   the expected session's turn and poison its history. The failing regression
   reported:

   ```text
   NormalizeEvent accepted result without session id
   ```

   Every normalized native event now requires a nonblank `session_id`, and the
   production line parser requires an exact match with the turn's expected
   session. Missing/foreign events are rejected before history emission or
   result accumulation. Regression seeds:
   `internal/claudep/testdata/fuzz/FuzzParseStreamJSONLine/missing-session-id`
   and `foreign-session-id`.

4. **Malformed Claude result, usage, and assistant content shapes were silently
   accepted.** A non-string/missing `result` became an empty successful result;
   arbitrary `usage` shapes, non-boolean `is_error`, malformed `subtype`, and
   malformed content blocks were normalized into history. Result text is now
   required to be a string, `is_error` must be boolean, a supplied subtype must
   be a nonblank string, usage must be an object with non-negative integer token
   counters, and assistant message/content/text shapes are validated. Decoding
   uses `json.Number` so large integers are not silently rounded. Regression
   seeds include `malformed-result`, `malformed-is-error`, `malformed-usage`,
   and `partial-json`.

No panic or process crash was found in the final fuzz runs. The bugs above were
real malformed-input state-corruption/client-availability defects exposed by
the adversarial cases and fixed in the owned packages.

## Coverage added

- `FuzzDecodeJSONRPC` feeds arbitrary complete/truncated/non-UTF-8 bytes into
  the production JSON-RPC envelope decoder. Every successful decode must be
  valid JSON, classifiable by method or ID, and carry only a string/number ID.
- `FuzzParseServerEvent` mutates the notification method and payload across
  deltas, item start/completion, usage, and turn completion. Every accepted
  event must retain non-empty thread/turn correlation, marshal safely, and be
  safe to project into canonical history.
- `FuzzParseStreamJSONLine` covers partial JSON, unknown forward-compatible
  types, missing/foreign sessions, malformed result/usage/content, non-UTF-8,
  and array mutations. Every accepted record must retain the expected session
  and canonical source, and normalization must be idempotent.
- `TestEventQueueConcurrentProducerConsumer` drives 5,000 events from a
  producer while a consumer drains the public stream, then independently waits
  for the completed result. It is included in the package `-race` gate.
- Duplicate, late, and out-of-order Codex notification coverage proves a
  completed result cannot be reopened or poisoned. Interleaved Claude session
  coverage proves only records matching the expected session enter history.
- `TestParseStreamJSONLineHandlesGiantContentArray` parses 8,192 text blocks
  and verifies the complete message. The fuzz corpus retains a 64-block array
  seed without making corpus minimization dominate the soak.

## Gate evidence

All commands below ran from `prettygo`.

### JSON-RPC decoder fuzz — 45 seconds

Command:

```text
CGO_ENABLED=0 go test ./internal/codexapp -run='^$' -fuzz='^FuzzDecodeJSONRPC$' -fuzztime=45s
```

Output:

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/204 completed
fuzz: elapsed: 0s, gathering baseline coverage: 204/204 completed, now fuzzing with 11 workers
fuzz: elapsed: 3s, execs: 370144 (123378/sec), new interesting: 23 (total: 227)
fuzz: elapsed: 6s, execs: 786542 (138784/sec), new interesting: 37 (total: 241)
fuzz: elapsed: 9s, execs: 1199873 (137775/sec), new interesting: 49 (total: 253)
fuzz: elapsed: 12s, execs: 1639687 (146613/sec), new interesting: 60 (total: 264)
fuzz: elapsed: 15s, execs: 2028502 (129614/sec), new interesting: 67 (total: 271)
fuzz: elapsed: 18s, execs: 2418358 (129930/sec), new interesting: 73 (total: 277)
fuzz: elapsed: 21s, execs: 2772065 (117919/sec), new interesting: 84 (total: 288)
fuzz: elapsed: 24s, execs: 3234172 (154026/sec), new interesting: 90 (total: 294)
fuzz: elapsed: 27s, execs: 3662894 (142876/sec), new interesting: 96 (total: 300)
fuzz: elapsed: 30s, execs: 4115749 (150984/sec), new interesting: 101 (total: 305)
fuzz: elapsed: 33s, execs: 4560847 (148375/sec), new interesting: 105 (total: 309)
fuzz: elapsed: 36s, execs: 5011533 (150236/sec), new interesting: 108 (total: 312)
fuzz: elapsed: 39s, execs: 5444920 (144444/sec), new interesting: 114 (total: 318)
fuzz: elapsed: 42s, execs: 5887845 (147649/sec), new interesting: 117 (total: 321)
fuzz: elapsed: 45s, execs: 6267561 (126581/sec), new interesting: 119 (total: 323)
fuzz: elapsed: 45s, execs: 6267561 (0/sec), new interesting: 119 (total: 323)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/codexapp  45.766s
```

### Codex server-event fuzz — 45 seconds

Command:

```text
CGO_ENABLED=0 go test ./internal/codexapp -run='^$' -fuzz='^FuzzParseServerEvent$' -fuzztime=45s
```

Output:

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/149 completed
fuzz: elapsed: 0s, gathering baseline coverage: 149/149 completed, now fuzzing with 11 workers
fuzz: elapsed: 3s, execs: 422905 (140967/sec), new interesting: 30 (total: 179)
fuzz: elapsed: 6s, execs: 900390 (159108/sec), new interesting: 44 (total: 193)
fuzz: elapsed: 9s, execs: 1308196 (135935/sec), new interesting: 56 (total: 205)
fuzz: elapsed: 12s, execs: 1753955 (148629/sec), new interesting: 66 (total: 215)
fuzz: elapsed: 15s, execs: 2171781 (139253/sec), new interesting: 79 (total: 228)
fuzz: elapsed: 18s, execs: 2586775 (138356/sec), new interesting: 86 (total: 235)
fuzz: elapsed: 21s, execs: 3011459 (141533/sec), new interesting: 89 (total: 238)
fuzz: elapsed: 24s, execs: 3438416 (142275/sec), new interesting: 95 (total: 244)
fuzz: elapsed: 27s, execs: 3840686 (134133/sec), new interesting: 99 (total: 248)
fuzz: elapsed: 30s, execs: 4286071 (148481/sec), new interesting: 105 (total: 254)
fuzz: elapsed: 33s, execs: 4750238 (154724/sec), new interesting: 107 (total: 256)
fuzz: elapsed: 36s, execs: 5229467 (159702/sec), new interesting: 113 (total: 262)
fuzz: elapsed: 39s, execs: 5698803 (156445/sec), new interesting: 116 (total: 265)
fuzz: elapsed: 42s, execs: 6171592 (157643/sec), new interesting: 120 (total: 269)
fuzz: elapsed: 45s, execs: 6636543 (154983/sec), new interesting: 121 (total: 270)
fuzz: elapsed: 45s, execs: 6636543 (0/sec), new interesting: 121 (total: 270)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/codexapp  45.440s
```

### Claude stream-JSON line fuzz — 45 seconds

Command:

```text
CGO_ENABLED=0 go test ./internal/claudep -run='^$' -fuzz='^FuzzParseStreamJSONLine$' -fuzztime=45s
```

Output from the final target/corpus:

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/349 completed
fuzz: elapsed: 0s, gathering baseline coverage: 349/349 completed, now fuzzing with 11 workers
fuzz: elapsed: 3s, execs: 990758 (330239/sec), new interesting: 9 (total: 358)
fuzz: elapsed: 6s, execs: 1970782 (326576/sec), new interesting: 12 (total: 361)
fuzz: elapsed: 9s, execs: 2867717 (299071/sec), new interesting: 14 (total: 363)
fuzz: elapsed: 12s, execs: 3527159 (219814/sec), new interesting: 19 (total: 368)
fuzz: elapsed: 15s, execs: 4204597 (225811/sec), new interesting: 21 (total: 370)
fuzz: elapsed: 18s, execs: 4923959 (239789/sec), new interesting: 22 (total: 371)
fuzz: elapsed: 21s, execs: 5544903 (206984/sec), new interesting: 22 (total: 371)
fuzz: elapsed: 24s, execs: 6155420 (203486/sec), new interesting: 24 (total: 373)
fuzz: elapsed: 27s, execs: 6715369 (186607/sec), new interesting: 25 (total: 374)
fuzz: elapsed: 30s, execs: 7331272 (205360/sec), new interesting: 25 (total: 374)
fuzz: elapsed: 33s, execs: 8403405 (357276/sec), new interesting: 27 (total: 376)
fuzz: elapsed: 36s, execs: 9410601 (335811/sec), new interesting: 29 (total: 378)
fuzz: elapsed: 39s, execs: 9931220 (173504/sec), new interesting: 32 (total: 381)
fuzz: elapsed: 42s, execs: 10262232 (110334/sec), new interesting: 32 (total: 381)
fuzz: elapsed: 45s, execs: 11201881 (313308/sec), new interesting: 32 (total: 381)
fuzz: elapsed: 46s, execs: 11201881 (0/sec), new interesting: 32 (total: 381)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/claudep  46.484s
```

### Race

Command:

```text
go test ./internal/codexapp ./internal/claudep -race -count=1
```

Output:

```text
ok  github.com/uzihaq/pretty-pty/prettygo/internal/codexapp  1.297s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/claudep   1.634s
```

### CGO-disabled build and vet

Commands:

```text
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
```

Both exited 0 with no output.

### Full suite

Command:

```text
CGO_ENABLED=0 go test ./... -count=1
```

Output:

```text
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty                 2.607s
?    github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd               [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/cmd/runner                [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api              5.706s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/backup           1.086s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/claudep          0.286s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/codexapp         1.438s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/integrations     0.855s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/interop          6.662s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger           4.899s
?    github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/migrate          3.316s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror           2.220s
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto            1.671s
?    github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest  [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/recovery         3.266s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session          2.723s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state            2.859s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/verdict          2.648s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/waitcond         5.214s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch            2.659s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets        2.004s
```

`git diff --check` also exited 0 with no output.
