# SESSIONS lane acceptance evidence

Implemented the session lifecycle runtime in `prettygo/internal/session` from
the normative `prettyd/src/sessions.ts`, `prettyd/src/push.ts`, and
`prettygo/CONTRACT/state-dir.md` behavior.

The production daemon now uses the session manager for startup discovery and
API create/list/kill operations. The manager reuses `internal/state` for the
canonical metadata, plist, registry, mirror, and protocol-backed session
objects. It adds:

- Claude session-ID pinning and full-access defaults before launch;
- three-attempt HELLO/socket discovery, live-PID conservation, orphan cleanup,
  bounded reconnects, and an explicit-force mass-kill guard;
- Claude spinner/footer and Codex lifecycle working detection with the
  first-sample gate and working-to-idle edge;
- idle sentinels, per-session/global hooks and their full environment,
  done/blocked/error terminal classification, and final assistant summaries;
- VAPID/subscription storage and delivery through
  `github.com/SherClockHolmes/webpush-go`, including 404/410 cleanup;
- authenticated VAPID subscribe/unsubscribe HTTP routes.

## Safety

Acceptance commands used
`HOME=/tmp/pretty-pty-sessions-acceptance-home`. Tests use `t.TempDir()` or
explicit `/tmp` roots and in-memory/process launchers. No acceptance test calls
`launchctl`, reads the default Pretty state directory, or contacts a real
daemon. The launchd-free create test writes its canonical
`tech.pretty-pty.runner.*` plist only inside a scratch `LaunchAgents`
directory.

## Focused session acceptance

```text
$ env HOME=/tmp/pretty-pty-sessions-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build CGO_ENABLED=0 go test -count=1 -v ./internal/session
=== RUN   TestClassifyIdleReasonHeritageSnapshots
=== RUN   TestClassifyIdleReasonHeritageSnapshots/done_screen
=== RUN   TestClassifyIdleReasonHeritageSnapshots/y/n_prompt
=== RUN   TestClassifyIdleReasonHeritageSnapshots/numbered_picker
=== RUN   TestClassifyIdleReasonHeritageSnapshots/error_trace
=== RUN   TestClassifyIdleReasonHeritageSnapshots/resolved_error
--- PASS: TestClassifyIdleReasonHeritageSnapshots (0.00s)
    --- PASS: TestClassifyIdleReasonHeritageSnapshots/done_screen (0.00s)
    --- PASS: TestClassifyIdleReasonHeritageSnapshots/y/n_prompt (0.00s)
    --- PASS: TestClassifyIdleReasonHeritageSnapshots/numbered_picker (0.00s)
    --- PASS: TestClassifyIdleReasonHeritageSnapshots/error_trace (0.00s)
    --- PASS: TestClassifyIdleReasonHeritageSnapshots/resolved_error (0.00s)
=== RUN   TestFinalAssistantSummary
--- PASS: TestFinalAssistantSummary (0.00s)
=== RUN   TestClaudeWorkingFromSnapshot
--- PASS: TestClaudeWorkingFromSnapshot (0.00s)
=== RUN   TestMassKillGuardRefusesDiscoverySweepBeforeBootout
--- PASS: TestMassKillGuardRefusesDiscoverySweepBeforeBootout (0.00s)
=== RUN   TestLaunchdFreeCreateWritesMetadataAndPlist
--- PASS: TestLaunchdFreeCreateWritesMetadataAndPlist (0.01s)
=== RUN   TestWorkingEdgeWritesSentinelAndHookEnvironment
--- PASS: TestWorkingEdgeWritesSentinelAndHookEnvironment (0.13s)
=== RUN   TestDiscoveryPreservesUnreachableLivePID
2026/07/16 15:13:28 [discover] runner 00000000-0000-4000-8000-000000000099 unreachable but pid 1234 alive — leaving it alone
--- PASS: TestDiscoveryPreservesUnreachableLivePID (0.00s)
=== RUN   TestPushStorageAndGoneSubscriptionCleanup
--- PASS: TestPushStorageAndGoneSubscriptionCleanup (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  0.540s
```

The mass-kill test creates four old scratch plists with a limit of three,
asserts that the refused sweep mutates none of them, then repeats with the
explicit force option and verifies cleanup. The create test uses an in-memory
launcher, checks the scratch metadata/plist contents and 0600 modes, and never
bootstraps launchd.

## Race detector

```text
$ CGO_ENABLED=0 go test -race -count=1 ./internal/session ./internal/state ./internal/api
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  2.117s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state    1.676s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api      2.244s
```

## Required static gates

```text
$ env HOME=/tmp/pretty-pty-sessions-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build CGO_ENABLED=0 go vet ./...
(no output; exit status 0)

$ env HOME=/tmp/pretty-pty-sessions-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build CGO_ENABLED=0 go build ./...
(no output; exit status 0)

$ env HOME=/tmp/pretty-pty-sessions-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build CGO_ENABLED=0 go test -count=1 ./...
?    github.com/uzihaq/pretty-pty/prettygo/cmd/prettyd                     [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/cmd/runner                      [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api                    1.443s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror                 0.912s
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness     [no test files]
?    github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record      [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto                  0.183s
?    github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest        [no test files]
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session                1.331s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state                  0.782s
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch                  1.494s
```

## Pure-Go dependency check

```text
$ env HOME=/tmp/pretty-pty-sessions-acceptance-home GOPATH=/Users/uzair/go GOMODCACHE=/Users/uzair/go/pkg/mod GOCACHE=/Users/uzair/Library/Caches/go-build CGO_ENABLED=0 go list -deps -f '{{if .CgoFiles}}{{.ImportPath}} {{.CgoFiles}}{{end}}' ./...
(no output; exit status 0 — no dependency reports Cgo files)
```
