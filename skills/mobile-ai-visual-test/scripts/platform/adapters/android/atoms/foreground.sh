#!/usr/bin/env bash
set -euo pipefail

device=""
out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

dump="$("${adb_prefix[@]}" shell dumpsys window 2>/dev/null || true)"
if [[ -n "$out" ]]; then
  mkdir -p "$(dirname "$out")"
  printf '%s\n' "$dump" >"$out"
fi

node -e '
const text = process.argv[1] || "";
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function normalizeActivity(packageName, activity) {
  if (!activity) return null;
  if (activity.startsWith(".")) return activity.slice(1);
  if (activity.startsWith(`${packageName}.`)) return activity.slice(packageName.length + 1);
  return activity;
}
const patterns = [
  /mCurrentFocus=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/,
  /mFocusedApp=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/,
  /topResumedActivity=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/,
  /ResumedActivity:.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/
];
let foreground = null;
for (const pattern of patterns) {
  const match = text.match(pattern);
  if (match) {
    foreground = { packageName: match[1], activityName: normalizeActivity(match[1], match[2]), line: match[0].trim() };
    break;
  }
}
console.log(JSON.stringify({schemaVersion:1,type:"foreground",platform:"android",time:localIso(),ok:!!foreground,foreground}, null, 2));
' "$dump"
