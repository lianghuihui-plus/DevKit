#!/usr/bin/env bash
set -euo pipefail

device=""
out_dir=""
label="observe"
app=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --out-dir) out_dir="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --app|--bundle) app="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$out_dir" ]] || { echo "logs 需要 --out-dir" >&2; exit 2; }
mkdir -p "$out_dir"

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

run_optional() {
  local timeout_seconds="$1"
  local output_file="$2"
  shift 2
  if perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" "$@" >"$output_file" 2>&1; then
    return 0
  fi
  printf '\n[observe warning] command failed or timed out: %s\n' "$*" >>"$output_file"
  return 0
}

window_dump="$out_dir/${label}-window-dump.txt"
activity_dump="$out_dir/${label}-activity-dump.txt"
pidof_file="$out_dir/${label}-pidof.txt"
logcat_file="$out_dir/${label}-logcat.txt"

run_optional 5 "$window_dump" "${adb_prefix[@]}" shell dumpsys window
run_optional 5 "$activity_dump" "${adb_prefix[@]}" shell dumpsys activity activities
if [[ -n "$app" ]]; then
  run_optional 3 "$pidof_file" "${adb_prefix[@]}" shell pidof "$app"
fi
run_optional 5 "$logcat_file" "${adb_prefix[@]}" logcat -d -t 200

node -e '
const path = require("path");
const files = process.argv.slice(1).filter(Boolean).map((file) => path.resolve(file));
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"atomResult",atom:"logs",platform:"android",time:localIso(),ok:true,files}, null, 2));
' "$window_dump" "$activity_dump" "${app:+$pidof_file}" "$logcat_file"
