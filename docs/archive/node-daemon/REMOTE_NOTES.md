# PR3 remote access notes

## Implemented flow

`pretty remote enable` now:

1. Runs `tailscale version` and `tailscale status --json`. A missing CLI points to
   `https://tailscale.com/download`; a disconnected/logged-out client says to run
   `tailscale up`.
2. Reads `/api/health` before changing Serve. It tries the CLI's resolved target,
   then this machine's own IPs from `tailscale status --json`; this covers a fresh
   shell where the LaunchAgent is pinned to `100.x` but `PRETTYD_HOST` is not
   exported. The health payload now includes the daemon's resolved `listen.host`
   and `listen.port`, so Serve targets the address that actually answered as
   prettyd rather than assuming `127.0.0.1`.
3. Prints the Certificate Transparency privacy disclosure before invoking
   `tailscale serve --bg http://<listen-host>:<listen-port>`.
4. Streams the Serve command's output while it runs, so Tailscale's one-time HTTPS
   consent URL is visible immediately.
5. Reads `tailscale serve status --json` (with the human-readable status as a
   compatibility fallback) and finds the HTTPS endpoint proxying that exact daemon
   target.
6. Resolves the `.ts.net` hostname through the system resolver, then fetches
   `<endpoint>/api/health` over HTTPS. Success is printed only after a real HTTP 200.
7. Prints the verified endpoint and a terminal QR for
   `https://pretty-pty.somewhere.tech/#endpoint=<encoded endpoint>`.

`pretty remote status` performs the same Tailscale preflight, endpoint readback,
DNS lookup, and HTTPS health verification without changing Serve configuration.

`pretty remote disable` removes only the default HTTPS root handler installed by
the enable command (`tailscale serve --https=443 --set-path=/ off`) and reads status
back afterward. It deliberately does not use `tailscale serve reset`, because reset
would remove unrelated Serve handlers on the machine.

## MagicDNS failure handling

The live machine reproduces the known gap: Tailscale reports MagicDNS enabled for
the tailnet and Serve is configured, but the local system resolver cannot resolve
the machine's `.ts.net` name. `pretty remote status` detects `ENOTFOUND`/equivalent
resolver failures separately from TLS, timeout, and non-200 failures. It reports:

- enable local Tailscale DNS with `tailscale set --accept-dns=true`;
- confirm MagicDNS in `https://login.tailscale.com/admin/dns`;
- rerun `pretty remote status`;
- no success claim until DNS resolution and the HTTPS health request both succeed.

No DNS preference, Serve configuration, or daemon state was changed during this
work.

## Read-only live probes

Only the allowed read-only commands were run against the live machine. Enable and
disable were not run.

The Serve command help was also read to confirm disable syntax. The installed
LaunchAgent plist was read (not edited) to confirm the live daemon's configured
bind address; it contains `PRETTYD_HOST=100.86.76.84`.

```text
$ tailscale version
1.94.1
  tailscale commit: d885b34776cd2e96f1f368a4d31729e37ff8b59b
  long version: 1.94.1-td885b3477
  go version: go1.25.6

$ tailscale status
100.86.76.84     mac-mini-1        uzairhaq@  macOS    -
100.72.182.4     macbook-pro-3     uzairhaq@  macOS    active; direct 10.129.174.84:41641
100.117.213.113  uzairs-s24-ultra  uzairhaq@  android  idle

$ tailscale serve status
https://mac-mini-1.tail61417e.ts.net (tailnet only)
|-- / proxy http://100.86.76.84:8787

$ tailscale serve status --json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "mac-mini-1.tail61417e.ts.net:443": {
      "Handlers": {
        "/": { "Proxy": "http://100.86.76.84:8787" }
      }
    }
  }
}

$ node prettyd/bin/pretty.cjs remote status
pretty: Tailscale Serve is configured at https://mac-mini-1.tail61417e.ts.net, but that .ts.net name does not resolve on this machine.
Enable Tailscale DNS locally with `tailscale set --accept-dns=true`, and make sure MagicDNS is enabled at
https://login.tailscale.com/admin/dns. Then retry: pretty remote status
Remote access was not verified; not reporting success.
[exit 2]
```

## Verification

```text
$ node -c prettyd/bin/pretty.cjs
[clean]

$ node -c prettyd/bin/remote.cjs
[clean]

$ npm --prefix prettyd run test:remote
tests 6, pass 6, fail 0

$ npm --prefix prettyd run typecheck
tsc -p tsconfig.json --noEmit
[clean]

$ git diff --check
[clean]
```

No build command was run: the worktree's `AGENTS.md` explicitly prohibits local
builds and requires raw TypeScript/TSX source deployment. The TypeScript compiler
was run in `--noEmit` mode instead. No commit was created.
