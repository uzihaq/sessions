---
name: pretty
description: Spawn, drive, monitor, and recover long-lived Claude Code / Codex / shell sessions and headless command lanes through the local `pretty` daemon. Use when you need to run a sub-agent (e.g. dispatch a Codex agent to do a task), run a long/background command as a tracked lane, watch another session, or reliably get an agent's result without screen-scraping. Requires the pretty daemon running locally (http://localhost:8787).
---

# pretty — drive agent sessions from the CLI

`pretty` is a local daemon + CLI for running **long-lived sessions** (Claude Code, Codex, shell) and **headless lanes** (any command) that survive restarts, expose structured history, and can be driven and monitored programmatically. Use it to dispatch sub-agents and get trustworthy results — not by typing into a terminal and scraping the screen, but through a real contract.

**Prereq:** the daemon must be running (`pretty ls` should work). If "connection refused", it isn't running — tell the user to `pretty install` (or check `pretty doctor`). All commands accept `--json` for machine-parseable output — **always use `--json` when parsing**; never scrape `pretty snap`.

## Core workflow: dispatch a sub-agent and get its result

```bash
# 1. Spawn. Codex runs on the structured app-server by default (reliable, no scraping).
id=$(pretty new --tool codex --cwd /path/to/work --name my-subtask --json | jq -r .id)
#   Claude:  pretty new --tool claude --cwd DIR --name NAME
#   Claude structured (subscription-billed, no live TUI): add --structured
#   Pick model/effort:  --model gpt-5.6-sol --effort high   (validated against the live catalog)

# 2. Drive it and WAIT for the reply in one call (best for request→response):
pretty ask "$id" "Do X. Reply DONE when finished." 
#   `ask` = send + wait for working→idle + print the last assistant message. Claude/Codex only.

# 3. Or send + poll separately:
pretty send "$id" "your message"     # blocks until receipt is confirmed (exit 0); exit 1/2 = failed/ambiguous
pretty wait "$id" --idle 30s --timeout 30m   # block until genuinely idle for 30s
pretty last "$id" --json             # structured last user+assistant message
pretty status "$id" --json           # state / git / activity / verdict card

# 4. Clean up when done:
pretty kill "$id"
```

## Headless lanes (run a command as a tracked session)

```bash
lane=$(pretty run --name build-check --cwd /repo -- go test ./... --json | jq -r .id)
pretty wait "$lane" --timeout 20m       # returns when the command exits
pretty last "$lane" --json              # exit code + output tail (completion manifest)
pretty lanes                            # list headless lanes
```

## Track YOUR OWN lanes — do not keep a mental list

If you (an agent) are running **inside a pretty session**, every lane you spawn is automatically tagged with your session as parent. So to find what you created — **ask pretty, don't remember** (this survives context compaction):

```bash
pretty sessions --mine              # BOTH agent sessions AND lanes you created (this session, transitively)
pretty sessions --mine --include-closed  # include exited/tombstoned records
pretty lanes --mine                 # just headless lanes you created
pretty sessions --all               # everything (all users) — use sparingly
```

**Rule: before ending your work, `pretty sessions --mine` and `pretty kill` the ones you no longer need** (this lists both agent sessions and lanes — `lanes --mine` alone misses agent sessions). Leaked lanes are the #1 orchestration failure. Never track lane ids in scratch files — query `--mine`.

## Recovery (after a crash / lost daemon)

```bash
pretty recover            # lists sessions that died unexpectedly, with resume recipes
pretty recover --reopen   # re-open every unexpectedly-lost session (idempotent)
```
`recover` never resurrects a session you deliberately `kill`ed (tombstoned). Use it after a reboot or if sessions vanish.

## Monitoring another session

```bash
pretty ls                       # all live sessions
pretty status <id> --json       # one session's full state
pretty transcript <id> --json   # full structured history
pretty tail <id> -f             # follow output live
pretty snap <id>                # current screen (human viewing only — DON'T parse this)
```

## Sacred rules (do not violate)

1. **Never `kill` a session you did not create.** Others' sessions may be real work. Use `pretty sessions --mine` to know which are yours (sessions + lanes). When unsure, don't kill.
2. **Conversation collision guard:** if `pretty new`/resume refuses with "already live as ...", the conversation is being driven elsewhere — **do not `--force` past it** unless you're certain the other driver is dead. Two drivers on one conversation corrupt it.
3. **Prefer structured output.** Use `--json` and `pretty last`/`status`/`transcript`, not `snap` scraping. Codex-app-server and Claude-`--structured` sessions give authoritative done/working signals; PTY sessions are best-effort.
4. **`ask` for request→response, `send`+`wait` for fire-then-monitor.** `send` alone returns before the reply is done.

## Background pattern (for long sub-tasks)

Run `pretty wait "$id" --timeout 30m &` in the background so your orchestration can be re-invoked when the sub-agent finishes, instead of blocking. Then `pretty last "$id" --json` for the result.

## Quick reference

| Need | Command |
|---|---|
| spawn codex sub-agent | `pretty new --tool codex --cwd DIR --name NAME --json` |
| spawn claude sub-agent | `pretty new --tool claude --cwd DIR --name NAME --json` |
| headless command lane | `pretty run --name NAME --cwd DIR -- CMD ARGS` |
| ask + get reply | `pretty ask <id> "msg"` |
| send (confirmed) | `pretty send <id> "msg"` |
| wait until idle | `pretty wait <id> --idle 30s --timeout 30m` |
| structured result | `pretty last <id> --json` / `pretty status <id> --json` |
| my sessions + lanes | `pretty sessions --mine` |
| list all | `pretty ls` |
| model catalog | `pretty models --json` |
| recover lost | `pretty recover [--reopen]` |
| clean up | `pretty kill <id>` |

Add `--host H --port P` to target a non-default daemon. `pretty --help` for everything.
