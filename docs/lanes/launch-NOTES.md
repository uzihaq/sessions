# Lane: LAUNCH notes

## Outcome

Implemented the Go-binary launch and distribution story entirely in the lane's
owned source surface. No Go source was changed and no commit was created.

### Public documentation

- Rewrote `README.md` for the three-binary Go distribution, trust contract,
  Homebrew/static installs, quickstart, core CLI, notifications/hooks,
  early-access remote flow, troubleshooting, and Go development. Final length:
  146 lines.
- Replaced the stale Node-era root `ARCHITECTURE.md` with the current Go
  daemon/runner/CLI process model, TS compatibility boundary, protocol/state
  overview, lane recovery, security boundaries, packaging, and isolated parity
  guidance.
- Added `docs/INSTALL.md` with exact archive names, checksum verification,
  macOS launchd behavior, honest Linux manual startup, state, upgrades,
  uninstall, and troubleshooting.
- Added `docs/RELEASE.md` with build/publish steps, GitHub asset naming, and
  one-time plus per-release Homebrew tap instructions.

### Packaging

- Added executable `prettygo/scripts/release.sh`.
- The script accepts `--help`, `--version`, `--output-dir`, and `--dry-run`.
- A real run invokes `make -C prettygo binaries` through the existing build
  target, stages the three binaries side by side, packages macOS arm64 plus
  Linux arm64/amd64 archives, writes `.sha256` sidecars, and prints digests.
- Added `Formula/pretty.rb` with platform/architecture GitHub release URLs,
  conspicuous `TODO_RELEASE_URL` / `TODO_RELEASE_SHA256` placeholders, the MIT
  license, adjacent binary installation, caveats, and a version smoke test.

### Landing pages

- Minimally changed `site/index.html` and `site/setup.html` without redesigning
  them.
- Replaced npm/node-pty setup with `brew install uzihaq/tap/pretty`, direct
  static archive commands, `pretty install`, and nearby docs links.
- Updated install prerequisites/troubleshooting/uninstall text for the Go
  distribution.
- Added no external script.

## Gate evidence

All daemon-sensitive verification used local scratch state. Nothing contacted
`100.86.76.84`; nothing started, stopped, or queried the soak daemon on `:8787`.

### Docs and source hygiene

```text
README.md: headings/fences OK (16 fences)
ARCHITECTURE.md: headings/fences OK (8 fences)
docs/INSTALL.md: headings/fences OK (16 fences)
docs/RELEASE.md: headings/fences OK (8 fences)
README.md: 146 lines (<200)
git diff --check: clean
site diff: no added <script src=...>; no npm/node-pty install text
```

### Release script and formula

```text
bash -n prettygo/scripts/release.sh: PASS
prettygo/scripts/release.sh --help: PASS
release.sh --version v0.1.0 --output-dir .launch-dry-run-should-not-exist --dry-run: PASS
dry-run output: "no commands executed and no files created"
dry-run destination existence check: absent, as required
ruby -c Formula/pretty.rb: Syntax OK
HOMEBREW_NO_AUTO_UPDATE=1 brew style Formula/pretty.rb: 1 file inspected, no offenses detected
```

The real packaging run wrote only scratch archives under
`/tmp/pretty-launch-release.RvWzhR`. All `.sha256` files verified, and each tar
contained `./pretty`, `./prettyd`, `./runner`, `./LICENSE`, and `./README.md`:

```text
5e3759674d42aa722d83886abe7cec6a2ca0a080b22d8972f0bc2c8eacd9bc58  pretty-pty_0.1.0_darwin_arm64.tar.gz
61fd8e2a57665b813bc79bb92b9251db550e06569ceacb8e3a03a9085adf770c  pretty-pty_0.1.0_linux_arm64.tar.gz
66e2cec72bf39f636402fe2d013b6f4b05ccbb0009ab271e42f2f3abe9ed7263  pretty-pty_0.1.0_linux_amd64.tar.gz
```

These are scratch-validation digests from a dirty development checkout and are
not values to publish in the placeholder formula. Official checksums must come
from a clean tagged release, as documented in `docs/RELEASE.md`.

### Go regression suite

Ran from `prettygo/` with:

```text
HOME=/tmp/pretty-launch-go-test.TV9lpV/home
PRETTYD_HOST=127.0.0.1
PRETTYD_PORT=18761
PRETTYD_STATE_DIR=/tmp/pretty-launch-go-test.TV9lpV/state/runners
PRETTY_LEDGER_PATH=/tmp/pretty-launch-go-test.TV9lpV/ledger/lanes.sqlite3
go test ./...
```

Result: every package passed, including `cmd/pretty`, `internal/api`,
`internal/ledger`, `internal/mirror`, `internal/proto`, `internal/recovery`,
`internal/session`, `internal/state`, `internal/verdict`, `internal/waitcond`,
`internal/watch`, and `internal/webassets`.

## Ownership audit

Authored changes are limited to:

```text
README.md
ARCHITECTURE.md
Formula/pretty.rb
docs/INSTALL.md
docs/RELEASE.md
docs/lanes/launch-NOTES.md
prettygo/scripts/release.sh
site/index.html
site/setup.html
```

`docs/lanes/launch-SPEC.md` was supplied untracked and left unchanged.
