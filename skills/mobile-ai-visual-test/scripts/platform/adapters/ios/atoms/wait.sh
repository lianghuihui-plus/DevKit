#!/usr/bin/env bash
set -euo pipefail

ms="1000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ms) ms="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
sleep "$(node -e 'console.log((Number(process.argv[1] || 1000) / 1000).toFixed(3))' "$ms")"
node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"ios",time:localIso(),action:"wait",ms:Number(process.argv[1] || 0),ok:true}, null, 2));
' "$ms"
