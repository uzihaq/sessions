#!/usr/bin/env bash
# pretty-PTY installer — run once after cloning the repo.
# Installs the `pretty` CLI onto your PATH, builds the daemon, and
# registers it as a macOS LaunchAgent so it starts at login.
#
# Usage:
#   bash scripts/install.sh
#
# The script resolves its own location so it works regardless of the
# directory you run it from.

set -euo pipefail

# ── Resolve repo root ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRETTYD_DIR="$REPO_ROOT/prettyd"
FRONTEND_DIR="$REPO_ROOT/frontend"

# ── Helpers ────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m    ok: %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m  warn: %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────────
info "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "node is not on PATH. Install Node.js >=18 (brew install node)."
node_ver="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$node_ver" -lt 18 ]; then
  die "Node.js >=18 required, found v$node_ver (brew upgrade node)."
fi
ok "node $(node --version)"

command -v npm >/dev/null 2>&1 || die "npm not found — reinstall Node.js."
ok "npm $(npm --version)"

# macOS only (launchctl and LaunchAgents are macOS concepts).
if [ "$(uname -s)" != "Darwin" ]; then
  die "pretty-PTY requires macOS (launchd). On Linux, run the daemon manually: cd prettyd && npm start"
fi
ok "macOS detected"

# ── Build prettyd ──────────────────────────────────────────────────────────
info "Installing prettyd dependencies and building"
(cd "$PRETTYD_DIR" && npm install)
(cd "$PRETTYD_DIR" && npm run build)
ok "prettyd built → $PRETTYD_DIR/dist/server.js"

# ── Build / install frontend ───────────────────────────────────────────────
if [ -d "$FRONTEND_DIR" ]; then
  info "Installing frontend dependencies"
  (cd "$FRONTEND_DIR" && npm install)
  ok "frontend dependencies installed"
fi

# ── Symlink the CLI ────────────────────────────────────────────────────────
info "Symlinking 'pretty' CLI onto PATH"
CLI_SRC="$PRETTYD_DIR/bin/pretty.cjs"
chmod +x "$CLI_SRC"

# Pick a writable directory that is already on the user's PATH.
# Prefer ~/bin (user-owned, no sudo), fall back to /usr/local/bin.
if echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/bin"; then
  CLI_LINK="$HOME/bin/pretty"
  mkdir -p "$HOME/bin"
elif echo "$PATH" | tr ':' '\n' | grep -qx "/usr/local/bin"; then
  CLI_LINK="/usr/local/bin/pretty"
else
  # Last resort: create ~/bin and tell the user to add it to PATH.
  mkdir -p "$HOME/bin"
  CLI_LINK="$HOME/bin/pretty"
  warn "$HOME/bin is not on your PATH."
  warn "Add this to your ~/.zshrc or ~/.bashrc:"
  warn "  export PATH=\"\$HOME/bin:\$PATH\""
fi

# Remove stale symlink or file so ln -sf is idempotent.
rm -f "$CLI_LINK"
ln -sf "$CLI_SRC" "$CLI_LINK"
ok "symlink: $CLI_LINK -> $CLI_SRC"

# Make sure the resolved symlink is executable (ln -sf preserves src perms).
chmod +x "$CLI_LINK"

# ── Register and start daemon ──────────────────────────────────────────────
info "Registering prettyd as a macOS LaunchAgent"

# `pretty install` writes the plist and runs launchctl bootstrap.
# It must be called AFTER the symlink is on PATH — or we call it directly.
if command -v pretty >/dev/null 2>&1; then
  pretty install
else
  # Symlink not yet visible in this shell's PATH — invoke via the full path.
  node "$CLI_SRC" install
fi

# ── Done ───────────────────────────────────────────────────────────────────
printf '\n'
info "Installation complete!"
printf '  CLI:      pretty help\n'
printf '  Token:    pretty token\n'
printf '  Sessions: pretty ls\n'
printf '\n'
printf 'The daemon starts at login (RunAtLoad=true, KeepAlive=true).\n'
printf 'Logs: ~/Library/Logs/pretty-pty/daemon.log\n'
