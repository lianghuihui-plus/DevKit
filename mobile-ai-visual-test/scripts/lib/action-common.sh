#!/usr/bin/env bash

mavt_validate_coordinate_metadata() {
  local coordinate_source="${1:-}"
  local target_bounds="${2:-}"
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

mavt_validate_coordinate_action() {
  local mode="${1:-case}"
  local action="${2:-}"
  local x="${3:-}"
  local y="${4:-}"
  local coordinate_source="${5:-}"
  local coordinate_evidence="${6:-}"
  local target_bounds="${7:-}"

  mavt_validate_coordinate_metadata "$coordinate_source" "$target_bounds"
  if [[ "$mode" == "case" && "$coordinate_source" == "manual" ]]; then
    echo "正式用例执行不允许使用 --coordinate-source manual；请改用 layout、visual、pixel 或 flow，并记录可复核证据。" >&2
    exit 2
  fi

  case "$action" in
    tap|toggle|longPress|inputText)
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

  if [[ "$coordinate_source" == "visual" || "$coordinate_source" == "pixel" || "$coordinate_source" == "flow" ]]; then
    if [[ -z "$target_bounds" ]]; then
      echo "${coordinate_source} 坐标动作必须提供 --target-bounds" >&2
      exit 2
    fi
  fi
}

mavt_latest_execution_id() {
  node -e '
const fs = require("fs");
const path = require("path");
const root = path.join(process.argv[1], "executions");
if (!fs.existsSync(root)) process.exit(1);
const names = fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory()).sort();
if (!names.length) process.exit(1);
process.stdout.write(names[names.length - 1]);
' "$1"
}

mavt_case_env_args() {
  node -e '
const fs = require("fs");
const path = require("path");
const caseDir = process.argv[1];
const platform = process.argv[6] || "";
const has = {
  platform: process.argv[2] === "1",
  device: process.argv[3] === "1",
  app: process.argv[4] === "1",
  entry: process.argv[5] === "1",
};
const statePath = path.join(platform ? path.join(caseDir, "platforms", platform) : caseDir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const env = state.environment || {};
const out = [];
function add(flag, value) {
  if (value !== undefined && value !== null && String(value) !== "") out.push(flag, String(value));
}
if (!has.platform) add("--platform", env.platform || platform);
if (!has.device) add("--device", env.device);
if (!has.app) add("--app", env.appId || env.bundleName);
if (!has.entry) add("--entry", env.entry || env.abilityName);
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
' "$@"
}

mavt_flow_platform() {
  node -e '
const fs = require("fs");
const path = require("path");
const statePath = path.join(process.argv[1], "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
process.stdout.write(state.environment?.platform || "");
' "$1"
}

mavt_flow_env_args() {
  node -e '
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
' "$@"
}

mavt_sleep_ms() {
  sleep "$(node -e '
const value = Number(process.argv[1] || 0);
if (!Number.isFinite(value) || value < 0) process.exit(2);
console.log((value / 1000).toFixed(3));
' "$1")"
}

mavt_action_failure_json() {
  node -e '
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
' "$@"
}

mavt_observation_failure_json() {
  node -e '
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
' "$@"
}

mavt_add_action_metadata() {
  node -e '
const event = JSON.parse(process.argv[1]);
const meta = {
  x: process.argv[2],
  y: process.argv[3],
  target: process.argv[4],
  coordinateSource: process.argv[5],
  targetBounds: process.argv[6],
  coordinateEvidence: process.argv[7],
  durationMs: process.argv[8],
  settleMs: process.argv[9],
  action: process.argv[10] || ""
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
if (meta.action && meta.action !== "wait" && event.ok !== false) event.settleMs = Number(meta.settleMs || 0);
const x = numberOrString(meta.x);
const y = numberOrString(meta.y);
if (x !== undefined) event.x = x;
if (y !== undefined) event.y = y;
if (meta.target) event.target = meta.target;
if (meta.coordinateSource) event.coordinateSource = meta.coordinateSource;
const bounds = parseBounds(meta.targetBounds);
if (bounds) event.targetBounds = bounds;
if (meta.coordinateEvidence) event.coordinateEvidence = meta.coordinateEvidence;
const durationMs = numberOrString(meta.durationMs);
if (durationMs !== undefined) event.durationMs = durationMs;
console.log(JSON.stringify(event, null, 2));
' "$@"
}

mavt_numbered_observe_label() {
  node -e '
const fs = require("fs");
const path = require("path");
const caseDir = process.argv[1];
const executionId = process.argv[2];
const raw = process.argv[3] || "observe";
const platform = process.argv[4] || "";
const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80) || "observe";
const timeline = path.join(platform ? path.join(caseDir, "platforms", platform) : caseDir, "executions", executionId, "timeline.jsonl");
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
' "$@"
}
