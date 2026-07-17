#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

mode=cutover
execute=0

usage() {
  cat <<'EOF'
Usage: bash scripts/cutover.sh [--dry-run | --execute]
       bash scripts/rollback.sh [--dry-run | --execute]

Dry-run is the default and performs only read-only binary/plist and
health/session checks. The live swap is impossible unless --execute is present.

Environment:
  PRETTYD_HOST                 daemon bind host (default: 127.0.0.1)
  PRETTYD_PORT                 daemon port (default: 8787)
  PRETTYD_GO_DAEMON           darwin-arm64 Go daemon binary
  PRETTYD_GO_RUNNER           darwin-arm64 Go runner binary
  PRETTYD_DAEMON_PLIST        installed daemon LaunchAgent plist
  PRETTYD_NODE_PLIST_BACKUP   exact node plist backup used by rollback.sh
  PRETTYD_DAEMON_LABEL        launchd label (default: tech.pretty-pty.daemon)
  PRETTYD_TOKEN_PATH          auth token path for protected API reads
  PRETTYD_TOKEN               auth token override (never printed)
  PRETTYD_STATE_DIR           runner state directory (rollback fallback only)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      execute=0
      ;;
    --execute)
      execute=1
      ;;
    --rollback)
      mode=rollback
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "cutover: unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

host="${PRETTYD_HOST:-127.0.0.1}"
port="${PRETTYD_PORT:-8787}"
go_daemon="${PRETTYD_GO_DAEMON:-$repo_root/prettygo/dist-go/prettyd-darwin-arm64}"
go_runner="${PRETTYD_GO_RUNNER:-$repo_root/prettygo/dist-go/runner-darwin-arm64}"
daemon_plist="${PRETTYD_DAEMON_PLIST:-$HOME/Library/LaunchAgents/tech.pretty-pty.daemon.plist}"
node_backup="${PRETTYD_NODE_PLIST_BACKUP:-$daemon_plist.node-backup}"
daemon_label="${PRETTYD_DAEMON_LABEL:-tech.pretty-pty.daemon}"
token_path="${PRETTYD_TOKEN_PATH:-$HOME/.local/state/pretty-PTY/token}"
runner_state_dir="${PRETTYD_STATE_DIR:-$HOME/.local/state/pretty-PTY/runners}"
domain="gui/$UID"
service="$domain/$daemon_label"

case "$host" in
  ""|*://*|*/*|*[[:space:]]*)
    echo "cutover: PRETTYD_HOST must be a bare host or IP address" >&2
    exit 64
    ;;
esac
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "cutover: PRETTYD_PORT must be between 1 and 65535" >&2
  exit 64
fi
if [[ "$host" == *:* ]]; then
  api_base="http://[$host]:$port"
else
  api_base="http://$host:$port"
fi

token="${PRETTYD_TOKEN:-}"
if [[ -z "$token" && -r "$token_path" ]]; then
  IFS= read -r token <"$token_path" || true
