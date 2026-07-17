# COLLISION-GUARD lane notes

## Result

Implemented a conversation-identity collision guard for every production
create-with-resume path in the Go daemon.

- `ledger.Store.LiveBindingFor` folds the append-only ledger and returns the
  current managed-active owner of a provider UUID as session ID, name, and
  provider kind. Tombstoned, exited, reaped, reopened, and lost lanes do not
  count as live bindings.
- `ledger.Store.MovedBinding` folds `moved_to` provenance and returns its
  target as the machine warning value. A still-live moved source reports the
  more specific moved warning rather than the generic local-live warning.
- Added the append-only `provider_rebound` event. Forced takeover records the
  old/source lane, provider UUID, and replacement lane before launch. The old
  lane remains running and managed; it is only superseded as the current
  binding after the replacement becomes managed-active, so a failed launch
  cannot silently discard the original owner.
- `session.Manager.Create` serializes the query plus pre-launch binding write,
  preventing two concurrent resume requests from both observing no owner.
  Claude `--resume` and Codex resume forms are guarded. Claude `--session-id`
  is deliberately fresh creation and bypasses the collision check.
- A local collision returns exactly:

  ```text
  conversation <uuid> is already live as "<name>" (session <id>) — attach with `pretty attach <id>`, or re-run with --force to take over.
  ```

- A moved collision returns exactly:

  ```text
  conversation moved to <machine>; reopening here forks it. --force to fork.
  ```

- HTTP create/adopt collisions use status 409. The CLI extracts the human
  error instead of printing a route/status/JSON wrapper.
- `--force` is threaded through `pretty new`, `pretty recover --reopen`, and
  `pretty adopt`. Recovery and adoption pass it into the same manager guard;
  there is no duplicate side path. No forced path calls `RequestKill`, runner
  `Kill`, reap, or any other termination operation on the existing session.

## Required behavior proof

The manager acceptance uses an in-memory launcher and a ledger under
`t.TempDir()`. It proves default refusal makes no launch, force launches and
records `provider_rebound` while the old session still accepts input, a fresh
Claude UUID is accepted, and a tombstoned owner no longer blocks resume.

```text
$ CGO_ENABLED=0 go test -count=1 -run 'TestConversationIdentityCollisionRefuseForceFreshAndAfterKill|TestMovedConversationRefusesUnlessForced' -v ./internal/session
=== RUN   TestConversationIdentityCollisionRefuseForceFreshAndAfterKill
    collision_test.go:103: refuse=true force=3c37cf39-b83e-496a-a491-af059f151233 rebound=true old_still_live=true fresh=e8d3e33b-1556-4dbf-a91e-8b78ddb75054 after_kill=de36d7e6-8290-44b1-ae0f-0bcc3046aa7a launches=6
--- PASS: TestConversationIdentityCollisionRefuseForceFreshAndAfterKill (0.03s)
=== RUN   TestMovedConversationRefusesUnlessForced
--- PASS: TestMovedConversationRefusesUnlessForced (0.02s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  0.572s
```

The ledger proof covers current-live selection, moved provenance, takeover
before replacement readiness, selection after readiness, and behavior after
the replacement is killed.

```text
$ CGO_ENABLED=0 go test -count=1 -run TestLiveAndMovedBindingQueriesFoldLifecycleAndRebindFacts -v ./internal/ledger
=== RUN   TestLiveAndMovedBindingQueriesFoldLifecycleAndRebindFacts
--- PASS: TestLiveAndMovedBindingQueriesFoldLifecycleAndRebindFacts (0.01s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger  0.320s
```

CLI coverage proves all three relevant commands send `force=true`. The adopt
HTTP acceptance additionally proves the exact default refusal, forced launch,
durable rebind event, and original-session survival.

```text
$ CGO_ENABLED=0 go test -count=1 -run TestForceThreadsThroughConversationBindingCommands -v ./cmd/pretty
=== RUN   TestForceThreadsThroughConversationBindingCommands
=== RUN   TestForceThreadsThroughConversationBindingCommands/new_resume
=== RUN   TestForceThreadsThroughConversationBindingCommands/recover_reopen
=== RUN   TestForceThreadsThroughConversationBindingCommands/adopt
--- PASS: TestForceThreadsThroughConversationBindingCommands (0.01s)
    --- PASS: TestForceThreadsThroughConversationBindingCommands/new_resume (0.00s)
    --- PASS: TestForceThreadsThroughConversationBindingCommands/recover_reopen (0.00s)
    --- PASS: TestForceThreadsThroughConversationBindingCommands/adopt (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.370s
```

## Required gates

Run from `prettygo/`; all commands exited 0.

```text
$ CGO_ENABLED=0 go build ./...
(no stdout/stderr)

$ CGO_ENABLED=0 go vet ./...
(no stdout/stderr)

$ CGO_ENABLED=0 go test -count=1 ./...
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty             3.012s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/api          5.182s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/interop      6.349s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/ledger       4.280s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/migrate      1.913s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/recovery     1.087s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session      2.537s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/state        2.425s
ok  github.com/uzihaq/pretty-pty/prettygo/internal/watch        3.027s
```

All proof state stayed under Go test temporary directories and used fake
runners. No live Pretty session, default ledger, provider process, or launchd
service was modified. The worktree remains uncommitted scratch state.
