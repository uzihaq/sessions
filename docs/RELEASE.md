# Release Pretty

Pretty.app is the primary macOS release vehicle. Standalone Go archives remain
a secondary headless/developer distribution, not the product's main install or
update story.

## Current state

The checked-in Tauri application is a signed v1 window and tray shell. It does
not yet bundle the Go runtime, install the daemon, update itself, or perform the
post-update adoption check. Do not distribute it as the finished product until
the v2 gate in [`NATIVE_APP.md`](NATIVE_APP.md) is complete.

Developer builds may use:

```sh
npm install
npm --prefix frontend install
npm run tauri:build
```

The resulting `.app` is a local development artifact. A Developer ID signature
alone is not a public release: the final bundle must also be notarized and
stapled.

## macOS app release gate

Before publishing a version:

1. Start from a clean reviewed commit on the current product branch.
2. Run the full Go, frontend, and Rust gates.
3. Build signed embedded Go binaries and the containing app.
4. Verify every nested executable with `codesign --verify --strict`.
5. Exercise a first install and an upgrade against scratch state.
6. Prove the pre/post session baseline and rollback behavior.
7. Submit for notarization, staple the ticket, and require `spctl` acceptance.
8. Sign and publish the updater manifest and immutable app artifact.
9. Install through the same channel a customer will use and repeat the health
   and session-adoption check.

The required Apple credential is an app-specific password or App Store Connect
API key. Credentials are release secrets and must never be committed.

## Standalone binary archives

The secondary archive builder remains available for automation and unsupported
headless installs:

```sh
./prettygo/scripts/release.sh --version 0.1.0 --dry-run
./prettygo/scripts/release.sh --version 0.1.0
```

Each archive contains adjacent `pretty`, `prettyd`, and `runner` binaries,
`LICENSE`, and `README.md`, with a matching SHA-256 file. Homebrew may remain a
power-user channel, but its formula is not the native app updater and must not
be presented as the primary macOS experience.

## Production mini

Shipping the macOS app does not authorize a mini cutover. The mini remains on
the Node daemon until the user schedules a joint first install after the app
has shipped. Follow [`CUTOVER.md`](CUTOVER.md) only during that separate
maintenance window.
