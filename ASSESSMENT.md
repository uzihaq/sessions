# pretty-PTY hosted-shell assessment

## 1. Verdict

**Conditional yes: a hosted dead shell is the right v1 UI distribution, but the proposal is not shippable as “an HTTPS page connects to `http://100.x.y.z:8787`.”** That route is a browser security dead end. The viable v1 is:

1. `prettyd` remains loopback-only on `127.0.0.1:8787`.
2. `tailscale serve --bg 8787` provides a tailnet-only, certificate-valid `https://<machine>.<tailnet>.ts.net` reverse proxy.
3. `https://pretty.somewhere.tech` connects directly to that HTTPS endpoint with the daemon token.
4. The same UI remains embedded in the npm package and served by `prettyd` at `http://localhost:8787` as the offline, recovery, and same-Mac path.

This preserves the useful properties: one centrally updated UI, no application relay, and browser-to-Mac terminal traffic. It also keeps a version-matched local escape hatch. It adds one unavoidable remote-access setup step: enabling Tailscale HTTPS/Serve, potentially including a Tailscale consent page.

The privacy claim needs narrower wording. “Terminal traffic goes directly between your browser and your Mac; Pretty does not relay or store it” is supportable. “We can provably never see terminal data because the shell is static” is not. The hosted JavaScript is the privileged terminal client and a future deployment, compromised hosting account, dependency, analytics script, or XSS could exfiltrate data. Central instant updates and immutable proof are in tension. Ship no third-party scripts, publish the source/build identity, use a restrictive CSP, and make the direct transport inspectable, but do not overclaim cryptographic impossibility.

### What breaks in the actual code today

- The default hosted-shell target does **not** become localhost. `LOCAL_DEFAULT` is `127.0.0.1:8787` (`frontend/src/lib/servers.ts:28-34`), but production browser code treats any local server as the daemon that served the page and returns `window.location.origin` (`frontend/src/api/prettyd.ts:34-56`). On `pretty.somewhere.tech`, the first API and WebSocket calls therefore go back to somewhere.tech, not to the Mac.
- A manually added server cannot solve HTTPS. `ServerConfig` has a `scheme` field (`servers.ts:10-22`) and the API layer correctly maps `https` to `wss` (`api/prettyd.ts:38-63`), but `ServerSelector` asks only for name, host, and port and never sets `scheme` or token (`frontend/src/components/ServerSelector.tsx:47-61, 113-139`). Every new server consequently defaults to `http`/`ws`.
- HTTP from the hosted origin is not allowed by the daemon. `handleHttp` only emits `Access-Control-Allow-Origin` when `isAllowedOrigin` approves the Origin (`prettyd/src/http.ts:174-193`). The current allowlist accepts loopback or a hostname equal to the bind host (`prettyd/src/config.ts:69-86`), not `pretty.somewhere.tech`.
- WebSockets fail harder: the upgrade is rejected with 403 before authentication when Origin is not allowed (`prettyd/src/ws.ts:444-478`).
- The token plumbing itself exists: HTTP uses `Authorization: Bearer`, WS uses `?token=`, and the UI persists the token in localStorage (`api/prettyd.ts:66-84, 311-332`; `servers.ts:36-57`). A 401 also produces a paste-token prompt. What is missing is safe, automatic first-run handoff and a reachable HTTPS endpoint.
- The daemon can serve a local shell, but the published package cannot. Its default web path is `../../frontend/dist` relative to the daemon module (`prettyd/src/http.ts:14-16`), while `prettyd/package.json` publishes `bin/`, daemon `dist/`, and `src/` only. `npm pack --dry-run` confirms there is no frontend in the tarball. A global install will return “web build not found” at `/`.

### Mixed content: the fix path

An HTTPS document's `fetch()` to `http://100.x.y.z:8787` and WebSocket to `ws://100.x.y.z:8787` are insecure active mixed content. The IP-literal form is blocked rather than silently upgraded. Tailscale encrypting the underlying link does not make the browser treat an HTTP URL as TLS.

