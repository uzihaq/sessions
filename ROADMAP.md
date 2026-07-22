# Sessions roadmap

The native application is now the product package. The Go daemon, runner, and
CLI remain the runtime inside that package; the React UI remains shared by the
native client and the daemon-served browser client.

## Shipped: Sessions.app for macOS

Sessions.app proves the lifetime boundary: it provides tray status and scoped
windows, while quitting the app leaves the daemon and every runner alive. Its
release build now bundles the signed Go runtime and implements idempotent
launchd installation, session-baseline rollback, and the signed updater flow.
Sessions 0.1.0 shipped publicly on 2026-07-21:

1. The app and nested runtime are Developer ID signed, notarized, stapled, and Gatekeeper accepted.
2. GitHub tag `v0.1.0` publishes the native app, updater, and checksummed macOS/Linux runtime archives.
3. Somewhere serves the byte-verified signed updater manifest, and the public Homebrew tap serves the app cask and runtime formula.

The native conversation surface now treats structured provider history as its
UI boundary. Codex app-server sessions display streaming answers, progress,
plans, reasoning summaries, tool and command activity, file diffs, context
usage, and safe interruption while retaining Terminal as a fallback. See
[`runtime/internal/codexapp/history.go`](runtime/internal/codexapp/history.go)
and [`frontend/src/components/RemoteView.tsx`](frontend/src/components/RemoteView.tsx).

The MacBook remains the development channel. The production mini is not part
of this phase and must remain untouched. Its first Sessions.app installation is a
later, joint Node-to-Go cutover after the app itself has shipped.

See [`docs/NATIVE_APP.md`](docs/NATIVE_APP.md) for the package and lifetime
contract.

## Now: Mac 0.2 polish, then Android

The next Mac release is implemented in source and awaits the user's local app test. It adds a polished Today journal
with local usage and session/lane evidence plus an opt-in, cached Codex-or-Claude daily recap; a native Connections
center for loopback port, same-Wi-Fi LAN, Tailscale Serve, and one-time device pairing; and automatic signed-update
discovery with an in-app badge and once-per-version native notification. Connections also promotes the optional
Somewhere platform and reports whether its CLI is absent, current, or updateable without mutating the user's global
install. Model calls remain off by default, Codex is recommended, the CLI chooses its default model, recap effort is
set to the lowest supported provider setting, provider input is hard-capped at 32 KiB and excludes transcripts and
durable session IDs, and update install remains explicit (`runtime/internal/recap/service.go`, `src-tauri/src/lib.rs`).

Exercise that source build and the existing public first-install/updater route without touching the production mini.
Then reuse the Tauri 2 client and React UI for Android.
The Android app is a paired client for a user's Mac daemon, not a mobile daemon
host. Native work includes FCM delivery over Sessions' existing encrypted push
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

- A custom Sessions relay or cloud terminal-data plane.
- A required Sessions account or token markup.
- Prompt queuing; the user rejected it as redundant.
- A PWA rung before native mobile.
- Making the Tauri process own daemon or runner lifetime.
- Any mini cutover before the macOS app has shipped and been exercised.
