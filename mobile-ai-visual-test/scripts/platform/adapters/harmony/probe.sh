#!/usr/bin/env bash
set -euo pipefail

device=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"
hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

tmp_dir="${TMPDIR:-/tmp}/mavt-harmony-probe-$$"
mkdir -p "$tmp_dir"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

run_probe_optional() {
  local timeout_seconds="$1"
  shift
  perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" "$@" >/dev/null 2>&1
}

targets=""
if command -v hdc >/dev/null 2>&1; then
  targets="$(hdc list targets 2>/dev/null || true)"
fi

uitest_version=""
screen_cap="false"
dump_layout="false"
aa_dump="false"
window_dump="false"
hilog="false"
if [[ -n "$device" || "$(printf '%s\n' "$targets" | sed '/^\s*$/d' | wc -l | tr -d ' ')" = "1" ]]; then
  if [[ -z "$device" ]]; then
    device="$(printf '%s\n' "$targets" | sed '/^\s*$/d' | head -1)"
    hdc_prefix=(hdc -t "$device")
  fi
  uitest_version="$("${hdc_prefix[@]}" shell uitest --version 2>/dev/null || true)"
  run_probe_optional 8 "$atoms_dir/screenshot.sh" --device "$device" --out "$tmp_dir/probe.png" --remote /data/local/tmp/mavt-probe.png && screen_cap="true" || true
  run_probe_optional 8 "$atoms_dir/dump-tree.sh" --device "$device" --out "$tmp_dir/probe.json" --remote /data/local/tmp/mavt-probe.json --log "$tmp_dir/dump-tree.log" && dump_layout="true" || true
  if run_probe_optional 5 "$atoms_dir/foreground.sh" --device "$device" --aa-out "$tmp_dir/aa-dump.txt" --window-out "$tmp_dir/window-dump.txt"; then
    [[ -s "$tmp_dir/aa-dump.txt" ]] && aa_dump="true"
    [[ -s "$tmp_dir/window-dump.txt" ]] && window_dump="true"
  fi
  run_probe_optional 5 "$atoms_dir/logs.sh" --device "$device" --out-dir "$tmp_dir/logs" --label probe && hilog="true" || true
fi

node -e '
const hdc = !!process.argv[3];
const device = process.argv[1] || null;
const uitestVersion = process.argv[4] || null;
const screenCap = process.argv[5] === "true";
const dumpLayout = process.argv[6] === "true";
const aaDump = process.argv[7] === "true";
const windowDump = process.argv[8] === "true";
const hilog = process.argv[9] === "true";
const hasTarget = hdc && !!device;
const canUseUitest = hasTarget && !!uitestVersion;
const canLaunchApp = hasTarget && aaDump;
const actions = [];
if (canLaunchApp) actions.push("launchApp", "restartApp");
if (canUseUitest) actions.push("tap", "toggle", "longPress", "inputText", "swipe", "back", "home");
if (hasTarget) actions.push("wait");
const data = {
  schemaVersion: 1,
  type: "environmentProbe",
  platform: "harmony",
  device,
  targets: (process.argv[2] || "").split(/\r?\n/).filter(Boolean),
  capabilities: {
    connector: "hdc",
    hdc,
    screenshot: screenCap,
    layout: dumpLayout,
    foregroundApp: aaDump || windowDump,
    logs: hilog,
    launchApp: canLaunchApp,
    actions,
    uitestVersion,
    screenCap,
    dumpLayout,
    aaDump,
    windowDump,
    hilog
  }
};
console.log(JSON.stringify(data, null, 2));
' "$device" "$targets" "$(command -v hdc || true)" "$uitest_version" "$screen_cap" "$dump_layout" "$aa_dump" "$window_dump" "$hilog"
