# Lane: CXWIRE — wire the app-server client into sessions so `pretty new --tool codex` uses the structured contract
Work ONLY in /Users/uzair/pretty-PTY-cxwire. internal/codexapp (the app-server client) is MERGED + live-verified (NewConversation, SendUserTurn streaming AgentMessageDelta/TokenCount/TurnComplete, auto-approve, RemoteEndpoint for TUI attach). Now make codex sessions RUN on it. FILE OWNERSHIP: internal/session (add a codex-app-server session path/kind), internal/codexapp (extend if needed), cmd/pretty (flag), internal/api (only if a new field is needed). Read prettygo/ARCHITECTURE.md + internal/codexapp/*.go + docs/lanes/appserver-NOTES.md.

## Design (keep the PTY-codex path intact as fallback behind a flag — do NOT break existing tests)
Add an APP-SERVER-BACKED codex session kind to the Manager. When `pretty new --tool codex` runs (default ON for codex, but gated by a config/env PRETTY_CODEX_APPSERVER=1 default-true so it's revertible):
1. Instead of spawning the codex TUI in a PTY, the session holds a codexapp conversation (NewConversation with the cwd/model/effort, auto-approve per skip-perms default). The launchd runner supervises a small host process that owns the app-server conversation + streams events (mirror the runner model, or run the codexapp client in the daemon with the runner holding the app-server proxy — pick the cleaner one, document why; MUST survive daemon restart + reattach like PTY runners: the app-server daemon persists conversations, so on reattach reconnect to the existing conversationId).
2. `pretty send <id>` → SendUserTurn; the streamed structured events (agent deltas, token counts, turn lifecycle) become the session's canonical history — NO rollout-file watching for app-server codex sessions (the structured events ARE the history). Map them into the same event/history shape `pretty last --json` / transcript already return so the API/UI is unchanged.
3. WATCHABLE/dual-view: expose RemoteEndpoint so a codex TUI can attach to the same conversation (`pretty attach <id>` or documented command); snapshot can render from structured events (defer full "cards" — for now a text rendering of the agent messages is fine).
4. working-state: derive from turn lifecycle (turn started=working, turn/completed=idle) — AUTHORITATIVE now, not heuristic. Wire into the classifier path so notifications + wait --until-idle-stable use the real signal for codex.
5. Persist conversationId in session metadata + ledger so reattach works.

## ACCEPTANCE (docs/lanes/cxwire-NOTES.md, REAL output, gated integration test like codexapp's CODEXAPP_INTEGRATION=1):
- `pretty new --tool codex --cwd /tmp` creates an app-server-backed session (assert metadata shows appserver kind + a conversationId).
- `pretty send <id> "Reply with exactly CXWIRE_OK."` → within ~30s `pretty last <id> --json` returns structured history containing an assistant message "CXWIRE_OK" sourced from app-server events (NOT a rollout file).
- working-state flips working→idle on turn completion (assert via status/ls).
- daemon restart → session reattaches to the same conversationId with history intact.
- dual-view: document the exact attach command + evidence (or a Go-level proof the RemoteEndpoint is reachable).
GATES: CGO_ENABLED=0 build/vet/full-suite -count=1 green (existing PTY-codex + all other tests UNbroken); the gated integration test passes with the flag. NO commit. Scratch state + scratch labels only, never the mini, never the installed :8787 daemon (use your own scratch port/state dir).
