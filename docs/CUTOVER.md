# Production mini cutover runbook

The production mini stays on the Node daemon until Sessions.app has shipped and
the user schedules a joint maintenance window. The cutover is deliberately a
manual SSH operation: observe the real machine first, record what is running,
then change one service definition while keeping every runner artifact intact.
There is no cutover or rollback script.

This runbook is an operator checklist, not authorization to touch the mini.
Stop whenever the observed machine differs from the assumptions below.

## Safety contract

- Never delete or rewrite a runner socket, metadata file, event log, session
  LaunchAgent, ledger entry, or provider transcript during cutover.
- Never infer the production plist label, state directory, port, or binary path.
  Read each value from the live plist and process state.
- Compare exact session IDs before and after. A matching count is necessary but
  not sufficient.
- Keep an exact copy of the old plist and its referenced Node checkout/binaries
  until the observation window has closed.
- If health, discovery, any session ID, or a preserved-runner round trip fails,
  restore the old plist immediately. Do not use recovery to hide a bad swap.

## Evidence required before the maintenance window

- The release build is signed, notarized, stapled, and accepted by Gatekeeper.
- The app has completed a first install and an updater-driven upgrade on
  isolated MacBook state without losing the pre-update session set.
- `go build ./...`, `go vet ./...`, and `go test ./...` pass in `runtime/`.
- `TestNodeRunnerUnderGoDaemonCutover` passes against the frozen Node fixture in
  `runtime/testdata/node-runtime/`.
- The three staged Apple Silicon binaries are `sessions`, `sessionsd`, and
  `sessions-runner`, and their hashes match the app's runtime manifest.
- A maintenance window, operator, rollback decision-maker, and observation
  period are agreed in advance.

## 1. Read-only SSH inventory

Before copying or changing anything, connect with the user present and record:

- macOS version, architecture, logged-in UID, hostname, and free disk space;
- the exact daemon PID, command line, environment, listener, LaunchAgent label,
  and plist path;
- the daemon health response and whether discovery is complete;
- the full session listing in JSON, including exact IDs, kinds, names, and
  states;
- every runner metadata file, socket, event log, and per-session LaunchAgent;
- daemon and representative runner log locations and recent errors;
- the existing Node checkout/binary path and its revision;
- current plist bytes and SHA-256.

Save the inventory outside the directories being changed. Take a fresh backup
of the plist, runtime state, ledger, and configuration without following or
modifying live sockets. Do not stop the daemon during inventory.

Create one disposable shell session through the old daemon and save its ID as
the preserved runner. Send it a unique marker and confirm that the expanded
marker appears in its snapshot; terminal echo alone is not proof.

## 2. Stage without activating

Copy the notarized Sessions.app package or its exact embedded runtime to a new,
immutable revision directory. Do not overwrite the old Node files. Verify:

- SHA-256 against the release manifest;
- `file` reports arm64 Mach-O executables;
- `codesign --verify --strict` succeeds for the app and all three binaries;
- the staged daemon can complete a scratch-state health check on a non-production
  port without reading production state.

Render a candidate LaunchAgent separately. Derive its user, host, port, state,
logs, and label from the observed service. Change only the daemon executable to
the staged `sessionsd`, set the adjacent `sessions-runner` path explicitly, and
use `SESSIONS_*` environment names. Validate the candidate with `plutil -lint`
and review its diff against the saved production plist line by line.

## 3. Manual activation

Immediately before activation, repeat health and the full JSON session listing.
That exact ID set is the cutover baseline.

With the old plist and rollback commands already prepared:

1. Boot out only the observed daemon LaunchAgent. Do not touch session
   LaunchAgents or runner processes.
2. Atomically place the reviewed candidate plist at the same service location.
3. Bootstrap and kickstart that one daemon service.
4. Poll health until `ok:true` and `discovering:false`, with a short agreed
   deadline.
5. Fetch the full session listing and compare exact IDs with the baseline.

Do not continue to acceptance checks if any baseline ID is absent, any unknown
service was affected, the daemon repeatedly exits, or logs show protocol or
reconnect failures. Roll back immediately.

## 4. Acceptance checks

After the exact baseline returns:

- Round-trip a new unique marker through the preserved Node-created runner and
  prove the expanded output appears in its snapshot.
- Inspect at least one existing Claude session and one existing Codex session
  without sending input to active work.
- Open the local UI, reconnect, and compare its session set with the CLI JSON.
- Create one disposable new session and confirm its process uses the staged
  `sessions-runner` binary.
- Inspect daemon and representative old/new runner logs for repeated exits,
  protocol warnings, or reconnect loops.

Record the revision, binary and plist hashes, exact baseline/final ID sets,
health output, preserved-runner marker, PIDs, operator, and timestamps.

## 5. Manual rollback

Rollback is the first response to any failed acceptance check or unexplained
regression:

1. Boot out only the new daemon LaunchAgent.
2. Restore the exact saved Node plist bytes atomically.
3. Validate the restored plist, bootstrap it, and kickstart the old daemon.
4. Wait for health and discovery, then compare exact IDs with the baseline.
5. Send a different marker through the same preserved runner and verify the
   expanded output in its snapshot.

Do not delete the staged Go runtime during rollback, and do not delete the Node
plist backup after a successful rollback. Preserve logs and both inventories for
diagnosis.

## 6. Recovery is not cutover

`sessions recover` may inspect ledger and runner state after the original
service is healthy again. The expected clean result is no unexpectedly lost
lanes. `sessions recover --reopen` creates replacement work and therefore
requires a separate, explicit decision; it is never part of normal activation
or rollback.

## 7. Observation window

Recheck health, discovery, exact session IDs, daemon PID stability, and logs
after 5 minutes, 30 minutes, and the next idle/active transition. Keep the old
Node runtime, original plist, fresh backup, and preserved runner through the
agreed window. End the disposable sessions only after rollback is no longer
needed and the user accepts the cutover.
