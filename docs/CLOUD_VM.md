# Sessions cloud worker v1

Status: **approved product direction; not yet implemented.** This document is
the security and product boundary for the first one-VM-per-user Somewhere tier.
It does not change the local/Tailscale product contract.

## Three APIs that must not be confused

1. The normal Sessions API belongs to the selected `sessionsd`. On this Mac it
   stays on loopback; LAN and Tailscale Serve are explicit user-owned network
   options. Somewhere does not receive those requests.
2. `POST /api/migrate/receive` belongs to a destination Sessions daemon. The
   current `sessions move` command sends a point-in-time provider conversation
   directly to that destination; it does not pass through Somewhere unless the
   destination is a future Somewhere cloud worker.
3. Backup uses the Somewhere storage API. The local daemon sends opted-in
   transcript bytes directly to the user's own Somewhere project at
   `https://api.somewhere.tech/v1/fs/...`. This is intentionally a Somewhere
   data surface, not a relay to another Sessions daemon.

## Somewhere login and backup

The shipped backup path reuses the Somewhere CLI login **by reference**. A user
runs `somewhere login`; the CLI writes its credential under
`~/.somewhere/config.json`. Sessions stores only that path in
`~/.config/sessions/backup.json` and rereads the CLI file for each push. It does
not copy the token into Sessions configuration, an agent prompt, a workspace,
or a runner environment. CLI token rotation therefore takes effect without
rewriting Sessions configuration.

The native onboarding ladder should be:

1. Detect or install the Somewhere CLI.
2. Run `somewhere login` and show the authenticated identity without exposing
   token bytes.
3. Choose or create the user's Somewhere project.
4. Enable backup and show last success, uploaded/skipped/unresolved counts, and
   recovery-key status.

The Somewhere account roadmap adds a private account surface for:

- backup inventory, recency, machine, provider, and restore/download;
- opt-in transcript search across backed-up machines;
- central usage rollups by provider, model, machine, project, tag, and day;
- fleet status: machines, sessions, working/idle/lost state, and last heartbeat;
- later, provisioning and opening the user's always-on worker.

Encrypted backup and hosted search are distinct promises. When
`sessions backup --encrypt` is enabled, Somewhere receives ciphertext and
cannot search or render transcript contents. Hosted search requires a separate,
explicit server-indexed mode for selected plaintext transcripts. The UI must
never imply that server-indexed search is end-to-end encrypted. Fleet status is
operational metadata and remains independently opt-in.

Central usage does not require transcript plaintext. Token counts, cost,
provider, model, tags, and timestamps can be uploaded as a separate opt-in
metadata stream while conversation archives remain encrypted.

### Password recovery is key wrapping, not password hashing

The existing archive format is encrypted with XChaCha20-Poly1305 and a random
local key. A future password-recovery mode must preserve that design: derive a
key-encryption key from the user's password with a memory-hard KDF such as
Argon2id, then use authenticated encryption to wrap the random archive key.
Somewhere stores the salt, KDF parameters, wrapped key, and ciphertext, never
the password. Decryption happens only after the client derives the same key.

`bcrypt` is deliberately not the encryption primitive. It is a one-way login
password verifier and cannot recover session bytes. The recovery phrase remains
the offline escape hatch; losing both the password and recovery phrase means the
encrypted archive is intentionally unrecoverable.

## What a session transfer preserves

The current move is non-destructive. It reads the source conversation, writes a
create-exclusive `0600` copy on the target, starts the target resume, and leaves
the source runner and original provider file in place. Even after the source
runner is deliberately stopped, Claude/Codex retains its provider history file.

It is not yet a complete Sessions-artifact transfer. Today it carries the
provider JSONL/rollout, provider UUID, minimal resume recipe, name, cwd, and Git
workspace identity. Git bytes travel through the repository remote; an allowed
dirty tree uses a temporary checkpoint ref. Credentials, account-profile homes,
attachments, usage aggregates, PTY rings, and the full Sessions ledger do not
move.

Before cloud transfer is promoted, the handoff envelope should also carry the
small useful Sessions metadata: description, tags, lineage/provenance, profile
*name* (never its credentials), and a portable workspace-relative cwd. It must:

- require an idle provider conversation or take a stable two-stat snapshot;
- include byte length and SHA-256 in an immutable manifest;
- stage, validate, fsync, and atomically install on the target;
- refuse a different existing provider file;
- acknowledge the installed digest before target resume;
- preserve the source until the user explicitly retires it.

