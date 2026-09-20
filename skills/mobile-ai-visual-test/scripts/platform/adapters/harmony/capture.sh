#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
device="" app="" out="" label="capture"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$out" && -n "$app" ]] || { echo "capture 需要 --out 和 --app" >&2; exit 2; }
label="$(node -e 'const s=String(process.argv[1]||"capture").replace(/[^A-Za-z0-9._-]+/g,"_").slice(0,80);process.stdout.write(s||"capture")' "$label")"
mkdir -p "$out/screenshots"
png="$out/screenshots/${label}.png"
args=(--out "$png" --remote "/data/local/tmp/mavt-${label}.png"); [[ -n "$device" ]] && args=(--device "$device" "${args[@]}")
started="$(node -e 'process.stdout.write(new Date().toISOString())')"
"$script_dir/atoms/screenshot.sh" "${args[@]}" >/dev/null
ended="$(node -e 'process.stdout.write(new Date().toISOString())')"
node -e '
const path=require("path");const [out,label,device,app,started,ended]=process.argv.slice(1);
const ref=path.posix.join("screenshots",`${label}.png`);
console.log(JSON.stringify({schemaVersion:1,type:"capture",platform:"harmony",time:ended,artifacts:{screenshot:ref},device:{id:device||null},app:{appId:app},captureTiming:{order:["screenshot"],captureStartedAt:started,screenshotCompletedAt:ended,spanMs:Math.max(0,Date.parse(ended)-Date.parse(started))}},null,2));
' "$out" "$label" "$device" "$app" "$started" "$ended"
