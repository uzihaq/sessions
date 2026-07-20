# Native application contract

Sessions.app is the primary product package. It distributes and manages the
local runtime without collapsing the process lifetimes that make sessions
durable.

## Lifetime boundary

```text
Sessions.app (Tauri window, tray, installer, updater)
        |
        | install, configure, health-check
        v
prettyd (independent per-user launchd service)
        |
        | discover and attach over local runner sockets
        v
runner <session> -> provider contract, PTY, or headless command
```

- The app may install, update, kickstart, and inspect the daemon.
- launchd owns the daemon after installation.
- Each runner remains independently supervised below the daemon.
- Quitting, crashing, or updating the app must not terminate the daemon or a
  runner.
- Updating the daemon must not restart runners. The replacement daemon adopts
  them through the existing protocol and state contract.

The current shell implements tray status, persistent window geometry, and
server/tool/session-scoped windows in `src-tauri/src/lib.rs`. The release build
also embeds signed Go binaries and runs the lifecycle boundary in
`src-tauri/src/lifecycle.rs`: exact bundled bytes are copied into an immutable,
versioned directory under `~/Library/Application Support/Sessions/runtime/`,
then launchd owns the selected `prettyd` version.

## macOS v2 release gate

A distributable build is complete only when all of these are true:

1. The app bundle contains signed arm64 `pretty`, `prettyd`, and `runner`
   binaries at stable resource paths.
2. First run verifies and stages those exact signed bytes, then installs or
   upgrades a per-user daemon plist using the immutable staged paths.
3. An upgrade records the live-session baseline before touching the daemon.
4. The daemon returns healthy with discovery complete after the swap.
5. Every pre-update runner is visible again and the session count has not
   dropped.
6. Failure restores the previous daemon plist and immutable runtime, then
   verifies the same baseline.
7. The app and nested binaries pass strict code-signing verification, hardened
   runtime inspection, notarization, stapling, and Gatekeeper assessment.
8. The updater consumes a signed manifest. The manifest and artifacts are
   distribution data only; terminal bytes never pass through somewhere.

The app must never call a broad cleanup command during install or update.
Recovery remains an explicit user action through `pretty recover`.

The implementation pins the updater public key and reads
`https://pretty-pty.somewhere.site/releases/latest.json`. Somewhere hosts only
that small mutable metadata file; every signed app archive is immutable and
versioned on GitHub Releases. The settings menu checks explicitly and tells the
user before installation that only the UI restarts—the launchd daemon and its
runners continue independently.

## Release sequence

1. Build and rehearse from source on the MacBook with isolated scratch state.
2. Ship the signed, notarized macOS app through its real update channel.
3. Build the Android paired client after the macOS app has shipped.
4. Revisit the production mini only when the user separately schedules a joint
   first install; that event is also the Node-to-Go cutover.

The mini cutover is deliberately unscheduled. Shipping either client does not
authorize it.
The interop and rollback evidence remains in `docs/CUTOVER.md`,
`docs/CUTOVER_AUDIT_2026-07-17.md`, `scripts/cutover.sh`, and
`scripts/rollback.sh`.

## Mobile sequence

Android follows the shipped macOS app. The Tauri mobile client pairs with and
connects to a Mac-hosted daemon; it does not run `prettyd` or session runners.
Reuse the existing per-device credential and encrypted push contracts. Keep
native additions narrow: secure credential storage, FCM, widgets, and Quick
Settings. iOS follows later when APNs, widgets, and Live Activities justify a
separate thin Swift client.
