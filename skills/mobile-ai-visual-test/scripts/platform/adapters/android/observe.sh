#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

device=""
bundle=""
app=""
out=""
label="observe"
android_ui_backend="auto"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
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

if [[ -z "$bundle" && -n "$app" ]]; then
  bundle="$app"
fi
label="$(node -e '
const raw = process.argv[1] || "observe";
const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80);
process.stdout.write(safe || "observe");
' "$label")"

if [[ -z "$out" ]]; then
  echo "缺少 --out" >&2
  exit 2
fi

mkdir -p "$out/screenshots" "$out/layouts" "$out/logs"

device_args=()
if [[ -n "$device" ]]; then
  device_args=(--device "$device")
fi

local_png="$out/screenshots/${label}.png"
local_xml="$out/layouts/${label}.xml"
local_window_dump="$out/logs/${label}-window-dump.txt"
local_errors="$out/logs/${label}-errors.txt"
local_dump_tree_json="$out/logs/${label}-dump-tree.json"
local_dump_layout="$out/logs/${label}-dump-layout.txt"
local_helper_meta="$out/logs/${label}-helper-snapshot.json"
local_helper_error="$out/logs/${label}-helper-snapshot.txt"

: >"$local_errors"

capture_started_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
selected_backend="uiautomator"
fallback_code=""
helper_status=20

foreground_args=(--out "$local_window_dump")
if [[ -n "$bundle" ]]; then
  foreground_args+=(--app "$bundle")
fi
"$atoms_dir/foreground.sh" "${device_args[@]}" "${foreground_args[@]}" >"$out/logs/${label}-foreground.json" 2>>"$local_errors" &
foreground_pid=$!

helper_pid=""
if [[ "$android_ui_backend" != "uiautomator" && -n "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" ]]; then
  node "$atoms_dir/helper-snapshot.js" \
    --session-state "$MAVT_ANDROID_HELPER_SESSION_STATE" \
    --screenshot-out "$local_png" --layout-out "$local_xml" --timeout-ms 15000 \
    >"$local_helper_meta" 2>"$local_helper_error" &
  helper_pid=$!
elif [[ "$android_ui_backend" == "helper" ]]; then
  wait "$foreground_pid" || true
  rm -f "$local_png" "$local_xml"
  echo "ANDROID_HELPER_SESSION_MISSING: strict Helper session is unavailable" >&2
  exit 1
fi

if [[ -n "$helper_pid" ]]; then
  set +e
  wait "$helper_pid"
  helper_status=$?
  set -e
fi
wait "$foreground_pid" || true

if [[ "$helper_status" -eq 0 ]]; then
  selected_backend="helper"
  layout_completed_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
  screenshot_completed_at="$layout_completed_at"
elif [[ "$android_ui_backend" == "helper" ]]; then
  rm -f "$local_png" "$local_xml"
  cat "$local_helper_error" >&2 || true
  echo "ANDROID_HELPER_SNAPSHOT_FAILED: strict Helper snapshot failed" >&2
  exit 1
else
  if [[ -n "$helper_pid" ]]; then
    fallback_code="ANDROID_HELPER_SNAPSHOT_FAILED"
    cat "$local_helper_error" >>"$local_errors" 2>/dev/null || true
  fi
  if ! "$atoms_dir/dump-tree.sh" "${device_args[@]}" --out "$local_xml" --remote "/sdcard/mavt-${label}.xml" >"$local_dump_tree_json" 2>"$local_dump_layout"; then
    layout_error="$(head -n 1 "$local_dump_layout" | tr -d '\r' || true)"
    printf '[layout] %s. See logs/%s-dump-layout.txt\n' "${layout_error:-uiautomator dump failed}" "$label" >>"$local_errors"
    rm -f "$local_xml"
  fi
  layout_completed_at="$(node -e 'process.stdout.write(new Date().toISOString())')"

  if ! "$atoms_dir/screenshot.sh" "${device_args[@]}" --out "$local_png" >"$out/logs/${label}-screenshot.json" 2>"$out/logs/${label}-screencap.txt"; then
    printf '[screenshot] screencap failed. See logs/%s-screencap.txt\n' "$label" >>"$local_errors"
    rm -f "$local_png"
  fi
  screenshot_completed_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
fi

