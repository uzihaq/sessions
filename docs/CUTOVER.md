# Node-to-Go daemon cutover

> **Deferred:** do not run this procedure now. Ship and exercise Pretty.app on
> macOS first. The production mini remains untouched until the user schedules
> its first app install as a joint maintenance window.

This runbook swaps only the daemon. Existing per-session runners stay alive and
keep owning their PTYs. The cutover scripts are dry-run-only unless
`--execute` is present, take a runner-count baseline, fail closed on a drop,
and keep an exact copy of the node daemon plist for rollback.

Run the live section only from a shell on the Mac mini during an announced
maintenance window. Do not aim development or test commands at the mini; use a
scratch `HOME`, runner state directory, ledger, and non-8787 port instead.

## Proven compatibility boundary

`prettygo/internal/interop/cutover_test.go` exercises real compiled processes
in both directions:

- a Node `prettyd/dist/runner.js` running `bash -i` is discovered by the Go
  daemon, listed by `GET /api/sessions`, accepts input, returns the expanded
  marker in a snapshot, survives Go-daemon shutdown, and reattaches after the
  Go daemon restarts;
- a Go runner is discovered by the TypeScript daemon and passes the same
  list/input/snapshot/survival regression.

Both use the canonical `RUNNER_*` environment, state files, Unix socket, HELLO,
replay, input, and output frame protocol. Both currently report protocol v1;
no HELLO/frame mismatch or daemon-side compatibility shim was required.

## 1. Preflight checklist

All boxes are mandatory before the maintenance window.

- [ ] The working tree and intended revision have been reviewed.
- [ ] The Go suite and vet pass with `CGO_ENABLED=0`.
- [ ] The bidirectional real-process interop proof passes.
- [ ] `prettyd`, `runner`, and `pretty` are built for `darwin/arm64` and have
      been staged on the mini at stable absolute paths.
- [ ] The mini is reachable over the normal administrative channel.
- [ ] The node daemon is healthy and discovery is complete.
- [ ] A disposable Node-spawned shell runner has been created and its ID saved
      for the preserved-runner round trip.
- [ ] A fresh, timestamped mini backup has been taken and verified.
- [ ] The exact installed node LaunchAgent plist exists and no stale cutover
      backup path will be overwritten.
- [ ] The rollback command, variables, and operator are ready before execute.

On the development machine, from the reviewed checkout:

```bash
npm --prefix prettyd run build

cd prettygo
CGO_ENABLED=0 go test -count=1 -v ./internal/interop
CGO_ENABLED=0 go test -count=1 ./...
CGO_ENABLED=0 go vet ./...

DIST_GO_DIR=/absolute/scratch/dist-go bash scripts/build-binaries.sh
file /absolute/scratch/dist-go/{prettyd,runner,pretty}-darwin-arm64
```

Each `file` result must be a Mach-O arm64 executable. Copy the three binaries
to a versioned directory on the mini, make them executable, and do not replace
an in-use binary in place. Example destination:

```text
~/Library/Application Support/pretty-PTY/bin/<revision>/
```

On the mini, create a disposable shell while the node daemon is still active.
This runner is the most direct live proof because it is Node-spawned before the
daemon swap:

```bash
export PRETTYD_HOST='<mini-tailnet-bind-address>'
export PRETTYD_PORT=8787
export PRETTY_BIN="$HOME/Library/Application Support/pretty-PTY/bin/<revision>/pretty-darwin-arm64"

VERIFY_ID="$($PRETTY_BIN --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" new --tool shell)"
test -n "$VERIFY_ID"
printf 'preserved runner: %s\n' "$VERIFY_ID"
```

Record the baseline from `pretty ls --json` and wait for
`GET /api/health` to show `discovering:false`.

### Fresh backup

The backup must be made during this maintenance window, before `--execute`.
It should include the node plist, runner history (sockets are intentionally
excluded), the lane ledger via SQLite's online backup, and Claude/Codex
conversation stores. The following is an example; adjust the destination to
the mini's established backup volume:

```bash
BACKUP_ROOT='<established-mini-backup-volume>/pretty-PTY'
BACKUP_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-node-to-go"
mkdir -p "$BACKUP_DIR"

cp -p "$HOME/Library/LaunchAgents/tech.pretty-pty.daemon.plist" "$BACKUP_DIR/"
rsync -a --exclude='*.sock' "$HOME/.local/state/pretty-PTY/" "$BACKUP_DIR/state/"
rsync -a "$HOME/.claude/projects/" "$BACKUP_DIR/claude-projects/"
rsync -a "$HOME/.codex/sessions/" "$BACKUP_DIR/codex-sessions/"
sqlite3 "$HOME/Library/Application Support/pretty-PTY/ledger/lanes.sqlite3" \
  ".backup '$BACKUP_DIR/lanes.sqlite3'"

find "$BACKUP_DIR" -type f ! -name SHA256SUMS -print0 \
  | while IFS= read -r -d '' file; do shasum -a 256 "$file"; done \
  >"$BACKUP_DIR/SHA256SUMS"
test -s "$BACKUP_DIR/SHA256SUMS"
plutil -lint "$BACKUP_DIR/tech.pretty-pty.daemon.plist"
sqlite3 "$BACKUP_DIR/lanes.sqlite3" 'PRAGMA integrity_check;'
```

The integrity check must print `ok`. Also confirm the backup is on the intended
backup volume, not merely another directory on the mini's system disk.

## 2. Dry run on the mini

Set absolute staged-binary and plist paths. Keep the node backup path unique to
this cutover; the script refuses to overwrite it.

```bash
export PRETTYD_GO_DAEMON="$HOME/Library/Application Support/pretty-PTY/bin/<revision>/prettyd-darwin-arm64"
export PRETTYD_GO_RUNNER="$HOME/Library/Application Support/pretty-PTY/bin/<revision>/runner-darwin-arm64"
export PRETTYD_DAEMON_PLIST="$HOME/Library/LaunchAgents/tech.pretty-pty.daemon.plist"
export PRETTYD_NODE_PLIST_BACKUP="$HOME/Library/LaunchAgents/tech.pretty-pty.daemon.node-<timestamp>.plist"

bash scripts/cutover.sh --dry-run
```

Dry run performs read-only binary/plist validation plus health/session reads,
then prints every planned mutation. It must report the expected nonzero runner
baseline. A dry-run failure is a hard stop; fix staged assets, reachability,
auth, discovery, or path variables first.

## 3. Execute the swap

Keep a second mini shell open. Then run exactly:

```bash
bash scripts/cutover.sh --execute
```

The script performs these guarded steps:

1. verifies both Go binaries are executable Darwin arm64 Mach-O files;
2. smoke-loads the Go daemon with `PRETTYD_SMOKE=1`;
3. confirms the installed plist points at the node daemon;
4. saves the exact node plist without overwriting an existing backup;
5. renders and lints a replacement plist whose program is the Go daemon and
   whose environment includes `PRETTYD_RUNNER`, `PRETTYD_HOST`, and
   `PRETTYD_PORT`;
6. boots out the node daemon, atomically installs the Go plist, bootstraps it,
   and kickstarts `tech.pretty-pty.daemon`;
7. waits for health 200, `discovering:false`, and a session count at least as
   large as the baseline.

If Go activation or runner-count verification fails after the node daemon was
stopped, the script automatically restores the saved node plist, kickstarts
the node daemon, and verifies the same baseline before returning failure.

Do not manually remove runner `.sock`, `.json`, `.events`, or per-session
LaunchAgent plists during the swap.

## 4. Acceptance checks

First verify daemon and fleet state:

```bash
curl --fail --silent --show-error "http://$PRETTYD_HOST:$PRETTYD_PORT/api/health"
curl --fail --silent --show-error "http://$PRETTYD_HOST:$PRETTYD_PORT/api/health/deep"
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" ls --json
```

