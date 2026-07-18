# CXDEFLAKE lane acceptance notes

## Result

`TestResumeConversationRestoresTurnDefaults` exposed a **product logical race**, named the **delivered-reply-vs-EOF select race**. This was not a test-timing failure and not a Go memory race. `handleResponse` could correlate `turn/start`, remove the call from `pending`, and put the valid result in the call's buffered response channel; the read loop could then process `turn/completed` and EOF before the waiting caller was scheduled. EOF closed the client-wide `done` channel, leaving both the valid response and `done` ready in `call`'s `select`. Go may choose either ready case, so the client sometimes discarded an already-received reply and returned `ErrClosed`. Full-suite CPU pressure widened that scheduling window; the resume/default assertions and the fake protocol ordering were correct.

The fix makes the per-call response channel the only terminal signal for an in-flight call. `handleResponse` sends successful or RPC-error replies there, and `Client.fail` already sends an error to every call still in `pending`. The redundant client-wide `done` channel and its competing `call` select case were removed. A response removed from `pending` can therefore no longer lose to later EOF, while calls that genuinely remain pending at closure still receive the failure. No assertion, timeout, or protocol expectation was weakened, and no sleep or skip was added.

## Reproduction and classification

The ordinary isolated test passed, as expected. Constraining scheduling to one Go processor and repeating the exact test reproduced the load-sensitive interleaving before the fix:

```text
$ GOMAXPROCS=1 CGO_ENABLED=0 go test ./internal/codexapp -run '^TestResumeConversationRestoresTurnDefaults$' -count=10000
--- FAIL: TestResumeConversationRestoresTurnDefaults (0.00s)
    client_test.go:288: start Codex user turn: codex app-server client closed
--- FAIL: TestResumeConversationRestoresTurnDefaults (0.00s)
    client_test.go:288: start Codex user turn: codex app-server client closed
--- FAIL: TestResumeConversationRestoresTurnDefaults (0.00s)
    client_test.go:288: start Codex user turn: codex app-server client closed
FAIL
FAIL    github.com/uzihaq/pretty-pty/prettygo/internal/codexapp    0.864s
FAIL
```

The required race-detector command was already green before the fix (`ok ... 1.724s`), which is consistent with a mutex-safe but semantically racy channel selection. The protocol/code audit above identified the product ordering defect rather than attributing the flake to the test's three-second context.

After the fix, the identical high-repetition reproduction is green:

```text
$ GOMAXPROCS=1 CGO_ENABLED=0 go test ./internal/codexapp -run '^TestResumeConversationRestoresTurnDefaults$' -count=10000
ok      github.com/uzihaq/pretty-pty/prettygo/internal/codexapp    0.946s
```

## Required race gate

Real output from twenty complete `internal/codexapp` race-detector repetitions:

```text
$ go test ./internal/codexapp -race -count=20
ok      github.com/uzihaq/pretty-pty/prettygo/internal/codexapp    1.734s
```

## Required full-suite gate

The full Go suite ran ten consecutive times with cache bypassed for every run. The loop captured each successful `go test` invocation and would have printed its complete output and exited at the first failure.

```text
$ for cxdeflake_run in $(seq 1 10)
> do
>   cxdeflake_started=$SECONDS
>   if cxdeflake_output=$(CGO_ENABLED=0 go test ./... -count=1 2>&1)
>   then
>     printf 'full-suite run %02d PASS (%ds)\n' "$cxdeflake_run" "$((SECONDS-cxdeflake_started))"
>   else
>     printf 'full-suite run %02d FAIL (%ds)\n%s\n' "$cxdeflake_run" "$((SECONDS-cxdeflake_started))" "$cxdeflake_output"
>     exit 1
>   fi
> done
full-suite run 01 PASS (8s)
full-suite run 02 PASS (7s)
full-suite run 03 PASS (6s)
full-suite run 04 PASS (6s)
full-suite run 05 PASS (6s)
full-suite run 06 PASS (7s)
full-suite run 07 PASS (6s)
full-suite run 08 PASS (6s)
full-suite run 09 PASS (7s)
full-suite run 10 PASS (6s)
```

All commands ran inside `/Users/uzair/pretty-PTY-cxdeflake`; no commit was created.
