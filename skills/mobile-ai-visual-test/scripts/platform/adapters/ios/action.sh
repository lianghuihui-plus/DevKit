#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

type=""
ms=""
device=""
app=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) type="${2:-}"; shift 2 ;;
    --ms) ms="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --device) device="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --app) app="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

normalize_action() {
  node -e '
const event = JSON.parse(process.argv[1]);
event.action = process.argv[2];
event.device = { ...(event.device || {}), id: process.argv[3] || null };
event.app = { ...(event.app || {}), appId: process.argv[4] || null };
console.log(JSON.stringify(event, null, 2));
' "$1" "$2" "$device" "$app"
}

run_atom() {
  local action="$1"
  shift
  local output
  local status
  set +e
  output="$("$@" 2> >(cat >&2))"
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    if node -e 'JSON.parse(process.argv[1])' "$output" 2>/dev/null; then
      normalize_action "$output" "$action"
    fi
    return "$status"
  fi
  normalize_action "$output" "$action"
}

case "$type" in
  wait)
    run_atom "$type" "$atoms_dir/wait.sh" --ms "${ms:-1000}"
    ;;
  launchApp)
    run_atom "$type" "$atoms_dir/launch-app.sh" "${args[@]}"
    ;;
  restartApp)
    run_atom "$type" "$atoms_dir/restart-app.sh" "${args[@]}"
    ;;
  tap|toggle)
    run_atom "$type" "$atoms_dir/tap.sh" "${args[@]}"
    ;;
  longPress)
    run_atom "$type" "$atoms_dir/long-press.sh" "${args[@]}"
    ;;
  inputText)
    run_atom "$type" "$atoms_dir/input-text.sh" "${args[@]}"
    ;;
  swipe)
    run_atom "$type" "$atoms_dir/swipe.sh" "${args[@]}"
    ;;
  back|home)
    run_atom "$type" "$atoms_dir/keyevent.sh" "${args[@]}" --key "$type"
    ;;
  *)
    echo "iOS 适配器不支持的动作: ${type:-unknown}" >&2
    exit 64
    ;;
esac
