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

remote_png="/data/local/tmp/mavt-${label}.png"
remote_json="/data/local/tmp/mavt-${label}.json"
local_png="$out/screenshots/${label}.png"
local_json="$out/layouts/${label}.json"
local_aa_dump="$out/logs/${label}-aa-dump.txt"
local_window_dump="$out/logs/${label}-window-dump.txt"
local_pidof="$out/logs/${label}-pidof.txt"
local_hilog="$out/logs/${label}-hilog.txt"
local_errors="$out/logs/${label}-errors.txt"

: >"$local_errors"

if ! "$atoms_dir/screenshot.sh" "${device_args[@]}" --remote "$remote_png" --out "$local_png" >"$out/logs/${label}-screenshot.json" 2>"$out/logs/${label}-screencap.txt"; then
  printf '[screenshot] screenCap failed. See logs/%s-screencap.txt\n' "$label" >>"$local_errors"
  rm -f "$local_png"
fi

dump_args=(--remote "$remote_json" --out "$local_json" --log "$out/logs/${label}-dump-layout.txt")
if [[ -n "$bundle" ]]; then
  dump_args+=(--bundle "$bundle")
fi
if ! "$atoms_dir/dump-tree.sh" "${device_args[@]}" "${dump_args[@]}" >"$out/logs/${label}-dump-tree.json" 2>>"$local_errors"; then
  printf '[layout] dumpLayout failed. See logs/%s-dump-layout.txt\n' "$label" >>"$local_errors"
  rm -f "$local_json"
fi

log_args=(--out-dir "$out/logs" --label "$label")
if [[ -n "$bundle" ]]; then
  log_args+=(--app "$bundle")
fi
"$atoms_dir/logs.sh" "${device_args[@]}" "${log_args[@]}" >"$out/logs/${label}-logs.json" 2>>"$local_errors" || true
"$atoms_dir/foreground.sh" "${device_args[@]}" --aa-out "$local_aa_dump" --window-out "$local_window_dump" >"$out/logs/${label}-foreground.json" 2>>"$local_errors" || true

node -e '
const path = require("path");
const fs = require("fs");
const out = process.argv[1], label = process.argv[2], png = process.argv[3], json = process.argv[4], device = process.argv[5], app = process.argv[6];
const aaDump = process.argv[7], windowDump = process.argv[8], pidofFile = process.argv[9], hilog = process.argv[10], errorsFile = process.argv[11], foregroundJson = process.argv[12];
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
function hasUsableContent(file) {
  const text = read(file).trim();
  return !!text && !/command failed or timed out/.test(text);
}
const fg = readJson(foregroundJson);
const foregroundAbility = fg?.foregroundAbility || null;
const foregroundProcess = fg?.foregroundProcess || null;
const focusedWindow = fg?.focusedWindow || null;
const foregroundLine = foregroundAbility?.line || foregroundProcess?.line || focusedWindow?.line || null;
const foregroundApp = foregroundAbility?.bundleName || foregroundProcess?.processName || null;
const logs = [aaDump, windowDump, pidofFile, hilog, errorsFile].map(rel).filter(Boolean);
const screenshotRel = rel(png);
const layoutRel = rel(json);
const errors = read(errorsFile).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "observation",
  platform: "harmony",
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
    foregroundApp,
    entry: foregroundAbility?.abilityName || null,
    inTargetApp: app && foregroundApp ? foregroundApp === app : null,
    processId: hasUsableContent(pidofFile) ? read(pidofFile).trim().split(/\s+/)[0] : foregroundProcess?.pid || null
  },
  capabilities: {
    screenshot: !!screenshotRel,
    layout: !!layoutRel,
    foregroundApp: !!foregroundLine,
    logs: logs.length > 0
  },
  raw: {
    foregroundLine,
    foregroundAbility,
    foregroundProcess,
    focusedWindow,
    errors,
    logFiles: logs
  },
  screenshot: screenshotRel,
  layout: layoutRel
}, null, 2));
' "$out" "$label" "$local_png" "$local_json" "$device" "$bundle" "$local_aa_dump" "$local_window_dump" "$local_pidof" "$local_hilog" "$local_errors" "$out/logs/${label}-foreground.json"
