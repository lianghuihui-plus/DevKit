#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
case_dir=""
execution_id=""
step_id=""
action_type=""
settle_ms="${MAVT_ACTION_SETTLE_MS:-1000}"
target=""
x=""
y=""
text=""
from_x=""
from_y=""
to_x=""
to_y=""
coordinate_source=""
target_bounds=""
coordinate_evidence=""
args=()
has_platform=0
has_device=0
has_app=0
has_entry=0

validate_coordinate_metadata() {
  if [[ -n "$coordinate_source" ]]; then
    case "$coordinate_source" in
      layout|visual|pixel|manual|flow) ;;
      *)
        echo "无效 --coordinate-source: $coordinate_source" >&2
        exit 2
        ;;
    esac
  fi
  if [[ -n "$target_bounds" ]]; then
    if ! node -e '
const parts = String(process.argv[1] || "").split(",").map((item) => Number(item.trim()));
process.exit(parts.length === 4 && parts.every((item) => Number.isFinite(item)) ? 0 : 1);
' "$target_bounds"; then
      echo "无效 --target-bounds: $target_bounds" >&2
      exit 2
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case-dir) case_dir="${2:-}"; shift 2 ;;
    --execution-id) execution_id="${2:-}"; shift 2 ;;
    --step-id) step_id="${2:-}"; shift 2 ;;
    --platform) has_platform=1; args+=("$1" "$2"); shift 2 ;;
    --device) has_device=1; args+=("$1" "$2"); shift 2 ;;
    --app|--bundle) has_app=1; args+=("$1" "$2"); shift 2 ;;
    --entry|--ability) has_entry=1; args+=("$1" "$2"); shift 2 ;;
    --type) action_type="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --target) target="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --y) y="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --text) text="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --from-x) from_x="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --from-y) from_y="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --to-x) to_x="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --to-y) to_y="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --coordinate-source) coordinate_source="${2:-}"; shift 2 ;;
    --target-bounds) target_bounds="${2:-}"; shift 2 ;;
    --coordinate-evidence) coordinate_evidence="${2:-}"; shift 2 ;;
    --settle-ms) settle_ms="${2:-}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -n "$case_dir" ]]; then
  if [[ -z "$action_type" ]]; then
    echo "缺少 --type" >&2
    exit 2
  fi
  validate_coordinate_metadata
  case "$action_type" in
    tap|toggle)
      if [[ -n "$x" || -n "$y" ]]; then
        if [[ -z "$coordinate_source" ]]; then
          echo "坐标动作必须提供 --coordinate-source" >&2
          exit 2
        fi
        if [[ -z "$coordinate_evidence" ]]; then
          echo "坐标动作必须提供 --coordinate-evidence" >&2
          exit 2
        fi
      fi
      ;;
    inputText)
      if [[ -n "$x" || -n "$y" ]]; then
        if [[ -z "$coordinate_source" ]]; then
          echo "坐标动作必须提供 --coordinate-source" >&2
          exit 2
        fi
        if [[ -z "$coordinate_evidence" ]]; then
          echo "坐标动作必须提供 --coordinate-evidence" >&2
          exit 2
        fi
      fi
      ;;
  esac
  if [[ "$coordinate_source" == "visual" || "$coordinate_source" == "pixel" ]]; then
    if [[ -z "$target_bounds" ]]; then
      echo "视觉坐标动作必须提供 --target-bounds" >&2
      exit 2
    fi
  fi
  if [[ -z "$execution_id" ]]; then
    execution_id="$(node -e '