The health response must be 200 with `ok:true`, `discovering:false`, and the
runner count must not be below the recorded baseline.

Now round-trip through the preserved Node runner. The command contains a shell
variable literally; the snapshot assertion requires its numeric expansion, so
matching only terminal echo of the typed command cannot pass:

```bash
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" \
  send "$VERIFY_ID" --no-wait 'echo CUTOVER_GO_$RANDOM'

for attempt in {1..20}; do
  SNAPSHOT="$($PRETTY_BIN --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" snap "$VERIFY_ID")"
  if printf '%s' "$SNAPSHOT" | grep -Eq 'CUTOVER_GO_[0-9]+'; then
    printf 'preserved Node runner round-trip: PASS\n'
    break
  fi
  sleep 0.25
done
printf '%s' "$SNAPSHOT" | grep -Eq 'CUTOVER_GO_[0-9]+'
```

Check at least one Claude and one Codex session snapshot without sending input
to an active conversation. Confirm the web UI loads, reconnects, and shows the
same session set. Inspect the daemon log and a representative runner log for
protocol warnings, reconnect loops, or repeated exits.

## 5. Rollback

Rollback is the first response to any health failure, runner-count drop,
preserved-runner input failure, repeated protocol warning, or UI/API regression
that cannot be explained immediately. Use the same exported variables,
especially the exact `PRETTYD_NODE_PLIST_BACKUP` created by cutover.

Preview:

```bash
bash scripts/rollback.sh --dry-run
```

Execute:

```bash
bash scripts/rollback.sh --execute
```

Rollback boots out the Go daemon, atomically restores the exact node plist,
bootstraps and kickstarts the node service, then waits for health,
`discovering:false`, and no runner-count drop. If the Go daemon is already
down, rollback derives a conservative baseline from the configured runner-state
socket directory and proceeds. It never deletes the saved node plist.

After rollback, repeat the preserved-runner round trip with a different marker:

```bash
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" \
  send "$VERIFY_ID" --no-wait 'echo ROLLBACK_NODE_$RANDOM'
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" snap "$VERIFY_ID" \
  | grep -E 'ROLLBACK_NODE_[0-9]+'
```

This confirms the same runner survived Go-to-node daemon rollback. Do not
delete the node plist backup until the cutover has passed its full observation
window and an additional fresh backup exists.

## 6. Recovery safety net

`pretty recover` reconciles the append-only lane ledger with runner sockets,
launchd, and Claude/Codex conversation stores. It is a safety net for a lane
that is genuinely unexpectedly lost; it is not part of a normal daemon swap
and should not be used to mask a runner-count regression.

On the mini, inspect only first:

```bash
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" recover
```

The expected result after a clean cutover is `no unexpectedly-lost lanes`.
If the report contains lanes, preserve all state and logs, compare it with the
fresh backup, and review every resume recipe. Only then explicitly reopen:

```bash
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" recover --reopen
```

`--reopen` creates replacement runners and is intentionally not automatic.
Never remove the original state artifacts merely because a replacement opened.

## 7. Post-cutover observation

- Keep the maintenance window open until the preserved runner, UI, snapshots,
  and representative Claude/Codex sessions have been checked.
- Recheck health, discovery, runner count, daemon PID stability, and logs after
  5 minutes, 30 minutes, and the next expected idle/active transition.
- Confirm new sessions use the staged Go runner while pre-cutover Node runners
  remain usable until they end naturally.
- Keep the fresh backup and exact node plist backup through the observation
  window.
- Kill the disposable `VERIFY_ID` only after the rollback window closes:

```bash
"$PRETTY_BIN" --host "$PRETTYD_HOST" --port "$PRETTYD_PORT" kill "$VERIFY_ID"
```

- Record revision, binary hashes, baseline/final counts, health output,
  round-trip marker, operator, timestamps, and whether rollback was exercised.
