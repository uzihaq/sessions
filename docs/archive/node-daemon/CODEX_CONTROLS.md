# Codex/Claude controls and finish notifications

Research date: 2026-07-12. This is based on the binaries installed on this machine and the code in this repository, including generated protocol types read directly from the `codex-app-server` branch without checking it out.

## Installed surfaces checked

- `codex --version`: `codex-cli 0.144.0`
- `claude --version`: `2.1.201 (Claude Code)`
- Commands inspected: `codex --help`, `codex exec --help`, `codex resume --help`, `codex app-server --help`, `codex app-server generate-ts --help`, `codex debug models`, `codex features list`, and `claude --help`.
- There is no `codex config` subcommand in 0.144.0. Configuration is read from `~/.codex/config.toml`, a selected profile, and repeatable `-c key=value` overrides.
- Codex's refreshed model catalog was inspected with `codex debug models` and cross-checked against `~/.codex/models_cache.json`.
- App-server claims below come from the generated `prettyd/src/codexProto` types on `codex-app-server`, especially `v2/ThreadStartParams.ts`, `v2/TurnStartParams.ts`, `v2/Model.ts`, `ReasoningEffort.ts`, and `v2/Config.ts`.

The model catalog is account/server supplied and can change independently of the CLI version. Pretty should query the app-server `model/list` catalog when available rather than hard-code this snapshot.

## 1. Model, effort, and fast-mode control

### Codex at process/thread start

All three interactive entry points checked (`codex`, `codex resume`, and `codex exec`) accept both:

```sh
-m, --model <MODEL>
-c, --config <key=value>
```

Therefore these are equivalent ways to select the initial model:

```sh
codex --model gpt-5.5
codex -c 'model="gpt-5.5"'
```

Reasoning effort has no dedicated top-level CLI flag in this Codex build. Set it through config:

```sh
codex --model gpt-5.5 -c 'model_reasoning_effort="xhigh"'
```

The same overrides can be passed to `codex resume` to override the resumed interactive session and to `codex exec` for a non-interactive run. Persistent defaults are:

```toml
# ~/.codex/config.toml
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
service_tier = "priority"
```

`-p/--profile` can layer `$CODEX_HOME/<name>.config.toml` over the base config. A command-line `-m`/`-c` override is the least surprising per-session mechanism because it does not rewrite the user's defaults.

### Models and efforts actually advertised now

The installed CLI's refreshed catalog advertises:

| Model | Efforts | Default | Fast service tier |
| --- | --- | --- | --- |
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` | `priority` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` | `priority` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` | `medium` | `priority` |
| `gpt-5.5` | `low`, `medium`, `high`, `xhigh` | `medium` | `priority` |
| `gpt-5.4` | `low`, `medium`, `high`, `xhigh` | `medium` | `priority` |
| `gpt-5.4-mini` | `low`, `medium`, `high`, `xhigh` | `medium` | none advertised |
| `gpt-5.3-codex-spark` | `low`, `medium`, `high`, `xhigh` | `high` | none advertised |
| `codex-auto-review` | `low`, `medium`, `high`, `xhigh` | `medium` | none advertised |

So the current install is newer than a “GPT-5.5 family only” assumption: it has GPT-5.6 Sol/Terra/Luna. `xhigh` is real. `max` and `ultra` are not universally supported and must be validated against the selected model.

“Fast” is **not** another effort value. The catalog describes Fast as service tier ID `priority`: “1.5x speed, increased usage.” At spawn, select it with:

```sh
codex --model gpt-5.5 -c 'service_tier="priority"'
```

There is no documented `--fast` flag in `codex --help`. The installed binary does have the stable `fast_mode` feature and a TUI service-tier selector, but the durable programmatic value is `service_tier = "priority"`. Unsupported tiers are omitted from requests by Codex, so Pretty should consult the model catalog and fail clearly instead of silently pretending Fast was applied.

### Codex during a TUI session

The installed TUI contains `/model`; its picker selects a model and then a supported reasoning level. It also has a service-tier/Fast selection surface. These actions update the live thread through the TUI and may persist defaults. Editing `config.toml` underneath a running TUI is not an adequate control contract: there is no public `codex config reload` command, and an existing turn/thread already has effective settings.

For a human-attached PTY, `/model` is the native mid-session path. Pretty can send `/model` and let the user finish the picker while attached, but it should not make cursor-key automation of that picker its API: labels/order are catalog- and version-dependent.

### Codex app-server during a thread

The generated protocol gives Pretty a clean, non-TUI mechanism:

- `thread/start` accepts `model`, `modelProvider`, and `serviceTier`. It also accepts a generic `config` map, through which an initial `model_reasoning_effort` can be supplied.
- `turn/start` explicitly accepts `model`, `effort`, and `serviceTier`.
- The comments on all three `turn/start` fields say the override applies “for this turn and subsequent turns.” This is a thread mutation, not merely a one-request hint.
- `ReasoningEffort` is generated as a string because support is catalog-driven. `Model.supportedReasoningEfforts`, `defaultReasoningEffort`, and `serviceTiers` are the validation source.

The current branch client does not expose these yet: `startThread(cwd)` sends only cwd/security/lifecycle fields, and `submitTurn(threadId, text)` sends only input metadata. The protocol already supports the needed extension.

Recommended app-server shape:

```ts
// Initial thread
thread/start {
  model: "gpt-5.5",
  serviceTier: "priority",
  config: { model_reasoning_effort: "xhigh" },
  // existing Pretty fields...
}

