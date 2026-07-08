#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

device=""
bundle=""
app=""
entry=""
type=""
x=""
y=""
text=""
from_x=""
from_y=""
to_x=""
to_y=""
ms=""
velocity=""
duration_ms=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --entry) entry="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
    --ability) entry="${2:-}"; shift 2 ;;
    --type) type="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; shift 2 ;;
    --y) y="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --from-x) from_x="${2:-}"; shift 2 ;;
    --from-y) from_y="${2:-}"; shift 2 ;;
    --to-x) to_x="${2:-}"; shift 2 ;;
    --to-y) to_y="${2:-}"; shift 2 ;;
    --ms) ms="${2:-}"; shift 2 ;;
    --velocity) velocity="${2:-}"; shift 2 ;;
    --duration-ms) duration_ms="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$bundle" && -n "$app" ]]; then
  bundle="$app"
fi
if [[ -z "$type" ]]; then
  echo "缺少 --type" >&2
  exit 2
fi

device_args=()
if [[ -n "$device" ]]; then
  device_args=(--device "$device")
fi

normalize_action() {
  node -e '
const event = JSON.parse(process.argv[1]);
event.action = process.argv[2];
console.log(JSON.stringify(event, null, 2));
' "$1" "$2"
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
    return "$status"
  fi
  normalize_action "$output" "$action"
}

case "$type" in
  launchApp)
    run_atom "$type" "$atoms_dir/launch-app.sh" "${device_args[@]}" --app "$bundle" ${entry:+--entry "$entry"}
    ;;
  restartApp)
    run_atom "$type" "$atoms_dir/restart-app.sh" "${device_args[@]}" --app "$bundle" ${entry:+--entry "$entry"}
    ;;
  tap)
    run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"
    ;;
  toggle)
    run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"
    ;;
  longPress)
    run_atom "$type" "$atoms_dir/long-press.sh" "${device_args[@]}" --x "$x" --y "$y" ${duration_ms:+--duration-ms "$duration_ms"}
    ;;
  inputText)
    if [[ -n "$x" || -n "$y" ]]; then
      echo "Android inputText 只向当前焦点输入文本，不接受 --x/--y；请先调用 tap 聚焦输入框，再调用 inputText。" >&2
      exit 2
    fi
    run_atom "$type" "$atoms_dir/input-text.sh" "${device_args[@]}" --text "$text"
    ;;
  swipe)
    duration_args=()
    if [[ -n "$velocity" ]]; then
      duration_args=(--duration-ms "$velocity")
    fi
    run_atom "$type" "$atoms_dir/swipe.sh" "${device_args[@]}" --from-x "$from_x" --from-y "$from_y" --to-x "$to_x" --to-y "$to_y" "${duration_args[@]}"
    ;;
  back)
    run_atom "$type" "$atoms_dir/keyevent.sh" "${device_args[@]}" --key BACK
    ;;
  home)
    run_atom "$type" "$atoms_dir/keyevent.sh" "${device_args[@]}" --key HOME
    ;;
  wait)
    run_atom "$type" "$atoms_dir/wait.sh" --ms "${ms:-1000}"
    ;;
  *)
    echo "不支持的动作类型: $type" >&2
    exit 2
    ;;
esac
