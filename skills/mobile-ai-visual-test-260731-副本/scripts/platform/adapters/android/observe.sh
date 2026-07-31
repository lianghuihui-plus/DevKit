#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

device=""
bundle=""
app=""
out=""
label="observe"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

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
local_activity_dump="$out/logs/${label}-activity-dump.txt"
local_pidof="$out/logs/${label}-pidof.txt"
local_logcat="$out/logs/${label}-logcat.txt"
local_errors="$out/logs/${label}-errors.txt"

: >"$local_errors"

if ! "$atoms_dir/screenshot.sh" "${device_args[@]}" --out "$local_png" >"$out/logs/${label}-screenshot.json" 2>"$out/logs/${label}-screencap.txt"; then
  printf '[screenshot] screencap failed. See logs/%s-screencap.txt\n' "$label" >>"$local_errors"
  rm -f "$local_png"
fi

if ! "$atoms_dir/dump-tree.sh" "${device_args[@]}" --out "$local_xml" --remote "/sdcard/mavt-${label}.xml" >"$out/logs/${label}-dump-tree.json" 2>"$out/logs/${label}-dump-layout.txt"; then
  printf '[layout] uiautomator dump failed. See logs/%s-dump-layout.txt\n' "$label" >>"$local_errors"
  rm -f "$local_xml"
fi

log_args=(--out-dir "$out/logs" --label "$label")
if [[ -n "$bundle" ]]; then
  log_args+=(--app "$bundle")
fi
"$atoms_dir/logs.sh" "${device_args[@]}" "${log_args[@]}" >"$out/logs/${label}-logs.json" 2>>"$local_errors" || true
"$atoms_dir/foreground.sh" "${device_args[@]}" --out "$local_window_dump" >"$out/logs/${label}-foreground.json" 2>>"$local_errors" || true

node -e '
const path = require("path");
const fs = require("fs");
const out = process.argv[1], label = process.argv[2], png = process.argv[3], xml = process.argv[4], device = process.argv[5], app = process.argv[6];
const windowDump = process.argv[7], activityDump = process.argv[8], pidofFile = process.argv[9], logcat = process.argv[10], errorsFile = process.argv[11], foregroundJson = process.argv[12];
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
function hasUsableContent(file) {
  const text = read(file).trim();
  return !!text && !/command failed or timed out/.test(text);
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
const activityText = read(activityDump);
const foreground = foregroundEvent?.foreground || parseComponent(windowText) || parseComponent(activityText);
const logs = [windowDump, activityDump, pidofFile, logcat, errorsFile].map(rel).filter(Boolean);
const screenshotRel = rel(png);
const layoutRel = rel(xml);
const errors = read(errorsFile).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "observation",
  platform: "android",
  time: localIso(),
  label,
  artifacts: {
    screenshot: screenshotRel,
    layout: layoutRel,
    logs
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
    processId: hasUsableContent(pidofFile) ? read(pidofFile).trim().split(/\s+/)[0] : null
  },
  capabilities: {
    screenshot: !!screenshotRel,
    layout: !!layoutRel,
    foregroundApp: !!foreground,
    logs: logs.length > 0
  },
  raw: {
    foregroundLine: foreground?.line || null,
    foreground,
    errors,
    logFiles: logs
  },
  screenshot: screenshotRel,
  layout: layoutRel
}, null, 2));
' "$out" "$label" "$local_png" "$local_xml" "$device" "$bundle" "$local_window_dump" "$local_activity_dump" "$local_pidof" "$local_logcat" "$local_errors" "$out/logs/${label}-foreground.json"
