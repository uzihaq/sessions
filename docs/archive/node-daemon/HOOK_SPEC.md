# Lovable finish-notifications — make pretty tap you only when it matters
Work ONLY in /Users/uzair/pretty-PTY-hook. NEVER touch the live daemon. Build + node -c must pass. No commit.

TODAY (prettyd/src/sessions.ts:194-214, setWorkingState): on working→idle it fires writeIdleSentinel + onIdle hooks + sendPush({title:`${label} finished`}) — no summary, no body, no distinction between "done clean" and "stuck waiting for the human". Make it lovable. Three parts:

## 1. Informative default push (zero config)
On the working→idle edge, build a RICH push instead of just "X finished":
- Extract a one-line SUMMARY from the session's final assistant message. The daemon holds structured events in `internal.claudeEventLog` (ClaudeSessionEvent[]). Add a helper `finalAssistantSummary(log)` that finds the last assistant text event and returns its first sentence / first ~100 chars (strip markdown, collapse whitespace). For codex sessions the same claudeEventLog is populated by the codex watcher; if empty, fall back to a mirror-snapshot tail. Null if nothing.
- Push shape: title = `🟢 ${label} — done`, body = the summary (or "finished" if none). Keep data.sessionId.

## 2. needs-you vs done (the high-value distinction)
Not every idle is "done" — some are "idle because it's BLOCKED waiting on the human" (a question, a numbered menu/picker, a trust/permission prompt, an error). Add a daemon-side classifier `classifyIdleReason(internal)` that reads the session's mirror snapshot (internal.mirrorSerialize / the same snapshot() path) and returns one of: 'done' | 'blocked' | 'error'. Heuristics on the last non-empty screen lines:
- 'blocked': trailing prompt asking for input — e.g. lines matching /\b(y\/n|yes\/no|\[y\/N\]|continue\?|proceed\?|approve|allow|trust|do you want|which|select|choose|\?\s*$)/i, a numbered picker (multiple `^\s*\d+[.)]\s+` lines with a caret/selector), or a visible "❯"/"›" prompt awaiting a menu choice.
- 'error': trailing lines matching /\b(error|failed|exception|panic|traceback|fatal)\b/i without a following resolution.
- else 'done'.
Then vary the push: blocked → title `🟡 ${label} — needs you`, body = the question/first prompt line; error → title `🔴 ${label} — hit an error`, body = the error line; done → the level-1 shape. This is the whole point — "go live your life, pretty taps you only when it matters." Keep it conservative: when unsure, 'done' (never cry wolf).

## 3. Rich global-hook env (power users)
In runGlobalOnIdleHook (and runOnIdleHook), add env vars beyond the current PRETTY_SESSION_ID/NAME/TOOL/CWD: PRETTY_FINAL_MESSAGE (the summary), PRETTY_OUTCOME ('done'|'blocked'|'error'), PRETTY_DURATION_MS (idle_at - last working-start; track a `workingStartedAt` on SessionInternal, set when working goes false→true). So a 3-line user script can send a great Telegram/Slack message with no extra parsing. Pretty stays out of integrations (no secrets/queues) — just hand them a rich payload.

CONSTRAINTS: TypeScript strict, no any. Classifier + summary must be cheap (runs once per idle edge, not in a loop) and must NOT throw into session handling (wrap in try/catch, default to 'done'/no-summary). Keep sendPush's existing signature (extend PushPayload if needed).

ACCEPTANCE (HOOK_NOTES.md): unit-style proof of classifyIdleReason on 4-5 sample snapshots (a done screen, a y/n prompt, a numbered picker, an error trace) printing the classification; finalAssistantSummary on a sample event log; `cd prettyd && npm run build` + `node -c bin/pretty.cjs` clean. Do NOT commit, do NOT touch the live daemon.