const fs = require("fs");
const path = require("path");
const root = path.join(process.argv[1], "executions");
if (!fs.existsSync(root)) process.exit(1);
const names = fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory()).sort();
if (!names.length) process.exit(1);
process.stdout.write(names[names.length - 1]);
' "$case_dir")"
  fi
  env_args=()
  while IFS= read -r item; do
    [[ -n "$item" ]] && env_args+=("$item")
  done < <(node -e '
const fs = require("fs");
const path = require("path");
const caseDir = process.argv[1];
const has = {
  platform: process.argv[2] === "1",
  device: process.argv[3] === "1",
  app: process.argv[4] === "1",
  entry: process.argv[5] === "1",
};
const statePath = path.join(caseDir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const env = state.environment || {};
const out = [];
function add(flag, value) {
  if (value !== undefined && value !== null && String(value) !== "") out.push(flag, String(value));
}
if (!has.platform) add("--platform", env.platform);
if (!has.device) add("--device", env.device);
if (!has.app) add("--app", env.appId || env.bundleName);
if (!has.entry) add("--entry", env.entry || env.abilityName);
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
' "$case_dir" "$has_platform" "$has_device" "$has_app" "$has_entry")
  merged_args=()
  if [[ ${#env_args[@]} -gt 0 ]]; then
    merged_args+=("${env_args[@]}")
  fi
  if [[ ${#args[@]} -gt 0 ]]; then
    merged_args+=("${args[@]}")
  fi
  args=()
  if [[ ${#merged_args[@]} -gt 0 ]]; then
    args=("${merged_args[@]}")
  fi
  precheck_args=("$case_dir" --check-budget --event-type actionResult --action "$action_type" --execution-id "$execution_id")
  if [[ -n "$step_id" ]]; then
    precheck_args+=(--step-id "$step_id")
  fi
  "$script_dir/run-case.js" "${precheck_args[@]}" >/dev/null
  set +e
  adapter_output="$("$script_dir/platform/action.sh" "${args[@]}" 2>&1)"
  adapter_status=$?
  set -e
  if [[ $adapter_status -eq 0 ]]; then
    if [[ "$action_type" != "wait" ]]; then
      sleep "$(node -e '
const value = Number(process.argv[1] || 0);
if (!Number.isFinite(value) || value < 0) process.exit(2);
console.log((value / 1000).toFixed(3));
' "$settle_ms")"
    fi
    result="$adapter_output"
  else
    result="$(node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const action = process.argv[1] || "unknown";
const error = process.argv[2] || "platform action failed";
const status = Number(process.argv[3] || 1);
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "actionResult",
  platform: null,
  time: localIso(),
  action,
  ok: false,
  error,
  failureCode: status === 64 ? "PLATFORM_UNIMPLEMENTED" : "TOOL_ERROR"
}, null, 2));
' "$action_type" "$adapter_output" "$adapter_status")"
  fi
  if [[ $adapter_status -eq 0 && "$action_type" != "wait" ]]; then
    result="$(node -e '
const event = JSON.parse(process.argv[1]);
event.settleMs = Number(process.argv[2] || 0);
console.log(JSON.stringify(event, null, 2));
' "$result" "$settle_ms")"
  fi
  result="$(node -e '
const event = JSON.parse(process.argv[1]);
const meta = {
  x: process.argv[2],
  y: process.argv[3],
  target: process.argv[4],
  coordinateSource: process.argv[5],
  targetBounds: process.argv[6],
  coordinateEvidence: process.argv[7]
};
function numberOrString(value) {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}
function parseBounds(value) {
  if (!value) return undefined;
  const parts = String(value).split(",").map((item) => Number(item.trim()));
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new Error(`Invalid --target-bounds: ${value}`);
  }
  return parts;
}
const x = numberOrString(meta.x);
const y = numberOrString(meta.y);
if (x !== undefined) event.x = x;
if (y !== undefined) event.y = y;
if (meta.target) event.target = meta.target;
if (meta.coordinateSource) event.coordinateSource = meta.coordinateSource;
const bounds = parseBounds(meta.targetBounds);
if (bounds) event.targetBounds = bounds;
if (meta.coordinateEvidence) event.coordinateEvidence = meta.coordinateEvidence;
console.log(JSON.stringify(event, null, 2));
' "$result" "$x" "$y" "$target" "$coordinate_source" "$target_bounds" "$coordinate_evidence")"
  if [[ -n "$step_id" ]]; then
    result="$(node -e '
const event = JSON.parse(process.argv[1]);
event.stepId = process.argv[2];
console.log(JSON.stringify(event, null, 2));
' "$result" "$step_id")"
  fi
  "$script_dir/run-case.js" "$case_dir" --record-json "$result" --execution-id "$execution_id" >/dev/null
  if [[ $adapter_status -eq 64 ]]; then
    "$script_dir/run-case.js" "$case_dir" --finalize --status BLOCKED --failure-code PLATFORM_UNIMPLEMENTED --reason "$adapter_output" --execution-id "$execution_id" >/dev/null
  fi
  printf '%s\n' "$result"
  if [[ $adapter_status -ne 0 ]]; then
    exit "$adapter_status"
  fi
else
  exec "$script_dir/platform/action.sh" "${args[@]}"
fi
