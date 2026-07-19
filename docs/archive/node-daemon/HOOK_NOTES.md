# Lovable finish notifications

## What changed

`prettyd/src/sessions.ts` now builds one finish-notification payload on each observed working → idle edge:

- `finalAssistantSummary()` walks backward to the last text-bearing assistant event, strips common Markdown, collapses whitespace, and returns its first sentence or a roughly 100-character truncation. Claude and normalized Codex events use the same path. If the structured log has no assistant text, the mirror tail is used as a best-effort fallback.
- `classifyIdleReason()` inspects only the trailing non-empty mirror lines and returns `done`, `blocked`, or `error`. Prompt punctuation/phrases, permission prompts, and selected numbered/visible menus are blocked. Unresolved trailing error language is error. Explicit later recovery language and ambiguous screens stay done.
- Pushes are now `🟢 <label> — done`, `🟡 <label> — needs you`, or `🔴 <label> — hit an error`. The body is the final summary for done, the prompt line for blocked, and the error line for error; `data.sessionId` is unchanged.
- Per-session and global idle hooks both receive `PRETTY_SESSION_ID`, `PRETTY_SESSION_NAME`, `PRETTY_SESSION_TOOL`, `PRETTY_SESSION_CWD`, `PRETTY_FINAL_MESSAGE`, `PRETTY_OUTCOME`, and `PRETTY_DURATION_MS`. A missing final summary is represented by an empty string.
- `workingStartedAt` is recorded on the false → true edge and cleared after its matching idle edge. Snapshot parsing, summary extraction, hook launch, and push delivery remain best-effort and cannot throw into activity tracking.

`prettyd/src/push.ts` already accepted an optional `body` while preserving the required `sendPush(payload)` signature, so the richer payload required no transport-layer API change.

## Classifier and summary proof

Reproducible proof lives in `prettyd/scripts/test-idle-notifications.mjs` and runs with:

```text
cd prettyd
node_modules/.bin/tsx scripts/test-idle-notifications.mjs
```

Observed output:

```text
classifyIdleReason samples
  done screen: done
  y/n prompt: blocked
  numbered picker: blocked
  error trace: error
  resolved error: done
finalAssistantSummary sample: Shipped lovable notifications.

6 assertions passed
```

The done sample includes `12 tests passed, 0 failed` to prove the error detector does not cry wolf on an explicit zero-failure result. The resolved-error sample proves that a later successful resolution wins over earlier error text.

## Verification

These required checks completed cleanly:

```text
cd prettyd && npm run build
cd prettyd && node -c bin/pretty.cjs
```

The stricter non-emitting TypeScript gate also passed:

```text
cd prettyd && npm run typecheck
```

No daemon install, restart, signal, or live-state mutation was performed.
