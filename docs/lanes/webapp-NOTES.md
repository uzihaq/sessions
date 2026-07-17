# WEBAPP lane notes

## Result

- The full React UI is now the hosted entry, with a first-run server picker
  when the browser has no saved server.
- The picker supports remembered servers, a `http://localhost:8787` quick
  connect, an endpoint/token form, and the existing
  `#endpoint=<url>&token=<token>` flow. Fragment tokens are scrubbed before
  React mounts, endpoints are upserted, and remote HTTP is rejected (HTTPS or
  loopback HTTP only).
- A selected server is authoritative for REST and WebSocket URLs. In
  particular, a hosted app selecting localhost no longer rewrites the request
  to `window.location.origin` or the hosted site's hostname. Same-origin URLs
  are used only when the selected endpoint truly matches the page origin.
- Vite, the manifest, app images, and the service worker use base-relative
  paths, so one build works as a static hosted site and as daemon-served UI.
- `prettygo/scripts/deploy-site.sh` builds and copies the complete frontend to
  a new scratch directory. It stages both `index.html` and `connect.html` (the
  latter keeps existing QR paths working) and only prints the Somewhere deploy
  command; it never deploys.
- No `prettygo` Go source was edited.

## Safety/isolation

The acceptance run never contacted `100.86.76.84`, sent no traffic to the
daemon on port `8787`, and never signalled that daemon's process. It used only:

```text
scratch root:    /tmp/pretty-pty-webapp-acceptance.WPdGGn
scratch daemon:  http://127.0.0.1:18787
static preview:  http://127.0.0.1:14173
daemon PID:      6953
preview PID:     7013
scratch session: 0e2d7b90-168a-44d1-a7a0-b528e79ecb76
scratch child:   7114
```

The daemon used a temp `HOME`, `PRETTYD_STATE_DIR`, daemon binary, and runner
binary under that scratch root. Cleanup targeted the one scratch session and
the two recorded PIDs, never a binary name:

```text
{"ok":true}
scratch_child_reaped=7114
scratch_launchd_label_removed
scratch_preview_reaped=7013
scratch_daemon_reaped=6953
```

Final `lsof` checks found no listeners on `127.0.0.1:14173` or
`127.0.0.1:18787`.

## Required gates

### TypeScript

```text
$ cd frontend && npx tsc --noEmit
[no diagnostics]
exit 0
```

### Vite production build

```text
$ cd frontend && npx vite build
vite v5.4.21 building for production...
transforming...
✓ 96 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                            3.53 kB │ gzip:   1.57 kB
dist/assets/xterm-DYP7pi_n.css             4.15 kB │ gzip:   1.67 kB
dist/assets/index-k-_yAgJT.css            77.45 kB │ gzip:  13.44 kB
dist/assets/index-Btfm_Iy6.js              0.27 kB │ gzip:   0.17 kB
dist/assets/index-CLSJ4cO9.js              2.33 kB │ gzip:   0.86 kB
dist/assets/core-DhEqZVGG.js               2.44 kB │ gzip:   0.98 kB
dist/assets/addon-serialize-CsFQTvP_.js   16.05 kB │ gzip:   5.18 kB
dist/assets/addon-canvas-2tScJBkJ.js      94.96 kB │ gzip:  24.50 kB
dist/assets/addon-webgl-Ce_JuRoB.js      101.15 kB │ gzip:  25.93 kB
dist/assets/xterm-DQboTQhM.js            292.15 kB │ gzip:  72.71 kB
dist/assets/index-Dts3fJjO.js            342.69 kB │ gzip: 109.86 kB
✓ built in 1.21s
exit 0
```

### Headless browser smoke

Command:

```text
$ cd frontend
$ PRETTY_WEBAPP_URL=http://127.0.0.1:14173 \
  PRETTYD_ENDPOINT=http://127.0.0.1:18787 \
  PRETTY_SMOKE_DIR=/tmp/pretty-pty-webapp-acceptance.WPdGGn/screens \
  node scripts/webapp-smoke.mjs
```

Real result:

```json
{
  "appUrl": "http://127.0.0.1:14173",
  "daemonEndpoint": "http://127.0.0.1:18787",
  "connectHeading": "Open your sessions from here.",
  "connectScreenshot": "/tmp/pretty-pty-webapp-acceptance.WPdGGn/screens/connect-screen.png",
  "sessionsRequest": "http://127.0.0.1:18787/api/sessions",
  "sessionsStatus": 200,
  "tabCount": 1,
  "sessionsScreenshot": "/tmp/pretty-pty-webapp-acceptance.WPdGGn/screens/session-list.png",
  "fragmentHashAfterBootstrap": "",
  "fragmentServerCount": 1,
  "fragmentTokenStored": true,
  "fragmentServerSelected": true
}
```

This proves that the separately hosted bundle sent `/api/sessions` to the
selected scratch daemon on `:18787`, not to its own static origin on `:14173`.
The same script also passed with both URLs set to the daemon origin
`http://127.0.0.1:18787`, exercising the identical build in daemon-served
mode (the production zero-config local path is `localhost:8787`; the safety
instruction required a different port for acceptance).

Screenshots were visually inspected after the run:

```text
b78aa423f75aa71583353ac8a97d1deba683b9d64b33c358af1a035a704f2009  connect-screen.png  (439781 bytes)
4b326abf5f84f5a139115b8e1cd2ed3d9bbea61aa2df1988d70067be81d0b55e  session-list.png    (20575 bytes)
```

### Deploy dry-stage

```text
$ ./prettygo/scripts/deploy-site.sh
> building the complete static frontend
...
✓ 96 modules transformed.
✓ built in 1.05s
> staged hosted app at /var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T//pretty-pty-site-stage.tMpSUi
> entrypoints: index.html and connect.html

No deployment was run. Review the staged files, then deploy with:
somewhere deploy --project pretty-pty --scope static --prebuilt /var/folders/pz/wc9kw9pn2rg3w0q8ztm_vgyc0000gn/T//pretty-pty-site-stage.tMpSUi

For a remote change preview only, append --dry-run to that command.
```

`index.html` and `connect.html` compared byte-for-byte equal in the stage, and
the staged tree contained all hashed bundles, icons, manifest, service worker,
and public assets. No real `somewhere deploy` command was run.

## Additional checks

```text
$ git diff --check
exit 0

$ bash -n prettygo/scripts/deploy-site.sh
exit 0

$ node --check frontend/scripts/webapp-smoke.mjs
exit 0
```