Usage can be recomputed from provider logs and is not transfer-critical. PTY
scrollback is presentation state, not resumable provider history. Arbitrary
attachments and credentials remain explicitly out of scope.

## v1 topology

The worker is a specialized cloud runtime, not the public Mac daemon copied
unchanged:

```text
Sessions.app / Android
          |
          | Somewhere user auth; HTTPS/WSS
          v
Somewhere control plane + narrow session gateway
          ^
          | outbound authenticated worker channel only
          |
private per-user Fly Machine + persistent volume

Sessions.app --loopback only--> local Mac sessionsd
```

The Fly Machine has no public listener, public IP requirement, Tailscale peer,
SSH product surface, reverse tunnel to a user network, or arbitrary TCP proxy.
It opens an outbound channel to the gateway. The gateway routes only typed
Sessions operations and never forwards arbitrary destinations.

Somewhere is already in the trust boundary for a Somewhere-owned VM: the agent,
workspace, and provider history exist in plaintext while the VM is running.
The gateway therefore does not create a new confidentiality claim. It does
create a cross-tenant blast-radius boundary and must be smaller than the full
daemon, capability-scoped, rate-limited, audited, and unable to name arbitrary
machines or paths.

## Separate identities

Never share one bearer across the human, native client, and worker:

- **Local Somewhere CLI credential:** stays on the user's computer. It may
  authorize account control and direct backup, but is never copied to a VM or
  exposed to an agent.
- **Native app session:** authenticates the human to the Sessions Somewhere
  application. Server code derives the user ID from the verified session; a
  caller-supplied `user_id` is never authority.
- **VM workload identity:** one random, revocable credential per machine,
  stored hashed by the control plane and injected outside the agent-readable
  workspace. It is bound to user, machine, expiry, and explicit capabilities.
- **Short session lease:** terminal input, file operations, and conversation
  attachment require a short-lived lease for one user/machine/session tuple.

The workload identity may heartbeat, publish assigned-session output, receive
input for a leased session, and access its assigned private backup path. It may
not deploy Somewhere projects, manage users or billing, query arbitrary data,
read another user's storage, mint capabilities, or proxy traffic.

## Isolation and no-reachback rules

Every user gets a distinct Fly Machine, persistent volume, and private network
boundary. The worker must not receive local Sessions endpoints, local device
tokens, Tailscale credentials, or the desktop client's configured-server list.
No product feature may ask the VM to connect to a Mac.

The worker network blocks private IPv4 ranges, CGNAT/tailnet space, link-local
and cloud-metadata destinations, IPv6 unique-local/link-local ranges, and DNS
answers resolving into those ranges. The agent still needs ordinary Internet
egress for provider APIs, Git, and package registries; the honest guarantee is
therefore capability and routing isolation from local Sessions, not that
arbitrary code can never contact a public Internet address.

Cloud-to-local transfer is client-mediated: the authenticated native app pulls
an immutable export from the cloud gateway and pushes it to the Mac's loopback
daemon. Local-to-cloud transfer is likewise initiated by the native app or
local CLI. Neither direction gives the VM a Mac address or credential.

## Smallest useful v1

Ship only:

1. Somewhere login and one private Fly Machine per user.
2. Provision/start/stop/revoke plus heartbeat and simple fleet status.
3. A specialized worker with persistent volume and provider login performed in
   that worker environment.
4. Structured Claude/Codex conversation plus interactive terminal attach over
   the outbound worker channel, with bounded replay after reconnect.
5. Workspace-root-scoped list/read/download/upload/apply-patch operations. No
   absolute-root browser and no arbitrary path proxy.
6. Git-backed workspace creation and client-mediated, checksum-verified session
   transfer.
7. Direct account backup status and explicitly opt-in hosted transcript search.

Explicitly defer shared machines, public VM ingress, browser terminals, inbound
webhooks to workers, arbitrary port forwarding, VM-to-Mac calls, collaboration,
bidirectional filesystem sync, multi-region/HA, server-side live process
migration, and claims of searchable end-to-end-encrypted transcripts.

## Public-ingress work that does not disappear

The central gateway is public and must authenticate every operation, including
health/status. Before it carries terminal data it needs short-lived attach
tickets, per-capability authorization, bounded frames/replay, rate and quota
limits, revocation, audit records, and tenant-ownership checks at every lookup.
Browser Origin is not authentication. The current local daemon's broad bearer
and query-token WebSocket compatibility are not the cloud credential model.
