# SOAKFIX lane notes

Date: 2026-07-16  
Branch: `go-soakfix`  
Result: PASS

## Diagnosis

All reproduction and acceptance work used scratch daemons. Nothing connected
to, restarted, or signalled the daemon on `:8787`, and no default runner state
or ledger was used.

The pre-fix reproduction used:

```text
scratch_root=/tmp/pretty-soakfix-prefx.MERIv3
port=52860
claude_session=43c74494-8034-4910-aee2-fa421eb9b6b7
claude_provider=f57ac726-ef8c-46b3-89a7-e7cdd96c00fd
```

The Go CLI reported the same visible failure as the soak:

```json
{"submitted":false,"confidence":"unconfirmed","reason":"timeout","sessionState":"normal-composer","sessionStateDescription":"No blocking menu or prompt was detected in the terminal snapshot.","textStillInComposer":false,"composerTail":"\r\n\r\n\r\n\r\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n❯  Respond with PONG message\r\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                                                                                                                                                                                   /rc active"}
```

`pretty last 43c74494 --json` returned:

```json
[]
```

The backing file proved the cwd mismatch:

```text
/Users/uzair/.claude/projects/-private-tmp/f57ac726-ef8c-46b3-89a7-e7cdd96c00fd.jsonl
```

On this checkout with Claude Code 2.1.212, inspection of that real JSONL also
showed that both the Go CLI and the normative Node CLI had submitted their
prompts despite timing out on confirmation:

```json
{"type":"user","text":"Reply with exactly PONG."}
{"type":"assistant","text":"PONG"}
{"type":"user","text":"Reply with exactly NODEPONG."}
{"type":"assistant","text":"NODEPONG"}
```

Thus the current source's PTY submit bytes were already behaviorally aligned;
the cutover-visible false negative came from the watcher looking under `-tmp`
while Claude wrote under `-private-tmp`. The submit sequence is now factored
and regression-locked directly against `prettyd/bin/pretty.cjs`: exact text
payload, 150 ms settle, separate CR, at most two CR retries only while the sent
snippet remains visible, and no retry after composer clear. Existing
bracketed-paste envelopes are passed through byte-for-byte; no extra wrapper
was invented.

## Implementation

- Added one cwd normalizer that uses `filepath.EvalSymlinks` and falls back to
  `filepath.Clean`.
- Codex bounded-date and full-scan matching normalize both the launch cwd and
  every rollout `session_meta.cwd` before comparison.
- Claude encodes the resolved cwd first, also probes the legacy unresolved
  encoding, and applies exact/sole/ambiguous resolution across the combined
  candidate set. The live watcher and recovery source check both use this
  policy.
- The Go send path now names and shares the normative text/delay/CR helpers and
  retry constants, with request-order and composer-clear regression tests.
- Codex usage/task-complete metadata records have empty assistant content.
  `pretty last` now ignores those non-message records so the required command
  returns the preceding text reply after the turn is fully complete.

## Focused regression output

