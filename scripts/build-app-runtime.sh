#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
go_root="$repo_root/runtime"
frontend_dist="$repo_root/frontend/dist"
embedded_assets="$go_root/internal/webassets/dist"
runtime_dir="$repo_root/src-tauri/runtime"
platform="${TAURI_ENV_PLATFORM:-darwin}"
architecture="${TAURI_ENV_ARCH:-$(uname -m)}"

if [[ "$platform" != "darwin" ]]; then
  echo "> Sessions runtime: skipping Go daemon bundle for $platform"
  exit 0
fi
if [[ "$architecture" != "aarch64" && "$architecture" != "arm64" ]]; then
  echo "build-app-runtime: Sessions currently ships only on Apple Silicon (got $architecture)" >&2
  exit 2
fi
if [[ ! -f "$frontend_dist/index.html" ]]; then
  echo "build-app-runtime: frontend build missing at $frontend_dist; run the configured frontend build first" >&2
  exit 1
fi
for required_command in go git codesign shasum; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "build-app-runtime: required command not found: $required_command" >&2
    exit 1
  fi
done

runtime_version="$(git -C "$repo_root" describe --tags --always --dirty 2>/dev/null || printf 'dev')"
if [[ ! "$runtime_version" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "build-app-runtime: unsafe runtime version from git: $runtime_version" >&2
  exit 1
fi

signing_identity="${SESSIONS_SIGN_IDENTITY:-}"
if [[ -z "$signing_identity" && -r "$HOME/.config/sessions/sign-identity" ]]; then
  signing_identity="$(head -n1 "$HOME/.config/sessions/sign-identity")"
fi
if [[ -z "$signing_identity" ]]; then
  echo "build-app-runtime: a Developer ID is required for nested runtime binaries" >&2
  echo "set SESSIONS_SIGN_IDENTITY or write it to ~/.config/sessions/sign-identity" >&2
  exit 1
fi

build_staging="$(mktemp -d "${TMPDIR:-/tmp}/sessions-runtime.XXXXXX")"
trap 'rm -rf "$build_staging"' EXIT

mkdir -p "$embedded_assets"
find "$embedded_assets" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$frontend_dist"/. "$embedded_assets"/

ldflags="-s -w -buildid=sessions/$runtime_version"
build_one() {
  local binary_name="$1"
  local build_tags="$2"
  local output="$build_staging/$binary_name"
  echo "> Sessions runtime: building $binary_name ($runtime_version)"
  if [[ -n "$build_tags" ]]; then
    (
      cd "$go_root"
      CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 GOFLAGS=-buildvcs=false \
        go build -trimpath -tags "$build_tags" -ldflags "$ldflags/$binary_name" \
        -o "$output" "./cmd/$binary_name"
    )
  else
    (
      cd "$go_root"
      CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 GOFLAGS=-buildvcs=false \
        go build -trimpath -ldflags "$ldflags/$binary_name" \
        -o "$output" "./cmd/$binary_name"
    )
  fi
  codesign --force --timestamp --options runtime \
    --identifier "tech.somewhere.sessions.runtime.$binary_name" \
    --sign "$signing_identity" "$output"
  codesign --verify --strict "$output"
}

build_one sessions ""
build_one sessionsd embedui
build_one sessions-runner ""

mkdir -p "$runtime_dir"
find "$runtime_dir" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
for binary_name in sessions sessionsd sessions-runner; do
  install -m 0755 "$build_staging/$binary_name" "$runtime_dir/$binary_name"
done

sessions_sha="$(shasum -a 256 "$runtime_dir/sessions" | awk '{print $1}')"
sessionsd_sha="$(shasum -a 256 "$runtime_dir/sessionsd" | awk '{print $1}')"
runner_sha="$(shasum -a 256 "$runtime_dir/sessions-runner" | awk '{print $1}')"
printf '%s\n' \
  '{' \
  '  "schemaVersion": 1,' \
  "  \"runtimeVersion\": \"$runtime_version\"," \
  '  "target": "darwin-arm64",' \
  '  "binaries": {' \
  "    \"sessions\": \"$sessions_sha\"," \
  "    \"sessionsd\": \"$sessionsd_sha\"," \
  "    \"sessions-runner\": \"$runner_sha\"" \
  '  }' \
  '}' >"$runtime_dir/runtime-manifest.json"

echo "> Sessions runtime: signed binaries ready in $runtime_dir"
