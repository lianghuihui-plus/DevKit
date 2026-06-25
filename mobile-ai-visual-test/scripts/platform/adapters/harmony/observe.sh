#!/usr/bin/env bash
set -euo pipefail

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

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
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

"${hdc_prefix[@]}" shell uitest screenCap -p "$remote_png" >/dev/null
"${hdc_prefix[@]}" file recv "$remote_png" "$local_png" >/dev/null

dump_args=(shell uitest dumpLayout -p "$remote_json" -m true)
if [[ -n "$bundle" ]]; then
  dump_args+=( -b "$bundle" )
fi
if ! "${hdc_prefix[@]}" "${dump_args[@]}" >"$out/logs/${label}-dump-layout.txt" 2>&1; then
  printf '[layout] dumpLayout failed. See logs/%s-dump-layout.txt\n' "$label" >>"$local_errors"
fi
if ! "${hdc_prefix[@]}" file recv "$remote_json" "$local_json" >/dev/null 2>&1; then
  printf '[layout] failed to receive remote layout: %s\n' "$remote_json" >>"$local_errors"
fi

run_optional 5 "$local_aa_dump" "${hdc_prefix[@]}" shell aa dump -l
run_optional 5 "$local_window_dump" "${hdc_prefix[@]}" shell hidumper -s WindowManagerService -a "-a"
if [[ -n "$bundle" ]]; then
  run_optional 3 "$local_pidof" "${hdc_prefix[@]}" shell pidof "$bundle"
fi
run_optional 5 "$local_hilog" "${hdc_prefix[@]}" shell "hilog -x | tail -n 200"

node -e '
const path = require("path");
const fs = require("fs");
const out = process.argv[1], label = process.argv[2], png = process.argv[3], json = process.argv[4], device = process.argv[5], app = process.argv[6];
const aaDump = process.argv[7], windowDump = process.argv[8], pidofFile = process.argv[9], hilog = process.argv[10], errorsFile = process.argv[11];
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
const aaText = read(aaDump);
const windowText = read(windowDump);
function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? match[1] : null;
}
function parseForegroundAbility(text) {
  const blocks = text.split(/AbilityRecord ID #/).slice(1);
  for (const block of blocks) {
    if (!/(?:^|\s)(?:state|app state) #FOREGROUND\b/.test(block)) continue;
    if (!/ability type \[PAGE\]/.test(block)) continue;
    const bundleName = firstMatch(block, /bundle name \[([^\]]+)\]/);
    const abilityName = firstMatch(block, /main name \[([^\]]+)\]/);
    const recordId = firstMatch(block, /^(\d+)/);
    return {
      bundleName,
      abilityName,
      recordId,
      line: block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8).join(" | ")
    };
  }
  return null;
}
function parseForegroundProcess(text, bundleName) {
  const blocks = text.split(/AppRunningRecord ID #/).slice(1);
  const preferred = blocks.find((block) => bundleName && block.includes(`process name [${bundleName}]`) && /state #FOREGROUND\b/.test(block)) ||
    blocks.find((block) => /state #FOREGROUND\b/.test(block) && !/process name \[com\.ohos\.sceneboard/.test(block));
  if (!preferred) return null;
  return {
    processName: firstMatch(preferred, /process name \[([^\]]+)\]/),
    pid: firstMatch(preferred, /pid #(\d+)/),
    line: preferred.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5).join(" | ")
  };
}
function parseFocusedWindow(text) {
  const focusWindow = firstMatch(text, /Focus window:\s*(\d+)/);
  if (!focusWindow) return null;
  const line = text.split(/\r?\n/).find((item) => {
    const cols = item.trim().split(/\s+/);
    return cols[3] === focusWindow;
  });
  return line ? { windowId: focusWindow, line: line.trim() } : { windowId: focusWindow, line: null };
}
const foregroundAbility = parseForegroundAbility(aaText);
const foregroundProcess = parseForegroundProcess(aaText, foregroundAbility?.bundleName || app);
const focusedWindow = parseFocusedWindow(windowText);
const foregroundLine = foregroundAbility?.line || foregroundProcess?.line || focusedWindow?.line || null;
const foregroundApp = foregroundAbility?.bundleName || foregroundProcess?.processName || null;
const logs = [aaDump, windowDump, pidofFile, hilog, errorsFile].map(rel).filter(Boolean);
const screenshotRel = rel(png);
const layoutRel = rel(json);
const errors = read(errorsFile)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
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
' "$out" "$label" "$local_png" "$local_json" "$device" "$bundle" "$local_aa_dump" "$local_window_dump" "$local_pidof" "$local_hilog" "$local_errors"
