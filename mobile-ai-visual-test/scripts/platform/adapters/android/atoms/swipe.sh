#!/usr/bin/env bash
set -euo pipefail

device=""
from_x=""
from_y=""
to_x=""
to_y=""
duration_ms=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --from-x) from_x="${2:-}"; shift 2 ;;
    --from-y) from_y="${2:-}"; shift 2 ;;
    --to-x) to_x="${2:-}"; shift 2 ;;
    --to-y) to_y="${2:-}"; shift 2 ;;
    --duration-ms|--velocity) duration_ms="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$from_x" && -n "$from_y" && -n "$to_x" && -n "$to_y" ]] || { echo "swipe 需要 --from-x --from-y --to-x --to-y" >&2; exit 2; }

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

if [[ -n "$duration_ms" ]]; then
  "${adb_prefix[@]}" shell input swipe "$from_x" "$from_y" "$to_x" "$to_y" "$duration_ms" >/dev/null
else
  "${adb_prefix[@]}" shell input swipe "$from_x" "$from_y" "$to_x" "$to_y" >/dev/null
fi

node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"android",time:localIso(),action:"swipe",ok:true}, null, 2));
'