fi
step() {
  printf '[%s] %s\n' "$1" "$2"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

fetch_health() {
  curl --fail --silent --show-error --max-time 2 "$api_base/api/health"
}

fetch_sessions() {
  if [[ -n "$token" ]]; then
    curl --fail --silent --show-error --max-time 3 \
      -H "Authorization: Bearer $token" "$api_base/api/sessions"
  else
    curl --fail --silent --show-error --max-time 3 "$api_base/api/sessions"
  fi
}

count_sessions_json() {
  local encoded="$1"
  local matches
  if ! printf '%s' "$encoded" | grep -Eq '"sessions"[[:space:]]*:'; then
    return 1
  fi
  matches="$(printf '%s' "$encoded" | grep -Eo '"id"[[:space:]]*:' || true)"
  if [[ -z "$matches" ]]; then
    printf '0\n'
  else
    printf '%s\n' "$matches" | wc -l | tr -d '[:space:]'
    printf '\n'
  fi
}

current_session_count() {
  local encoded
  local count
  encoded="$(fetch_sessions)" || return 1
  count="$(count_sessions_json "$encoded")" || return 1
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$count"
}

wait_for_target() {
  local minimum="$1"
  local attempts="${2:-60}"
  local health_json=""
  local count=""
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    health_json="$(fetch_health 2>/dev/null || true)"
    if printf '%s' "$health_json" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' &&
       printf '%s' "$health_json" | grep -Eq '"discovering"[[:space:]]*:[[:space:]]*false'; then
      count="$(current_session_count 2>/dev/null || true)"
      if [[ "$count" =~ ^[0-9]+$ ]] && (( count >= minimum )); then
        verified_count="$count"
        return 0
      fi
    fi
    sleep 0.5
  done
  verified_count="${count:-unknown}"
  return 1
}

socket_fallback_count() {
  local matches
  if [[ ! -d "$runner_state_dir" ]]; then
    printf '0\n'
    return
  fi
  matches="$(find "$runner_state_dir" -maxdepth 1 -type s -name '*.sock' -print 2>/dev/null || true)"
  if [[ -z "$matches" ]]; then
    printf '0\n'
  else
    printf '%s\n' "$matches" | wc -l | tr -d '[:space:]'
    printf '\n'
  fi
}

print_header() {
  printf 'pretty %s\n' "$mode"
  if (( execute )); then
    printf 'mode: EXECUTE\n'
  else
    printf 'mode: DRY-RUN (default; no files, processes, or launchd state will change)\n'
  fi
  printf 'api: %s\n' "$api_base"
  printf 'plist: %s\n' "$daemon_plist"
  printf 'node backup: %s\n' "$node_backup"
}

read_baseline() {
  step read "waiting for healthy daemon with completed discovery"
  if ! wait_for_target 0 20; then
    fail "cannot read a healthy, fully discovered daemon at $api_base"
  fi
  baseline="$verified_count"
  step guard "runner baseline = $baseline"
}

print_cutover_plan() {
  step plan "validate darwin-arm64 Go daemon and runner binaries"
  step plan "smoke-load $go_daemon with PRETTYD_SMOKE=1"
  step plan "copy the exact node plist to $node_backup (refuse overwrite)"
  step plan "render and lint a Go plist with PRETTYD_HOST=$host, PRETTYD_PORT=$port, PRETTYD_RUNNER=$go_runner"
  step plan "launchctl bootout $service"
  step plan "atomically install the Go plist, bootstrap, and kickstart $service"
  step plan "wait for health 200, discovery=false, and session count >= $baseline"
  step plan "automatically restore the node plist if activation or runner-count verification fails"
}

print_rollback_plan() {
  step plan "validate the saved node plist at $node_backup"
  step plan "launchctl bootout $service (an already-stopped Go daemon is allowed)"
  step plan "atomically restore the exact node plist, bootstrap, and kickstart $service"
  step plan "wait for health 200, discovery=false, and session count >= $baseline"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_arm64_binary() {
  local path="$1"
  local label="$2"
  [[ -f "$path" && -x "$path" ]] || fail "$label is not an executable file: $path"
  file "$path" | grep -Eq 'Mach-O.*arm64' || fail "$label is not a darwin-arm64 Mach-O binary: $path"
}

validate_cutover_inputs() {
  local current_program
  for command_name in curl file plutil; do
    require_command "$command_name"
  done
  [[ -x /usr/libexec/PlistBuddy ]] || fail "/usr/libexec/PlistBuddy is required"
  step preflight "validating staged darwin-arm64 binaries"
  require_arm64_binary "$go_daemon" "Go daemon"
  require_arm64_binary "$go_runner" "Go runner"
  [[ -f "$daemon_plist" ]] || fail "installed daemon plist not found: $daemon_plist"
  [[ ! -e "$node_backup" ]] || fail "refusing to overwrite existing node plist backup: $node_backup"
  plutil -lint "$daemon_plist" >/dev/null || fail "installed daemon plist is invalid: $daemon_plist"
  current_program="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$daemon_plist" 2>/dev/null || true)"
  printf '%s' "$current_program" | grep -Eq 'node|dist/server\.js' ||
    fail "installed daemon plist does not look like the node daemon; refusing cutover"
}

validate_rollback_inputs() {
  local saved_program
  for command_name in curl plutil; do
    require_command "$command_name"
  done
  [[ -x /usr/libexec/PlistBuddy ]] || fail "/usr/libexec/PlistBuddy is required"
  step preflight "validating exact node plist backup"
  [[ -f "$node_backup" ]] || fail "node plist backup not found: $node_backup"
  plutil -lint "$node_backup" >/dev/null || fail "node plist backup is invalid: $node_backup"
  saved_program="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$node_backup" 2>/dev/null || true)"
  printf '%s' "$saved_program" | grep -Eq 'node|dist/server\.js' ||
    fail "saved plist does not point at the node daemon: $node_backup"
}

set_plist_string() {
  local plist="$1"
  local key="$2"
  local value="$3"
  /usr/libexec/PlistBuddy -c "Delete :$key" "$plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$key string $value" "$plist"
}

render_go_plist() {
  local target="$1"
  cp "$daemon_plist" "$target"
  /usr/libexec/PlistBuddy -c 'Delete :ProgramArguments' "$target" >/dev/null
  /usr/libexec/PlistBuddy -c 'Add :ProgramArguments array' "$target"
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $go_daemon" "$target"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables' "$target" >/dev/null 2>&1 ||
    /usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables dict' "$target"
  set_plist_string "$target" 'EnvironmentVariables:PRETTYD_HOST' "$host"
  set_plist_string "$target" 'EnvironmentVariables:PRETTYD_PORT' "$port"
  set_plist_string "$target" 'EnvironmentVariables:PRETTYD_RUNNER' "$go_runner"
  set_plist_string "$target" 'WorkingDirectory' "$(dirname "$go_daemon")"
  plutil -lint "$target" >/dev/null
  chmod 0600 "$target"
}

