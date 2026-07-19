# Safe deploy notes

## Implemented contract

`pretty deploy [--repo <dir>] [--no-pull] [--dry-run]` resolves the checkout,
rejects unresolved git conflicts, and runs this order for a live deploy:

1. `git pull --ff-only` unless `--no-pull` is set.
2. Unconditional `npm install` in both `prettyd/` and `frontend/`.
3. The prettyd and frontend builds.
4. A five-second `PRETTYD_SMOKE=1` import of `prettyd/dist/server.js`.
5. Runner baseline, LaunchAgent kickstart, a health poll of up to 30 seconds,
   and runner-survival verification.

Every failure before the kickstart aborts the deploy. The compiled server must
contain the `PRETTYD_SMOKE` guard before the CLI will import it, which prevents a
stale pre-guard build from starting a second server during a dry run.

`scripts/install.sh` is now a compatibility wrapper around this command rather
than a second install/build/restart implementation.

## Dry-run output

The repository intentionally had no generated `prettyd/dist/server.js`, and the
workspace instructions prohibit creating build output locally. The dry run
therefore printed the complete plan, executed its one allowed action (the import
preflight), and failed closed on the missing artifact. It did not run npm, a
build, `pgrep`, `launchctl`, or an HTTP health request.

```text
$ node prettyd/bin/pretty.cjs deploy --repo /Users/uzair/pretty-PTY-deploy --no-pull --dry-run
pretty deploy
repo: /Users/uzair/pretty-PTY-deploy
mode: dry-run

Plan:
  1. SKIP (--no-pull)  (cd /Users/uzair/pretty-PTY-deploy && git pull --ff-only)
  2. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-deploy/prettyd && npm install)
  3. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-deploy/frontend && npm install)
  4. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-deploy/prettyd && npm run build)
  5. SKIP (--dry-run)  (cd /Users/uzair/pretty-PTY-deploy/frontend && npm run build)
  6. RUN                (cd /Users/uzair/pretty-PTY-deploy/prettyd && PRETTYD_SMOKE=1 /opt/homebrew/Cellar/node/25.6.1/bin/node --input-type=module -e 'await import("file:///Users/uzair/pretty-PTY-deploy/prettyd/dist/server.js")')
  7. SKIP (--dry-run)  pgrep -f dist/runner.js | wc -l  # runner baseline
  8. SKIP (--dry-run)  launchctl kickstart -k gui/501/tech.pretty-pty.daemon
  9. SKIP (--dry-run)  poll 127.0.0.1:8787/api/health for up to 30s
  10. SKIP (--dry-run)  verify runner count >= baseline - 1

Executing the import preflight (the only dry-run action):

FAIL: deploy aborted during dist/server.js import preflight
pretty: cannot read /Users/uzair/pretty-PTY-deploy/prettyd/dist/server.js: ENOENT: no such file or directory, open '/Users/uzair/pretty-PTY-deploy/prettyd/dist/server.js'
[exit 2]
```

This is the expected result for a raw-source checkout. After a real deploy has
built `dist/server.js`, dry-run executes the smoke import and reports `PASS`
without restarting or probing the daemon.

## Verification

```text
$ node -c prettyd/bin/pretty.cjs
[clean]

$ bash -n scripts/install.sh
[clean]

$ git diff --check
[clean]
```

No build, install, daemon restart, signal, health request, or commit was made.
