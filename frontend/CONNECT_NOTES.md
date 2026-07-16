# Connect implementation notes

## What changed

- Replaced separate host and port inputs with one endpoint input. Explicit HTTP/HTTPS URLs use their standard default ports (80/443); bare localhost and IP endpoints infer HTTP with port 8787; bare hostnames infer HTTPS with port 443.
- Added an Advanced reveal with an optional token field. The parsed scheme and token are persisted in `ServerConfig`, and server rows show the complete scheme-qualified endpoint.
- Added startup handling for `#endpoint=<url>&token=<token>`. It scrubs the fragment with `history.replaceState` before validation/storage, accepts HTTPS or loopback HTTP, upserts and selects the matching server, and does not duplicate an endpoint when replayed.
- Replaced the hard-coded service-worker cache name with a Vite build injection. `VITE_BUILD_ID` produces a deterministic package/build hash when supplied; local builds use a random, date-free seed so every build gets a new cache key.

## Manual browser trace

Run against the Vite dev server with Puppeteer at `http://127.0.0.1:5273`:

1. Opened Settings → server selector → Add server, entered bare `mac.tailnet.ts.net`, revealed Advanced, and entered `ui-token`.
   - Stored endpoint: `https://mac.tailnet.ts.net:443`
   - Token stored: `ui-token`
   - New server selected: yes
2. Loaded `/?trace=1#endpoint=https%3A%2F%2Fmac.tailnet.ts.net&token=fragment-token`.
   - Settled URL: `http://127.0.0.1:5273/?trace=1`
   - `location.hash`: empty
   - Existing endpoint updated rather than duplicated (server count stayed 2)
   - Token updated to `fragment-token`; matching server remained selected
3. Reloaded the scrubbed URL, then replayed the fragment at `/?trace=2`.
   - Server count stayed 2 after both operations (idempotent)
4. Loaded `/?trace=3#endpoint=http%3A%2F%2F100.64.0.10%3A8787&token=must-not-persist`.
   - Fragment was scrubbed
   - Server count stayed 2
   - Rejected token did not appear in persisted server storage

The 390×844 viewport inspection reported no horizontal overflow with the endpoint and token fields expanded.

## Gates

```text
$ npx tsc --noEmit
exit 0 (no diagnostics)

$ npx vite build
vite v5.4.21 building for production...
✓ 94 modules transformed.
✓ built in 1.07s
exit 0
```

The emitted cache key also changed across consecutive builds:

```text
pretty-pty-0f1a7d011005 -> pretty-pty-580310c9ff70
```
