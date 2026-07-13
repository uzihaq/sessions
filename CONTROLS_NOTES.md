# Agent controls implementation notes

## What changed

- Feature A — `prettyd/bin/pretty.cjs:1160-1283`
  - Added tool-neutral `--model`, `--effort`, and `--fast` parsing before tool resolution.
  - Applies the native translation once after all `--tool`, positional, and `--cmd` paths converge.
  - Codex receives `--model`, `-c model_reasoning_effort="..."`, and `-c service_tier="priority"`.
  - Claude receives `--model` and `--effort`; Claude `--fast` and controls on shell/custom commands fail before session creation.
  - Existing native `--model`/`-m`, `--effort`, and `-c`/`--config` values are detected to avoid duplicates.
- Feature B — `prettyd/bin/pretty.cjs:1292-1331`, help/dispatch at `1687` and `1716`
  - Added `pretty model <session> <model> [--effort <level>]`.
  - Resolves unique session prefixes, rejects working sessions, sends Claude slash commands through the existing input endpoint with the required delay, and returns the exact Codex guidance.
- Feature C — `prettyd/src/sessions.ts:78-100,164-208`
  - Loads and validates `~/.config/pretty/hooks.json` once at daemon startup.
  - Malformed files log one warning and are ignored.
  - The global hook is additive with the existing per-session hook and web push, receives all four `PRETTY_SESSION_*` variables, runs detached in the session cwd, and has a 30-second kill timer.
- Feature D — `prettyd/src/sessions.ts:219-251,715`; `prettyd/src/types.ts:47-50`
  - Derives requested spawn-time `model`, `effort`, and `fast` values from runner args and exposes them through `SessionInfo`, the sessions API, and therefore `pretty ls --json`.

Nothing was skipped.

## Acceptance output

All commands below used `node prettyd/bin/pretty.cjs --host 127.0.0.1 --port 8899 ...` against the test daemon built from this worktree.

### 1. Codex model + effort + fast

```text
COMMAND 1 ID: ab179f8c-0cbf-4a09-b8a2-8bae849915ad
{
  "cmd": "codex",
  "args": [
    "-c",
    "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=\"xhigh\"",
    "-c",
    "service_tier=\"priority\""
  ],
  "cwd": "/tmp"
}
ls metadata: {"model":"gpt-5.5","effort":"xhigh","fast":true}
killed ab179f8c-0cbf-4a09-b8a2-8bae849915ad
```

### 2. Positional and `--cmd` Codex paths

```text
COMMAND 2 ID: 8d60e1bb-feea-47b7-97ac-c1e4a2bc6093
{
  "cmd": "codex",
  "args": [
    "-c",
    "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5.5"
  ],
  "cwd": "/tmp"
}
killed 8d60e1bb-feea-47b7-97ac-c1e4a2bc6093

--cmd coverage ID: 353417a4-7c1c-4823-8375-082514d07036
{
  "cmd": "codex",
  "args": [
    "-c",
    "check_for_update_on_startup=false",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=\"high\""
  ],
  "cwd": "/tmp"
}
killed 353417a4-7c1c-4823-8375-082514d07036
```

### 3. Claude model + effort

```text
COMMAND 3 ID: ba706005-c738-4eb5-98d5-52ab7919c4b4
{
  "cmd": "claude",
  "args": [
    "--dangerously-skip-permissions",
    "--session-id",
    "679441b8-0dd0-4bb0-ba2b-18b111234bbd",
    "--model",
    "sonnet",
    "--effort",
    "high"
  ],
  "cwd": "/tmp"
}
killed ba706005-c738-4eb5-98d5-52ab7919c4b4
```

### 4. Claude fast rejection

```text
exit=1
pretty: --fast is not supported for claude (claude has no service tier)
```

### 5. Live model switching and rejections

```text
idle for 1012ms
CLAUDE ID: a2f3dc39-0c3d-424b-a8a6-04976e4074b8
sent /model sonnet
sent /effort high

SNAPSHOT TAIL:
❯ /model sonnet
  ⎿  Set model to Sonnet 5 and saved as your default for new sessions

❯ /effort high
  ⎿  Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation

CODEX MODEL REJECTION:
exit=1
pretty: live model switch for codex requires an app-server-backed session (coming); use /model in the Terminal view, or respin with: pretty new --tool codex --model <m>

WORKING REJECTION:
working_seen=1
exit=1
pretty: session is mid-turn; try when idle (pretty wait a2f3dc39-0c3d-424b-a8a6-04976e4074b8)
```

The live Claude commands update Claude's saved defaults. The pre-test `~/.claude/settings.json` model (`claude-fable-5[1m]`) was restored after this test; the pre-existing effort was already `high`.

### 6. Global hook

The test daemon was restarted after writing the requested hook file.

```text
HOOK SESSION ID: d99ac754-c0e9-4337-bce2-3b98e2477e44
submitted
idle for 1009ms
hook file appeared: /tmp/pretty-hook-fired-d99ac754-c0e9-4337-bce2-3b98e2477e44
```

The user's hooks file was absent before the test and is absent again afterward. Hook marker files and scratch Claude JSONL/history entries were removed.

### 7. Gates

```text
=== prettyd npm run build ===
> prettyd@0.1.0 build
> tsc -p tsconfig.json

=== node -c CLI ===
node -c: clean

=== frontend npx tsc --noEmit ===
frontend tsc: clean

=== diff check ===
git diff --check: clean
```

## Cleanup and runner verification

Every acceptance runner was killed and the port-8899 daemon was stopped. No scratch launchd label remains.

The pre-test launchd baseline contained 27 existing `tech.pretty-pty.runner.*` labels. Using a separate `PRETTYD_STATE_DIR` exposed an existing global orphan-sweep interaction: the test daemon booted those labels out because launchd labels are global while the supplied state directory was isolated. Their persistent `.events` logs and Claude/Codex structured logs were intact. I mapped the original IDs to their exact Claude sessions/Codex threads and cwd values, re-bootstrapped the same 27 IDs, and verified:

```text
restored 12 Claude + 15 Codex runner plists
launchd_runner_count=27
json=27 sock=27 events=28
labels_missing_from_baseline:
extra_labels_vs_baseline:
```

Thus the final launchd label set exactly matches the recorded pre-test baseline, with all 27 original IDs live and no extra labels.
