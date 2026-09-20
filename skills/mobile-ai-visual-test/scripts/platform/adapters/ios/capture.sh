#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
out="" label="capture" app="" device="" atom_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; atom_args+=("$1" "${2:-}"); shift 2 ;;
    --device) device="${2:-}"; atom_args+=("$1" "${2:-}"); shift 2 ;;
    *) atom_args+=("$1"); if [[ $# -gt 1 && "${2:-}" != --* ]]; then atom_args+=("$2"); shift 2; else shift; fi ;;
  esac
done
[[ -n "$out" && -n "$app" ]] || { echo "capture 需要 --out 和 --app" >&2; exit 2; }
label="$(node -e 'const s=String(process.argv[1]||"capture").replace(/[^A-Za-z0-9._-]+/g,"_").slice(0,80);process.stdout.write(s||"capture")' "$label")"
mkdir -p "$out/screenshots"
png="$out/screenshots/${label}.png"
started="$(node -e 'process.stdout.write(new Date().toISOString())')"
"$script_dir/atoms/screenshot.sh" "${atom_args[@]}" --out "$png" >/dev/null
ended="$(node -e 'process.stdout.write(new Date().toISOString())')"
node -e '
const path=require("path");const [out,label,device,app,started,ended]=process.argv.slice(1);
const ref=path.posix.join("screenshots",`${label}.png`);
console.log(JSON.stringify({schemaVersion:1,type:"capture",platform:"ios",time:ended,artifacts:{screenshot:ref},device:{id:device||null},app:{appId:app},captureTiming:{order:["screenshot"],captureStartedAt:started,screenshotCompletedAt:ended,spanMs:Math.max(0,Date.parse(ended)-Date.parse(started))}},null,2));
' "$out" "$label" "$device" "$app" "$started" "$ended"
