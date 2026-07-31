#!/usr/bin/env bash
set -euo pipefail

device=""
out=""
remote="/data/local/tmp/mavt-screenshot.png"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --remote) remote="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$out" ]] || { echo "screenshot 需要 --out" >&2; exit 2; }
mkdir -p "$(dirname "$out")"

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

"${hdc_prefix[@]}" shell rm -f "$remote" >/dev/null 2>&1 || true
"${hdc_prefix[@]}" shell uitest screenCap -p "$remote" >/dev/null
"${hdc_prefix[@]}" file recv "$remote" "$out" >/dev/null

node -e '
const path = require("path");
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"atomResult",atom:"screenshot",platform:"harmony",time:localIso(),ok:true,path:path.resolve(process.argv[1])}, null, 2));
' "$out"
