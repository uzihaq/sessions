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
sessionsd (independent per-user launchd service)
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

The current shell implements tray status, persistent window geometry,
server/tool/session-scoped windows, native connection actions, and a configurable
loopback port in `src-tauri/src/lib.rs`. The release build
also embeds signed Go binaries and runs the lifecycle boundary in
`src-tauri/src/lifecycle.rs`: exact bundled bytes are copied into an immutable,
versioned directory under `~/Library/Application Support/Sessions/runtime/`,
then launchd owns the selected `sessionsd` version. After a healthy install or
update it also exposes the versioned `sessions` binary through a standard
command directory (`/opt/homebrew/bin`, `/usr/local/bin`, then
`~/.local/bin`). If Sessions already owns links in more than one of those
locations, every managed link is updated together so PATH ordering cannot
select an older runtime. An unrelated executable or symlink is never
overwritten, and PATH integration failure never rolls back a healthy daemon or
endangers live sessions.

## macOS v2 release gate

Local release signing is reusable without keeping secrets in the checkout. The
updater keypair lives at `~/.config/sessions/sessions-updater.key{,.pub}` and the
Developer ID identity lives in the login Keychain. Store the Apple app-specific
password once as a generic Keychain password whose service is
`tech.somewhere.sessions.notarization` and whose account is the Apple ID;
`scripts/release-app.sh` loads it automatically when explicit `APPLE_*`
environment variables are absent. CI continues to use repository environment
secrets and takes precedence over the local fallback.

A distributable build is complete only when all of these are true:

1. The app bundle contains signed arm64 `sessions`, `sessionsd`, and `sessions-runner`
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
Recovery remains an explicit user action through `sessions recover`.
Closed-record retention is likewise explicit: `sessions gc` previews by
default and `--apply` appends archive facts without deleting transcripts,
worktrees, or recovery history.

The implementation pins the updater public key and reads
`https://sessions.somewhere.tech/releases/latest.json`. Somewhere hosts only
that small mutable metadata file; every signed app archive is immutable and
versioned on GitHub Releases. The app checks that manifest quietly on launch
and every six hours, shows an in-app badge, and sends at most one native
notification per available version. Download and installation remain explicit.
The settings menu tells the user that only the UI restarts—the launchd daemon
and its runners continue independently.

The bundled CLI exposes the same explicit choice as `sessions update` and a
non-mutating `sessions update --check`. This is a second implementation of the
same pinned trust contract, not a second release channel:

- no command-line or environment override can replace the manifest URL,
  public key, app destination, or release artifact;
- the only accepted artifact is the exact HTTPS
  `github.com/somewhere-tech/sessions/releases/download/v<version>/Sessions.app.tar.gz`
  path announced for `darwin-aarch64`;
- the archive must verify with the pinned prehashed Minisign key, then the
  extracted bundle must pass Developer ID, team, bundle-ID, version, and
  Gatekeeper/notarization checks;
- archive traversal, links, unexpected roots, oversized data, and downgrades
  fail before mutation;
- installation stages beside `/Applications/Sessions.app`, stops only the exact
  current-user Sessions UI process, performs a durable macOS atomic exchange
  with rollback, verifies the installed result, removes the temporary previous
  app, and reopens the UI.

Neither CLI path signals `sessionsd` or a runner. The reopened app performs the
normal managed-runtime handoff. Existing runners are re-adopted serially. A
successful attachment may consume a two-second HELLO wait plus the
ten-second initial replay window; failed probes can retry. Readiness therefore
starts at 30 seconds and adds 15 seconds per baseline runner, capped at five
minutes. The handoff still requires discovery completion and every pre-update
session ID before accepting the new daemon; otherwise it restores and
re-verifies the previous runtime.

## Mac management surfaces

The shared React client now has native-oriented product surfaces:

