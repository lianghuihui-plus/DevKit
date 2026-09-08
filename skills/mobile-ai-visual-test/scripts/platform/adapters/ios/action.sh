#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"
source "$script_dir/../../../lib/action-common.sh"

type=""
ms=""
device=""
app=""
interval_ms=""
capture_out=""
capture_label=""
capture_at_ms=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) type="${2:-}"; shift 2 ;;
    --ms) ms="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --device) device="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --app) app="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --interval-ms) interval_ms="${2:-}"; shift 2 ;;
    --capture-out) capture_out="${2:-}"; shift 2 ;;
    --capture-label) capture_label="${2:-}"; shift 2 ;;
    --capture-at-ms) capture_at_ms="${2:-}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

normalize_action() {
  node -e '
const { normalizeAdapterActionResult } = require(process.argv[5]);
const event = normalizeAdapterActionResult(JSON.parse(process.argv[1]), {
  action: process.argv[2], deviceId: process.argv[3], appId: process.argv[4], platform: "ios", transport: "APPIUM_W3C",
});
console.log(JSON.stringify(event, null, 2));
' "$1" "$2" "$device" "$app" "$script_dir/../../../lib/action-result.js"
}

run_atom() {
  local action="$1"
  shift
  local output
  local error_output
  local status
  local error_file
  error_file="$(mktemp -t mavt-ios-action.XXXXXX)"
  set +e
  output="$("$@" 2>"$error_file")"
  status=$?
  set -e
  error_output="$(cat "$error_file")"
  rm -f "$error_file"
  if [[ $status -ne 0 ]]; then
    if node -e 'JSON.parse(process.argv[1])' "$output" 2>/dev/null; then
      normalize_action "$output" "$action"
    else
      local failure_output
      failure_output="$(node -e '
const { actionResult } = require(process.argv[1]);
const message = String(process.argv[6] || `iOS ${process.argv[2]} atom exited with ${process.argv[5]}`).trim().slice(0, 4000);
const event = actionResult(process.argv[2], {
  ok: false,
  failureCode: "IOS_ACTION_FAILED",
  message,
  adapterError: { stage: "atom", exitCode: Number(process.argv[5]), message },
  device: { id: process.argv[3] || null },
  app: { appId: process.argv[4] || null },
});
console.log(JSON.stringify(event, null, 2));
' "$script_dir/lib/output.js" "$action" "$device" "$app" "$status" "$error_output")"
      normalize_action "$failure_output" "$action"
    fi
    return "$status"
  fi
  if [[ -n "$error_output" ]]; then
    printf '%s\n' "$error_output" >&2
  fi
  normalize_action "$output" "$action"
}

run_captured_long_press() {
  mkdir -p "$capture_out/screenshots"
  local screenshot_file="$capture_out/screenshots/${capture_label}.png"
  run_atom "$type" "$atoms_dir/long-press.sh" "${args[@]}" \
    --capture-out "$screenshot_file" \
    --capture-ref "screenshots/${capture_label}.png" \
    --capture-at-ms "$capture_at_ms"
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
  doubleTap)
    run_atom "$type" "$atoms_dir/double-tap.sh" "${args[@]}" --interval-ms "${interval_ms:-100}"
    ;;
  longPress)
    if [[ -n "$capture_at_ms" ]]; then
      run_captured_long_press
    else
      run_atom "$type" "$atoms_dir/long-press.sh" "${args[@]}"
    fi
    ;;
  inputText)
    run_atom "$type" "$atoms_dir/input-text.sh" "${args[@]}"
    ;;
  dismissKeyboard)
    run_atom "$type" "$atoms_dir/dismiss-keyboard.sh" "${args[@]}"
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
