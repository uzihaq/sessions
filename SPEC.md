# Fix: `pretty send` exits 1 on sends that actually succeeded (false negative)
Work ONLY in /Users/uzair/pretty-PTY-sendfix. Maintenance track — minimal, surgical TS/CJS change. Files: prettyd/bin/pretty.cjs (the send confirmation logic; find cmdSend / the confirm polling) + daemon src ONLY if the needed signal isn't already exposed. Gate: node -c bin/pretty.cjs (+ npm run build if src touched). No commit. NEVER touch any live daemon.

LIVE BUG (verbatim from a real agent lane today):
  Error: Exit code 1
  pretty send: could not confirm submission after 10000ms
    sent but not confirmed — the session may still be starting; retry, or use `pretty wait` first
    message is no longer in the composer but no JSONL user event appeared yet
  composer tail: "• Working (10s • esc to interrupt)"
The message WAS accepted: composer is cleared AND the session is Working on it. But confirmation requires a JSONL user event within 10s, and a busy/just-started session flushes that late → exit 1 on a successful send. Agents then retry (double-send risk) or wrongly report failure.

FIX (evidence hierarchy, not a longer timeout):
1. Confirmation evidence tiers: (a) JSONL user event appeared → CONFIRMED (exit 0, as today). (b) No JSONL event yet BUT composer cleared AND session working=true (or Working visible in the composer-tail snapshot) → ACCEPTED (exit 0) with a one-line note "accepted (working); JSONL confirmation pending". This is a real acceptance signal — the tool took the input and is running.
2. Exit 1 is RESERVED for genuine failure evidence: message still sitting in the composer after the window, session exited/unreachable, or send API error.
3. Ambiguous leftovers (composer cleared, NOT working, no JSONL within window) → keep a distinct nonzero exit (2) with the current honest wording — do not claim success without evidence.
4. --json output gains a `confidence: "confirmed"|"accepted"|"unconfirmed"` field; human output stays one line. Do NOT change the polling architecture; reuse the signals the CLI already fetches (it already reads composer tail + can read session working state from the sessions API).
ACCEPTANCE (NOTES.md, real output): unit-style test driving the decision function with the 4 evidence combinations (confirmed / accepted-working / still-in-composer / ambiguous) proving exit codes 0/0/1/2; node -c clean. Include a diff summary. No commit.
