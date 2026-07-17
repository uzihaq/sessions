# Lane: CODEX APP-SERVER — drive Codex over the structured JSON-RPC contract (the foundational change)
Work ONLY in /Users/uzair/pretty-PTY-appserver. Build internal/codexapp/ (new). This is FOUNDATIONAL: replace PTY-scraping for Codex with the app-server contract — structured reliability AND the GUI stays attachable (dual-view). Read prettygo/ARCHITECTURE.md pins (pure Go, CGO_ENABLED=0).

## Ground truth — the ACTUAL protocol (codex 0.144.5)
- Full JSON-RPC schema is in internal/codexapp/protoschema/*.json (50+ typed messages: newConversation/sendUserTurn/sendUserMessage/*Notification/*Params/*Response, ServerNotification, ClientNotification, JSONRPCMessage, token-count, approvals, item/turn events). READ THESE — they are the contract.
- Transport: `codex app-server proxy` proxies stdio bytes ↔ the running app-server daemon's control socket. `codex app-server daemon start` starts the persistent daemon; `enable-remote-control` exposes it; the standard `codex` TUI can attach to a daemon conversation (this is the DUAL-VIEW — structured drive + attachable GUI on ONE conversation). Discover exact attach mechanics by probing (`codex app-server daemon --help`, `codex --help` for a resume/attach/remote flag).

## DELIVERABLE (this lane = the CLIENT + a proven turn, NOT yet the full session wiring)
1. internal/codexapp: a Go client that speaks the app-server JSON-RPC over `codex app-server proxy` stdio (line-delimited JSON-RPC). Generate Go structs from protoschema/ for the messages you use (newConversation, sendUserTurn/sendUserMessage, and the server notifications for agent-message deltas, token counts, turn/item lifecycle, turn completed). Handle the request/response id correlation + the streaming server-notification channel.
2. Client API: NewConversation(ctx, {cwd, model, effort, approvalPolicy=never/bypass}) -> conversationId; SendUserTurn(ctx, convId, text) -> streams structured events (AgentMessageDelta, ItemStarted/Completed, TokenCount, TurnComplete) via a channel; returns final assistant message + token usage + completion status. Approvals: auto-approve (bypass) per our skip-perms default.
3. DUAL-VIEW PROOF: show the standard codex TUI attaching to the SAME conversation the client created (or document precisely the exact command + why, if attach requires daemon/remote-control setup). This is the whole point — capture the evidence.

## ACCEPTANCE (docs/lanes/appserver-NOTES.md, REAL output)
- A Go test/spike (this machine has codex authed; use a scratch cwd like /tmp) that: starts the app-server, NewConversation in /tmp, SendUserTurn "Reply with exactly APPSERVER_OK.", and asserts the streamed events include agent-message content == "APPSERVER_OK", a TokenCount > 0, and a turn-completed. Print the raw event sequence.
- The dual-view evidence (TUI attach to the same conversation) OR a precise documented mechanism + the daemon/remote-control commands that enable it.
- CGO_ENABLED=0 go build ./... + go vet clean. Full existing suite still green (you ADD codexapp; don't touch other packages). NO commit.
NEXT LANE (note in NOTES, don't build): wiring codexapp into internal/session so `pretty new --tool codex` launches via app-server (structured history replaces rollout-watchers; snapshot/attach = the TUI). This lane de-risks the protocol first.
