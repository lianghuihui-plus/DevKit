#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
flow_dir=""
recording_id=""
instruction=""
target=""
success_hint=""
settle_ms="${MAVT_ACTION_SETTLE_MS:-1000}"
coordinate_source=""
target_bounds=""
coordinate_evidence=""
platform=""
has_platform=0
has_device=0
has_app=0
has_entry=0
type=""
x=""
y=""
text=""
from_x=""
from_y=""
to_x=""
to_y=""
args=()

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
    --flow-dir) flow_dir="${2:-}"; shift 2 ;;
    --recording-id) recording_id="${2:-}"; shift 2 ;;
    --instruction) instruction="${2:-}"; shift 2 ;;
    --target) target="${2:-}"; shift 2 ;;
    --success-hint) success_hint="${2:-}"; shift 2 ;;
    --settle-ms) settle_ms="${2:-}"; shift 2 ;;
    --coordinate-source) coordinate_source="${2:-}"; shift 2 ;;
    --target-bounds) target_bounds="${2:-}"; shift 2 ;;
    --coordinate-evidence) coordinate_evidence="${2:-}"; shift 2 ;;
    --platform) platform="${2:-}"; has_platform=1; shift 2 ;;
    --device) has_device=1; args+=("$1" "$2"); shift 2 ;;
    --app|--bundle) has_app=1; args+=("$1" "$2"); shift 2 ;;
    --entry|--ability) has_entry=1; args+=("$1" "$2"); shift 2 ;;
    --type) type="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --y) y="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --text) text="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --from-x) from_x="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --from-y) from_y="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --to-x) to_x="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --to-y) to_y="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$flow_dir" || -z "$recording_id" || -z "$type" ]]; then
  echo "缺少 --flow-dir、--recording-id 或 --type" >&2
  exit 2
fi

validate_coordinate_metadata

case "$type" in
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

recording_dir="$flow_dir/recordings/$recording_id"
mkdir -p "$recording_dir/logs"

if [[ $has_platform -eq 0 ]]; then
  platform="$(node -e '
const fs = require("fs");
const path = require("path");
const statePath = path.join(process.argv[1], "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
process.stdout.write(state.environment?.platform || "harmony");
' "$flow_dir")"
fi
env_args=()
while IFS= read -r item; do
  [[ -n "$item" ]] && env_args+=("$item")
done < <(node -e '
const fs = require("fs");
const path = require("path");
const flowDir = process.argv[1];
const has = {
  device: process.argv[2] === "1",
  app: process.argv[3] === "1",
  entry: process.argv[4] === "1"
};
const statePath = path.join(flowDir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const env = state.environment || {};
const out = [];
function add(flag, value) {
  if (value !== undefined && value !== null && String(value) !== "") out.push(flag, String(value));
}
if (!has.device) add("--device", env.device);
if (!has.app) add("--app", env.appId || env.bundleName);
if (!has.entry) add("--entry", env.entry || env.abilityName);
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
' "$flow_dir" "$has_device" "$has_app" "$has_entry")
if [[ ${#env_args[@]} -gt 0 ]]; then
  merged_args=("${env_args[@]}")
  if [[ ${#args[@]} -gt 0 ]]; then
    merged_args+=("${args[@]}")
  fi
  args=("${merged_args[@]}")
fi

set +e
adapter_output="$("$script_dir/../platform/action.sh" --platform "$platform" --type "$type" "${args[@]}" 2>&1)"
adapter_status=$?
set -e

if [[ $adapter_status -eq 0 && "$type" != "wait" ]]; then
  sleep "$(node -e '
const value = Number(process.argv[1] || 0);
if (!Number.isFinite(value) || value < 0) process.exit(2);
console.log((value / 1000).toFixed(3));
' "$settle_ms")"
fi

node -e '
const fs = require("fs");
const path = require("path");
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const recordingDir = process.argv[1];
const adapterStatus = Number(process.argv[2]);
const adapterOutput = process.argv[3];
const type = process.argv[4];
const instruction = process.argv[5] || "";
const target = process.argv[6] || "";
const successHint = process.argv[7] || "";
const settleMs = Number(process.argv[8] || 0);
const coordinateSource = process.argv[16] || "";
const targetBoundsText = process.argv[17] || "";
const coordinateEvidence = process.argv[18] || "";
function parseBounds(value) {
  if (!value) return undefined;
  const parts = String(value).split(",").map((item) => Number(item.trim()));
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new Error(`Invalid --target-bounds: ${value}`);
  }
  return parts;
}
const actionDetails = {
  x: process.argv[9] || undefined,
  y: process.argv[10] || undefined,
  text: process.argv[11] || undefined,
  fromX: process.argv[12] || undefined,
  fromY: process.argv[13] || undefined,
  toX: process.argv[14] || undefined,
  toY: process.argv[15] || undefined
};
const targetBounds = parseBounds(targetBoundsText);
if (coordinateSource) actionDetails.coordinateSource = coordinateSource;
if (targetBounds) actionDetails.targetBounds = targetBounds;
if (coordinateEvidence) actionDetails.coordinateEvidence = coordinateEvidence;
let actionResult;
if (adapterStatus === 0) {
  actionResult = JSON.parse(adapterOutput);
  if (type !== "wait") actionResult.settleMs = settleMs;
} else {
  actionResult = {
    schemaVersion: 1,
    type: "actionResult",
    platform: null,
    time: localIso(),
    action: type,
    ok: false,
    error: adapterOutput,
    failureCode: adapterStatus === 64 ? "PLATFORM_UNIMPLEMENTED" : "TOOL_ERROR"
  };
}
if (actionDetails.x !== undefined) actionResult.x = Number.isFinite(Number(actionDetails.x)) ? Number(actionDetails.x) : actionDetails.x;
if (actionDetails.y !== undefined) actionResult.y = Number.isFinite(Number(actionDetails.y)) ? Number(actionDetails.y) : actionDetails.y;
if (target) actionResult.target = target;
if (coordinateSource) actionResult.coordinateSource = coordinateSource;
if (targetBounds) actionResult.targetBounds = targetBounds;
if (coordinateEvidence) actionResult.coordinateEvidence = coordinateEvidence;
const event = {
  time: localIso(),
  type: "flowAction",
  humanInstruction: instruction,
  action: { type, target: target || undefined, ...actionDetails },
  actionResult,
  successHint: successHint || undefined
};
fs.appendFileSync(path.join(recordingDir, "timeline.jsonl"), `${JSON.stringify(event)}\n`);
process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
process.exit(adapterStatus === 0 ? 0 : adapterStatus);
' "$recording_dir" "$adapter_status" "$adapter_output" "$type" "$instruction" "$target" "$success_hint" "$settle_ms" "$x" "$y" "$text" "$from_x" "$from_y" "$to_x" "$to_y" "$coordinate_source" "$target_bounds" "$coordinate_evidence"
