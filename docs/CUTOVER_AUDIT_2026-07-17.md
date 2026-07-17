# Opus adversarial cutover audit (2026-07-17) — verdicts + findings
VERDICT: daily-drive on MacBook = SAFE (sound, race-clean, sacred invariants hold). Mini swap (~30 live sessions) = NOT YET.
SOUND (verified): mass-kill guard can't reach live runners; ledger write-ahead + tombstone separation correct; loopback auth peer-based (not header-spoofable); protocol/classifier/watcher-limits parity with TS; no data races under -race.
FINDINGS:
1. MED (mini-blocker) interop test only covers /bin/bash — no claude/codex watcher reattach under cutover, no 30-session scale, no orphan mass-kill-guard exercise, no launchd PID-reuse branch. → extend interop with provider session + scale + orphan cases.
2. MED snapshot endpoint returns VIEWPORT only; TS returns 1000 lines scrollback (mirror.go ReflowTo/SerializeANSI vs sessions.ts:295). Mitigated by WS replay stream; confirm web client relies on replay, else serialize retained history.
3. MED (mini-blocker) transiently-lost-but-alive runner stranded until restart: manager.go:734 scheduleReconnect early-returns without reschedule; no periodic re-discovery (Discover runs once at startup). Sacred invariant NOT violated (never killed) but visibility lost. → always reschedule + periodic guarded Discover.
4. LOW ledger store.go:372 secureFiles() chmod x3 on EVERY append (perf + a Create can error after commit). → chmod once at open.
5. LOW/INFO /api/health/deep pre-auth (matches TS; awareness on tailnet bind).
6. LOW no panic recovery in background goroutines (streamAttachment/observe/watcher/AfterFunc); http auto-recovers handlers. → defensive recover().
7. INFO codex resolver normalizes cwd (EvalSymlinks) vs TS raw compare — deliberate improvement; confirm symlink fixture.
ENV: TestDaemonScratchLaunchdBootstrapHealthBootout flaky (real launchctl bootout >5s) — widen timeout.
