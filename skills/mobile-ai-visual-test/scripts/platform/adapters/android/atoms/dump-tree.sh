#!/usr/bin/env bash
set -euo pipefail

device=""
out=""
remote="/sdcard/mavt-dump-tree.xml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --remote) remote="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$out" ]] || { echo "dump-tree 需要 --out" >&2; exit 2; }
mkdir -p "$(dirname "$out")"

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

"${adb_prefix[@]}" shell uiautomator dump "$remote" >/dev/null
"${adb_prefix[@]}" pull "$remote" "$out" >/dev/null

node -e '
const path = require("path");
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"atomResult",atom:"dump-tree",platform:"android",time:localIso(),ok:true,path:path.resolve(process.argv[1])}, null, 2));
' "$out"