Chrome's Local Network Access permission is not the v1 remote fix. It is browser-specific and evolving; its mixed-content relaxation is for local/loopback destinations, while Tailscale's `100.64.0.0/10` CGNAT range is not RFC1918. WebSocket integration has also lagged fetch. It may make explicit `http://localhost` fetches usable after a permission grant in supporting Chrome versions, but it does nothing for a phone reaching another machine and is not a Safari/Firefox product contract. See [Chrome's Local Network Access design](https://developer.chrome.com/blog/local-network-access) and [MDN's mixed-content guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content).

The least-user-effort robust remote path is Tailscale Serve, not adding TLS to `prettyd`:

```text
browser
  https/wss
    -> https://mac-name.tailnet-name.ts.net
         Tailscale Serve terminates TLS and enforces tailnet ACLs
           -> http://127.0.0.1:8787
                prettyd
```

`tailscale serve --bg 8787` automatically provisions/terminates HTTPS, proxies the loopback port, and persists across Tailscale or machine restarts. If HTTPS is not enabled, the CLI leads the user through consent. That is less code and certificate lifecycle than teaching `prettyd` native TLS. It also lets the daemon stop binding directly to a `100.x` address. See the official [Tailscale Serve guide](https://tailscale.com/docs/features/tailscale-serve) and [`tailscale serve` reference](https://tailscale.com/docs/reference/tailscale-cli/serve). Onboarding must disclose that HTTPS certificates publish the machine and tailnet DNS names to Certificate Transparency; Tailscale recommends renaming sensitive machine names first ([Tailscale HTTPS documentation](https://tailscale.com/docs/how-to/set-up-https-certificates)).

For same-Mac use, the simplest path is a normal top-level link from the hosted onboarding page to `http://localhost:8787`. Top-level navigation is not a mixed-content subresource request; once there, UI/API/WS are same-origin. This is more reliable than making the hosted page depend on Chrome's local-network permission. It requires fixing the embedded frontend package first.

### Origin allowlist and CSWSH

Add one **exact serialized origin**, not another hostname-only exception:

```ts
const HOSTED_SHELL_ORIGINS = new Set([
  'https://pretty.somewhere.tech'
]);

if (HOSTED_SHELL_ORIGINS.has(parsed.origin)) return true;
```

Use this shared check for both the HTTP CORS response and WS upgrade, as the code already does. Tests should reject `http://pretty.somewhere.tech`, alternate ports, suffixes such as `pretty.somewhere.tech.evil.test`, malformed origins, and any other somewhere.tech subdomain. Add `Vary: Origin` to CORS responses. Do not use `*.somewhere.tech` and do not reflect arbitrary origins.

Allowing that fixed HTTPS origin is a reasonable CSWSH policy **with token auth left on**. A hostile site cannot read the token from the trusted origin's localStorage and cannot complete a WS handshake because its Origin is rejected. The 256-bit token is separately checked before WS upgrade, and non-health HTTP routes require it. The trusted hosted shell itself becomes part of the security boundary; compromise of that origin is equivalent to compromise of a terminal client. The `open` escape hatch should be documented as an expert-only reduction in defense-in-depth and should not be the onboarding path.

The current helper compares only `parsed.hostname`, so its existing loopback/bind-host rules accept any scheme and port on those hostnames. That is not a reason to make the new rule equally broad. Tighten/test the policy deliberately, while retaining the exact loopback origins needed by the embedded shell.

### Token handoff

The current `pretty install` prints a raw URL and token if the daemon has generated one; otherwise it tells the user to retry `pretty token` (`prettyd/bin/pretty.cjs:1525-1537`). Requiring a less-technical user to copy host, port, scheme, and 64 hex characters into separate controls is unnecessary failure surface.

Add `pretty open` and make successful install end there:

- Same Mac: open the embedded shell on `http://localhost:8787` with a one-time fragment payload.
- Another device: print a hosted-shell connection URL and a QR code containing the HTTPS Serve endpoint and token.
- Put the bootstrap data in the URL **fragment**, never the hosted URL query string: `https://pretty.somewhere.tech/#endpoint=...&token=...`. Fragments are not sent in the HTTP request or included in normal Referer headers.
- On load, validate that the endpoint is HTTPS (or loopback HTTP), save it to the existing server store, remove the fragment immediately with `history.replaceState`, and connect. Do not retain the secret in browser history.
- Keep `pretty token` and manual endpoint entry as recovery tools. A short pairing code is not worth v0.1: implementing it securely requires another pairing/rendezvous protocol. A QR encodes the existing secret with no backend.

The QR/link is a bearer credential. Anyone who sees it and can reach the daemon can act as the user, so render it only on explicit request, avoid telemetry, and provide token rotation/revocation.

### Offline/local fallback

Keep both shells. The hosted shell is the default remote UI and onboarding surface. The daemon-served shell is needed for airplane/offline use, hosted outage or bad deployment recovery, same-Mac zero-PNA access, and compatibility with an older daemon. Both should be generated from the same frontend source; the npm release embeds a known-good build, while somewhere.tech serves the current build.

Do not let the service worker blur these two distributions. Its current cache version is manually fixed at `pretty-pty-v2`, despite a TODO to inject a build hash (`frontend/public/sw.js`). Use a release hash and show an explicit update action rather than silently replacing a live terminal tab.

## 2. Gap list, ranked by user mortality

### 1. Remote transport and bootstrap — nearly 100% mortality

Today the advertised `https -> http://100.x` route is blocked, the hosted default calls somewhere.tech itself, and Add Server cannot select HTTPS. Make loopback + persistent Tailscale Serve the supported topology; discover its HTTPS URL; add endpoint parsing; add the exact hosted Origin; and auto-import the fragment link. Until all of these land together, a less-technical remote user does not connect.

### 2. npm artifact and launchd install correctness — very high mortality

The npm `bin` mapping is present and the dry-run tarball contains `bin/pretty.cjs` plus daemon `dist/`, which is good. The embedded web build is absent and its runtime lookup points outside the package. Release automation must build daemon and frontend before packing, place the web assets inside the `prettyd` package, and smoke-test the actual tarball in a clean directory. `pretty install` should fail early if `dist/server.js`, the web index, `launchctl`, or the selected Node executable is missing; wait for `/api/health` instead of racing token creation; and be idempotent on upgrades, including restarting an already-loaded daemon rather than merely tolerating status 17.

### 3. Native dependency/toolchain preflight — high mortality for affected machines

`node-pty` is native. Version 1.0.0 in this checkout carries Darwin arm64/x64 prebuilds, so Xcode Command Line Tools should not be an unconditional prerequisite, but unsupported Node/platform combinations or failed prebuild installs fall back to node-gyp. Detect macOS/architecture/Node support, actually load `node-pty` and spawn a trivial PTY during install/doctor, and only then direct failures to `xcode-select --install`. Preserve the existing spawn-helper chmod workaround, but turn failures into one actionable diagnosis rather than a later `posix_spawnp failed` when the user creates their first session.

### 4. First-run product flow — high mortality

Replace the server dropdown's host/port-only form with one endpoint field that parses `https://name.ts.net` and an advanced manual token field. `pretty install`/`pretty open` should prepopulate everything. The hosted page needs a stateful checklist: Tailscale installed and signed in, daemon healthy locally, Serve enabled, token accepted, then first session. Classify mixed content, Origin 403, auth 401, DNS/Tailscale-offline, and daemon-down separately; “Daemon unreachable” is not enough.

### 5. Frontend/daemon version skew and cached-shell updates — medium now, high after the first incompatible release

The daemon already sends protocol `2` in WS `hello`, and the frontend declares protocol `2`, but `wsMux.ts` routes the message without checking `msg.protocol`. Health reports a hard-coded `0.1.0`. A centrally updated shell makes skew normal, not exceptional. Generate versions at release time; negotiate an API/protocol compatibility range; and show two distinct actions: “new shell available — reload” for service-worker/build skew, and “daemon update required — run npm update + pretty install” for incompatible daemon skew. Never send users into a reload loop when the daemon is the old component.

### 6. README/onboarding rewrite — medium mortality, high support cost

The README is developer-first and stale: it tells users to bind directly to a `100.x` IP, says the API is unauthenticated/CORS permissive, and describes token auth as planned even though token and Origin checks are implemented. Rewrite it around the public install path, supported macOS/Node/Tailscale versions, one-command local success, remote Serve consent, QR/open flow, updating/uninstalling, logs, token rotation, recovery via localhost, and the precise privacy/threat model. Keep developer architecture below the user path.

### 7. LICENSE and npm metadata — zero runtime mortality, absolute public-release gate

There is no repository LICENSE and no package `license`, `repository`, `engines`, or macOS support metadata. Users may technically run the software, but organizations cannot safely adopt it and npm consumers cannot know their rights. Choose the license before publishing and include it in the tarball. Also settle the public package/product naming before documenting `npm i -g`; `prettyd` is the package name while `pretty` is the executable.

## 3. Smallest PR-sized plan to v0.1 public

Estimates are focused engineering time, excluding npm/Tailscale account review latency.

1. **Transport/security contract (0.5–1 day).** Add exact `https://pretty.somewhere.tech` Origin support, `Vary: Origin`, CORS/WS regression tests, and a clear rule that remote mode keeps token auth enabled. Add a release-derived daemon version and compatibility fields to health/hello. No hosted deploy yet.

2. **Reproducible npm artifact and local fallback (1–1.5 days).** Embed the frontend under the npm package, change the daemon's default web path accordingly, add LICENSE/metadata, and create a pack/install smoke test that uses the produced tarball. Harden `pretty install` health waiting, restart-on-upgrade, file checks, `node-pty` PTY probe, and useful Xcode CLT fallback. Success gate: on a clean macOS account, `npm i -g <tarball> && pretty install` makes `http://localhost:8787` usable without the repo checkout.

3. **Tailscale Serve setup (1–1.5 days).** Add `pretty remote enable` (and offer it from `pretty install`) that detects Tailscale/login state, keeps prettyd on loopback, runs persistent `tailscale serve --bg 8787`, handles the HTTPS consent URL, reads back the `https://*.ts.net` endpoint, and verifies HTTP plus WS through it. Explain the Certificate Transparency machine-name disclosure before consent. Success gate: a second tailnet device can reach health over HTTPS after reboot.

4. **Hosted first-run and token handoff (1–2 days).** Separate “hosted shell” from the current “production means daemon-served” URL assumption. Parse full endpoints, support HTTPS/WSS in the selector, import and immediately scrub fragment bootstrap data, add `pretty open`, and output a QR for remote-device transfer. Build the onboarding/error states and a same-Mac “Open localhost app” link. Success gate: a fresh phone goes from QR to sessions with no manual token or host typing.

5. **Skew/update UX and hardening (0.5–1 day).** Compare shell, API, and WS protocol versions; inject a service-worker build hash; add reload/update-daemon toasts; apply a strict no-third-party CSP; verify that tokens never enter hosted request URLs or telemetry. Test current shell/old daemon and old cached shell/current daemon.

6. **Docs, hosted deploy, and release rehearsal (1 day).** Rewrite README and hosted onboarding, publish the somewhere.tech raw frontend source through its normal compiler, test Chrome/Safari/Firefox on Mac plus iOS/Android over tailnet, rehearse install/update/uninstall/offline recovery, inspect the final npm tarball, then publish v0.1.

**Total: roughly 5–8 focused engineering days.** PRs 1–4 are the minimum coherent public beta. If Tailscale Serve cannot be automated or reliably explained, do not ship the hosted shell as the main UI; ship the daemon-served localhost/tailnet UI first and use somewhere.tech only for onboarding. Do not ship the raw HTTP `100.x` design with browser-specific workarounds.
