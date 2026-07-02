#!/usr/bin/env bash
set -euo pipefail

device=""
key=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --key) key="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$key" ]] || { echo "keyevent 需要 --key" >&2; exit 2; }

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

"${adb_prefix[@]}" shell input keyevent "$key" >/dev/null

node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"android",time:localIso(),action:"keyevent",key:process.argv[1],ok:true}, null, 2));
' "$key"
