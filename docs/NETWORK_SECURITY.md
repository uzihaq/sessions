# Sessions-owned network and outbound security

Status: **product security policy.** Sessions is local by default. This policy
applies to network traffic initiated by Sessions.app, `sessionsd`, and the
`sessions` CLI. It does not claim that Claude, Codex, a shell, or an agent's own
tools are offline; those subprocesses retain the permissions the user gave
them.

## Default

- Starting, viewing, searching, tagging, and measuring local sessions requires
  no Somewhere account and sends no transcript, prompt, terminal output, usage
  event, or telemetry to Somewhere.
- A new Sessions-owned outbound data path must be visible and attributable. Its
  implementation and UI must name the destination, trigger, payload class,
  credential source, retention expectation, timeout/retry behavior, and how the
  user disables or revokes it.
- Data-bearing outbound features are opt-in. An update check may fetch public
  release metadata automatically, but it must not attach local session data or
  a durable machine/user identifier.
- Sessions does not add third-party analytics, advertising SDKs, or silent crash
  uploads. Local diagnostics stay local until the user previews and explicitly
  sends them.
- LAN, Tailscale Serve, pairing, a future cloud worker, backup, and support
  access are separate capabilities. Enabling one never silently enables
  another or creates a general-purpose tunnel.

## Review checklist for an outbound feature

1. Is the destination allowlisted and is TLS/authentication fail-closed?
2. Can the payload be metadata instead of transcript or terminal content?
3. Does the UI show the action before the first data-bearing request?
4. Are credentials referenced from their owner rather than copied into prompts,
   workspaces, runner environments, or logs?
5. Are requests bounded, cancelable, rate-limited where appropriate, and free
   of unbounded retry queues?
6. Can the user turn it off and revoke server-side capability without
   reinstalling Sessions?
7. Do tests prove local-only operation still works with the network unavailable?

## Native update traffic

Automatic update awareness and `sessions update --check` send only an HTTPS
GET with a non-identifying updater user agent to the fixed public release route:
`sessions.somewhere.tech` redirects to the allowlisted deployed host
`sessions.somewhere.site`. They send no token, cookie, account credential,
machine ID, session ID, usage, transcript, prompt, terminal content, or
telemetry. Installation is explicit.

`sessions update` then accepts only the exact immutable GitHub release path for
the announced version; GitHub's asset redirect is restricted to
`release-assets.githubusercontent.com`. Redirect count and response sizes are
bounded. Even a compromised mutable manifest cannot authorize executable
bytes: the archive must verify with the public key compiled into the CLI, then
the app must pass Developer ID/team/bundle/version and Gatekeeper checks before
the atomic swap. There is no URL, key, proxy credential, or app-path option in
the command surface. The system HTTPS proxy setting may be honored, but TLS
validation and the artifact signature remain mandatory.

## Support-ticket access (coming soon)

`sessions support` may eventually let a user attach diagnostics or grant
temporary support access to a named Somewhere support ticket. It is not a
generic remote shell and is not implemented yet. The minimum acceptable shape
is:

- the user is authenticated through the Somewhere CLI and selects an exact
  ticket;
- local diagnostics are redacted and previewable before upload;
- any live grant is separately confirmed, read-only by default, scoped to
  named machines/sessions/capabilities, short-lived, revocable, and audited;
- a grant never exposes unrelated sessions, provider credentials, environment
  variables, arbitrary filesystem paths, or a master daemon token;
- there is no unattended inbound listener or permanent reverse tunnel;
- write/control access, if ever added, requires a second explicit approval and
  is visually distinct from sharing a diagnostic bundle.

The exact v1 remains an open product decision: a diagnostic-only attachment is
substantially safer than live read access and should ship first unless a real
support case proves it insufficient.
