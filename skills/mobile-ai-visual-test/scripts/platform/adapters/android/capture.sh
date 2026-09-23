#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
device="" app="" out="" label="capture" android_ui_backend="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --android-ui-backend) android_ui_backend="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
case "$android_ui_backend" in
  auto|helper|uiautomator) ;;
  *) echo "无效 --android-ui-backend: $android_ui_backend" >&2; exit 2 ;;
esac
[[ -n "$out" && -n "$app" ]] || { echo "capture 需要 --out 和 --app" >&2; exit 2; }
label="$(node -e 'const s=String(process.argv[1]||"capture").replace(/[^A-Za-z0-9._-]+/g,"_").slice(0,80);process.stdout.write(s||"capture")' "$label")"
mkdir -p "$out/screenshots"
png="$out/screenshots/${label}.png"
args=(--out "$png"); [[ -n "$device" ]] && args=(--device "$device" "${args[@]}")
started="$(node -e 'process.stdout.write(new Date().toISOString())')"
selected_backend="uiautomator"
fallback_code=""
helper_layout="$(mktemp "$out/.helper-capture.XXXXXX.xml")"
cleanup() { rm -f "$helper_layout"; }
trap cleanup EXIT
helper_status=20
if [[ "$android_ui_backend" != "uiautomator" && -n "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" ]]; then
  set +e
  node "$script_dir/atoms/helper-snapshot.js" \
    --session-state "$MAVT_ANDROID_HELPER_SESSION_STATE" \
    --screenshot-out "$png" --layout-out "$helper_layout" --timeout-ms 15000 >/dev/null
  helper_status=$?
  set -e
elif [[ "$android_ui_backend" == "helper" ]]; then
  rm -f "$png"
  echo "ANDROID_HELPER_SESSION_MISSING: strict Helper session is unavailable" >&2
  exit 1
fi
if [[ "$helper_status" -eq 0 ]]; then
  selected_backend="helper"
elif [[ "$android_ui_backend" == "helper" ]]; then
  rm -f "$png"
  echo "ANDROID_HELPER_SNAPSHOT_FAILED: strict Helper snapshot failed" >&2
  exit 1
else
  [[ -n "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" && "$android_ui_backend" != "uiautomator" ]] && fallback_code="ANDROID_HELPER_SNAPSHOT_FAILED"
  "$script_dir/atoms/screenshot.sh" "${args[@]}" >/dev/null
fi
ended="$(node -e 'process.stdout.write(new Date().toISOString())')"
node -e '
const path=require("path");const [out,label,device,app,started,ended,requested,selected,fallback]=process.argv.slice(1);
const ref=path.posix.join("screenshots",`${label}.png`);
console.log(JSON.stringify({schemaVersion:1,type:"capture",platform:"android",time:ended,artifacts:{screenshot:ref},device:{id:device||null},app:{appId:app},captureTiming:{order:selected==="helper"?["helperSnapshot"]:["screenshot"],captureStartedAt:started,screenshotCompletedAt:ended,spanMs:Math.max(0,Date.parse(ended)-Date.parse(started)),androidUiBackend:{requested,selected,fallback:fallback||null}}},null,2));
' "$out" "$label" "$device" "$app" "$started" "$ended" "$android_ui_backend" "$selected_backend" "$fallback_code"
