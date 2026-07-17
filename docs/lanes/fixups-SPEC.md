# Lane: FIXUPS — soak finds + deflake
Work ONLY in /Users/uzair/pretty-PTY-fixups. Four surgical items:
1. internal/state/config.go resolveRunnerPath: add platform-suffixed co-located candidates (runner-<GOOS>-<GOARCH>, runner-darwin-arm64 style from scripts/build-binaries.sh naming) AND fail LOUD: if no candidate resolves to an absolute existing executable, createSession must refuse with a clear error — NEVER emit a bare relative name into a launchd plist (tonight's soak: exit 127). Test: table over fake dirs.
2. `pretty new --name X` did not persist (soak: NAME shows "-"): trace name through CLI → POST body → metadata write → ls; fix + test.
3. `pretty ls --json` shape: verify against TS CLI's shape (prettyd/bin/pretty.cjs ls --json against a scratch TS daemon); make identical; golden test.
4. DEFLAKE TestWorkingEdgeWritesSentinelAndHookEnvironment (internal/session/manager_test.go:117): fails ~1/4 under full-suite parallel load (15ms ActivityInterval). Make it load-robust WITHOUT weakening assertions (synchronize on observable state instead of wall-clock, or isolate timing with a controllable clock). Prove: 10 consecutive full-suite runs green.
GATES: build/vet/full-suite -count=1 green ×3. docs/lanes/fixups-NOTES.md real output. No commit.
