# Release pretty-PTY binaries

Releases publish one archive per supported OS/architecture. Each archive
contains the adjacent `pretty`, `prettyd`, and `runner` binaries plus `LICENSE`
and `README.md`.

## Prerequisites

- a clean checkout at the release tag
- Go and npm versions accepted by the repository
- authenticated `gh` CLI access to `uzihaq/pretty-PTY`
- push access to the separate `uzihaq/homebrew-tap` repository

The frontend build is embedded in `prettyd`; Node/npm are release-build tools,
not end-user dependencies.

## Build archives

Inspect the release plan without building or writing artifacts:

```sh
./prettygo/scripts/release.sh --version 0.1.0 --dry-run
```

Build every target through `make binaries`, package the archives, create
`.sha256` files, and print the checksums:

```sh
./prettygo/scripts/release.sh --version 0.1.0
```

The default output directory is `dist-release/`. Override it with
`--output-dir`. Supported targets match `prettygo/scripts/build-binaries.sh`:

- `darwin/arm64`
- `linux/arm64`
- `linux/amd64`

Before publishing, verify the three checksums printed by the script, inspect
each tar listing, and smoke-test `pretty version` on available target machines.

## Publish a GitHub release

Tags and artifact versions use `v<version>` and `<version>` respectively:

```sh
git tag -s v0.1.0 -m "pretty-PTY v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 dist-release/*.tar.gz dist-release/*.sha256 \
  --repo uzihaq/pretty-PTY --verify-tag --generate-notes
```

Confirm each asset downloads from:

```text
https://github.com/uzihaq/pretty-PTY/releases/download/v<version>/pretty-pty_<version>_<os>_<arch>.tar.gz
```

## Create the Homebrew tap

This is a one-time setup:

1. Create the public repository `uzihaq/homebrew-tap` on GitHub.
2. Clone it and create a `Formula/` directory.
3. Copy this repository's `Formula/pretty.rb` to `Formula/pretty.rb` in the tap.
4. Commit and push the tap repository.
5. Verify discovery with `brew tap uzihaq/tap` and `brew info pretty`.

For every release:

1. Replace the formula's placeholder version and all three GitHub release URLs.
2. Replace every `TODO_RELEASE_SHA256` zero digest with the corresponding
   checksum printed by `release.sh`.
3. Run `ruby -c Formula/pretty.rb`, `brew style Formula/pretty.rb`, and
   `brew audit --strict Formula/pretty.rb` in the tap checkout.
4. Install from the local formula and run the test block:

   ```sh
   brew install --build-from-source ./Formula/pretty.rb
   brew test pretty
   pretty install
   curl -fsS http://127.0.0.1:8787/api/health
   ```

5. Commit and push the formula update. Users can then run
   `brew install uzihaq/tap/pretty`.

Do not publish a formula whose URL is still a placeholder or whose SHA-256 is
all zeroes. Homebrew's checksum is part of the release trust boundary.
