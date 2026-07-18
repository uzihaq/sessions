# OWNERSHIP lane notes

## Result

Implemented one ownership model for agent sessions, headless lanes, durable
closed records, recovery inventory, and cleanup.

- Added `pretty sessions`, with `--mine`, `--owner ID`, `--all`, and
  `--include-closed`. It lists agent sessions and lanes in one table with
  `TYPE`, `STATE`, and root `OWNER` columns. Closed records are hidden by
  default.
- `sessions --mine`, `ls --mine`, and `lanes --mine` now use the same matching
  rule: `PRETTY_OWNER_ID`, then the transitive `PRETTY_SESSION_ID` descendant
  subtree, then the daemon OS-user principal. `ls` lists only agent sessions,
  `lanes` lists only lanes, and `sessions` lists both.
- When `--mine` reaches the OS-user fallback, human output explicitly says
  that the scope is the OS user and names the uid principal. Command help also
  documents that this is user-wide, not invocation-scoped.
- Closed ledger rows are synthesized back into `List(true)` after the
  registry's short exited grace expires. The ledger fold now retains runner
  exit code/signal, so `ls -a`, `lanes`, `sessions --include-closed`, and ID
  resolution continue to report truthful terminal state after the live object
  disappears.
- `pretty recover` now emits only unexpectedly-lost rows with a real,
  non-blocked resume recipe. `pretty recover --all` includes blocked,
  provider-unbound, and otherwise unresumable lost rows under `STATUS` and
  `REASON`; it does not label those diagnostics as resumable commands.
  Recovery JSON still includes the complete report and adds a `status` field
  to every lane row.
- `pretty kill` treats an exited lane as a successful no-op with an
  `already exited; nothing to kill` message. It recognizes both retained
  exited state and a durable completion manifest, and sends no DELETE for the
  latter.
- Existing raw session JSON objects are decoded only for matching; filtered
  output retains the original objects instead of re-encoding their fields. A
  regression test preserves an unknown `futureMixedCase` field, keeping broad
  JSON casing outside this lane.

The repository skill still names `pretty lanes --mine`. It was not edited
because `skills/pretty/SKILL.md` is outside this lane's declared file
ownership; the new `pretty sessions --mine` command is ready for that owning
lane to adopt.

## Scratch isolation

All acceptance state is rooted under `t.TempDir()`. Tests use an in-memory
runner launcher, a scratch SQLite ledger, scratch runner/LaunchAgent paths, and
an `httptest` loopback server. They do not contact the installed daemon or
read/write the default Pretty state directories.

## Focused proof

Run from `prettygo/`:

```text
$ CGO_ENABLED=0 go test -count=1 -v ./cmd/pretty ./internal/session -run '^(TestSessionsMineUnifiesOwnedAgentAndLaneIncludesClosedAndKillNoops|TestSessionsMineLabelsOSUserFallbackAsUserWide|TestKillExitedLaneUsesDurableManifestAsCleanNoop|TestLSMineJSONFiltersTypesWithoutRewritingRawFieldCasing|TestRecoverDefaultIsActionableAndAllExplainsBlockedRows|TestListIncludeExitedSynthesizesDurableClosedRecords)$'
=== RUN   TestRecoverDefaultIsActionableAndAllExplainsBlockedRows
--- PASS: TestRecoverDefaultIsActionableAndAllExplainsBlockedRows (0.01s)
=== RUN   TestSessionsMineUnifiesOwnedAgentAndLaneIncludesClosedAndKillNoops
--- PASS: TestSessionsMineUnifiesOwnedAgentAndLaneIncludesClosedAndKillNoops (0.02s)
=== RUN   TestSessionsMineLabelsOSUserFallbackAsUserWide
--- PASS: TestSessionsMineLabelsOSUserFallbackAsUserWide (0.00s)
=== RUN   TestKillExitedLaneUsesDurableManifestAsCleanNoop
--- PASS: TestKillExitedLaneUsesDurableManifestAsCleanNoop (0.00s)
=== RUN   TestLSMineJSONFiltersTypesWithoutRewritingRawFieldCasing
--- PASS: TestLSMineJSONFiltersTypesWithoutRewritingRawFieldCasing (0.00s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  0.559s
=== RUN   TestListIncludeExitedSynthesizesDurableClosedRecords
--- PASS: TestListIncludeExitedSynthesizesDurableClosedRecords (0.01s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/internal/session  0.261s
```

The unified scratch test creates an agent session and a lane with the same
external owner plus an unrelated session. It proves `sessions --mine` returns
both owned types, `ls --mine` returns only the agent, `lanes --mine` returns
only the lane, default `sessions` hides the killed lane,
`--include-closed` restores it with `exited(0)`, and killing it again is a
successful no-op. Separate tests prove the manifest-only noop and ledger-only
closed-record reconstruction.

## Required gates

These commands exited 0 with no output:

```text
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go vet ./...
```

The uncached full suite also passed:

```text
$ CGO_ENABLED=0 go test ./... -count=1
ok   github.com/uzihaq/pretty-pty/prettygo/cmd/pretty
ok   github.com/uzihaq/pretty-pty/prettygo/internal/api
ok   github.com/uzihaq/pretty-pty/prettygo/internal/backup
ok   github.com/uzihaq/pretty-pty/prettygo/internal/claudep
ok   github.com/uzihaq/pretty-pty/prettygo/internal/codexapp
ok   github.com/uzihaq/pretty-pty/prettygo/internal/integrations
ok   github.com/uzihaq/pretty-pty/prettygo/internal/interop
ok   github.com/uzihaq/pretty-pty/prettygo/internal/ledger
ok   github.com/uzihaq/pretty-pty/prettygo/internal/migrate
ok   github.com/uzihaq/pretty-pty/prettygo/internal/mirror
ok   github.com/uzihaq/pretty-pty/prettygo/internal/proto
ok   github.com/uzihaq/pretty-pty/prettygo/internal/recovery
ok   github.com/uzihaq/pretty-pty/prettygo/internal/session
ok   github.com/uzihaq/pretty-pty/prettygo/internal/state
ok   github.com/uzihaq/pretty-pty/prettygo/internal/verdict
ok   github.com/uzihaq/pretty-pty/prettygo/internal/waitcond
ok   github.com/uzihaq/pretty-pty/prettygo/internal/watch
ok   github.com/uzihaq/pretty-pty/prettygo/internal/webassets
```

No commit was created.
