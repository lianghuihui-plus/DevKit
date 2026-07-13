#!/usr/bin/env bash
set -euo pipefail

device=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

adb_path="$(command -v adb || true)"
script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"
targets=""
if [[ -n "$adb_path" ]]; then
  targets="$(adb devices 2>/dev/null | awk 'NR > 1 && $2 == "device" {print $1}' || true)"
fi

if [[ -z "$device" && "$(printf '%s\n' "$targets" | sed '/^\s*$/d' | wc -l | tr -d ' ')" = "1" ]]; then
  device="$(printf '%s\n' "$targets" | sed '/^\s*$/d' | head -1)"
fi

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

tmp_dir="${TMPDIR:-/tmp}/mavt-android-probe-$$"
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

screenshot="false"
layout="false"
foreground_app="false"
logs="false"
screen=""
dependencies_json="[]"

if [[ -n "$adb_path" && -n "$device" ]]; then
  run_probe_optional 8 "$atoms_dir/screenshot.sh" --device "$device" --out "$tmp_dir/probe.png" && screenshot="true" || true
  run_probe_optional 8 "$atoms_dir/dump-tree.sh" --device "$device" --out "$tmp_dir/probe.xml" --remote /sdcard/mavt-probe.xml && layout="true" || true
  if run_probe_optional 5 "$atoms_dir/foreground.sh" --device "$device" --out "$tmp_dir/window.txt"; then
    foreground_app="true"
  fi
  run_probe_optional 5 "$atoms_dir/logs.sh" --device "$device" --out-dir "$tmp_dir/logs" --label probe && logs="true" || true
  screen="$("${adb_prefix[@]}" shell wm size 2>/dev/null | sed -n 's/.*Physical size: //p' | head -1 | tr -d '\r' || true)"
  dependencies_json="$("$atoms_dir/mavt-ime.sh" --device "$device" --status 2>/dev/null | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const dependency = JSON.parse(input);
    process.stdout.write(JSON.stringify([dependency]));
  } catch {
    process.stdout.write("[]");
  }
});
' || printf '[]')"
fi

node -e '
const adb = !!process.argv[1];
const device = process.argv[2] || null;
const targets = (process.argv[3] || "").split(/\r?\n/).filter(Boolean);
const screenshot = process.argv[4] === "true";
const layout = process.argv[5] === "true";
const foregroundApp = process.argv[6] === "true";
const logs = process.argv[7] === "true";
const screen = process.argv[8] || null;
const dependencies = JSON.parse(process.argv[9] || "[]");
const hasTarget = adb && !!device;
const actions = [];
if (hasTarget) actions.push("launchApp", "restartApp", "tap", "toggle", "longPress", "inputText", "swipe", "back", "home", "wait");
const diagnostics = [];
function diag(id, level, message, howToFix, check) {
  diagnostics.push({ id, level, message, howToFix, check });
}
if (!adb) {
  diag("adbMissing", "ERROR", "未找到 adb", "安装 Android SDK Platform Tools，并把 platform-tools 加入 PATH；详见 references/installation.md#android", "command -v adb");
} else if (!device) {
  diag("androidDeviceMissing", "ERROR", "未发现可用 Android 设备", "连接设备并开启 USB 调试，确认 adb devices 中状态为 device；详见 references/installation.md#android", "adb devices");
}
if (hasTarget && !screenshot) {
  diag("androidScreenshotUnavailable", "ERROR", "Android 截图能力不可用", "确认设备已解锁并允许调试，然后重试 scripts/probe-env.sh --platform android", "adb exec-out screencap -p");
}
if (hasTarget && !layout) {
  diag("androidLayoutUnavailable", "ERROR", "Android 控件树能力不可用", "确认 uiautomator dump 可执行，必要时解锁设备并保持目标页面前台", "adb shell uiautomator dump");
}
if (hasTarget && !foregroundApp) {
  diag("androidForegroundUnavailable", "ERROR", "Android 前台应用识别不可用", "确认 dumpsys window/activity 可执行，并保持设备处于可调试状态", "adb shell dumpsys window");
}
if (hasTarget && !logs) {
  diag("androidLogsUnavailable", "WARN", "Android 日志能力不可用", "确认 adb logcat 可执行；日志缺失不阻塞核心视觉测试", "adb logcat -d");
}
const ime = dependencies.find((item) => item && item.id === "mavtInputIme");
if (hasTarget && ime && !ime.ok) {
  diag("androidImeNotReady", "INFO", "MAVT Input IME 尚未准备", "执行 scripts/prepare-env.sh --case-dir <case-dir> --platform android 自动构建、安装并启用输入法", "scripts/prepare-env.sh --case-dir <case-dir> --platform android");
}
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "environmentProbe",
  platform: "android",
  device,
  targets,
  ready: !diagnostics.some((item) => item.level === "ERROR"),
  diagnostics,
  capabilities: {
    connector: "adb",
    adb,
    screenshot,
    layout,
    foregroundApp,
    logs,
    launchApp: hasTarget,
    actions,
    screenCap: screenshot,
    dumpLayout: layout,
    screen,
    dependencies,
    implemented: true
  }
}, null, 2));
' "$adb_path" "$device" "$targets" "$screenshot" "$layout" "$foreground_app" "$logs" "$screen" "$dependencies_json"
