#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
flow_dir=""
recording_id=""
platform=""
has_platform=0
has_device=0
has_app=0
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --flow-dir) flow_dir="${2:-}"; shift 2 ;;
    --recording-id) recording_id="${2:-}"; shift 2 ;;
    --platform) platform="${2:-}"; has_platform=1; shift 2 ;;
    --device) has_device=1; args+=("$1" "$2"); shift 2 ;;
    --app|--bundle) has_app=1; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$flow_dir" || -z "$recording_id" ]]; then
  echo "缺少 --flow-dir 或 --recording-id" >&2
  exit 2
fi

recording_dir="$flow_dir/recordings/$recording_id"
mkdir -p "$recording_dir/screenshots" "$recording_dir/layouts" "$recording_dir/logs"

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
  app: process.argv[3] === "1"
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
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
' "$flow_dir" "$has_device" "$has_app")
if [[ ${#env_args[@]} -gt 0 ]]; then
  merged_args=("${env_args[@]}")
  if [[ ${#args[@]} -gt 0 ]]; then
    merged_args+=("${args[@]}")
  fi
  args=("${merged_args[@]}")
fi

adapter_output="$("$script_dir/../platform/observe.sh" --platform "$platform" --out "$recording_dir" "${args[@]}")"
node -e '
const fs = require("fs");
const path = require("path");
const recordingDir = process.argv[1];
const raw = process.argv[2];
const event = JSON.parse(raw);
const flowDir = path.dirname(path.dirname(recordingDir));
const statePath = path.join(flowDir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
event.scope = "flowRecording";
event.flowId = state.flowId;
event.recordingId = path.basename(recordingDir);
fs.appendFileSync(path.join(recordingDir, "timeline.jsonl"), `${JSON.stringify(event)}\n`);
process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
' "$recording_dir" "$adapter_output"
