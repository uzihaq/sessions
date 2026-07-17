# Codex app-server lane notes

## Result

`prettygo/internal/codexapp` now drives persistent Codex conversations through
the app-server protocol. Its public flow is:

```go
client, err := codexapp.NewClient(ctx, codexapp.Options{})
conversationID, err := client.NewConversation(ctx, codexapp.ConversationOptions{
    CWD:    "/tmp/work",
    Model:  "",     // empty uses the Codex default
    Effort: "high", // optional turn override
})
stream, err := client.SendUserTurn(ctx, conversationID, "message")
for event := range stream.Events {
    // AgentMessageDelta, ItemStarted, ItemCompleted, TokenCount, TurnComplete
}
result, err := stream.Result(ctx)
```

Empty approval/sandbox options deliberately map to `approvalPolicy: "never"`
and `sandbox: "danger-full-access"`. The client also answers current command,
file-change, and permission approval requests with session-scoped approval, and
answers the two legacy approval request methods for compatibility.

### Protocol detail discovered during verification

Codex 0.144.5 no longer exposes the legacy `newConversation`, `sendUserTurn`,
or `sendUserMessage` wire methods in the supplied schema. The requested Go API
maps to the current methods:

- `NewConversation` -> `thread/start`
- `SendUserTurn` -> `turn/start`
- assistant streaming -> `item/agentMessage/delta`
- tokens -> `thread/tokenUsage/updated`
- completion -> `turn/completed`

There is also an important transport distinction. Direct
`codex app-server --stdio` uses newline-delimited JSON, but
`codex app-server proxy` is byte-transparent: its stdin/stdout carry an HTTP
WebSocket upgrade followed by WebSocket frames. The client therefore performs
the `ws://localhost/rpc` upgrade over the proxy pipes and sends one JSON-RPC
object per text frame. Sending JSONL directly to `proxy` produces no response.

The client first tries the managed daemon. The Homebrew Cask installation on
this machine lacks the installer's fixed standalone path, so its daemon command
returns:

```text
Error: managed standalone Codex install not found at /Users/uzair/.codex/packages/standalone/current/codex
```

For normal use, `NewClient` automatically falls back to an owned app-server on
a private `/tmp` Unix socket, still reached through `codex app-server proxy`.
`Client.RemoteEndpoint()` returns the exact endpoint for TUI attachment. Setting
`ManagedDaemonRequired` disables that fallback.

## Real turn proof

The acceptance test is opt-in so the ordinary suite never spends a model turn:

```sh
cd prettygo
CODEXAPP_INTEGRATION=1 CGO_ENABLED=0 \
  go test -v ./internal/codexapp -run '^TestRealAppServerTurn$' -count=1
```

For the captured run, a disposable `/tmp` `CODEX_HOME` supplied the managed
standalone slot while reusing this machine's existing authentication. The test
created a fresh scratch cwd beneath `/tmp`, sent
`Reply with exactly APPSERVER_OK.`, printed every selected structured event,
and removed the scratch cwd afterward.

