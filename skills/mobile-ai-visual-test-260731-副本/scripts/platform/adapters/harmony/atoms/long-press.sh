#!/usr/bin/env bash
set -euo pipefail

device=""
x=""
y=""
duration_ms="800"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; shift 2 ;;
    --y) y="${2:-}"; shift 2 ;;
    --duration-ms|--velocity) duration_ms="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$x" && -n "$y" ]] || { echo "longPress 需要 --x 和 --y" >&2; exit 2; }
node -e '
const value = Number(process.argv[1]);
process.exit(Number.isFinite(value) && value > 0 ? 0 : 1);
' "$duration_ms" || { echo "longPress 需要正数 --duration-ms" >&2; exit 2; }

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

output="$("${hdc_prefix[@]}" shell uitest uiInput swipe "$x" "$y" "$x" "$y" "$duration_ms" 2>&1)" || { printf '%s\n' "$output" >&2; exit 1; }
if printf '%s\n' "$output" | grep -Eiq 'Missing parameter|Invalid parameters|Please confirm|unrecognized option|Illegal argument|USAGE'; then
  printf '%s\n' "$output" >&2
  exit 1
fi

node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"harmony",time:localIso(),action:"longPress",ok:true,durationMs:Number(process.argv[1])}, null, 2));
' "$duration_ms"