// A later turn; values remain effective for later turns
turn/start {
  threadId,
  input,
  model: "gpt-5.6-sol",
  effort: "high",
  serviceTier: "priority"
}
```

### Claude equivalents

Claude Code 2.1.201 accepts both controls directly at spawn/resume:

```sh
claude --model sonnet --effort high
claude --resume <id> --model opus --effort xhigh
```

`--model` accepts aliases such as `fable`, `opus`, and `sonnet`, or a full model name. `--effort` advertises `low`, `medium`, `high`, `xhigh`, and `max`; availability is model/account/policy dependent.

During an interactive Claude session, `/model` changes the model and `/effort <level>` changes effort. The installed binary also exposes `auto` (use the model default) and session-only `ultracode` (xhigh plus dynamic-workflow orchestration, when enabled). Unlike Codex's picker, Claude's direct slash forms are suitable for Pretty to type into an idle PTY:

```text
/model sonnet
/effort high
```

Claude has no `--fast` service-tier control in the installed help, so Pretty should reject `--fast` for Claude rather than give it unrelated semantics.

### What Pretty should expose

Add tool-neutral creation flags:

```sh
pretty new --tool codex  --model gpt-5.5 --effort xhigh --fast
pretty new --tool claude --model sonnet  --effort high
```

Translation:

- Codex PTY: append `--model <model>`, `-c model_reasoning_effort="<effort>"`, and, for `--fast`, `-c service_tier="priority"` to the existing preset args.
- Claude PTY: append `--model <model>` and `--effort <effort>`; reject `--fast`.
- Codex app-server: populate `thread/start` as above and retain the selected values in Pretty's session metadata so every subsequent `turn/start` can carry explicit effective settings.

The current `pretty new --tool ...` passes leftover arguments through, so `--model` already happens to work for both tools and Claude's `--effort` already works. Dedicated parsing is still warranted because Codex effort needs translation and because Pretty should validate tool-specific flags rather than rely on accidental passthrough.

Add a live command:

```sh
pretty model <session> <model> [--effort <level>] [--fast|--no-fast]
```

Implementation policy:

1. For an app-server Codex session, update Pretty's stored defaults and place the values on the next `turn/start`; reject or queue the change if a turn is already active. Return the server-confirmed effective settings.
2. For an idle Claude PTY, send `/model <model>` and then `/effort <level>`, confirming each input through the existing structured-event acknowledgement path.
3. For a Codex PTY, do not pretend the picker is an API. Open `/model` for an attached human, or report that live non-interactive switching requires an app-server-backed session. A later implementation could restart/resume with overrides, but that is materially more disruptive and should be explicit.

Also show `model`, `effort`, and Fast/service tier in `pretty ls --json` and the web session inspector. For app-server sessions, source the displayed effective values from thread settings/events rather than merely echoing requested values.

## 2. Finish notifications and hooks

### Codex native mechanisms

#### External `notify` command

The installed config accepts a command argv array:

```toml
notify = ["/path/to/notifier", "optional-fixed-arg"]
```

Codex launches it for the legacy `agent-turn-complete` event and appends one JSON argument. The installed binary's payload fields include `thread-id`, `turn-id`, `cwd`, `input-messages`, and `last-assistant-message`. This works for both interactive turns and non-interactive operation, but it is a user-wide Codex setting, not something Pretty should rewrite for each session.

This install also has stable native hooks and recognizes `Stop` hooks in `~/.codex/hooks.json`. That is useful for a user's Codex-wide automation, but Pretty should not install or modify it: the hook is agent-specific and would duplicate Pretty's tool-neutral working-to-idle event.

#### TUI terminal notifications

The installed config schema contains `[tui]` settings named `notifications`, `notification_method`, and `notification_condition`. The binary exposes notification methods `osc9` and `bel`, and conditions `unfocused` and `always`. These notify the terminal hosting the TUI; effectiveness depends on terminal support/focus and the TUI remaining alive. They are a good local convenience, not a daemon-level delivery guarantee.

#### `codex exec` process exit

`codex exec` is non-interactive and exits when the run completes. A caller can use the exit status and `--output-last-message`/`--json` directly. That is the most reliable finish signal for one-shot jobs. Pretty's normal Codex sessions are long-lived interactive PTYs, so process exit is not a per-turn completion signal there.

### Claude native mechanisms

Claude Code reads hooks from settings JSON. The installed version recognizes `Stop` and `Notification`; this machine's valid configuration demonstrates the exact shape:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "./notify-finished.sh" }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          { "type": "command", "command": "./notify-attention.sh" }
        ]
      }
    ]
  }
}
```

