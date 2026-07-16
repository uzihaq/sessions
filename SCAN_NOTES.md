# Codex resolver full-scan fallback

## Implementation

- `resolveCodexRolloutPath` still tries the bounded `{today, yesterday, createdAt}` directories first.
- Only the existing bounded `no-cwd-match` branch recursively scans all of `~/.codex/sessions`.
- Full-scan candidates must have `session_meta.payload.cwd === opts.cwd`. They are ordered by absolute timestamp distance from `opts.createdAt`, without rejecting timestamps before `createdAt`; path order breaks exact ties.
- A successful fallback returns `fresh-match-fullscan` and reports `ambiguousCount` using the existing convention.
- A fallback with no match still returns `no-cwd-match`. The existing `no-dir`, `empty-dir`, and `no-after-spawn` outcomes are unchanged.
- Rollout reads remain bounded to the first line via `FIRST_LINE_BYTES`. The bound is now 64 KiB because the three real regression files have 17,087–17,276-byte `session_meta` lines and could not be parsed under the previous 16 KiB cap.

## Real runner proof (read-only)

Before the change, the resolver returned `no-cwd-match` for all three specified runner records. The files do exist and their first-line metadata has the requested cwd. In the current filesystem, each file is in the runner's local `createdAt` date directory, so these exact failures were caused by the truncated 16 KiB JSON read rather than by the bounded date selection.

The updated test reads each `.json` from `~/.local/state/pretty-PTY/runners`, calls the resolver with its `cwd`, `args`, and `createdAt`, and verifies that the returned path is an existing file:

| Runner | cwd | `createdAt` | Resolved rollout | Reason |
| --- | --- | --- | --- | --- |
| `0cae0b90-1548-43d8-a439-ad1df6fdba9f` | `/Users/uzair/somewhere/wt/dashboard-dogfood` | `2026-07-13T00:12:26.313Z` | `2026/07/12/rollout-2026-07-12T17-12-26-019f58d1-6938-72c2-b1d3-638b9c056fcc.jsonl` | `fresh-match` |
| `0ecc9dcd-2c91-4c05-93c4-08bbda88c8e6` | `/Users/uzair/somewhere/wt/review-comms` | `2026-07-16T04:23:41.543Z` | `2026/07/15/rollout-2026-07-15T21-23-42-019f692a-8514-7d12-87ac-d5f723688694.jsonl` | `fresh-match` |
| `0fa852c4-ea1c-4a2f-b0b8-b0003b01fdf4` | `/Users/uzair/somewhere/tech` | `2026-07-13T17:33:08.305Z` | `2026/07/13/rollout-2026-07-13T10-33-12-019f5c8a-4003-7760-82e5-f6abba9803de.jsonl` | `fresh-match` |

A separate disposable-`HOME` regression creates a bounded-directory cwd miss plus two matching rollouts outside the bounded dates. It verifies that the resolver selects the closer rollout from one minute before `createdAt`, returns `fresh-match-fullscan`, and sets `ambiguousCount` to `2`. No live Codex session, runner record, or daemon state is written.

## Verification

- `npm run test:codex-resolver` — pass: 6 tests, including all three real runner subtests and the isolated full-scan fallback.
- `npm run typecheck` — pass (`tsc -p tsconfig.json --noEmit`).
- `git diff --check` — pass.
- `npm run build` was not run because the workspace instructions explicitly prohibit build commands; the non-emitting strict typecheck was used instead.
- `npm run test:remote` — 5 pass, 1 unrelated pre-existing failure. The unchanged test expects `https://pretty-pty.somewhere.tech/...`, while the unchanged implementation returns `https://pretty-pty.somewhere.site/...`.

No commit was created, and the live daemon was never started, stopped, signaled, or otherwise touched.
