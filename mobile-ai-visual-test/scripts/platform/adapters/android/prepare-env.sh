#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

device=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app|--bundle|--entry|--ability) shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

device_args=()
if [[ -n "$device" ]]; then
  device_args=(--device "$device")
fi

ime_result="$("$atoms_dir/mavt-ime.sh" "${device_args[@]}" --prepare)"

node -e '
const imeResult = JSON.parse(process.argv[1]);
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const dependencies = [imeResult.dependency];
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "environmentPrepare",
  platform: "android",
  time: localIso(),
  ok: dependencies.every((item) => item && item.ok),
  dependencies
}, null, 2));
' "$ime_result"
