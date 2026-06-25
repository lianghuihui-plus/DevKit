#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
case_dir=""
execution_id=""
label=""
has_label=0
out=""
args=()
has_platform=0
has_device=0
has_app=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case-dir) case_dir="${2:-}"; shift 2 ;;
    --execution-id) execution_id="${2:-}"; shift 2 ;;
    --platform) has_platform=1; args+=("$1" "$2"); shift 2 ;;
    --device) has_device=1; args+=("$1" "$2"); shift 2 ;;
    --app|--bundle) has_app=1; args+=("$1" "$2"); shift 2 ;;
    --label) label="${2:-}"; has_label=1; shift 2 ;;
    --out) out="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -n "$case_dir" ]]; then
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
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
' "$case_dir" "$has_platform" "$has_device" "$has_app")
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
  if [[ -z "$out" ]]; then
    out="$case_dir/executions/$execution_id"
    args+=("--out" "$out")
  fi
  "$script_dir/run-case.js" "$case_dir" --check-budget --event-type observation --execution-id "$execution_id" >/dev/null
  numbered_label="$(node -e '
const fs = require("fs");
const path = require("path");
const caseDir = process.argv[1];
const executionId = process.argv[2];
const raw = process.argv[3] || "observe";
const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80) || "observe";
const timeline = path.join(caseDir, "executions", executionId, "timeline.jsonl");
let count = 0;
if (fs.existsSync(timeline)) {
  count = fs.readFileSync(timeline, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((total, line) => {
      try {
        return JSON.parse(line).type === "observation" ? total + 1 : total;
      } catch {
        return total;
      }
    }, 0);
}
process.stdout.write(`${String(count + 1).padStart(3, "0")}-${safe}`);
' "$case_dir" "$execution_id" "$label")"
  args+=("--label" "$numbered_label")
  set +e
  adapter_output="$("$script_dir/platform/observe.sh" "${args[@]}" 2>&1)"
  adapter_status=$?
  set -e
  if [[ $adapter_status -eq 0 ]]; then
    observation="$adapter_output"
  else
    observation="$(node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const label = process.argv[1] || "observe";
const error = process.argv[2] || "platform observe failed";
const status = Number(process.argv[3] || 1);
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "observation",
  platform: null,
  time: localIso(),
  label,
  artifacts: {},
  capabilities: {
    screenshot: false,
    layout: false,
    foregroundApp: false,
    logs: false
  },
  raw: {
    error,
    failureCode: status === 64 ? "PLATFORM_UNIMPLEMENTED" : "TOOL_ERROR"
  }
}, null, 2));
' "$numbered_label" "$adapter_output" "$adapter_status")"
  fi
  "$script_dir/run-case.js" "$case_dir" --record-json "$observation" --execution-id "$execution_id" >/dev/null
  if [[ $adapter_status -eq 64 ]]; then
    "$script_dir/run-case.js" "$case_dir" --finalize --status BLOCKED --failure-code PLATFORM_UNIMPLEMENTED --reason "$adapter_output" --execution-id "$execution_id" >/dev/null
  fi
  printf '%s\n' "$observation"
  if [[ $adapter_status -ne 0 ]]; then
    exit "$adapter_status"
  fi
else
  if [[ $has_label -eq 1 ]]; then
    args+=("--label" "$label")
  fi
  exec "$script_dir/platform/observe.sh" "${args[@]}"
fi
