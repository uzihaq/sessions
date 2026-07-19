# Development ground rules

1. **The production mini is hands-off.** Do not edit its checkout, start test
   daemons, run launchctl, rehearse cutover, or deploy to it. Its eventual
   Pretty.app first install is a separate joint operation with the user.
2. **Build from `go-rewrite`.** Every change uses an isolated worktree and a
   focused branch from the current Go product branch. The old
   `pty-runner-architecture` branch is historical production state, not a base
   for new work.
3. **Isolate every test daemon.** Set both `PRETTYD_STATE_DIR` and
   `PRETTYD_PORT`; also relocate `PRETTY_LEDGER_PATH` and use a scratch home
   whenever a test touches user-level auth, provider, or launchd state.
4. **Protect the daily driver.** The only development daemon label is
   `tech.pretty-pty.dev.daemon`. Record the live-session baseline before a
   reload and verify `soak-d2` plus the full baseline afterward.
5. **Keep app and daemon lifetimes separate.** Tauri development may open,
   close, rebuild, or replace Pretty.app. It must not terminate a daemon or
   runner as a side effect.
6. **Use explicit lifecycle commands.** `pretty kill` is the sanctioned way to
   close a selected session. Recovery and worktree cleanup remain opt-in and
   refuse ambiguous or unsafe operations.
7. **Verify lane output yourself.** Run the complete Go gate, relevant
   frontend/Tauri checks, and focused acceptance tests. Skipped tests are not
   passes.

The repository's active package direction is documented in
[`NATIVE_APP.md`](NATIVE_APP.md). Node-era implementation notes are retained
under [`archive/node-daemon/`](archive/node-daemon/) only as historical and
cutover evidence.