- **Today** renders local day totals plus factual session/lane activity without
  requiring a model. Written recap generation is opt-in and off by default. It
  uses one pre-authenticated Codex or Claude CLI call and never overrides the
  CLI's default model. Codex runs ephemeral and read-only with user configuration
  and rules ignored; Claude runs without tools or session persistence. Both use
  the lowest supported reasoning effort. The service passes the prompt on stdin,
  hard-caps provider-safe input at 32 KiB, replaces durable IDs with per-call
  aliases, omits full transcripts, and caches the Markdown under daemon state by
  date/input/provider (`runtime/internal/recap/service.go`).
- **Connections** exposes loopback, same-Wi-Fi LAN, Tailscale Serve, and
  device approval in one ladder. The normal Tailscale path is discovery:
  Sessions reads the signed-in client's tailnet peers, displays only machines
  whose HTTPS health route identifies as `sessionsd`, sends a request carrying
  the source device name, and waits for the host app's explicit Accept/Deny.
  Tailscale Serve supplies the account identity; Sessions issues the normal
  revocable per-device credential only after acceptance. No QR, SSH, manual
  endpoint, or master-token copying is part of that path. A five-minute
  single-use link remains the fallback for a private LAN without Tailscale,
  and browser claims remain same-origin. Both paths key the saved entry by a
  daemon-persisted identity, so alternate endpoints update one machine rather
  than duplicating it. Changing the installed daemon port is
  native-only: the lifecycle manager checks the new port, captures live runner
  IDs, moves the launchd daemon, verifies complete re-adoption, persists the
  preference, and restores the prior port and plist on failure. A process which
  races onto the requested new port cannot prevent that restoration.
- **Fleet** is the consumer-facing machine picker as well as the live
  multi-daemon view. `Find machines` invokes the same verified tailnet
  discovery and explicit host-approval flow as Connections; saved daemon
  identity prevents duplicate entries when the endpoint changes. Fleet shows
  each daemon's reported version and advises about older, newer, or
  non-comparable builds without requiring version equality. The compatibility
  boundary remains the daemon protocol, not the marketing release number.
  Nearby-Wi-Fi Bonjour/mDNS discovery is deliberately labeled Coming soon
  until Sessions can advertise the service and handle macOS Local Network
  permission without surprising the user.
- **Somewhere** is an optional card within Connections, not a Sessions account
  requirement. The native command reports whether the CLI is installed, its
  version, and whether the npm registry advertises a newer release. The card
  links to `somewhere.tech` and copies the relevant install/update/docs command;
  it never mutates the user's global CLI (`src-tauri/src/lib.rs`,
  `frontend/src/components/SomewhereCard.tsx`).

Neither surface changes ownership: Tauri remains a client/management plane,
sessionsd remains launchd-owned, and every active session remains runner-owned.

## Release sequence

1. Build and rehearse from source on the MacBook with isolated scratch state.
2. Ship the signed, notarized macOS app through its real update channel.
3. Complete the production Mini handoff through the same public signed channel,
   preserving every runner process.
4. Build the Android paired client.

The first three steps are complete through public 0.2.3. The Mini's app,
managed CLI, and daemon updated while all nine exact session IDs and runner
PIDs remained unchanged. Those runners still use their immutable 0.2.0 runtime,
which must remain installed until they exit.
The compatibility evidence remains in `docs/CUTOVER_AUDIT_2026-07-17.md` and
the interop tests. `docs/CUTOVER.md` is the manual SSH checklist for that joint
operation; there is intentionally no automated production cutover script.

## Mobile sequence

Android follows the shipped macOS app. The Tauri mobile client discovers and
requests access from a Mac-hosted daemon when both devices share a tailnet, with
the one-time LAN QR as fallback; it does not run `sessionsd` or session runners.
Reuse the existing per-device credential and encrypted push contracts. Keep
native additions narrow: secure credential storage, FCM, widgets, and Quick
Settings. iOS follows later when APNs, widgets, and Live Activities justify a
separate thin Swift client.
