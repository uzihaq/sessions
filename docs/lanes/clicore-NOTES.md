# CLICORE lane notes

Date: 2026-07-17

## Result

- Fixed the critical child-argument corruption in `cmd/pretty/app.go`.
  Global `--json`, `--host`, and `--port` parsing now applies only to the
  prefix before the subcommand. Parsing stops at the subcommand (and therefore
  cannot cross a later `--` separator). `pretty run` copies every argument
  after its first `--` directly into the lane request.
- Replaced the hand-written help blob and switch-based command registry with a
  declarative command table in `cmd/pretty/help.go`. Each entry owns its name,
  usage, summary, long help, examples, group, aliases, and handler. The table
  drives dispatch, complete top-level help, and per-command help.
- Top-level help is daily-first in the required order:
  `new/run/ls/lanes/send/ask/wait/last/status/kill/recover`, followed by the
  remaining daily utilities, then `model/models/attach`, then the
  `Admin/operational` group. All dispatched commands are present, including
  `run`, `recover`, `move`, `adopt`, `backup`, and `models`.
- `pretty <command> --help`, `pretty <command> -h`, and
  `pretty help <command>` now render detailed command help with examples and
  exit 0. Help scanning also stops at `--`, so a child `--help` is preserved.
- Added `pretty run --wait [--output] -- <cmd...>`. It waits on the created
  lane's completion manifest, returns the child's exit code, and prints the
  captured output tail when `--output` is set. Without `--wait`, human output
  remains the lane id and JSON output remains the unmodified create response.
  JSON wait output reuses the existing lane-wait shape (which already contains
  `last_output_tail`).
- Kept established command-local `--json` spellings for fixed-shape commands
  (including `wait`, `backup`, `models`, `status`, and `verdict`) without
  allowing that compatibility parser to inspect past a bare `--`. Commands
  with arbitrary child/message arguments require the global prefix spelling,
  so their payload flags cannot be stolen.
- Permission presets/defaults were not changed.

## Tests added

`cmd/pretty/clicore_test.go` covers:

- the `--` preservation matrix for child `--json`, `--host` plus value,
  `--port` plus value, all reserved globals together, the reported shell
  `argv0` reproduction, a second separator, child help flags, empty strings,
  spaces, and embedded newlines;
- prefix-only global parsing and the first-`--` boundary;
- top-level help completeness and required daily ordering;
- successful detailed `--help` for every command-table entry and parity with
  `pretty help run`;
- `run --wait` success and failure exit propagation;
- `run --wait --output` captured-tail output;
- unchanged non-wait id output and create-response JSON shape; and
- rejection of `--output` without `--wait`.

Existing lane-wait and backup tests remain green, including their JSON output
checks.

## Verification

Run from `prettygo/`:

```text
CGO_ENABLED=0 go build ./...
PASS

CGO_ENABLED=0 go vet ./...
PASS

CGO_ENABLED=0 go test ./... -count=1
PASS
```

The full suite passed for all packages. The focused `cmd/pretty` suite also
passed independently with `CGO_ENABLED=0 go test ./cmd/pretty -count=1`.

No commit was created; all changes remain scratch worktree changes.
