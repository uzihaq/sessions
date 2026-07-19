# pretty-PTY Audit

Generated: 2026-06-15 21:33 PDT

## Scope

Reviewed the local repository and live local runtime for security, efficiency,
dead code, stale tests/docs, and likely causes of slow loading or painful
typing. I did not create, kill, or type into any real PTY session. A local
headless browser typed into the Pretty textarea only, without pressing Enter.

## Executive Summary

The app has already moved in the right direction on several historical
performance issues: one mux WebSocket instead of one socket per session,
bounded event logs, tail-window rendering, lazy xterm loading, and capped
Claude event replay.

The remaining issues are still significant:

- The daemon is effectively a remote-control API for local shells with no
  authentication, wildcard CORS, and broad filesystem/session metadata access.
- Markdown rendering has an unused link sanitizer while both Remote and Grid
  inject rendered HTML. Tauri also has CSP disabled.
- `prettyd` has a high-severity `ws` npm advisory.
- Daemon startup is blocked by runner discovery before `server.listen()`;
  during this audit Vite was ready in 172 ms, but `prettyd` did not print its
  listen line until roughly 40 seconds later.
- The web UI still does too much work on load with many sessions: in the
  measured run it rendered 36 tabs, loaded 54 dev modules, and transferred a
  2.1 MB `claude.png`.
- The input path is workaround-heavy: paste markers, delayed Enter, and
  automatic Enter retries at 2s, 4.5s, and 8s. Grid typing posts one HTTP
  request per key.
- Several tests and docs describe the retired parser architecture and no
  longer match the code.

## Highest Priority Findings

### 1. Unauthenticated shell-control API

Severity: High

Evidence:

- `prettyd/src/http.ts:11-17` sets `Access-Control-Allow-Origin: *`.
- `prettyd/src/http.ts:44-47` exposes all sessions.
- `prettyd/src/http.ts:59-105` exposes arbitrary absolute directory listing.
- `prettyd/src/http.ts:108-115` creates sessions.
- `prettyd/src/http.ts:121-125` kills sessions.
- `prettyd/src/http.ts:160-163` exposes Claude session metadata and previews.
- `prettyd/src/http.ts:183-214` returns JSONL event history.
- `prettyd/src/http.ts:219-228` sends raw input bytes to a PTY.
- `prettyd/src/ws.ts:174-180` accepts mux input/resize frames without auth.
- `prettyd/src/ws.ts:213-230` accepts single-session raw or JSON input.
- `prettyd/src/server.ts:7-20` blocks `0.0.0.0`, but allows binding to a
  specific non-loopback address.

Impact:

Anyone who can reach `prettyd` can inspect session metadata, list filesystem
directories, read Claude event tails, create shells, kill sessions, upload
files, and send keystrokes to running PTYs. Loopback-only is tolerable for a
personal tool. Binding to a tailnet or LAN address makes Tailscale/network
membership the only security boundary.

Recommended fix:

- Add a daemon token required by every REST and WS route.
- Use an origin allowlist instead of `*`.
- Split read-only metadata from mutation routes, with stricter auth for
  `create`, `kill`, `input`, `upload`, and `ws`.
- Consider per-session capability tokens so opening one session in a browser
  does not grant control of every session.
- Add request logging for mutating actions.

### 2. Markdown/link XSS in rendered assistant content

Severity: High

Evidence:

- `frontend/src/lib/contentRender.ts:56-65` defines `sanitizeAnchorHrefs`.
- `frontend/src/lib/contentRender.ts:107-109` parses markdown, linkifies paths,
  and returns HTML without calling the sanitizer.
- `frontend/src/components/RemoteView.tsx:423-426` injects this HTML via
  `dangerouslySetInnerHTML`.
- `frontend/src/components/GridView.tsx:322-326` injects the same renderer.
- `src-tauri/tauri.conf.json:24-26` sets `"csp": null`.
- `node frontend/scripts/markdown-smoke.cjs` passes normal cases, but has no
  malicious link-scheme coverage.

Impact:

Assistant or terminal-originated markdown such as a crafted link can become
clickable HTML in the app origin. The sanitizer comment correctly identifies
`javascript:`, `data:`, and `vbscript:` as the danger, but the function is
dead. XSS impact is larger because localStorage contains app state and because
the backend has unauthenticated PTY-control APIs.

Recommended fix:

- Call `sanitizeAnchorHrefs` before returning from `renderContent`.
- Add a smoke test for `javascript:`, whitespace-obfuscated schemes, `data:`,
  and safe `http`, `https`, `mailto`, `vscode`, relative, and hash links.
- Prefer a `marked` renderer extension that rejects unsafe protocols before
  HTML is generated.
