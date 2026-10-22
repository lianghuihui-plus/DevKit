#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"
source "$script_dir/../../../lib/action-common.sh"

device=""
bundle=""
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
android_ui_backend="auto"

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
    --android-ui-backend) android_ui_backend="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
case "$android_ui_backend" in
  auto|helper|uiautomator) ;;
  *) echo "无效 --android-ui-backend: $android_ui_backend" >&2; exit 2 ;;
esac

if [[ -z "$bundle" && -n "$app" ]]; then
  bundle="$app"
fi
if [[ -z "$type" ]]; then
  echo "缺少 --type" >&2
  exit 2
fi

[[ "$type" == "inputText" && -z "$mode" ]] && mode="replace"
adapter_action="$(mavt_action_request_json "$type" "" "$x" "$y" "$text" "$from_x" "$from_y" "$to_x" "$to_y" "$duration_ms" "$ms" "" "$velocity" "" "" "" "$mode" "$interval_ms")"
mavt_validate_action_request "$script_dir/../../../lib/action-contract.js" "$adapter_action" "Android adapter"

device_args=()
if [[ -n "$device" ]]; then
  device_args=(--device "$device")
fi

normalize_action() {
  node -e '
const { normalizeAdapterActionResult } = require(process.argv[5]);
const event = normalizeAdapterActionResult(JSON.parse(process.argv[1]), {
  action: process.argv[2], deviceId: process.argv[3], appId: process.argv[4], platform: "android", transport: "ADB_INPUT",
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
    return "$status"
  fi
  normalize_action "$output" "$action"
}

helper_rejected() {
  local failure_code="$1"
  local raw
  raw="$(node -e '
const action=process.argv[1], code=process.argv[2];
console.log(JSON.stringify({schemaVersion:2,type:"actionResult",platform:"android",action,
  command:{status:"REJECTED",transport:"ANDROID_HELPER_HTTP",elapsedMs:0,failureCode:code},
  deviceExecution:{status:"NOT_EXECUTED",verification:"NONE",actualTouchPoint:null},failureCode:code}));
' "$type" "$failure_code")"
  normalize_action "$raw" "$type"
}

helper_unknown() {
  local raw
  raw="$(node -e '
const action=process.argv[1];
console.log(JSON.stringify({schemaVersion:2,type:"actionResult",platform:"android",action,
  command:{status:"UNKNOWN",transport:"ANDROID_HELPER_HTTP",elapsedMs:0},
  deviceExecution:{status:"UNVERIFIED",verification:"NONE",actualTouchPoint:null},
  failureCode:"ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN"}));
' "$type")"
  normalize_action "$raw" "$type"
}

run_helper_action() {
  local output
  local status
  output="$(node "$atoms_dir/helper-action.js" \
    --session-state "$MAVT_ANDROID_HELPER_SESSION_STATE" \
    --action-json "$adapter_action" --timeout-ms 15000 2> >(cat >&2))"
  status=$?
  if [[ $status -eq 0 ]]; then
    normalize_action "$output" "$type"
    return 0
  fi
  if [[ $status -eq 20 ]]; then
    return 20
  fi
  helper_unknown
}

run_helper_or_legacy() {
  local legacy_function="$1"
  if [[ "$android_ui_backend" != "uiautomator" && -n "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" ]]; then
    set +e
    run_helper_action
    local status=$?
    set -e
    if [[ $status -eq 0 ]]; then return 0; fi
    if [[ $status -ne 20 ]]; then return "$status"; fi
    if [[ "$android_ui_backend" == "helper" ]]; then
      helper_rejected "ANDROID_HELPER_UNAVAILABLE_BEFORE_DISPATCH"
      return 0
    fi
  elif [[ "$android_ui_backend" == "helper" ]]; then
    helper_rejected "ANDROID_HELPER_SESSION_MISSING"
    return 0
  fi
  "$legacy_function"
}

run_targeted_input() {
  "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y" >/dev/null
  local output
  output="$("$atoms_dir/input-text.sh" "${device_args[@]}" --text "$text" --mode "$mode")"
  output="$(node -e '
const event = JSON.parse(process.argv[1]);
event.executedPoint = { x: Number(process.argv[2]), y: Number(process.argv[3]) };
event.inputTarget = "target-point";
console.log(JSON.stringify(event));
' "$output" "$x" "$y")"
  normalize_action "$output" "$type"
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
  "$atoms_dir/screenshot.sh" "${device_args[@]}" --out "$screenshot_file" >/dev/null
  local capture_status=$?
  captured_at_ms="$(( $(node -e 'process.stdout.write(String(Date.now()))') - action_started_ms ))"
  wait "$action_pid"
  local action_status=$?
  set -e
  [[ $action_status -eq 0 ]] || return "$action_status"
  [[ $capture_status -eq 0 ]] || return "$capture_status"
  attach_during_capture "$(normalize_action "$(cat "$result_file")" "$type")" "$captured_at_ms"
}

run_captured_helper_long_press() {
  mkdir -p "$capture_out/screenshots" "$capture_out/logs"
  local result_file="$capture_out/logs/${capture_label}-helper-action.json"
  local error_file="$capture_out/logs/${capture_label}-helper-action.txt"
  local screenshot_file="$capture_out/screenshots/${capture_label}.png"
  local action_started_ms
  local captured_at_ms
  action_started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  node "$atoms_dir/helper-action.js" \
    --session-state "$MAVT_ANDROID_HELPER_SESSION_STATE" \
    --action-json "$adapter_action" --timeout-ms 15000 >"$result_file" 2>"$error_file" &
  local action_pid=$!
  mavt_sleep_ms "$capture_at_ms"
  "$atoms_dir/screenshot.sh" "${device_args[@]}" --out "$screenshot_file" >/dev/null
  local capture_status=$?
  captured_at_ms="$(( $(node -e 'process.stdout.write(String(Date.now()))') - action_started_ms ))"
  wait "$action_pid"
  local action_status=$?
  if [[ $action_status -ne 0 ]]; then
    rm -f "$screenshot_file"
    cat "$error_file" >&2 || true
    return "$action_status"
  fi
  if [[ $capture_status -ne 0 ]]; then
    rm -f "$screenshot_file"
    return "$capture_status"
  fi
  attach_during_capture "$(normalize_action "$(cat "$result_file")" "$type")" "$captured_at_ms"
}

case "$type" in
  launchApp)
    run_atom "$type" "$atoms_dir/launch-app.sh" "${device_args[@]}" --app "$bundle" ${entry:+--entry "$entry"}
    ;;
  restartApp)
    run_atom "$type" "$atoms_dir/restart-app.sh" "${device_args[@]}" --app "$bundle" ${entry:+--entry "$entry"}
    ;;
  tap)
    legacy_tap() { run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"; }
    run_helper_or_legacy legacy_tap
    ;;
  doubleTap)
    legacy_double_tap() {
      "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y" >/dev/null
      mavt_sleep_ms "${interval_ms:-100}"
      run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"
    }
    run_helper_or_legacy legacy_double_tap
    ;;
  toggle)
    legacy_toggle() { run_atom "$type" "$atoms_dir/tap.sh" "${device_args[@]}" --x "$x" --y "$y"; }
    run_helper_or_legacy legacy_toggle
    ;;
  longPress)
    if [[ -n "$capture_at_ms" ]]; then
      if [[ "$android_ui_backend" != "uiautomator" && -n "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" ]]; then
        set +e
        run_captured_helper_long_press
        helper_capture_status=$?
        set -e
        if [[ $helper_capture_status -eq 20 ]]; then
          if [[ "$android_ui_backend" == "helper" ]]; then
            helper_rejected "ANDROID_HELPER_UNAVAILABLE_BEFORE_DISPATCH"
          else
            run_captured_long_press
          fi
        elif [[ $helper_capture_status -ne 0 ]]; then
          helper_unknown
        fi
      elif [[ "$android_ui_backend" == "helper" ]]; then
        helper_rejected "ANDROID_HELPER_SESSION_MISSING"
      else
        run_captured_long_press
      fi
    else
      legacy_long_press() { run_atom "$type" "$atoms_dir/long-press.sh" "${device_args[@]}" --x "$x" --y "$y" ${duration_ms:+--duration-ms "$duration_ms"}; }
      run_helper_or_legacy legacy_long_press
    fi
    ;;
  inputText)
    legacy_input_text() {
      if [[ -n "$x" && -n "$y" ]]; then
        run_targeted_input
      else
        run_atom "$type" "$atoms_dir/input-text.sh" "${device_args[@]}" --text "$text" --mode "$mode"
      fi
    }
    run_helper_or_legacy legacy_input_text
    ;;
  swipe)
    swipe_duration_ms="$(node -e '
