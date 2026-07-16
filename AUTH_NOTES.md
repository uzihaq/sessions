# Loopback auth exemption proof

The shared HTTP and WebSocket predicate is:

```text
exempt = socketPeer in {127.0.0.1, ::1, ::ffff:127.0.0.1}
         AND X-Forwarded-For is absent
```

It reads the TCP peer from `req.socket.remoteAddress`. It does not inspect
`Host` or `Origin`, so spoofing either header cannot grant the exemption.
The X-Forwarded-For guard prevents a Tailscale Serve connection, which is
proxied to the daemon over loopback, from being mistaken for a direct local
connection.

`npm --prefix prettyd run test:auth-exemption` proves the required cases:

| Socket peer | X-Forwarded-For | Exempt |
| --- | --- | --- |
| `127.0.0.1` (and both supported IPv6 forms) | absent | yes |
| `127.0.0.1` | present | no |
| `100.64.0.2` | absent | no |

The `~/.local/state/pretty-PTY/open` escape hatch remains an independent auth
bypass. WebSocket Origin validation still runs before auth, so the existing
CSWSH policy is unchanged for exempt and authenticated clients alike.
