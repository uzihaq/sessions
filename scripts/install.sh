#!/usr/bin/env bash
# Compatibility entry point for the canonical safe deploy.
# Dependency installs, builds, smoke import, restart, and verification all live
# in `pretty deploy` so this script cannot drift into an unsafe restart path.
#
# Usage:
#   bash scripts/install.sh [--no-pull] [--dry-run]
#
# The script resolves its own location so it works regardless of the
# directory you run it from.

set -euo pipefail

# ── Resolve repo root ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_SRC="$REPO_ROOT/prettyd/bin/pretty.cjs"

exec node "$CLI_SRC" deploy --repo "$REPO_ROOT" "$@"
