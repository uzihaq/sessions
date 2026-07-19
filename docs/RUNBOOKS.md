# Runbooks

## MacBook development daemon

The MacBook is the only development host. Build from an isolated worktree:

```sh
cd prettygo
export PATH="$PATH:/opt/homebrew/bin"
make binaries
```

Reload only when the task requires it. Before the reload, record `pretty ls`;
afterward wait for discovery to finish, compare the full session set, and
verify `soak-d2`. A count drop or missing session is a failed update.

## Pretty.app development install

`npm run ship` builds the current app shell and replaces the local copy in
`/Applications` without restarting a running app. This is a developer loop,
not the customer updater. The v1 shell does not install or update the daemon.

Do not add daemon ownership to the app process. The v2 installer/updater must
follow [`NATIVE_APP.md`](NATIVE_APP.md).

## Production mini

Do nothing until the user explicitly schedules the joint cutover. Do not use
the old Node `pretty deploy`, do not run the repository's development scripts,
and do not test Pretty.app service installation there.

When scheduled, the mini's first Pretty.app installation becomes the
Node-to-Go cutover. Use [`CUTOVER.md`](CUTOVER.md) and preserve the exact
rollback path. Shipping the app or updating this repository does not itself
schedule that operation.

## Fleet recovery

A recoverable lane is a conversation, workspace, and validated resume recipe.
The ledger and recovery package are authoritative.

1. Run `pretty recover` for a read-only reconciliation.
2. Review every classification and blocked reason.
3. Run `pretty recover --reopen` only for eligible unexpectedly lost lanes.
4. Use `pretty adopt` only with an explicit provider file or conversation ID.
5. Never run two live drivers for the same provider conversation.

Recovery must not be used to hide a failed app or daemon update. A session
baseline regression triggers rollback and investigation first.

## Backups

Use the shipped `pretty backup` path for session history. With `--encrypt`,
content is encrypted locally before upload and the recovery key stays on the
user's machine. Repository history remains protected through Git remotes and
normal signed release tags; do not pass repository archives or credentials
through an agent prompt.
