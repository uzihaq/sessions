# Lane: CLICORE — fix the top CLI findings from the honest review (critical `--` bug + help + one-shot run)
Work ONLY in /Users/uzair/pretty-PTY-clicore. FILE OWNERSHIP: cmd/pretty/ ONLY (app.go, run.go, help/command-table, related _test.go). Three findings from a real dogfood review (evidence in each):

## FINDING 2 (CRITICAL correctness bug) — `--` flag stealing. FIX FIRST.
Repro: `pretty run --name X -- bash -c 'printf "argv0=%s\n" "$0"' --json` — the `--json` AFTER `--` was STOLEN by pretty's global parser (turned on pretty JSON, removed from child argv). Root cause: cmd/pretty/app.go `newApp` scans+removes --json/--host/--port from the ENTIRE argv before subcommand parsing. This violates `--` convention and can silently retarget the client (--host/--port) or corrupt the child. 
FIX: parse global flags ONLY before the subcommand token, and NEVER past the first `--`. Everything after `--` is the child command, byte-for-byte. Add tests asserting exact preservation of every child arg after `--` including `--json`, `--host`, `--port` (e.g. `pretty run -- tool --json --host x` → child receives all three; pretty output stays default).

## FINDING 4 (HIGH) — help is broken/incomplete
`pretty --help` OMITS working commands run/recover/move/adopt/backup/models but spends space on deploy/remote. `pretty run --help` and `pretty recover --help` print a 1-line usage error and EXIT 1 (should be real help, exit 0). `pretty help run` ignores the arg. The skill says "`pretty --help` for everything" — currently false.
FIX: a single declarative command table (name, usage, summary, long help, examples) that generates: complete top-level help (ALL commands, DAILY workflows first — new/run/ls/lanes/send/ask/wait/last/status/kill/recover — then model/models/attach, then admin: install/uninstall/deploy/remote/token/backup grouped under an "admin/operational" heading), per-subcommand `pretty <cmd> --help` (exit 0, with examples), and `pretty help <cmd>`. Every command including run/recover/move/adopt/backup MUST appear. --help always exits 0.

## FINDING (missing, HIGH-value small win) — one-shot `pretty run --wait --output`
Current spawn→wait→last is 3 commands for a short job. Add `pretty run --wait [--output] -- <cmd>`: spawns the lane, blocks until exit, with --output prints the captured output tail, and PROPAGATES the child exit code as pretty's exit code (like `pretty wait` already does for lanes). Keep the non--wait behavior (print id) unchanged.

CONSTRAINTS: do NOT touch permission defaults (separate user decision). Do NOT change --json field shapes yet (a separate JSON-contract lane owns that) — only ADD the run --wait output, don't restructure existing JSON. Keep all existing behavior/tests green.
GATES: CGO_ENABLED=0 build/vet/full-suite -count=1 green; new tests: `--` preservation matrix (the critical one), --help exits 0 + lists run/recover/move/adopt/backup, run --wait propagates exit code + --output prints tail. docs/lanes/clicore-NOTES.md. No commit. Scratch only.
