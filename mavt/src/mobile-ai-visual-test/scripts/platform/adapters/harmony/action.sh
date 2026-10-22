#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"
source "$script_dir/../../../lib/action-common.sh"

device=""
bundle=""
ability=""
app=""
entry=""
type=""
x=""
y=""
text=""
mode=""
from_x=""
from_y=""
to_x=""
to_y=""
ms=""
velocity=""
duration_ms=""
interval_ms=""
capture_out=""
capture_label=""
capture_at_ms=""
device_form_factor=""
startup_orientation=""
startup_orientation_enforcement=""
startup_orientation_applies_to=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --entry) entry="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
    --ability) ability="${2:-}"; shift 2 ;;
    --type) type="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; shift 2 ;;
    --y) y="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --from-x) from_x="${2:-}"; shift 2 ;;
    --from-y) from_y="${2:-}"; shift 2 ;;
    --to-x) to_x="${2:-}"; shift 2 ;;
    --to-y) to_y="${2:-}"; shift 2 ;;
    --ms) ms="${2:-}"; shift 2 ;;
    --velocity) velocity="${2:-}"; shift 2 ;;
    --duration-ms) duration_ms="${2:-}"; shift 2 ;;
    --interval-ms) interval_ms="${2:-}"; shift 2 ;;
    --capture-out) capture_out="${2:-}"; shift 2 ;;
    --capture-label) capture_label="${2:-}"; shift 2 ;;
    --capture-at-ms) capture_at_ms="${2:-}"; shift 2 ;;
    --device-form-factor) device_form_factor="${2:-}"; shift 2 ;;
    --startup-orientation) startup_orientation="${2:-}"; shift 2 ;;
    --startup-orientation-enforcement) startup_orientation_enforcement="${2:-}"; shift 2 ;;
    --startup-orientation-applies-to) startup_orientation_applies_to="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$bundle" && -n "$app" ]]; then
  bundle="$app"
fi
if [[ -z "$ability" && -n "$entry" ]]; then
  ability="$entry"
fi
if [[ -z "$type" ]]; then
  echo "缺少 --type" >&2
  exit 2
fi

[[ "$type" == "inputText" && -z "$mode" ]] && mode="replace"
adapter_action="$(mavt_action_request_json "$type" "" "$x" "$y" "$text" "$from_x" "$from_y" "$to_x" "$to_y" "$duration_ms" "$ms" "" "$velocity" "" "" "" "$mode")"
mavt_validate_action_request "$script_dir/../../../lib/action-contract.js" "$adapter_action" "Harmony adapter"

device_args=()
if [[ -n "$device" ]]; then
  device_args=(--device "$device")
fi

normalize_action() {
  node -e '
const { normalizeAdapterActionResult } = require(process.argv[5]);
const event = normalizeAdapterActionResult(JSON.parse(process.argv[1]), {
  action: process.argv[2], deviceId: process.argv[3], appId: process.argv[4], platform: "harmony", transport: "HDC_UITEST",
});
console.log(JSON.stringify(event, null, 2));
' "$1" "$2" "$device" "$bundle" "$script_dir/../../../lib/action-result.js"
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

attach_during_capture() {
  node -e '
const event = JSON.parse(process.argv[1]);
event.duringActionCapture = { capturedAtMs: Number(process.argv[3]), artifacts: { screenshot: `screenshots/${process.argv[2]}.png` } };
console.log(JSON.stringify(event, null, 2));
' "$1" "$capture_label" "${2:-$capture_at_ms}"
}

run_captured_long_press() {
  mkdir -p "$capture_out/screenshots" "$capture_out/logs"
  local result_file="$capture_out/logs/${capture_label}-action.json"
  local screenshot_file="$capture_out/screenshots/${capture_label}.png"
  local action_started_ms
  local captured_at_ms
  action_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  set +e
  "$atoms_dir/long-press.sh" "${device_args[@]}" --x "$x" --y "$y" ${duration_ms:+--duration-ms "$duration_ms"} >"$result_file" &
  local action_pid=$!
  mavt_sleep_ms "$capture_at_ms"
  "$atoms_dir/screenshot.sh" "${device_args[@]}" --remote "/data/local/tmp/mavt-${capture_label}.png" --out "$screenshot_file" >/dev/null
  local capture_status=$?
  captured_at_ms="$(( $(node -e 'process.stdout.write(String(Date.now()))') - action_started_ms ))"
  wait "$action_pid"
  local action_status=$?
  set -e
  [[ $action_status -eq 0 ]] || return "$action_status"
  [[ $capture_status -eq 0 ]] || return "$capture_status"
  attach_during_capture "$(normalize_action "$(cat "$result_file")" "$type")" "$captured_at_ms"
}

case "$type" in
  launchApp)
    run_atom "$type" "$atoms_dir/launch-app.sh" "${device_args[@]}" --bundle "$bundle" --ability "$ability"
    ;;
  restartApp)
    restart_args=("${device_args[@]}" --bundle "$bundle" --ability "$ability")
    [[ -n "$device_form_factor" ]] && restart_args+=(--device-form-factor "$device_form_factor")
    [[ -n "$startup_orientation" ]] && restart_args+=(--startup-orientation "$startup_orientation")
    [[ -n "$startup_orientation_enforcement" ]] && restart_args+=(--startup-orientation-enforcement "$startup_orientation_enforcement")
    [[ -n "$startup_orientation_applies_to" ]] && restart_args+=(--startup-orientation-applies-to "$startup_orientation_applies_to")
    run_atom "$type" "$atoms_dir/restart-app.sh" "${restart_args[@]}"
    ;;
  tap)
    run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"
    ;;
  doubleTap)
    "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y" >/dev/null
    mavt_sleep_ms "${interval_ms:-100}"
    run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"
    ;;
  toggle)
    run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"
    ;;
  longPress)
    if [[ -n "$capture_at_ms" ]]; then
      run_captured_long_press
    else
      run_atom "$type" "$atoms_dir/long-press.sh" "${device_args[@]}" --x "$x" --y "$y" ${duration_ms:+--duration-ms "$duration_ms"}
    fi
    ;;
  inputText)
    input_args=("${device_args[@]}")
    [[ -n "$bundle" ]] && input_args+=(--bundle "$bundle")
    input_args+=(--x "$x" --y "$y" --text "$text" --mode "$mode")
    run_atom "$type" "$atoms_dir/input-text.sh" "${input_args[@]}"
    ;;
  swipe)
    run_atom "$type" "$atoms_dir/swipe.sh" "${device_args[@]}" --from-x "$from_x" --from-y "$from_y" --to-x "$to_x" --to-y "$to_y" --velocity "${velocity:-600}"
    ;;
  back)
    run_atom "$type" "$atoms_dir/keyevent.sh" "${device_args[@]}" --key Back
    ;;
  home)
    run_atom "$type" "$atoms_dir/keyevent.sh" "${device_args[@]}" --key Home
    ;;
  wait)
    run_atom "$type" "$atoms_dir/wait.sh" --ms "${ms:-1000}"
    ;;
  *)
    echo "不支持的动作类型: $type" >&2
    exit 2
    ;;
esac
