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
const diagnostics = [];
function diag(id, level, message, howToFix, check) {
  diagnostics.push({ id, level, message, howToFix, check });
}
if (!hdc) {
  diag("hdcMissing", "ERROR", "未找到 hdc", "安装 DevEco Studio 或 HarmonyOS Command Line Tools，并把 hdc 加入 PATH；详见 references/installation.md#harmonyos", "command -v hdc");
} else if (!device) {
  diag("harmonyTargetMissing", "ERROR", "未发现可用 HarmonyOS 设备", "连接真机或启动模拟器，确认 hdc list targets 能看到目标设备；详见 references/installation.md#harmonyos", "hdc list targets");
}
if (hasTarget && !uitestVersion) {
  diag("harmonyUitestMissing", "ERROR", "HarmonyOS uitest 不可用", "确认设备支持 uitest，并执行 hdc shell uitest --version 验证", "hdc shell uitest --version");
}
if (hasTarget && !screenCap) {
  diag("harmonyScreenshotUnavailable", "ERROR", "HarmonyOS 截图能力不可用", "确认设备已解锁且 uitest screenCap 可执行", "hdc shell uitest screenCap -p /data/local/tmp/mavt-probe.png");
}
if (hasTarget && !dumpLayout) {
  diag("harmonyLayoutUnavailable", "ERROR", "HarmonyOS 控件树能力不可用", "确认 uitest dumpLayout 可执行；详见 references/installation.md#harmonyos", "hdc shell uitest dumpLayout -p /data/local/tmp/mavt-probe.json");
}
if (hasTarget && !aaDump) {
  diag("harmonyAaDumpUnavailable", "ERROR", "HarmonyOS 启动或前台应用识别能力不可用", "确认 aa dump 可执行；launchApp/restartApp 依赖该能力", "hdc shell aa dump");
}
if (hasTarget && !hilog) {
  diag("harmonyLogsUnavailable", "WARN", "HarmonyOS hilog 不可用", "确认 hdc shell hilog 可执行；日志缺失不阻塞核心视觉测试", "hdc shell hilog");
}
const data = {
  schemaVersion: 1,
  type: "environmentProbe",
  platform: "harmony",
  device,
  targets: (process.argv[2] || "").split(/\r?\n/).filter(Boolean),
  ready: !diagnostics.some((item) => item.level === "ERROR"),
  diagnostics,
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
