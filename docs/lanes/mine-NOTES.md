# Lane provenance + `pretty lanes --mine` notes

## Outcome

Implemented the adopted direct-edge provenance graph and CLI selectors without
persisting a root session. Every new write-ahead `created` event now records an
immutable typed creator:

- `session:<uuid>` records the direct parent session.
- `user:uid:<daemon-uid>` is the no-header fallback.
- `external:<opaque-id>` records an explicit/environment owner root.

The folded ledger state exposes `CreatorKind` and `CreatorID`. Existing created
events without the additive fields still fold as legacy events; all new typed
writes validate the principal shape.

## Capture boundary

- The runner environment sets `PRETTY_SESSION_ID` to the new session UUID after
  caller environment merging. Caller-provided `PRETTY_SESSION_ID` values cannot
  override it.
- The CLI forwards its own `PRETTY_SESSION_ID` on session/lane creation as
  `X-Pretty-Creator-Session`.
- `PRETTY_OWNER_ID` (or creation `--owner`) takes precedence and is forwarded as
  `X-Pretty-Owner-ID`.
- The daemon rejects empty/duplicate/conflicting creator headers. A session
  creator must be a UUID whose ledger stream contains a valid `created` event.
  Malformed and valid-but-stale IDs fail before session preparation or launch.
- Explicit `--owner` while inheriting `PRETTY_SESSION_ID` is rejected unless
  `--detach` is present. This applies to `pretty new`, `pretty run`, and explicit
  owner selection in `pretty lanes`.

## Derived lane view

The manager derives these response fields from direct ledger edges each time it
lists sessions; none is persisted as a root:

- `creator_kind`, `creator_id`
- `parent_session_id` for a direct session edge
- `creator_ancestry` ordered from direct parent outward
- `root_creator_kind`, `root_creator_id`
- `provenance_status`: `rooted`, `parent-live`, `parent-dead`,
  `parent-missing`, `cycle`, or `legacy`

Any terminal ancestor (`user_kill_requested`, `runner_exited`, `runner_lost`, or
`reaped`) makes every descendant `parent-dead`. The direct edge and derived root
remain unchanged; there is no reassignment or ownership transfer.

## CLI behavior

| Command | Selection |
| --- | --- |
| `pretty lanes`, `pretty lanes --all`, `pretty ls --kind lane` | Global lane view |
| `pretty lanes --mine` with `--owner` / `PRETTY_OWNER_ID` | Lanes rooted at that external principal |
| `pretty lanes --mine` with `PRETTY_SESSION_ID` | All lane descendants whose ancestry contains that session |
| `pretty lanes --mine` with neither environment value | Lanes rooted at `uid:<daemon-uid>` |
| `pretty lanes --subtree <id>` | All transitive lane descendants of the session (unique prefixes accepted) |
| Add `--direct` to a session selector | Immediate children only |

`--direct` is rejected for user/external principals. Human-readable lane output
adds a `PROVENANCE` column; JSON includes the derived fields above.

## Proof

Focused coverage:

- `internal/ledger.TestCreatedProvenanceFoldsOnceAndRemainsImmutable`: direct
  fields fold from the first created event; a later created event cannot change
  them; legacy events remain readable.
- `internal/ledger.TestCreatedRequiresTypedCreatorProvenance`: missing creator,
  forged session ID, malformed user ID, and unknown creator kind are rejected.
- `internal/session.TestCreateProvenanceGraphValidationAndDeadParentClassification`:
  user fallback, A-to-B direct child, A-to-B-to-C ancestry, external root,
  forged/stale/conflicting parents, and transitive dead-parent classification.
- `internal/session.TestLaunchdFreeCreateWritesMetadataAndPlist`: malicious
  caller `PRETTY_SESSION_ID` is replaced by the newly created UUID in the main
  launch environment.
- `internal/api.TestCreateHeadersBecomeValidatedLedgerProvenance`: header capture
  reaches the child created event; empty, forged, stale, and conflicting headers
  fail.
- `cmd/pretty.TestRunPostsHeadlessLaneRequest`: inherited session header forward.
- `cmd/pretty.TestRunExplicitOwnerRequiresDetachAndForwardsExternalRoot`: explicit
  owner conflict, detach escape hatch, owner header forward, and session-header
  suppression.
- `cmd/pretty.TestLaneMineResolutionPrecedenceSubtreeDirectAndOwnerIsolation`:
  transitive mine, direct-only, subtree, owner-over-session precedence, external
  isolation, detach requirement, user-root fallback, and global `--all`.

Repository gates run from `prettygo/`:

```text
CGO_ENABLED=0 go build ./...   PASS
CGO_ENABLED=0 go vet ./...     PASS
CGO_ENABLED=0 go test ./...    PASS
git diff --check              PASS
```

No commit was created. The supplied `mine-SPEC.md`, this note, and all code/test
changes remain scratch/uncommitted.
