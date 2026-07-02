#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

type=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) type="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

case "$type" in
  wait)
    exec "$atoms_dir/wait.sh" "${args[@]}"
    ;;
  launchApp)
    exec "$atoms_dir/launch-app.sh" "${args[@]}"
    ;;
  tap|toggle)
    exec "$atoms_dir/tap.sh" "${args[@]}"
    ;;
  longPress)
    exec "$atoms_dir/long-press.sh" "${args[@]}"
    ;;
  inputText)
    exec "$atoms_dir/input-text.sh" "${args[@]}"
    ;;
  swipe)
    exec "$atoms_dir/swipe.sh" "${args[@]}"
    ;;
  back|home)
    exec "$atoms_dir/keyevent.sh" "${args[@]}"
    ;;
  *)
    echo "iOS 适配器尚未实现" >&2
    exit 64
    ;;
esac
