# PR2: real npm package + LICENSE + install smoke test
Goal: `npm i -g pretty-pty && pretty install` on a clean Mac → working pretty with the UI at localhost:8787. Today `npm pack` ships a FRONTEND-LESS daemon (global install = UI-less). Fix the package so the built frontend ships inside it. Work ONLY in this worktree (/Users/uzair/pretty-PTY-pkg). NEVER touch the live daemon, main-dir, launchd, or the global `pretty`.

1. Identity — prettyd/package.json: name "pretty-pty", version 0.1.0, bin { "pretty": "bin/pretty.cjs" }, "repository", "engines": {"node":">=18"}, "os": ["darwin"], description, keywords. Keep the command named `pretty`.
2. Embed the frontend: the daemon serves DEFAULT_WEB_DIR = ../../frontend/dist (relative to the daemon module) — that path does NOT exist in a global install. Fix: add a build/prepack step that builds the frontend and copies frontend/dist INTO the prettyd package (e.g. prettyd/web/), make the daemon's web-dir resolver (prettyd/src/http.ts) fall back to a bundled ./web next to dist, and ensure package.json "files" ships it. Confirm `npm pack --dry-run` lists web/index.html + assets.
3. LICENSE: add an MIT LICENSE at repo root + "license":"MIT". FLAG in PKG_NOTES.md: Uzair confirms MIT vs other before publish (trivially changeable).
4. `pretty install` hardening (bin/pretty.cjs cmdInstall): fail early with a clear message if dist/server.js, the bundled web index, launchctl, or the node binary is missing; after load WAIT for /api/health 200 (don't race token creation); idempotent on upgrade (kickstart an already-loaded daemon instead of erroring on launchctl status 17). Do NOT run it here.
5. `pretty doctor`: add a node-pty preflight — actually require('node-pty') + spawn a trivial PTY; on failure print "run xcode-select --install", not a later raw posix_spawn error.
ACCEPTANCE (real output in PKG_NOTES.md), NO global install / NO pretty install / NO launchd:
- `npm pack` in the worktree, then `tar tzf *.tgz | grep -E 'web/index|bin/pretty'` shows the frontend + bin are IN the tarball.
- `cd $(mktemp -d) && npm init -y && npm i <abs path to the .tgz> && ./node_modules/.bin/pretty --version` works (LOCAL install, never -g).
- prettyd build + `node -c bin/pretty.cjs` clean.
Do NOT commit.
