#!/usr/bin/env bash
set -euo pipefail

device=""
out=""
remote="/sdcard/mavt-dump-tree.xml"
timeout_seconds="${MAVT_ANDROID_LAYOUT_TIMEOUT_SECONDS:-4}"
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  timeout_seconds=4
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --remote) remote="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$out" ]] || { echo "dump-tree 需要 --out" >&2; exit 2; }
mkdir -p "$(dirname "$out")"
rm -f "$out"

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000'
}

emit_result() {
  local ok="$1" status="$2" code="$3" message="$4" duration_ms="$5"
  node -e '
const path = require("path");
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const ok = process.argv[1] === "true";
const result = {
  schemaVersion: 1,
  type: "atomResult",
  atom: "dump-tree",
  platform: "android",
  time: localIso(),
  ok,
  path: ok ? path.resolve(process.argv[2]) : null,
  capture: {
    status: process.argv[3],
    code: process.argv[4] || null,
    message: process.argv[5],
    durationMs: Number(process.argv[6]),
    fallback: ok ? null : "SCREENSHOT",
  },
};
console.log(JSON.stringify(result, null, 2));
' "$ok" "$out" "$status" "$code" "$message" "$duration_ms"
}

fail_capture() {
  local code="$1" message="$2" started_ms="$3"
  local duration_ms=$(( $(now_ms) - started_ms ))
  rm -f "$out"
  "${adb_prefix[@]}" shell rm -f "$remote" >/dev/null 2>&1 || true
  emit_result false UNAVAILABLE "$code" "$message" "$duration_ms"
  printf '%s: %s\n' "$code" "$message" >&2
  exit 1
}

started_ms="$(now_ms)"
"${adb_prefix[@]}" shell rm -f "$remote" >/dev/null 2>&1 || true

set +e
dump_output="$(perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" "${adb_prefix[@]}" shell uiautomator dump "$remote" 2>&1)"
dump_status=$?
set -e
dump_output="$(printf '%s' "$dump_output" | tr -d '\r')"

if [[ "$dump_output" == *"could not get idle state"* ]]; then
  fail_capture ANDROID_LAYOUT_NOT_IDLE "页面持续变化，uiautomator 未进入可采集状态" "$started_ms"
fi
if [[ "$dump_status" -eq 142 || "$dump_status" -eq 124 ]]; then
  fail_capture ANDROID_LAYOUT_TIMEOUT "控件树采集超过 ${timeout_seconds} 秒时限" "$started_ms"
fi
if [[ "$dump_status" -ne 0 ]]; then
  fail_capture ANDROID_LAYOUT_CAPTURE_FAILED "uiautomator dump 执行失败${dump_output:+：$dump_output}" "$started_ms"
fi
if ! "${adb_prefix[@]}" shell test -s "$remote" >/dev/null 2>&1; then
  fail_capture ANDROID_LAYOUT_OUTPUT_MISSING "uiautomator 未生成本次控件树文件" "$started_ms"
fi
if ! "${adb_prefix[@]}" pull "$remote" "$out" >/dev/null 2>&1 || [[ ! -s "$out" ]]; then
  fail_capture ANDROID_LAYOUT_PULL_FAILED "控件树文件无法拉取到本地" "$started_ms"
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
skill_root="$(cd "$script_dir/../../../../.." && pwd)"
set +e
validation_message="$(node -e '
const fs = require("fs");
const { parseLayout } = require(process.argv[2]);
const parsed = parseLayout(fs.readFileSync(process.argv[1], "utf8"), "xml");
if (!parsed.usable) {
  process.stderr.write(parsed.diagnostics?.[0]?.message || "invalid layout XML");
  process.exit(1);
}
' "$out" "$skill_root/scripts/lib/layout-observation.js" 2>&1)"
validation_status=$?
set -e
if [[ "$validation_status" -ne 0 ]]; then
  fail_capture ANDROID_LAYOUT_INVALID "控件树 XML 无效${validation_message:+：$validation_message}" "$started_ms"
fi

"${adb_prefix[@]}" shell rm -f "$remote" >/dev/null 2>&1 || true
duration_ms=$(( $(now_ms) - started_ms ))
emit_result true AVAILABLE "" "控件树采集成功" "$duration_ms"
