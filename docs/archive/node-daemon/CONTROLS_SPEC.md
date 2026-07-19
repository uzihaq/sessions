# Spec: agent controls (model/effort/fast) + finish hooks — lane 1 (CLI + daemon)

Read CODEX_CONTROLS.md at the repo root first — it is the research this spec implements (installed
codex 0.144.0, claude 2.1.201; verified mechanisms, not assumptions). Work ONLY in
/Users/uzair/pretty-PTY-controls. Do NOT commit. Do NOT touch the live daemon on port 8787 or any
existing session. Match existing code style; TypeScript strict, no `any`.

## Feature A — `pretty new --model / --effort / --fast`

In `prettyd/bin/pretty.cjs` `cmdNew()`: pluck three new flags before tool resolution:
`--model <m>`, `--effort <level>`, `--fast` (boolean).

Translation (per CODEX_CONTROLS.md §1):
- tool codex  → append `--model <m>` ; effort → `-c model_reasoning_effort="<level>"` ;
  `--fast` → `-c service_tier="priority"`.
- tool claude → append `--model <m>` and `--effort <level>` verbatim.
  `--fast` with claude → `fail()` with a one-line message (claude has no service tier).
- tool shell / custom cmd → any of the three flags is an error ("only for claude/codex").

These must work on EVERY entry path that resolves a tool: `--tool codex`, positional
`pretty new codex`, and `--cmd codex` (see `applyToolDefault()` — thread the plucked values into
it or apply after it; do not double-add if the caller already passed `--model`/`-c model_...`).
Effort values: pass through as given (catalog-dependent; do NOT hard-code an allowlist — codex
validates server-side and claude validates itself). Update the help text (`new` usage lines).

## Feature B — `pretty model <session> <model> [--effort <level>]` (live switch, claude only for now)

New CLI command `model`, wired in the dispatch switch:
- Resolve the session (existing `resolveSessionId` prefix logic).
- If session tool is claude-code AND the session is idle (not working — check the sessions API
  field): send `/model <model>\r` via the existing input path, wait ~1s, then send
  `/effort <level>\r` if given. Print what was sent. (Per research: claude's slash forms are
  direct commands, safe to type; do NOT attempt this for codex.)
- If the session is a codex session: exit 1 with exactly this guidance:
  "live model switch for codex requires an app-server-backed session (coming); use /model in the
  Terminal view, or respin with: pretty new --tool codex --model <m>".
- If the session is working: exit 1 "session is mid-turn; try when idle (pretty wait <id>)".
Add to help text.

## Feature C — global onIdle hook

Per CODEX_CONTROLS.md §2 "Recommended v1 layering", item 2:
- New config file `~/.config/pretty/hooks.json`, shape: `{ "onIdle": "shell command" }`.
- Daemon (`prettyd/src/sessions.ts`): load+validate at startup (malformed → log one warning, ignore;
  never crash). On every observed working true→false edge where the session hasn't exited (the
  existing `setWorkingState` edge that already runs per-session `--on-idle` and push), ALSO run the
  global command: detached `/bin/sh -c`, cwd = session cwd, env adds `PRETTY_SESSION_ID`,
  `PRETTY_SESSION_NAME`, `PRETTY_SESSION_TOOL`, `PRETTY_SESSION_CWD` to the existing env. Global and
  per-session hooks are additive (both run, once per edge). Fire-and-forget; failure must never
  affect session state. Add a 30s kill-timer on the spawned child.
- Keep per-session `--on-idle` and web push untouched.

## Feature D — surface model/effort in `pretty ls --json`

If cheaply derivable, include the spawn-time `model`/`effort`/`fast` in the session metadata the
daemon stores (createSession already receives args — parse the known flags out of them) and expose
in the sessions API + `pretty ls --json`. Requested values only; do not fake "effective" values.
If this requires touching more than sessions.ts/types.ts/http.ts lightly, note it in NOTES and skip.

## Acceptance (run ALL; paste real output into CONTROLS_NOTES.md)

Run your own test daemon from THIS worktree — do not touch the live one:
`cd prettyd && npm run build && PRETTYD_HOST=127.0.0.1 PRETTYD_PORT=8899 node dist/server.js &`
Use `node prettyd/bin/pretty.cjs --host 127.0.0.1 --port 8899 ...` (check how the CLI takes
host/port — env PRETTYD_HOST/PRETTYD_PORT if flags don't exist). KILL every scratch session you
create AND stop your test daemon when done (runners are launchd-global — verify none of your
scratch runners outlive the test: `launchctl list | grep tech.pretty-pty.runner` before/after).

1. `pretty new --tool codex --model gpt-5.5 --effort xhigh --fast --cwd /tmp` → runner .json args
   contain `--model gpt-5.5`, `-c model_reasoning_effort="xhigh"`, `-c service_tier="priority"`,
   plus the existing bypass+update-check defaults. Kill it.
2. Positional `pretty new codex --model gpt-5.5 --cwd /tmp` → same translation applies. Kill it.
3. `pretty new --tool claude --model sonnet --effort high --cwd /tmp` → args contain
   `--model sonnet --effort high` + skip-permissions + --session-id. Kill it.
4. `pretty new --tool claude --fast --cwd /tmp` → exits non-zero with the claude/fast error.
5. `pretty model <claude-scratch> sonnet --effort high` on an idle scratch claude → snapshot shows
   the /model / /effort commands were typed (or their effect); codex scratch → exits 1 with the
   exact guidance text; working session → the mid-turn error.
6. Global hook: write `~/.config/pretty/hooks.json` = `{"onIdle": "touch /tmp/pretty-hook-fired-$PRETTY_SESSION_ID"}`,
   restart YOUR test daemon, drive one short claude turn in a scratch session
   (`pretty send <id> --wait "say hi"`), verify the file appears. RESTORE the user's hooks.json
   to whatever existed before (or delete if none existed).
7. Gates: `cd prettyd && npm run build` clean; `node -c prettyd/bin/pretty.cjs`;
   `cd frontend && npx tsc --noEmit` clean (should be untouched).

Write CONTROLS_NOTES.md: what you changed per feature (file:line), acceptance output, anything skipped and why.
