# Lane: CLAUDEP — structured Claude path via `claude -p stream-json`, SIDE BY SIDE with PTY-claude
Work ONLY in /Users/uzair/pretty-PTY-claudep. Mirror the codex app-server pattern (internal/codexapp + the cxwire session-wiring, both MERGED — READ them as the template). FILE OWNERSHIP: internal/claudep (new client), internal/session (new session kind), cmd/pretty (flag), internal/state (metadata field). KEEP PTY-claude (the existing watchable/interactive path) fully intact and DEFAULT — this ADDS a structured kind alongside it (revertible, opt-in), exactly like codex-app-server sits beside codex-pty.

## Ground truth (claude 2.1.212, this machine, subscription-authed — NO ANTHROPIC_API_KEY, keep it that way = subscription billing not metered API)
- Transport: `claude -p "<text>" --output-format stream-json --verbose [--model X]` emits line-delimited JSON events: system/init (carries session_id), assistant (message.content blocks), tool_use/tool_result, result (carries usage/tokens + final). --output-format stream-json REQUIRES --verbose.
- Session continuity: each turn is a SEPARATE `claude -p --resume <session_id> --output-format stream-json --verbose "<text>"` invocation sharing the session (the JSONL/session_id is the truth) — RECOMMENDED model (robust: a crashed turn never loses the session). --input-format stream-json persistent-process mode exists but prefer per-turn-resume unless you find it clearly better (document choice).
- NO attachable TUI (Claude has no dual-view) — watchable = OUR rendering of the structured events (for now a text history is fine; "cards" later). This kind is for structured/headless reliability; PTY-claude remains for the live TUI.

## DELIVERABLE
1. internal/claudep: a client that runs a claude -p turn and streams normalized events (assistant text, tool calls, result+usage), correlates session_id, resumes across turns. Subscription auth (inherit the user's claude login env; MUST NOT set ANTHROPIC_API_KEY).
2. internal/session: a claude-structured session kind. `pretty new --tool claude --structured` (or `pretty run --tool claude` for headless) creates it; first turn starts a session, captures session_id into metadata+ledger; `pretty send` runs a --resume turn; structured events = canonical history (mapped to the same shape pretty last --json/transcript already return); working-state from turn lifecycle (turn running=working, result=idle) — AUTHORITATIVE; reattach via the persisted session_id. PTY-claude kind unchanged + default.
3. cmd/pretty: the flag; help text noting subscription-billed + no live-attach.

## ACCEPTANCE (docs/lanes/claudep-NOTES.md, REAL output; gated integration test CLAUDEP_INTEGRATION=1)
- `pretty new --tool claude --structured --cwd /tmp` → structured session (metadata shows kind + session_id).
- `pretty send <id> "Reply with exactly CLAUDEP_OK."` → within ~30s `pretty last <id> --json` returns assistant "CLAUDEP_OK" from structured events (not TUI-scraping).
- a SECOND send resumes the same session_id (multi-turn continuity) — history accumulates.
- working flips working→idle on result.
- daemon restart → reattaches via session_id.
- confirm subscription auth (no ANTHROPIC_API_KEY needed; works via the logged-in claude).
GATES: CGO_ENABLED=0 build/vet/full-suite green (PTY-claude + all tests UNbroken); gated integration passes. docs/lanes/claudep-NOTES.md. No commit. Scratch state/port only, never the mini, never the installed :8787 daemon.