- Set a Tauri CSP that blocks inline scripts and dangerous navigation.

### 3. High-severity `ws` dependency advisory

Severity: High

Evidence:

- `npm --prefix prettyd audit --omit=dev` reports one high-severity advisory
  for `ws`.
- `prettyd/package-lock.json` resolves `ws` to `8.20.0`.
- `prettyd/package.json:18-22` declares `ws` as a production dependency.

Impact:

The daemon uses `ws` for the live control channel. The advisories reported by
npm include memory disclosure and DoS classes. This is especially relevant
because the WebSocket endpoint is unauthenticated when reachable.

Recommended fix:

- Run `npm --prefix prettyd audit fix` or bump `ws` to a patched release.
- Re-run `npm --prefix prettyd audit --omit=dev`.
- Re-run WS smoke checks after the bump.

### 4. LaunchAgent plists persist sensitive environment variables

Severity: Medium-High

Evidence:

- `prettyd/src/sessions.ts:232-258` forwards `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, proxy variables, CA variables, and request-provided
  env into `launchdEnv`.
- `prettyd/src/sessions.ts:262-267` passes that env into launchd.
- `prettyd/src/launchd.ts:38-58` writes every env var into the plist XML.
- `prettyd/src/launchd.ts:100-103` writes the plist without an explicit file
  mode.
- Observed existing runner plists are currently `0600`, so this is not an
  observed world-readable leak on this machine. The code relies on umask.

Impact:

Secrets can persist in `~/Library/LaunchAgents` for the lifetime of the
session. Relying on umask is fragile, and request-provided env could widen
what gets persisted.

Recommended fix:

- Write plists with `{ mode: 0o600 }` explicitly and `chmodSync` after writes.
- Minimize the env allowlist. Avoid writing API tokens into persistent plists
  if the runner can read them from a user-only secret file or inherited secure
  source.
- Redact env values from any future diagnostics.

## Performance Findings

### 5. Daemon startup is blocked by serial runner discovery

Severity: High for perceived app load

Evidence:

- `prettyd/src/server.ts:33-44` awaits `discoverRunners()` before
  `server.listen()`.
- `prettyd/src/sessions.ts:514-570` scans runner sockets serially, trying up
  to three connects with 800 ms delays per socket.
- Runtime observation: `npm run dev` showed Vite ready in 172 ms, while
  `prettyd listening on http://127.0.0.1:8787` appeared roughly 40 seconds
  later.
- Runtime state observed: 36 runner plists, 47 `.events` files, 194 `.log`
  files, and 197 MB under `~/.local/state/pretty-PTY`.

Impact:

The frontend can be ready while the daemon is unavailable. On a live machine
with many historical runners, startup can feel like the web UI is hung.

Recommended fix:

- Call `server.listen()` first, then run discovery in the background.
- Expose `/api/health` as `{ ok, discovering, sessionsLoaded }`.
- Parallelize discovery with a small concurrency limit.
- Add a startup sweep for stale logs and old state files that does not block
  listening.

### 6. Cold UI load mounts too much for many sessions

Severity: Medium-High

Evidence:

- `frontend/src/App.tsx:121-132` refreshes sessions immediately and every 3s.
- `frontend/src/App.tsx:246-257` can render all sessions into GridView.
- `frontend/src/components/SessionView.tsx:68-92` keeps a `SessionView` and
  `useTerminal` hook for each session tab.
- `frontend/src/hooks/useTerminal.ts:58-82` documents that even
  `mountTerminal=false` still attaches to the mux socket.
- Runtime measurement: 36 tabs rendered, 39 remote messages rendered,
  54 dev script resources transferred about 2.3 MB, and `claude.png`
  transferred about 2.1 MB.

Impact:

The mux and replay gates avoid the worst previous socket storm, but the app
still creates a lot of React and WS bookkeeping on load. The large image is
also a simple first-load cost.

Recommended fix:

- Render only the active `SessionView` plus maybe recently visited sessions.
  Keep inactive tab metadata cheap.
- Add an explicit session detail endpoint so inactive tabs do not need hooks.
- Convert `claude.png` to a smaller WebP/AVIF or SVG-sized placeholder. The
  public asset is 2.0 MB.
- In production, verify bundle/module sizes after a proper build in an
  environment where build is allowed.

### 7. Typing/submission path is fragile

Severity: High for UX

Evidence:

- `frontend/src/components/InputBar.tsx:65-88` sends bracketed paste, then
  sends Enter 30 ms later.
- `frontend/src/hooks/useDispatch.ts:107-114` documents Enter retry offsets.
- `frontend/src/hooks/useDispatch.ts:565-581` schedules extra bare Enters at
  2s, 4.5s, and 8s while pending.
