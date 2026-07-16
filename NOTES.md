# Send-confirmation false-negative fix

## Decision-matrix proof

Run from `prettyd/`. This imports only the pure decision function; it does not
contact or manage a daemon.

```sh
node <<'NODE'
const assert = require('node:assert/strict');
const { decideSendConfirmation } = require('./bin/pretty.cjs');

const cases = [
  ['confirmed',         { jsonlConfirmed: true,  textStillInComposer: false, working: false }, 'confirmed',   0],
  ['accepted-working',  { jsonlConfirmed: false, textStillInComposer: false, working: true  }, 'accepted',    0],
  ['still-in-composer', { jsonlConfirmed: false, textStillInComposer: true,  working: false }, 'unconfirmed', 1],
  ['ambiguous',         { jsonlConfirmed: false, textStillInComposer: false, working: false }, 'unconfirmed', 2]
];

for (const [name, evidence, confidence, exitCode] of cases) {
  const actual = decideSendConfirmation(evidence);
  assert.deepEqual(actual, { confidence, exitCode });
  console.log(`${name}: confidence=${actual.confidence} exit=${actual.exitCode}`);
}
NODE
```

Real output:

```text
confirmed: confidence=confirmed exit=0
accepted-working: confidence=accepted exit=0
still-in-composer: confidence=unconfirmed exit=1
ambiguous: confidence=unconfirmed exit=2
```

Syntax gate:

```text
$ node -c bin/pretty.cjs
# no output; exit 0
```

## Diff summary

- Added a pure evidence-tier decision function: JSONL confirmation wins;
  otherwise a cleared composer plus `working` is accepted; a message left in
  the composer is a definite failure; and a cleared, idle composer is
  unconfirmed/ambiguous.
- Reused the existing sessions poll and timeout snapshot. Acceptance reads the
  existing `session.working` flag or the compact `• Working` status line in the
  already-fetched composer tail. Poll timing and Enter retry behavior are
  unchanged.
- Reserved send exit 1 for definite evidence (composer retained the message,
  the session disappeared, or the input API failed). Ambiguous timeout exits 2.
- Added `confidence: "confirmed" | "accepted" | "unconfirmed"` to structured
  send results. Accepted human output is the single line
  `accepted (working); JSONL confirmation pending`.
- No daemon source was changed, and no daemon lifecycle command was run.
