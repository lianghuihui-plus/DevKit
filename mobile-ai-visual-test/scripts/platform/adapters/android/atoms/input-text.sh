#!/usr/bin/env bash
set -euo pipefail

device=""
text=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --x|--y)
      echo "android atoms/input-text.sh 只向当前焦点输入文本，不接受坐标；请先调用 tap 原子能力聚焦输入框。" >&2
      exit 2
      ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$text" ]] || { echo "input-text 需要 --text" >&2; exit 2; }

script_dir="$(cd "$(dirname "$0")" && pwd)"

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi
pre_input_state="$("$script_dir/input-state.sh" ${device:+--device "$device"} 2>/dev/null || true)"

android_text() {
  node -e '
const value = process.argv[1] || "";
process.stdout.write(value
  .replace(/%/g, "%25")
  .replace(/\s/g, "%s")
  .replace(/([&|;<>()$`"'"'"'\\])/g, "\\$1"));
' "$1"
}

is_ascii_text() {
  node -e '
const value = process.argv[1] || "";
process.exit(/^[\x00-\x7F]*$/.test(value) ? 0 : 1);
' "$1"
}

text_base64() {
  node -e '
process.stdout.write(Buffer.from(process.argv[1] || "", "utf8").toString("base64"));
' "$1"
}

android_unicode_text() {
  local value="$1"
  local ime_id previous_ime text64 broadcast_output status_output
  ime_id="mavt.android.ime/.MavtInputMethodService"
  status_output="$("$script_dir/mavt-ime.sh" ${device:+--device "$device"} --status)" || return $?
  if ! node -e '
const dependency = JSON.parse(process.argv[1]);
process.exit(dependency.ok ? 0 : 1);
' "$status_output"; then
    echo "Android Unicode input dependency is not prepared: MAVT Input IME is required. Run scripts/prepare-env.sh for the case/platform before starting execution." >&2
    return 1
  fi
  text64="$(text_base64 "$value")"
  previous_ime="$("${adb_prefix[@]}" shell settings get secure default_input_method 2>/dev/null | tr -d '\r' || true)"
  "${adb_prefix[@]}" shell ime set "$ime_id" >/dev/null
  sleep 0.3
  set +e
  broadcast_output="$("${adb_prefix[@]}" shell am broadcast -a mavt.android.ime.INPUT_TEXT -n mavt.android.ime/.MavtInputReceiver --es text64 "$text64" 2>&1)"
  broadcast_status=$?
  set -e
  if [[ -n "$previous_ime" && "$previous_ime" != "null" && "$previous_ime" != "$ime_id" ]]; then
    "${adb_prefix[@]}" shell ime set "$previous_ime" >/dev/null 2>&1 || true
  fi
  if [[ $broadcast_status -ne 0 || "$broadcast_output" != *"result=-1"* ]]; then
    printf '%s\n' "$broadcast_output" >&2
    return 1
  fi
}

input_method=""
if is_ascii_text "$text"; then
  "${adb_prefix[@]}" shell input text "$(android_text "$text")" >/dev/null
  input_method="adb-shell-input-text"
else
  android_unicode_text "$text"
  input_method="mavt-input-ime"
fi

node -e '
const preInputStateText = process.argv[2] || "";
let preInputState = null;
try {
  preInputState = preInputStateText ? JSON.parse(preInputStateText) : null;
} catch {
  preInputState = { raw: preInputStateText };
}
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const event = {schemaVersion:1,type:"actionResult",platform:"android",time:localIso(),action:"inputText",ok:true,inputMethod:process.argv[1]};
if (preInputState) {
  event.preInputState = preInputState;
  event.inputStateUsage = "diagnostic_only";
}
console.log(JSON.stringify(event, null, 2));
' "$input_method" "$pre_input_state"
