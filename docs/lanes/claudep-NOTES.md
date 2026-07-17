# CLAUDEP lane notes

## Result

Structured Claude is available as an opt-in session kind:

```sh
pretty new --tool claude --structured --cwd /tmp
```

The existing PTY-backed Claude session remains unchanged and remains the
default:

```sh
pretty new --tool claude
```

The structured path uses the logged-in Claude Code subscription. It strips
`ANTHROPIC_API_KEY` from both the launchd runner environment and every
`claude` child process, so it cannot silently switch to metered API-key
billing.

Claude has no dual-view attach protocol for this mode. `pretty attach` reports
that limitation for `claude-structured`; `pretty snap`, `pretty last`, and
`pretty transcript` render the structured history instead. PTY Claude keeps
its normal live TUI and attach behavior.

## Architecture

The new `internal/claudep` client starts one process per turn:

```text
first turn: claude -p --output-format stream-json --verbose --session-id <uuid> <prompt>
later turn: claude -p --output-format stream-json --verbose --resume <uuid> <prompt>
```

Model, effort, permission, and other allowed Claude flags are retained. The
client owns process execution, line-delimited JSON decoding, session-ID
correlation, and normalized event/result streaming. Native assistant content,
`tool_use`/`tool_result` blocks, result text, and usage remain in the canonical
records with `source: "claude-p-stream-json"`.

The runner process owns the durable boundary, matching the merged Codex
app-server session wiring:

1. Pretty preallocates a valid Claude UUID so `pretty new --json` can return
   the provider identity without spending a hidden bootstrap turn.
2. The first real `system/init` record must correlate to that UUID. After it,
   every turn is a separate `--resume` invocation.
3. The runner appends normalized records to `<pretty-id>.claudep.jsonl` and
   replays them through the runner protocol's structured frame (`0x25`).
4. `turn_started` sets working and Claude's `result` record sets idle. This
   lifecycle is authoritative; the PTY byte/spinner heuristic is not used for
   this kind.
5. `claudeSessionId` is carried in runner HELLO, session metadata, API session
   data, and the lane ledger's provider binding.

The daemon therefore can restart and reconnect to the still-running durable
runner using the existing socket discovery path. The runner replays canonical
history and the persisted Claude UUID. If the runner itself restarts after an
unfinished turn, it records a failed result boundary rather than leaving the
session permanently working.

An immediate send after Claude's `result` can race the previous short-lived
process's final teardown. The runner queues such a submission and starts it as
soon as teardown completes, preserving ordered multi-turn continuity without
dropping or combining prompts.

## Gated real proof

The opt-in integration test builds a scratch runner, uses a scratch state root,
scratch launch-agent directory, private in-process HTTP server, and a scratch
working directory beneath `/tmp`. It never touches the installed `:8787`
daemon or production launchd labels.

```sh
cd prettygo
CLAUDEP_INTEGRATION=1 CGO_ENABLED=0 \
  go test -v ./cmd/pretty \
  -run '^TestClaudePRealTurnsRestartReattach$' -count=1
```

Captured output:

```text
=== RUN   TestClaudePRealTurnsRestartReattach
    SESSION_ID b9355989-16e0-4d8d-b63f-ded81691fd1f
    CLAUDE_SESSION_ID 6596fd99-80ee-4358-90d0-35854f686332
    METADATA kind=claude-structured claudeSessionId=6596fd99-80ee-4358-90d0-35854f686332
    AUTH ANTHROPIC_API_KEY absent; Claude subscription login inherited
    FIRST_SEND {"submitted":true,"confidence":"confirmed","text":"Reply with exactly CLAUDEP_OK."}
    FIRST_WORKING_STATE working -> idle
    FIRST_LAST [{"role":"assistant","text":"CLAUDEP_OK","timestamp":"2026-07-17T22:45:20.548Z"}]
    SECOND_SEND {"submitted":true,"confidence":"confirmed","text":"Reply with exactly CLAUDEP_SECOND_OK ..."}
    SECOND_WORKING_STATE working -> idle
    SECOND_LAST [{"role":"assistant","text":"CLAUDEP_SECOND_OK","timestamp":"2026-07-17T22:45:25.636Z"}]
    REATTACHED claudeSessionId=6596fd99-80ee-4358-90d0-35854f686332 history=12 last=[{"role":"assistant","text":"CLAUDEP_SECOND_OK",...}]
--- PASS: TestClaudePRealTurnsRestartReattach (10.84s)
PASS
```

The second prompt only returns `CLAUDEP_SECOND_OK` when the immediately
preceding reply in the resumed provider conversation was `CLAUDEP_OK`; it
returns a failure marker otherwise. The test also requires:

- every non-empty structured `session_id` to equal the metadata UUID;
- a correlated `system/init` record;
- two result records with positive token usage;
- assistant messages to have `source == "claude-p-stream-json"`;
- both working-to-idle transitions; and
- the same UUID, event count, and last assistant reply after constructing a
  fresh daemon session manager and running discovery.

## Deterministic coverage

The ordinary suite covers:

- PTY Claude remaining the default and `--structured` being Claude-only;
- exact first-turn `--session-id` and later-turn `--resume` arguments;
- forced `stream-json --verbose` output;
- API-key removal from runner and child environments;
- assistant/tool/result/usage normalization and lifecycle decoding;
- canonical snapshot/history rendering;
- metadata and ledger provider-ID persistence; and
- authoritative working-to-idle state.

## Verification

```sh
cd prettygo
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
CGO_ENABLED=0 go test ./... -count=1
```

No commit was created.
