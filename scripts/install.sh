#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
scripts/install.sh was retired with the Node-daemon deploy path; no changes were made.

For local Pretty.app development, use:
  npm run ship

For the current standalone Go development daemon, install adjacent pretty,
prettyd, and runner binaries and run:
  pretty install

Public app release and update work follows docs/RELEASE.md and
docs/NATIVE_APP.md. The production mini must not be changed by this script.
EOF
exit 2