restore_node_after_failure() {
  local reason="$1"
  local restore_tmp
  step abort "$reason; restoring node daemon before returning failure"
  launchctl bootout "$service" >/dev/null 2>&1 || true
  restore_tmp="$(mktemp "$daemon_plist.rollback.XXXXXX")" || return 1
  if ! cp "$node_backup" "$restore_tmp" || ! chmod 0600 "$restore_tmp" || ! mv -f "$restore_tmp" "$daemon_plist"; then
    rm -f "$restore_tmp"
    return 1
  fi
  if ! launchctl bootstrap "$domain" "$daemon_plist"; then
    return 1
  fi
  if ! launchctl kickstart -k "$service"; then
    return 1
  fi
  if ! wait_for_target "$baseline" 60; then
    return 1
  fi
  step rollback "node daemon restored; runner count = $verified_count (baseline $baseline)"
  return 0
}

execute_cutover() {
  local next_plist

  [[ "$(uname -s)" == Darwin ]] || fail "--execute is supported only on macOS"
  for command_name in launchctl; do
    require_command "$command_name"
  done
  (( baseline > 0 )) || fail "refusing a live cutover with a zero-session baseline"

  step preflight "CGO-free Go binary smoke check"
  PRETTYD_SMOKE=1 PRETTYD_RUNNER="$go_runner" "$go_daemon" || fail "Go daemon smoke check failed"

  next_plist="$(mktemp "$daemon_plist.cutover.XXXXXX")"
  trap 'rm -f "${next_plist:-}"' EXIT
  step prepare "saving exact node plist backup"
  cp "$daemon_plist" "$node_backup"
  chmod 0600 "$node_backup"
  step prepare "rendering Go daemon plist"
  render_go_plist "$next_plist"

  step swap "stopping node daemon via launchctl bootout"
  if ! launchctl bootout "$service"; then
    restore_node_after_failure "node daemon bootout returned failure" ||
      fail "node bootout failed and automatic node recovery also failed; use $node_backup manually"
    fail "node daemon bootout failed; node daemon restored"
  fi
  step swap "installing Go plist"
  if ! mv -f "$next_plist" "$daemon_plist"; then
    restore_node_after_failure "Go plist install failed" ||
      fail "Go plist install failed and automatic node restore also failed; use $node_backup manually"
    fail "Go plist install failed; node daemon restored"
  fi
  trap - EXIT
  if ! chmod 0600 "$daemon_plist" || ! launchctl bootstrap "$domain" "$daemon_plist" ||
     ! launchctl kickstart -k "$service"; then
    restore_node_after_failure "Go daemon activation failed" ||
      fail "Go activation and automatic node restore failed; use $node_backup manually"
    fail "Go daemon activation failed; node daemon restored"
  fi

  step verify "waiting for Go health and runner rediscovery"
  if ! wait_for_target "$baseline" 60; then
    restore_node_after_failure "runner count dropped below baseline $baseline (observed $verified_count)" ||
      fail "runner verification and automatic node restore failed; use $node_backup manually"
    fail "runner verification failed; node daemon restored"
  fi
  step pass "Go daemon healthy; runner count = $verified_count (baseline $baseline)"
  printf 'PASS: cutover complete. Keep %s for rollback.\n' "$node_backup"
}

execute_rollback() {
  local restore_tmp

  [[ "$(uname -s)" == Darwin ]] || fail "--execute is supported only on macOS"
  for command_name in launchctl; do
    require_command "$command_name"
  done

  step swap "stopping Go daemon (already stopped is allowed)"
  launchctl bootout "$service" >/dev/null 2>&1 || true
  restore_tmp="$(mktemp "$daemon_plist.rollback.XXXXXX")"
  trap 'rm -f "${restore_tmp:-}"' EXIT
  cp "$node_backup" "$restore_tmp"
  chmod 0600 "$restore_tmp"
  mv -f "$restore_tmp" "$daemon_plist"
  trap - EXIT

  step swap "bootstrapping exact node plist backup"
  launchctl bootstrap "$domain" "$daemon_plist" || fail "node daemon bootstrap failed"
  launchctl kickstart -k "$service" || fail "node daemon kickstart failed"
  step verify "waiting for node health and runner rediscovery"
  if ! wait_for_target "$baseline" 60; then
    fail "node daemon did not recover runner baseline $baseline (observed $verified_count); backup remains at $node_backup"
  fi
  step pass "node daemon healthy; runner count = $verified_count (baseline $baseline)"
  printf 'PASS: rollback complete. Go and node runners remain protocol-compatible.\n'
}

print_header
if [[ "$mode" == cutover ]]; then
  validate_cutover_inputs
else
  validate_rollback_inputs
fi
if [[ "$mode" == rollback && "$execute" -eq 1 ]]; then
  step read "capturing pre-rollback runner baseline"
  if wait_for_target 0 10; then
    baseline="$verified_count"
    step guard "API runner baseline = $baseline"
  else
    baseline="$(socket_fallback_count)"
    step guard "daemon unavailable; conservative socket baseline = $baseline"
  fi
else
  read_baseline
fi

if [[ "$mode" == cutover ]]; then
  print_cutover_plan
else
  print_rollback_plan
fi

if (( ! execute )); then
  printf 'DRY-RUN PASS: read-only checks complete; runner baseline = %s; no changes made.\n' "$baseline"
  exit 0
fi

if [[ "$mode" == cutover ]]; then
  execute_cutover
else
  execute_rollback
fi
