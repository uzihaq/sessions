# Codex reattach fix

## Outcome

Reattached Codex runners now resolve rollout history from the runner's own
creation date, and the watcher observes that date tree as well as the normal
today/yesterday trees. The scan remains bounded to at most three unique date
directories.

## 1. Watcher attachment on discovery

Before the fix described by `CODEXFIX_SPEC.md`, newly-created Codex sessions
had structured rollout watchers while sessions discovered after a daemon
restart did not.

The task checkout already had the correct single attachment point in the
shared registration path: `createSession()` calls `registerRunner()` at
`prettyd/src/sessions.ts:872`, and `discoverRunners()` calls the same function
at `prettyd/src/sessions.ts:1146`. The Codex branch classifies the runner and
starts `watchCodexRollout()` at `prettyd/src/sessions.ts:917` and
`prettyd/src/sessions.ts:992-997`, then records normalized events at
`prettyd/src/sessions.ts:1003-1009`.

After this patch, that behavior remains deliberately in `registerRunner()`;
the invariant is documented at `prettyd/src/sessions.ts:989-991`. No second
discovery-only watcher was added, because that would double-read and
double-watch every discovered rollout.

## 2. Older rollout resolution

Before, `codexFreshSessionDirs()` and `codexWatchDirs()` derived paths only
from today and yesterday. A runner created earlier could not find a cwd match,
so its watcher stayed detached and Pretty history remained empty.

After:

- `prettyd/src/codexResolver.ts:74-87` adds the runner's finite `createdAt`
  date and de-duplicates the resulting paths.
- `prettyd/src/codexResolver.ts:217-220` passes `createdAt` into resolution,
  yielding today, yesterday, and the runner start date (at most three days).
- `prettyd/src/codexWatcher.ts:175-177` watches the same bounded date set, so
  reattached sessions follow live appends in the older rollout directory.

Resume-by-ID behavior is unchanged and still resolves before the date-based
fresh-session path.

## Regression proof

`prettyd/scripts/test-codex-resolver.mjs:1-100` is a read-only unit test against
the real `~/.codex/sessions` tree. It chooses a rollout outside today's and
yesterday's directories, reads only its first 16 KiB for `session_meta`, and
asserts that cwd plus the rollout timestamp resolves that exact file.

The test failed before the resolver change with `no-cwd-match`; after the
change it passes with `fresh-match`.

Verification commands:

```text
cd prettyd
npm run test:codex-resolver
npm run build
node -c bin/pretty.cjs
```

All pass. No daemon was started, stopped, signaled, queried, or replaced, and
no commit was created.
