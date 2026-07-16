#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
go_root="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$go_root/.." && pwd)"
frontend_dir="$repo_root/frontend"
frontend_dist="$frontend_dir/dist"
asset_dir="$go_root/internal/webassets/dist"
out_dir="${DIST_GO_DIR:-$go_root/dist-go}"

for command_name in npm go git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "build-binaries: required command not found: $command_name" >&2
    exit 1
  fi
done

echo "> building frontend"
npm --prefix "$frontend_dir" run build
if [[ ! -f "$frontend_dist/index.html" ]]; then
  echo "build-binaries: frontend build did not produce $frontend_dist/index.html" >&2
  exit 1
fi

mkdir -p "$asset_dir" "$out_dir"
find "$asset_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$frontend_dist"/. "$asset_dir"/

version="$(git -C "$repo_root" describe --tags --always --dirty 2>/dev/null || printf 'dev')"
ldflags="-s -w -X main.version=$version"

build_binary() {
  local goos="$1"
  local goarch="$2"
  local command_name="$3"
  local tags="$4"
  local output="$out_dir/${command_name}-${goos}-${goarch}"
  local binary_ldflags="$ldflags -buildid=pretty-pty/$version/$command_name/$goos/$goarch"
  echo "> building ${command_name}-${goos}-${goarch} (version $version)"
  if [[ -n "$tags" ]]; then
    (
      cd "$go_root"
      CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -tags "$tags" -ldflags "$binary_ldflags" -o "$output" "./cmd/$command_name"
    )
  else
    (
      cd "$go_root"
      CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -ldflags "$binary_ldflags" -o "$output" "./cmd/$command_name"
    )
  fi
}

for target in darwin/arm64 linux/arm64 linux/amd64; do
  goos="${target%/*}"
  goarch="${target#*/}"
  build_binary "$goos" "$goarch" pretty ""
  build_binary "$goos" "$goarch" prettyd embedui
  build_binary "$goos" "$goarch" runner ""
done

darwin_daemon="$out_dir/prettyd-darwin-arm64"
plist="$out_dir/tech.pretty-pty.daemon-darwin-arm64.plist"
sed \
  -e "s|@PRETTYD_BINARY@|$darwin_daemon|g" \
  -e "s|@WORKING_DIRECTORY@|$out_dir|g" \
  -e "s|@LOG_PATH@|$out_dir/prettyd-darwin-arm64.log|g" \
  "$script_dir/launchd.plist.tmpl" >"$plist"
chmod 0644 "$plist"

echo "> wrote $plist"
echo "> binaries available in $out_dir"