- `frontend/src/components/GridView.tsx:214-227` sends bracketed paste in
  grid without the same confirmation path.
- `frontend/src/components/GridView.tsx:210-238` maintains a local typed
  buffer while sending each key through `sendInput`.

Impact:

The app is compensating for low-level terminal/TUI ambiguity instead of
having an acknowledged "submit this message" operation. Extra Enter retries
can feel surprising, and grid typing over one HTTP POST per key will always
feel worse than a live socket when latency is present.

Recommended fix:

- Add a `submitText(sessionId, text)` backend operation that owns bracketed
  paste plus Enter as one ordered write and reports an acknowledgement.
- Make the runner or daemon expose a stronger receipt signal than JSONL
  eventual confirmation.
- Remove automatic Enter retries once a reliable submit acknowledgement exists.
- For Grid typing, use the mux WebSocket for focused cells or batch key input
  instead of one POST per key.

### 8. Active Remote view polls full snapshots every 2 seconds

Severity: Medium

Evidence:

- `frontend/src/components/SessionView.tsx:127-155` polls
  `fetchServerSnapshot(sessionId)` every 2 seconds while active in Remote
  mode to detect multi-choice pickers.
- `prettyd/src/sessions.ts:617-639` serializes up to 1000 scrollback lines for
  each snapshot call.

Impact:

Only the active session does this, but the active session is exactly where
typing responsiveness matters. Serializing/parsing a large active buffer every
2 seconds is avoidable work.

Recommended fix:

- Replace polling with a lightweight server-side detector that runs on output
  changes and emits a tiny mux event.
- Or add a small `snapshot?tailRows=N` / `picker-state` endpoint instead of
  serializing 1000 lines.

### 9. Grid mode scales as one polling loop per visible cell

Severity: Medium

Evidence:

- `frontend/src/components/GridView.tsx:124-151` starts a 2-second polling
  interval per cell.
- Each cell calls `fetchClaudeEvents(session.id, { tail: 40 })`.

Impact:

Grid is a useful monitor, but with 36 sessions it means 18 event requests per
second. The endpoint is capped to tail data, but repeated JSON parsing and
rendering still costs CPU.

Recommended fix:

- Add a batch endpoint for grid summaries.
- Poll only visible cells with IntersectionObserver.
- Back off idle cells to a slower cadence.

## Correctness and Maintainability Findings

### 10. Verification coverage is stale or failing

Severity: Medium

Evidence:

- `frontend/package.json:10-12` advertises parser smoke scripts.
- `frontend/scripts/parser-smoke.cjs:20-29` bundles
  `src/parsers/detect.ts`, which no longer exists.
- `frontend/scripts/serialize-smoke.cjs:32-49` bundles retired parser and
  `xtermSnapshot` modules that no longer exist.
- `README.md:27-52` still describes `usePrettyParser`, `parsers/detect.ts`,
  Split/Pretty modes, and `npm run build` verification.
- `prettyd/scripts/test-reflow.mjs` still fails 9 of 18 assertions under
  `tsx`, mostly around intentional padding and table heuristic changes.

Impact:

The advertised tests do not protect the current JSONL/Remote architecture.
New regressions can pass typecheck while the old smoke scripts stay red.

Recommended fix:

- Replace parser smoke tests with JSONL-to-message, markdown security, mux,
  input submission, and session lifecycle tests.
- Update reflow expectations or change reflow behavior; either way, get the
  smoke test green.
- Update README to describe the current Remote/Terminal model.

### 11. Dead code and unused exports are present

Severity: Low-Medium

Evidence from strict unused checks:

- `frontend/src/lib/contentRender.ts:56` has unused `sanitizeAnchorHrefs`.
  This should be used, not deleted.
- `frontend/src/hooks/useDispatch.ts:145` has unused `prefixOf`.
- `frontend/src/components/ResumeDialog.tsx:163` has unused `hiddenByOpen`.
- `prettyd/src/runner.ts:36` imports unused `OutputEvent`.
- `frontend/src/hooks/useDispatch.ts:4-18` explicitly keeps a legacy
  parser `Block` path even though RemoteView no longer passes blocks.

Recommended fix:

- Enable `noUnusedLocals` and `noUnusedParameters` in both tsconfigs once the
  current findings are addressed.
- Delete the dead parser reconciler path after tests cover JSONL
  confirmation.

### 12. Reflow behavior and tests disagree

Severity: Medium

Evidence:

- `prettyd/src/reflow.ts:107-115` removed broad "3+ space gaps" preservation.
- `prettyd/src/reflow.ts:292-304` pads lines to viewport width.
- `prettyd/scripts/test-reflow.mjs` still expects pass-through no-padding
  strings and broad column preservation.

