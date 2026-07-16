# Codex rollout backfill proof

## Implementation

- On attach (and after inode replacement/truncation), `watchCodexRollout` snapshots the rollout size and reads only the final 16 MiB.
- If that window starts inside a JSONL record, the partial record is skipped. At most the final 2,000 physical lines are replayed.
- The reader advances to the snapshot's exact ending byte before processing later appends. A single serialized reader handles replay and live reads, so the ranges cannot overlap or leave a gap.
- Replay and live bytes both enter `consumeBytes`, which performs the same JSON parse, `normalizeCodexRolloutLine`, event callback, and working-state callback.
- No UUID de-duplication is used to hide an overlapping read; the byte offset is the handoff.

## Real rollout + append test

Test: `prettyd/scripts/test-codex-backfill.mjs`

The test finds a real rollout under `~/.codex/sessions`, reads that source only to select it, and copies it to an isolated temporary directory. The watcher attaches to the byte-for-byte copy so the real Codex session remains read-only. After immediate backfill completes, the test appends a uniquely marked normalized event plus a non-deduplicated working-state sentinel to the copy. It asserts:

1. immediate normalized backfill count is greater than zero and no more than 2,000;
2. the appended normalized event is emitted exactly once; and
3. the working-state sentinel is consumed exactly once, independently proving the byte range was not reread.

Command and result (2026-07-15):

```text
$ cd prettyd && npx tsx --test scripts/test-codex-backfill.mjs
✔ backfills a real rollout and hands off to appended bytes exactly once
ℹ source (read-only): 2026/05/13/rollout-2026-05-13T17-11-40-019e23d3-2616-7b53-856d-619bcdbd2b41.jsonl
ℹ immediate normalized backfill events: 2
ℹ appended normalized event emissions: 1
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

## Clean gates

```text
$ cd prettyd && npm run typecheck
> tsc -p tsconfig.json --noEmit

$ cd prettyd && npm run build
> tsc -p tsconfig.json
```

Both commands exited 0.