```text
$ CGO_ENABLED=0 go test -count=1 -v ./internal/watch ./cmd/pretty -run 'Test(ResolveCodexRolloutNormalizesCWDRealpaths|ClaudeCWDResolutionUsesRealpathAndLegacyEncoding|ClaudeWatcherFindsRealpathProjectForAliasCWD|ClaudeSubmitSequenceMatchesNodeCLI|ClaudeEnterRetriesRequireTextStillInComposer|LastAndTranscriptJSONShapes)$'
=== RUN   TestClaudeCWDResolutionUsesRealpathAndLegacyEncoding
--- PASS: TestClaudeCWDResolutionUsesRealpathAndLegacyEncoding (0.00s)
=== RUN   TestClaudeWatcherFindsRealpathProjectForAliasCWD
--- PASS: TestClaudeWatcherFindsRealpathProjectForAliasCWD (0.00s)
=== RUN   TestResolveCodexRolloutNormalizesCWDRealpaths
=== RUN   TestResolveCodexRolloutNormalizesCWDRealpaths/fixture_alias_to_realpath
=== RUN   TestResolveCodexRolloutNormalizesCWDRealpaths/fixture_realpath_to_alias
=== RUN   TestResolveCodexRolloutNormalizesCWDRealpaths/macOS_/tmp_to_/private/tmp
--- PASS: TestResolveCodexRolloutNormalizesCWDRealpaths (0.00s)
    --- PASS: TestResolveCodexRolloutNormalizesCWDRealpaths/fixture_alias_to_realpath (0.00s)
    --- PASS: TestResolveCodexRolloutNormalizesCWDRealpaths/fixture_realpath_to_alias (0.00s)
    --- PASS: TestResolveCodexRolloutNormalizesCWDRealpaths/macOS_/tmp_to_/private/tmp (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch  0.171s
=== RUN   TestClaudeSubmitSequenceMatchesNodeCLI
--- PASS: TestClaudeSubmitSequenceMatchesNodeCLI (0.00s)
=== RUN   TestClaudeEnterRetriesRequireTextStillInComposer
=== RUN   TestClaudeEnterRetriesRequireTextStillInComposer/visible_text_gets_two_bounded_retries
=== RUN   TestClaudeEnterRetriesRequireTextStillInComposer/cleared_composer_never_retries
--- PASS: TestClaudeEnterRetriesRequireTextStillInComposer (0.01s)
    --- PASS: TestClaudeEnterRetriesRequireTextStillInComposer/visible_text_gets_two_bounded_retries (0.00s)
    --- PASS: TestClaudeEnterRetriesRequireTextStillInComposer/cleared_composer_never_retries (0.00s)
=== RUN   TestLastAndTranscriptJSONShapes
=== RUN   TestLastAndTranscriptJSONShapes/last
=== RUN   TestLastAndTranscriptJSONShapes/transcript
--- PASS: TestLastAndTranscriptJSONShapes (0.00s)
    --- PASS: TestLastAndTranscriptJSONShapes/last (0.00s)
    --- PASS: TestLastAndTranscriptJSONShapes/transcript (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.249s
```

## Real scratch daemon acceptance

The final proof used freshly built Go daemon, runner, and CLI binaries:

```text
scratch_root=/tmp/pretty-soakfix-e2e.knINLE
port=53769
runner_state=/tmp/pretty-soakfix-e2e.knINLE/state/runners
ledger=/tmp/pretty-soakfix-e2e.knINLE/state/ledger/lanes.sqlite3
claude_version=2.1.212 (Claude Code)
codex_version=codex-cli 0.144.5
```

### Codex: `/tmp` launch, `/private/tmp` rollout

Creation returned a real Codex process:

```json
{
  "args": [
    "-c",
    "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox"
  ],
  "cmd": "codex",
  "cols": 300,
  "createdAt": 1784263830746,
  "cwd": "/tmp",
  "exitCode": null,
  "exitSignal": null,
  "exited": false,
  "exitedAt": null,
  "id": "4b7ab744-9e9f-4a3e-bdf8-dacdb261b0e1",
  "lastDataAt": 1784263831545,
  "lastUserMessageAt": null,
  "name": "soakfix-e2e-codex",
  "pid": 65038,
  "rows": 50,
  "tool": "codex",
  "working": true
}
```

The TUI and rollout metadata independently showed the realpath cwd:

```text
│ directory:   /private/tmp                         │
```

```text
/Users/uzair/.codex/sessions/2026/07/16/rollout-2026-07-16T21-50-31-019f6e69-6ddd-7b42-9c22-2129d8156101.jsonl
{"type":"session_meta","payload":{"id":"019f6e69-6ddd-7b42-9c22-2129d8156101","cwd":"/private/tmp","timestamp":"2026-07-17T04:50:31.005Z"}}
```

The send confirmed through structured events:

