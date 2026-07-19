# pretty-PTY roadmap

The native application is now the product package. The Go daemon, runner, and
CLI remain the runtime inside that package; the React UI remains shared by the
native client and the daemon-served browser client.

## Now: ship Pretty.app for macOS

Pretty.app v1 already proves the lifetime boundary: it provides tray status and
scoped windows, while quitting the app leaves the daemon and every runner
alive. The release build is v2:

1. Bundle the signed `pretty`, `prettyd`, and `runner` binaries in the app.
2. Install or upgrade the per-user launchd daemon on first run without taking
   ownership of its lifetime.
3. Add a signed Tauri updater feed hosted as static metadata on somewhere.
4. Notarize the app before distributing it outside the development machine.
5. Encode the update safety ritual: record the session baseline, swap the
   daemon, wait for health and discovery, verify every runner was re-adopted,
   and report success only when the counts match. Roll back on failure.

The MacBook remains the development channel. The production mini is not part
of this phase and must remain untouched. Its first Pretty.app installation is a
later, joint Node-to-Go cutover after the app itself has shipped.

See [`docs/NATIVE_APP.md`](docs/NATIVE_APP.md) for the package and lifetime
contract.

## Next: Android

After the macOS app ships, reuse the Tauri 2 client and React UI for Android.
The Android app is a paired client for a user's Mac daemon, not a mobile daemon
host. Native work includes FCM delivery over Pretty's existing encrypted push
path, secure credential storage, widgets, and a Quick Settings entry point.
If Tauri's Android shell proves limiting, keep the daemon protocol and use a
thin Kotlin client rather than changing the runtime boundary.

## Later

- iOS client focused on APNs, widgets, and Live Activities.
- Central keyword search across configured machines.
- Session sharing after the pairing and per-device credential ladder.
- Unified diff review in the native app.
- Customer-owned always-on machines through somewhere.
- Local semantic search only if FTS5 proves insufficient in real use.

## Explicitly not planned

- A custom Pretty relay or cloud terminal-data plane.
- A required Pretty account or token markup.
- Prompt queuing; the user rejected it as redundant.
- A PWA rung before native mobile.
- Making the Tauri process own daemon or runner lifetime.
- Any mini cutover before the macOS app has shipped and been exercised.
