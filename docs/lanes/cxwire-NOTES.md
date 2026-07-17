# CXWIRE lane notes

## Result

`pretty new --tool codex` now requests a `codex-app-server` session by default.
The original PTY-backed Codex path remains intact and can be selected with
either rollback control:

```sh
PRETTY_CODEX_APPSERVER=0 pretty new --tool codex
pretty new --tool codex --pty-codex
```

`--codex-appserver` explicitly forces the structured path. Because the current
app-server client auto-approves for Pretty's default skip-permissions mode,
`--no-skip-perms` deliberately keeps using the PTY path.

## Architecture

The existing launchd runner has a dedicated app-server host mode. This was
chosen instead of putting the client in `prettyd`: the runner already supplies
the durable per-session process/socket boundary, so a daemon restart only
reattaches to the runner and cannot interrupt the active app-server client.

For a structured Codex session the runner:

1. starts the app-server client and calls `NewConversation`, or calls
   `ResumeConversation` with the persisted conversation ID after a runner
   restart;
2. maps composer submission to `SendUserTurn`;
3. persists every normalized app-server notification in
   `<session-id>.codexapp.jsonl`;
4. replays those JSON events over the runner protocol's forward-compatible
   structured frame (`0x25`); and
5. publishes `conversationId` and `remoteEndpoint` in runner metadata and the
   HELLO payload.

The daemon stores those events in the same structured event window used by
`pretty last`, `pretty transcript`, the HTTP events endpoint, and WebSocket
consumers. Completed agent items retain `source: "codex-app-server"`; deltas,
token usage, item events, and turn lifecycle remain in the canonical history
as structured records. App-server sessions explicitly do not start the Codex
rollout watcher.

`turn_started` sets working immediately and `turn_completed` sets idle
immediately. The byte-rate heuristic remains only for legacy PTY sessions.
This authoritative state flows through notifications and
`wait --until-idle-stable` without a new API shape.

The metadata JSON stores `conversationId` and `remoteEndpoint`. The lane ledger
records the conversation ID as the provider UUID with the minimal durable
`codex resume <conversationId>` recipe; the endpoint-specific attach data stays
in metadata.

Snapshots render normalized user/assistant messages as plain text for the
existing Pretty terminal view.

## Dual view

For an app-server session, the exact user command is:

```sh
pretty attach <pretty-session-id>
```

Pretty executes the stock TUI against the same conversation:

```sh
codex resume --remote "$REMOTE_ENDPOINT" --no-alt-screen "$CONVERSATION_ID"
```

The gated proof also checks that the endpoint persisted in metadata resolves
to a live Unix socket. The original WebSocket/PTY attach path is unchanged for
PTY Codex and other sessions.

## Gated real-turn proof

The opt-in integration test builds a scratch runner, starts a private
app-server Unix socket, uses a temporary `CODEX_HOME` (linking only the existing
auth file), and serves Pretty on random test ports. It never contacts the
installed `:8787` daemon and never creates a production launchd label.

```sh
cd prettygo
CXWIRE_INTEGRATION=1 CGO_ENABLED=0 \
  go test -v ./cmd/pretty \
  -run '^TestCXWireRealTurnRestartReattach$' -count=1
```

Final output:

```text
=== RUN   TestCXWireRealTurnRestartReattach
    cxwire_integration_test.go:131: SESSION_ID 5cb2d779-3e97-4348-919d-b68e1dedb06d
    cxwire_integration_test.go:132: CONVERSATION_ID 019f7186-35e1-7b52-aab6-eeda988474a7
    cxwire_integration_test.go:133: REMOTE_ENDPOINT unix:///tmp/pretty-cxwire-1614404308/app-server.sock
    cxwire_integration_test.go:134: METADATA kind=codex-app-server conversationId=019f7186-35e1-7b52-aab6-eeda988474a7
    cxwire_integration_test.go:168: SEND {"submitted":true,"confidence":"confirmed","text":"Reply with exactly CXWIRE_OK."}
    cxwire_integration_test.go:189: WORKING_STATE working -> idle
    cxwire_integration_test.go:195: LAST_BEFORE_RESTART [
          {
            "role": "assistant",
            "text": "CXWIRE_OK",
            "timestamp": "2026-07-17T19:20:55.67Z"
          }
        ]
    cxwire_integration_test.go:223: LAST_AFTER_RESTART [
          {
            "role": "assistant",
            "text": "CXWIRE_OK",
            "timestamp": "2026-07-17T19:20:55.67Z"
          }
        ]
    cxwire_integration_test.go:232: REATTACHED conversation=019f7186-35e1-7b52-aab6-eeda988474a7 history=11 remote=unix:///tmp/pretty-cxwire-1614404308/app-server.sock
--- PASS: TestCXWireRealTurnRestartReattach (7.74s)
PASS
ok  github.com/uzihaq/pretty-pty/prettygo/cmd/pretty  8.146s
```

The test requires the assistant record to have
`source == "codex-app-server"`; a matching message from any other source does
not satisfy the assertion. It then constructs a fresh session manager, runs
discovery, and verifies the same conversation ID, the same assistant timestamp,
all 11 structured events, idle state, and a reachable remote endpoint.

## Deterministic coverage

The ordinary suite additionally covers:

- default-on, environment-off, explicit PTY, and explicit app-server CLI
  selection;
- structured user/assistant mapping and lifecycle decoding;
- authoritative working to idle behavior with no rollout watcher;
- structured snapshot/history rendering;
- conversation ID and endpoint persistence in metadata;
- provider conversation ID persistence in the ledger; and
- `thread/resume` restoring model/effort defaults for subsequent turns.

## Verification

```sh
cd prettygo
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
CGO_ENABLED=0 go test ./... -count=1
```

Final result:

```text
go build: exit 0, no output
go vet:   exit 0, no output
go test:  exit 0, all packages PASS
```

No commit was created.