```text
$ pretty --json send 4b7ab744 --timeout 60s 'Reply with exactly OK.'
{"submitted":true,"confidence":"confirmed","text":"Reply with exactly OK."}
```

After the real turn was idle, the required command returned the non-empty
structured reply:

```text
$ pretty --json last 4b7ab744
[
  {
    "role": "user",
    "text": "Reply with exactly OK.",
    "timestamp": "2026-07-17T04:50:46.642Z"
  },
  {
    "role": "assistant",
    "text": "OK",
    "timestamp": "2026-07-17T04:50:51.671Z"
  }
]
```

### Claude: `/tmp` launch, `-private-tmp` project

Creation returned a real Claude process:

```json
{
  "args": [
    "--dangerously-skip-permissions",
    "--session-id",
    "f5ddc093-85a0-48a4-b0a6-c00a4b35e8df"
  ],
  "cmd": "claude",
  "cols": 300,
  "createdAt": 1784263956841,
  "cwd": "/tmp",
  "exitCode": null,
  "exitSignal": null,
  "exited": false,
  "exitedAt": null,
  "id": "f822722e-4546-4891-b0c1-79e38c032e7f",
  "lastDataAt": 1784263957651,
  "lastUserMessageAt": null,
  "name": "soakfix-e2e-claude",
  "pid": 65577,
  "rows": 50,
  "tool": "claude-code",
  "working": false
}
```

The send confirmed in the first poll:

```text
$ pretty --json send f822722e --timeout 60s 'Reply with exactly PONG.'
{"submitted":true,"confidence":"confirmed","text":"Reply with exactly PONG."}
```

The backing JSONL was under the resolved encoding:

```text
/Users/uzair/.claude/projects/-private-tmp/f5ddc093-85a0-48a4-b0a6-c00a4b35e8df.jsonl
```

The terminal snapshot contained both prompt and real reply:

```text
$ pretty snap f822722e | rg -n -C 2 'Reply with exactly PONG|PONG'
21- ▎ More details here: https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access
22-
23:❯ Reply with exactly PONG.
24-
25:⏺ PONG
26-
27-✻ Cooked for 5s
--
46-
47-────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
48:❯  Respond with PONG message
49-────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
50-  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                                                                                                                                                                                                                          /rc
```

The required structured output was non-empty:

```text
$ pretty --json last f822722e
[
  {
    "role": "user",
    "text": "Reply with exactly PONG.",
    "timestamp": "2026-07-17T04:52:47.912Z"
  },
  {
    "role": "assistant",
    "text": "PONG",
    "timestamp": "2026-07-17T04:52:51.564Z"
  }
]
```

## Required gates, three consecutive final runs

All commands ran from `prettygo/` with `CGO_ENABLED=0` after the final code
change:

```text
run 1: go build ./...             PASS
run 1: go vet ./...               PASS
run 1: go test -count=1 ./...     PASS
run 2: go build ./...             PASS
run 2: go vet ./...               PASS
run 2: go test -count=1 ./...     PASS
run 3: go build ./...             PASS
run 3: go vet ./...               PASS
run 3: go test -count=1 ./...     PASS
```

`go build` and `go vet` produced no stderr/stdout. The third uncached suite
produced:

```text
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty                  1.438s
?   github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd                [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/cmd/runner                 [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api               3.266s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger            2.726s
?   github.com/uzihaq/pretty-pty/prettygo/internal/ledger/testhelper [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/mirror            0.502s
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness [no test files]
?   github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record  [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/proto             1.506s
?   github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest   [no test files]
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery          1.413s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session           0.449s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state             2.022s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/verdict           1.712s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/waitcond          4.150s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch             2.291s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/webassets         1.929s
```

## Cleanup

Both real sessions were killed through the scratch daemon, both launchd labels
were absent (`launchctl print` status 113), both child PIDs were gone
(`kill -0` status 1), the scratch daemon was stopped, and port 53769 refused a
health connection (curl status 7). The scratch directory is retained for
inspection. No commit was created.
