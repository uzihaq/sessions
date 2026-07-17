# WALK lane notes

## Changes

- Refreshed `site/setup.html` around the Homebrew or checksummed static-archive
  install paths, followed by `pretty install` and the printed local URL. The
  page now calls out the absence of Node, npm, install scripts, and a native
  build toolchain as part of the trust story.
- Replaced the manual launchctl removal steps with `pretty uninstall`, followed
  by `brew uninstall pretty`, and kept `pretty doctor` as the first
  troubleshooting command.
- Added the static-Go/no-install-script guarantee to the existing trust contract
  in `site/index.html` without changing its visual system.
- Kept `site/connect.html`'s fragment capture and immediate scrub, endpoint
  validation, local-only storage, and `/api/health` probe. A successful probe
  now hands the endpoint and token to the full hosted app at
  `https://pretty-pty.somewhere.site/` in a URL fragment.
- Replaced the legacy short CLI list in `site/docs.html` with the requested Go
  command set: `new`, `ls`, `send`, `ask`, `wait`, `run`, `lanes`, `status`,
  `verdict`, `recover`, `adopt`, `move`, `backup`, `remote`, `model`, `kill`,
  `doctor`, `install`, and `uninstall`. The existing idle-hook environment
  reference remains in place.

## Gates

- All four HTML files passed a stack-based tag-balance check.
- Every inline script passed `node --check`.
- No external `<script src>` appears in `site/`.
- `site/` contains no `npm i`, `npm install`, or `node-pty` instruction.
- The `<style>` block in every page is byte-for-byte unchanged from `HEAD`.
- The CLI section contains exactly 19 command rows.
- `git diff --check -- site docs/lanes/walk-NOTES.md` passed.

No commit was created.
