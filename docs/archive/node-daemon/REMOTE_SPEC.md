# PR3: pretty remote enable (tailscale serve wrapper)
Goal: one command that makes the daemon reachable from other devices over HTTPS so the hosted shell + phone access work. Work ONLY in this worktree (/Users/uzair/pretty-PTY-remote). NEVER reconfigure the live tailscale serve or touch the live daemon — the machine is live. Test parse + logic only.

Add `pretty remote enable` / `disable` / `status` to bin/pretty.cjs:
1. Preflight: `tailscale version` installed + `tailscale status` logged in; else print the exact fix (download link / `tailscale up`).
2. `tailscale serve --bg http://<daemon-host>:<port>` targeting the daemon's ACTUAL listen address (read it from /api/health or the resolved config), NOT hard-coded 127.0.0.1 — the daemon may bind a 100.x tailnet IP. Surface tailscale's one-time HTTPS-consent URL to the user.
3. Read back the https://<machine>.<tailnet>.ts.net endpoint (`tailscale serve status` / `tailscale status --json`).
4. VERIFY it works: resolve + fetch <endpoint>/api/health. KNOWN LIVE GAP: the .ts.net name may NOT resolve locally (MagicDNS not in the system resolver) even when serve is configured — detect that specific failure and tell the user how to enable MagicDNS (accept-dns / admin toggle); never claim success without a real 200.
5. Print connect info: the endpoint + a terminal QR encoding https://pretty-pty.somewhere.tech/#endpoint=<endpoint> (use `qrcode-terminal` dep or a dependency-free ASCII QR) so scanning lands on the hosted walkthrough pre-filled.
6. Disclose CT-log machine-name visibility BEFORE enabling.
ACCEPTANCE (REMOTE_NOTES.md): you MAY run `tailscale status` / `tailscale serve status` read-only and `pretty remote status`, but do NOT run enable/disable against the live machine. Describe the flow + paste the read-only probes. tsc/build + `node -c bin/pretty.cjs` clean. Do NOT commit.
