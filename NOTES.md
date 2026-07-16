# WATCHERS acceptance evidence

Implemented `prettygo/internal/watch` from the normative TypeScript sources. The tests use only `t.TempDir()` fixtures. The acceptance commands below also set `HOME=/tmp/pretty-pty-watchers-acceptance-home`, so no real `~/.codex`, `~/.claude`, pretty-PTY state, or daemon was read or touched.

Commands were run from `prettygo/` with `/opt/homebrew/bin/go`.

## Synthetic resolver, normalization, and watcher tests

```text
$ env HOME=/tmp/pretty-pty-watchers-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build /opt/homebrew/bin/go test -count=1 -v ./...
=== RUN   TestResolveClaudeJSONL
=== RUN   TestResolveClaudeJSONL/exact_wins_alongside_another_conversation
=== RUN   TestResolveClaudeJSONL/missing_launch_id_with_sole_file
=== RUN   TestResolveClaudeJSONL/ambiguous_is_deliberately_unresolved
=== RUN   TestResolveClaudeJSONL/empty_directory
=== RUN   TestResolveClaudeJSONL/missing_directory
=== RUN   TestResolveClaudeJSONL/no_launch_id_with_sole_file
=== RUN   TestResolveClaudeJSONL/no_launch_id_with_multiple_files
=== RUN   TestResolveClaudeJSONL/non-jsonl_files_ignored
--- PASS: TestResolveClaudeJSONL (0.01s)
    --- PASS: TestResolveClaudeJSONL/exact_wins_alongside_another_conversation (0.00s)
    --- PASS: TestResolveClaudeJSONL/missing_launch_id_with_sole_file (0.00s)
    --- PASS: TestResolveClaudeJSONL/ambiguous_is_deliberately_unresolved (0.00s)
    --- PASS: TestResolveClaudeJSONL/empty_directory (0.00s)
    --- PASS: TestResolveClaudeJSONL/missing_directory (0.00s)
    --- PASS: TestResolveClaudeJSONL/no_launch_id_with_sole_file (0.00s)
    --- PASS: TestResolveClaudeJSONL/no_launch_id_with_multiple_files (0.00s)
    --- PASS: TestResolveClaudeJSONL/non-jsonl_files_ignored (0.00s)
=== RUN   TestClaudeResolverHelpers
--- PASS: TestClaudeResolverHelpers (0.00s)
=== RUN   TestClaudeWatcherTailsAPIEventsAndDeduplicatesReread
--- PASS: TestClaudeWatcherTailsAPIEventsAndDeduplicatesReread (0.08s)
=== RUN   TestNormalizeCodexRolloutLine
=== RUN   TestNormalizeCodexRolloutLine/assistant_message
=== RUN   TestNormalizeCodexRolloutLine/user_message
=== RUN   TestNormalizeCodexRolloutLine/user_environment_preamble_filtered
=== RUN   TestNormalizeCodexRolloutLine/developer_message_filtered
=== RUN   TestNormalizeCodexRolloutLine/function_call
=== RUN   TestNormalizeCodexRolloutLine/function_output
=== RUN   TestNormalizeCodexRolloutLine/task_started
=== RUN   TestNormalizeCodexRolloutLine/task_complete
=== RUN   TestNormalizeCodexRolloutLine/nested_token_count
--- PASS: TestNormalizeCodexRolloutLine (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/assistant_message (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/user_message (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/user_environment_preamble_filtered (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/developer_message_filtered (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/function_call (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/function_output (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/task_started (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/task_complete (0.00s)
    --- PASS: TestNormalizeCodexRolloutLine/nested_token_count (0.00s)
=== RUN   TestCodexFreshSessionDirsIncludeTodayYesterdayAndCreatedAt
--- PASS: TestCodexFreshSessionDirsIncludeTodayYesterdayAndCreatedAt (0.00s)
=== RUN   TestExtractCodexResumeID
=== RUN   TestExtractCodexResumeID/subcommand
=== RUN   TestExtractCodexResumeID/flag
=== RUN   TestExtractCodexResumeID/equals
=== RUN   TestExtractCodexResumeID/reject_short
=== RUN   TestExtractCodexResumeID/reject_non_hex
--- PASS: TestExtractCodexResumeID (0.00s)
    --- PASS: TestExtractCodexResumeID/subcommand (0.00s)
    --- PASS: TestExtractCodexResumeID/flag (0.00s)
    --- PASS: TestExtractCodexResumeID/equals (0.00s)
    --- PASS: TestExtractCodexResumeID/reject_short (0.00s)
    --- PASS: TestExtractCodexResumeID/reject_non_hex (0.00s)
=== RUN   TestResolveCodexRolloutReasons
=== RUN   TestResolveCodexRolloutReasons/no-dir
=== RUN   TestResolveCodexRolloutReasons/empty-dir
=== RUN   TestResolveCodexRolloutReasons/no-cwd-match
=== RUN   TestResolveCodexRolloutReasons/no-after-spawn
=== RUN   TestResolveCodexRolloutReasons/fresh-match_chooses_earliest_after_spawn
--- PASS: TestResolveCodexRolloutReasons (0.02s)
    --- PASS: TestResolveCodexRolloutReasons/no-dir (0.00s)
    --- PASS: TestResolveCodexRolloutReasons/empty-dir (0.00s)
    --- PASS: TestResolveCodexRolloutReasons/no-cwd-match (0.01s)
    --- PASS: TestResolveCodexRolloutReasons/no-after-spawn (0.00s)
    --- PASS: TestResolveCodexRolloutReasons/fresh-match_chooses_earliest_after_spawn (0.00s)
=== RUN   TestResolveCodexRolloutReadsBeyond16KiB
    codex_resolver_test.go:121: resolved session_meta first line of 20639 bytes (>16KiB) with reason fresh-match
--- PASS: TestResolveCodexRolloutReadsBeyond16KiB (0.00s)
=== RUN   TestResolveCodexRolloutFullScanNearestTimestamp
    codex_resolver_test.go:140: out-of-window rollout resolved with reason fresh-match-fullscan among 2 cwd matches
--- PASS: TestResolveCodexRolloutFullScanNearestTimestamp (0.00s)
=== RUN   TestResolveCodexRolloutResumeIsGlobalAndNewest
--- PASS: TestResolveCodexRolloutResumeIsGlobalAndNewest (0.00s)
=== RUN   TestCodexWatcherBoundedBackfillAndExactLiveHandoff
    codex_watcher_test.go:121: bounded replay events: 2000; appended marker emissions: 1; appended working transitions: 1
--- PASS: TestCodexWatcherBoundedBackfillAndExactLiveHandoff (0.23s)
=== RUN   TestCodexWatcherPreservesPartialRecordAtHandoff
--- PASS: TestCodexWatcherPreservesPartialRecordAtHandoff (0.11s)
=== RUN   TestBoundedBackfillStart
--- PASS: TestBoundedBackfillStart (0.00s)
PASS
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	0.760s
```

## Race detector

```text
$ env HOME=/tmp/pretty-pty-watchers-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build /opt/homebrew/bin/go test -race -count=1 ./...
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/watch	1.869s
```

## Vet and static builds

```text
$ env HOME=/tmp/pretty-pty-watchers-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build /opt/homebrew/bin/go vet ./...
(no output; exit status 0)

$ env HOME=/tmp/pretty-pty-watchers-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build CGO_ENABLED=0 /opt/homebrew/bin/go build ./...
(no output; exit status 0)

$ env HOME=/tmp/pretty-pty-watchers-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build GOOS=linux GOARCH=amd64 CGO_ENABLED=0 /opt/homebrew/bin/go build ./...
(no output; exit status 0)
```