Use `Stop` for “Claude finished responding.” `Notification` is an attention event (for example permission/idle prompts), not a synonym for turn completion. As with Codex-native config, Pretty should respect these hooks but not edit user or project Claude settings.

### What Pretty already has

The current main-branch implementation already provides the right cross-tool completion edge:

- `pretty new --on-idle <shell-command>` stores a per-session command.
- `setWorkingState` fires only on an observed `working: true -> false` edge while the runner is still alive. Codex working state comes from rollout `task_started`/`task_complete` lifecycle events when available; Claude uses its structured state/screen signal.
- The hook runs detached via `/bin/sh -c` in the session cwd with `PRETTY_SESSION_ID` and `PRETTY_SESSION_NAME`. Failure is deliberately fire-and-forget.
- The same edge writes an idle sentinel and calls `sendPush({ title: "<label> finished", data: { sessionId } })`.
- Web push is more than scaffolding: the daemon has authenticated VAPID/subscribe/unsubscribe endpoints, persists subscriptions, removes expired subscriptions, and the frontend has a service worker plus a settings flow that requests permission and subscribes.

One semantic boundary is important: idle means “the current agent turn completed,” while runner exit means “the long-lived session ended.” Do not conflate them. The existing `!internal.exited` check correctly prevents a process exit from masquerading as a completed turn.

### Recommended v1 layering

Make Pretty's working-to-idle edge the canonical event and layer delivery on it:

1. Keep `--on-idle` as the per-session, one-off action.
2. Add one optional global daemon hook at `~/.config/pretty/hooks.json`:

   ```json
   {
     "onIdle": "command-to-run"
   }
   ```

   Run it for every working-to-idle edge, in addition to any per-session hook. Use the same detached, non-blocking execution and add `PRETTY_SESSION_TOOL` and `PRETTY_SESSION_CWD` to the existing ID/name environment. Load/validate it at daemon startup and log malformed config or spawn failure without breaking session tracking.
3. Keep web push as the built-in remote notification channel. It already shares the canonical edge and should remain opt-in through the web settings permission flow.
4. Do **not** add first-class Telegram, Slack, Discord, or generic-webhook configuration in v1. Users can implement any of them with the global command (for example a small script that calls a webhook). This avoids storing secrets, retry queues, provider-specific payloads, and duplicate delivery controls in the daemon.

The global and per-session hooks should be additive and run once per observed edge. A command timeout (for example 30 seconds) and bounded captured stderr in the daemon log would improve operability over permanently detached children, but notification delivery must never block or change session state.

Native Codex/Claude hooks remain useful when those tools run outside Pretty. When they run inside Pretty, users who enable both native and Pretty notifications should expect duplicate pings; document this rather than trying to inspect and suppress user-owned agent config.

## Concrete v1 recommendation

Implement in this order:

1. Add `--model` and `--effort` to `pretty new`, translating them to each installed tool's native spawn flags/config. Add Codex-only `--fast` as `service_tier="priority"`.
2. On the `codex-app-server` work, add model catalog retrieval and pass initial settings to `thread/start`; pass live changes through `turn/start.model`, `.effort`, and `.serviceTier`.
3. Add `pretty model ...` for app-server Codex and direct-slash Claude sessions. Keep Codex PTY switching human-driven through `/model` until the session is app-server-backed.
4. Add the single global `onIdle` daemon hook, reusing the existing edge. Keep the existing per-session hook and web push.
5. Treat provider webhooks as scripts configured through that global hook, not daemon features.

This produces one Pretty-level control vocabulary while preserving the actual semantics of each installed agent: model and effort are separate, Codex Fast is a service tier, app-server overrides are thread-persistent, and “finished” is a structured working-to-idle edge rather than PTY silence or process exit.