```text
CONVERSATION_ID 019f7156-c1fe-7461-9a8b-a7e5af977520
SCRATCH_CWD /tmp/pretty-pty-codexapp-714776628
EVENT 01 codexapp.ItemStarted {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","startedAtMs":1784312941416,"item":{"id":"019f7156-cb68-7023-abb6-48317b385246","type":"userMessage"}}
EVENT 02 codexapp.ItemCompleted {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","completedAtMs":1784312941416,"item":{"id":"019f7156-cb68-7023-abb6-48317b385246","type":"userMessage"}}
EVENT 03 codexapp.ItemStarted {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","startedAtMs":1784312943562,"item":{"id":"msg_07fadbec369d1cac016a5a746f8b388197b58ffeb52ab67ff3","type":"agentMessage","phase":"final_answer"}}
EVENT 04 codexapp.AgentMessageDelta {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","itemId":"msg_07fadbec369d1cac016a5a746f8b388197b58ffeb52ab67ff3","delta":"AP"}
EVENT 05 codexapp.AgentMessageDelta {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","itemId":"msg_07fadbec369d1cac016a5a746f8b388197b58ffeb52ab67ff3","delta":"PS"}
EVENT 06 codexapp.AgentMessageDelta {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","itemId":"msg_07fadbec369d1cac016a5a746f8b388197b58ffeb52ab67ff3","delta":"ERVER"}
EVENT 07 codexapp.AgentMessageDelta {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","itemId":"msg_07fadbec369d1cac016a5a746f8b388197b58ffeb52ab67ff3","delta":"_OK"}
EVENT 08 codexapp.ItemCompleted {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","completedAtMs":1784312943892,"item":{"id":"msg_07fadbec369d1cac016a5a746f8b388197b58ffeb52ab67ff3","type":"agentMessage","text":"APPSERVER_OK","phase":"final_answer"}}
EVENT 09 codexapp.TokenCount {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","usage":{"last":{"cachedInputTokens":9984,"inputTokens":14060,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":14068},"modelContextWindow":258400,"total":{"cachedInputTokens":9984,"inputTokens":14060,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":14068}}}
EVENT 10 codexapp.TurnComplete {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","status":"completed"}
RESULT {"conversationId":"019f7156-c1fe-7461-9a8b-a7e5af977520","turnId":"019f7156-c242-7b43-9603-07fb33823090","message":"APPSERVER_OK","tokenUsage":{"last":{"cachedInputTokens":9984,"inputTokens":14060,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":14068},"modelContextWindow":258400,"total":{"cachedInputTokens":9984,"inputTokens":14060,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":14068}},"status":"completed"}
--- PASS: TestRealAppServerTurn (5.05s)
```

Assertions proved all three acceptance signals:

- agent-message deltas concatenated to exactly `APPSERVER_OK`, and the
  authoritative completed agent item also contained exactly `APPSERVER_OK`;
- last-turn token count was positive (`14068` total tokens); and
- a structured `TurnComplete` arrived with status `completed`.

The unmanaged-install fallback was separately exercised without spending a
turn:

```text
REMOTE_ENDPOINT unix:///tmp/pretty-pty-appserver-2954781504/app-server.sock
CONVERSATION_ID 019f715a-7a72-7423-a44e-a081bda342d2
--- PASS: TestRealAppServerFallbackHandshake (0.26s)
```

## Dual-view proof

With the client-created conversation still on the same managed daemon, the
stock Codex 0.144.5 TUI attached using:

```sh
codex app-server daemon start
codex app-server daemon enable-remote-control
codex resume --remote unix:// --no-alt-screen \
  019f7156-c1fe-7461-9a8b-a7e5af977520
```

The captured terminal rendered the same conversation and scratch cwd:

```text
╭───────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.144.5)                    │
│                                               │
│ model:     gpt-5.6-sol                         │
│ directory: /tmp/pretty-pty-codexapp-714776628 │
╰───────────────────────────────────────────────╯

› Reply with exactly APPSERVER_OK.

• APPSERVER_OK
```

On exit, the TUI itself printed:

```text
To continue this session, run codex resume 019f7156-c1fe-7461-9a8b-a7e5af977520
```

For the client's owned fallback server, use the endpoint returned by the
client while it is alive:

```sh
codex resume --remote "$REMOTE_ENDPOINT" --no-alt-screen "$CONVERSATION_ID"
```

The local Unix TUI path talks directly to the app-server's WebSocket socket;
the Go protocol client reaches that same socket through the byte-transparent
proxy. Both views therefore operate on the same persistent thread ID.

## Verification

The package's deterministic test covers request/response correlation,
pre-response notifications, ordered result aggregation, and auto-approval. The
real-turn and fallback tests are opt-in.

```sh
cd prettygo
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
CGO_ENABLED=0 go test ./...
```

Final output:

```text
go build: exit 0, no output
go vet:   exit 0, no output
go test:  all packages PASS
ok github.com/uzihaq/pretty-pty/prettygo/internal/codexapp 0.681s
```

## Next lane (not implemented here)

Wire `internal/codexapp` into `internal/session` so `pretty new --tool codex`
owns an app-server conversation instead of a Codex PTY. Structured app-server
history should replace rollout watching; snapshot/attach should open the stock
TUI against that conversation.
