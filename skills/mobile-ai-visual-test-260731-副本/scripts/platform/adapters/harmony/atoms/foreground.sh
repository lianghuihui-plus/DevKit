#!/usr/bin/env bash
set -euo pipefail

device=""
aa_out=""
window_out=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --aa-out) aa_out="${2:-}"; shift 2 ;;
    --window-out) window_out="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

aa_text="$("${hdc_prefix[@]}" shell aa dump -l 2>/dev/null || true)"
window_text="$("${hdc_prefix[@]}" shell hidumper -s WindowManagerService -a "-a" 2>/dev/null || true)"
if [[ -n "$aa_out" ]]; then
  mkdir -p "$(dirname "$aa_out")"
  printf '%s\n' "$aa_text" >"$aa_out"
fi
if [[ -n "$window_out" ]]; then
  mkdir -p "$(dirname "$window_out")"
  printf '%s\n' "$window_text" >"$window_out"
fi

node -e '
const aaText = process.argv[1] || "";
const windowText = process.argv[2] || "";
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
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
    return { bundleName, abilityName, recordId, line: block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8).join(" | ") };
  }
  return null;
}
function parseForegroundProcess(text, bundleName) {
  const blocks = text.split(/AppRunningRecord ID #/).slice(1);
  const preferred = blocks.find((block) => bundleName && block.includes(`process name [${bundleName}]`) && /state #FOREGROUND\b/.test(block)) ||
    blocks.find((block) => /state #FOREGROUND\b/.test(block) && !/process name \[com\.ohos\.sceneboard/.test(block));
  if (!preferred) return null;
  return { processName: firstMatch(preferred, /process name \[([^\]]+)\]/), pid: firstMatch(preferred, /pid #(\d+)/), line: preferred.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5).join(" | ") };
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
const foregroundProcess = parseForegroundProcess(aaText, foregroundAbility?.bundleName);
const focusedWindow = parseFocusedWindow(windowText);
console.log(JSON.stringify({schemaVersion:1,type:"foreground",platform:"harmony",time:localIso(),ok:!!(foregroundAbility || foregroundProcess || focusedWindow),foregroundAbility,foregroundProcess,focusedWindow}, null, 2));
' "$aa_text" "$window_text"