Impact:

This can be either stale tests or a real display regression. The failures mean
there is no reliable guardrail for terminal wrapping behavior.

Recommended fix:

- Decide whether padding is intended output or a rendering-only concern.
- If padding is intended, update tests to trim where appropriate and add tests
  for background-color stripe prevention.
- If not intended, move background fill into CSS and stop padding plain text.

### 13. Docs are materially out of date

Severity: Low-Medium

Evidence:

- README still says the terminal stream feeds parsers and Pretty cards
  (`README.md:13-14`).
- README says Phase 4 launchd is incomplete (`README.md:22`), but launchd is
  implemented and active in the code.
- README test instructions point at dead parser scripts (`README.md:44-52`).
- README says `marked` is not installed (`README.md:74-80`), but
  `frontend/package.json:20-22` includes `marked`.

Recommended fix:

- Rewrite README around current architecture: `prettyd`, runner plists,
  mux WS, JSONL watcher, RemoteView, Terminal view, and Tauri wrapper.
- Remove stale phase claims.

## Lower Priority Hygiene

- Root-level `claude.png` and `openai-icon.svg` duplicate public assets. The
  root `claude.png` is tracked and 2.0 MB.
- `frontend/dist`, `prettyd/dist`, and `src-tauri/target` exist locally. They
  are ignored by git, but `src-tauri/target` is 3.6 GB and slows broad local
  scans.
- `readJson()` in `prettyd/src/http.ts:21-27` is unbounded for JSON routes.
  Uploads have a 25 MB cap, but input/session creation JSON does not.
- `prettyd/src/http.ts:59-105` exposes the whole filesystem namespace to the
  directory picker. This should be behind auth and ideally constrained to
  allowed roots.
- Existing state has 194 runner log files. Add a retention policy.

## Runtime Measurements

Read-only measurements from this machine:

- `curl /api/health`: 200 in about 0.008 s.
- `curl /api/sessions`: 200 in about 0.001 s, about 16 KB response.
- `curl /api/claude-sessions`: 200 in about 0.020 s, about 58 KB response.
- Headless Chrome load of `http://127.0.0.1:5273/`:
  - `networkidle2`: about 973 ms.
  - DOMContentLoaded: about 90 ms.
  - 36 tabs rendered.
  - 39 remote messages rendered.
  - 54 dev script resources, about 2.3 MB transferred.
  - one image resource, about 2.1 MB transferred.
  - local textarea typing of about 540 characters: about 309 ms, no Enter.
- Browser console showed two transient mux WS warnings:
  `WebSocket is closed before the connection is established`.

## Verification Run

Passing:

- `npm --prefix frontend run typecheck`
- `npm --prefix prettyd run typecheck`
- `cargo check` in `src-tauri`
- `npm --prefix frontend audit --omit=dev` - 0 vulnerabilities
- `node frontend/scripts/markdown-smoke.cjs` - 8 passed
- `./node_modules/.bin/tsx scripts/test-jsonl-resolver.mjs` in `prettyd` - 9 passed
- `./node_modules/.bin/tsx scripts/test-claude-working.mjs` in `prettyd` - 14 passed
- `./node_modules/.bin/tsx scripts/test-working-serialize.mjs` in `prettyd` - 2 passed

Failing:

- `npm --prefix frontend run test:parsers` - missing
  `frontend/src/parsers/detect.ts`.
- `npm --prefix frontend run test:serialize` - missing retired parser modules.
- `./node_modules/.bin/tsx scripts/test-reflow.mjs` in `prettyd` - 9 passed,
  9 failed.
- `npm --prefix prettyd audit --omit=dev` - one high-severity `ws` advisory.
- `tsc --noUnusedLocals --noUnusedParameters`:
  - frontend: 3 unused findings.
  - prettyd: 1 unused finding.

Not run:

- I did not run `npm run build` or Tauri build. The repo instructions warn
  against build/deploy-style verification in this environment, and the audit
  did not require a deploy artifact.

## Recommended Fix Order

1. Add daemon auth/origin checks and update frontend/CLI clients.
2. Use the markdown href sanitizer, add malicious-link tests, and set a Tauri
   CSP.
3. Patch `ws` and re-run npm audit.
4. Make `prettyd` listen before runner discovery; move discovery to a bounded
   background task.
5. Replace the input submission workaround with an acknowledged submit API.
6. Reduce first-load work: lazy active-only session views, batch summaries, and
   optimize `claude.png`.
7. Update stale tests/docs, then enable unused-code checks.
8. Clean runner log retention and stale local generated artifacts.