const { swipeDurationMs } = require(process.argv[1]);
process.stdout.write(String(swipeDurationMs({
  type: "swipe",
  fromX: process.argv[2],
  fromY: process.argv[3],
  toX: process.argv[4],
  toY: process.argv[5],
  velocity: process.argv[6] || 600,
})));
' "$script_dir/../../../lib/action-contract.js" "$from_x" "$from_y" "$to_x" "$to_y" "${velocity:-600}")"
    legacy_swipe() { run_atom "$type" "$atoms_dir/swipe.sh" "${device_args[@]}" --from-x "$from_x" --from-y "$from_y" --to-x "$to_x" --to-y "$to_y" --duration-ms "$swipe_duration_ms"; }
    run_helper_or_legacy legacy_swipe
    ;;
  back)
    legacy_back() { run_atom "$type" "$atoms_dir/keyevent.sh" "${device_args[@]}" --key BACK; }
    run_helper_or_legacy legacy_back
    ;;
  home)
    legacy_home() { run_atom "$type" "$atoms_dir/keyevent.sh" "${device_args[@]}" --key HOME; }
    run_helper_or_legacy legacy_home
    ;;
  wait)
    run_atom "$type" "$atoms_dir/wait.sh" --ms "${ms:-1000}"
    ;;
  *)
    echo "不支持的动作类型: $type" >&2
    exit 2
    ;;
esac