node -e '
const path = require("path");
const fs = require("fs");
const out = process.argv[1], label = process.argv[2], png = process.argv[3], xml = process.argv[4], device = process.argv[5], app = process.argv[6];
const windowDump = process.argv[7], errorsFile = process.argv[8], foregroundJson = process.argv[9], dumpTreeJson = process.argv[10];
const captureStartedAt = process.argv[11], layoutCompletedAt = process.argv[12], screenshotCompletedAt = process.argv[13];
const requestedBackend = process.argv[14], selectedBackend = process.argv[15], fallbackCode = process.argv[16] || null, helperMetaFile = process.argv[17];
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function rel(file) {
  return file && fs.existsSync(file) ? path.relative(out, file) : null;
}
function read(file) {
  return file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function readJson(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; } catch { return null; }
}
function parseComponent(text) {
  const patterns = [
    /mCurrentFocus=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/,
    /mFocusedApp=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/,
    /topResumedActivity=.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/,
    /ResumedActivity:.*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$/]+)[}\s]/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    return { packageName: match[1], activityName: normalizeActivity(match[1], match[2]), line: match[0].trim() };
  }
  return null;
}
function normalizeActivity(packageName, activity) {
  if (!activity) return null;
  if (activity.startsWith(".")) return activity.slice(1);
  if (activity.startsWith(`${packageName}.`)) return activity.slice(packageName.length + 1);
  return activity;
}
const foregroundEvent = readJson(foregroundJson);
const windowText = read(windowDump);
const foreground = foregroundEvent?.foreground || parseComponent(windowText);
const screenshotRel = rel(png);
const layoutRel = rel(xml);
const errors = read(errorsFile).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const dumpTree = readJson(dumpTreeJson);
const helperMeta = readJson(helperMetaFile);
const layoutCapture = selectedBackend === "helper" ? {
  status: "AVAILABLE", code: null, message: "控件树采集成功", durationMs: helperMeta?.atomicElapsedMs ?? null, fallback: null,
} : dumpTree?.capture || (layoutRel ? {
  status: "AVAILABLE", code: null, message: "控件树采集成功", durationMs: null, fallback: null,
} : {
  status: "UNAVAILABLE", code: "ANDROID_LAYOUT_CAPTURE_FAILED", message: "本次观察没有生成控件树", durationMs: null, fallback: "SCREENSHOT",
});
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "observation",
  platform: "android",
  time: localIso(),
  label,
  artifacts: {
    screenshot: screenshotRel,
    layout: layoutRel
  },
  device: {
    id: device || null,
    screen: null
  },
  app: {
    appId: app || null,
    foregroundApp: foreground?.packageName || null,
    entry: foreground?.activityName || null,
    inTargetApp: app && foreground?.packageName ? foreground.packageName === app : null,
    processId: foregroundEvent?.processId || null
  },
  capabilities: {
    screenshot: !!screenshotRel,
    layout: !!layoutRel,
    foregroundApp: !!foreground
  },
  technicalSignals: {
    androidUiBackend: {
      requested: requestedBackend,
      selected: selectedBackend,
      fallback: fallbackCode,
      helperVersion: helperMeta?.helperVersion || null,
      protocolVersion: helperMeta?.protocolVersion || null,
      atomicElapsedMs: helperMeta?.atomicElapsedMs ?? null,
      requestElapsedMs: helperMeta?.requestElapsedMs ?? null
    },
    layoutCapture,
    captureTiming: {
      order: selectedBackend === "helper" ? ["helperSnapshot"] : ["layout", "screenshot"],
      captureStartedAt,
      layoutCompletedAt,
      screenshotCompletedAt,
      spanMs: Math.max(0, Date.parse(screenshotCompletedAt) - Date.parse(captureStartedAt))
    }
  },
  raw: {
    foregroundLine: foreground?.line || null,
    foreground,
    errors
  },
  screenshot: screenshotRel,
  layout: layoutRel
}, null, 2));
' "$out" "$label" "$local_png" "$local_xml" "$device" "$bundle" "$local_window_dump" "$local_errors" "$out/logs/${label}-foreground.json" "$local_dump_tree_json" "$capture_started_at" "$layout_completed_at" "$screenshot_completed_at" "$android_ui_backend" "$selected_backend" "$fallback_code" "$local_helper_meta"
