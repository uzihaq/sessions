# Sessions roadmap

The native application is now the product package. The Go daemon, runner, and
CLI remain the runtime inside that package; the React UI remains shared by the
native client and the daemon-served browser client.

## Now: ship Sessions.app for macOS

Sessions.app proves the lifetime boundary: it provides tray status and scoped
windows, while quitting the app leaves the daemon and every runner alive. Its
release build now bundles the signed Go runtime and implements idempotent
launchd installation, session-baseline rollback, and the signed updater flow.
The remaining release work is:

1. Prepare the clean versioned release commit and notes, then run the release preflight.
2. Notarize the app before distributing it outside the development machine.
3. Publish the first manifest only after its notarized artifact exists, then exercise the updater through the same channel customers will use.

The native conversation surface now treats structured provider history as its
UI boundary. Codex app-server sessions display streaming answers, progress,
plans, reasoning summaries, tool and command activity, file diffs, context
usage, and safe interruption while retaining Terminal as a fallback. See
[`prettygo/internal/codexapp/history.go`](prettygo/internal/codexapp/history.go)
and [`frontend/src/components/RemoteView.tsx`](frontend/src/components/RemoteView.tsx).

The MacBook remains the development channel. The production mini is not part
of this phase and must remain untouched. Its first Sessions.app installation is a
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
- Session sharing after the pairing and per-device credential ladder.
- Standalone cross-turn diff review and inline comments back to an agent; event-level Codex diffs already render in the conversation activity feed.
- Customer-owned always-on machines through somewhere.
- Local semantic search only if FTS5 proves insufficient in real use.

## Explicitly not planned

- A custom Pretty relay or cloud terminal-data plane.
- A required Sessions account or token markup.
- Prompt queuing; the user rejected it as redundant.
- A PWA rung before native mobile.
- Making the Tauri process own daemon or runner lifetime.
- Any mini cutover before the macOS app has shipped and been exercised.
