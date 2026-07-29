#!/usr/bin/env bash

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
if (String(env.platform || platform).toLowerCase() === "ios") {
  add("--device-type", env.deviceType);
  add("--appium-server", env.appiumServer);
  add("--wda-local-port", env.wdaLocalPort);
  add("--web-driver-agent-url", env.webDriverAgentUrl);
  add("--xcode-org-id", env.xcodeOrgId);
  add("--xcode-signing-id", env.xcodeSigningId);
  add("--updated-wda-bundle-id", env.updatedWDABundleId);
  add("--show-xcode-log", env.showXcodeLog);
  add("--show-ios-log", env.showIOSLog);
  add("--use-new-wda", env.useNewWDA);
  add("--allow-provisioning-device-registration", env.allowProvisioningDeviceRegistration);
  add("--wda-launch-timeout", env.wdaLaunchTimeout);
  add("--derived-data-path", env.derivedDataPath);
}
process.stdout.write(out.length ? `${out.join("\n")}\n` : "");
' "$@"
}

mavt_validate_case_env_binding() {
  node -e '
const fs = require("fs");
const path = require("path");
const caseDir = path.resolve(process.argv[1]);
const platform = String(process.argv[2] || "").trim().toLowerCase();
const explicit = { device: process.argv[3] || "", app: process.argv[4] || "", entry: process.argv[5] || "" };
const statePath = path.join(caseDir, "platforms", platform, "state.json");
if (!fs.existsSync(statePath)) {
  console.error(`ENV_UNCONFIRMED: 缺少平台环境状态: ${statePath}`);
  process.exit(2);
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const env = state.environment || {};
const savedPlatform = String(env.platform || "").trim().toLowerCase();
if (savedPlatform && savedPlatform !== platform) {
  console.error(`ENVIRONMENT_BINDING_MISMATCH: 已确认平台 ${savedPlatform} 与正式执行平台 ${platform} 不一致。`);
  process.exit(2);
}
const saved = { device: String(env.device || ""), app: String(env.appId || env.bundleName || ""), entry: String(env.entry || env.abilityName || "") };
for (const key of Object.keys(explicit)) {
  if (explicit[key] && explicit[key] !== saved[key]) {
    console.error(`ENVIRONMENT_BINDING_MISMATCH: 显式 ${key}=${explicit[key]} 与已确认环境 ${saved[key] || "<empty>"} 不一致。`);
    process.exit(2);
  }
}
' "$1" "$2" "${3:-}" "${4:-}" "${5:-}"
}

mavt_execution_env_args() {
  local script_dir="$1"
  local case_dir="$2"
  local platform="$3"
  local execution_id="$4"
  local purpose="${5:-runtime}"
  node "$script_dir/execution/resolve-execution-environment.js" args \
    --case-dir "$case_dir" --platform "$platform" --execution-id "$execution_id" --purpose "$purpose"
}

mavt_validate_execution_env_binding() {
  local script_dir="$1"
  local case_dir="$2"
  local platform="$3"
  local execution_id="$4"
  local device="${5:-}"
  local app="${6:-}"
  local entry="${7:-}"
  local args=(validate --case-dir "$case_dir" --platform "$platform" --execution-id "$execution_id")
  [[ -n "$device" ]] && args+=(--device "$device")
  [[ -n "$app" ]] && args+=(--app "$app")
  [[ -n "$entry" ]] && args+=(--entry "$entry")
  node "$script_dir/execution/resolve-execution-environment.js" "${args[@]}" >/dev/null
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

mavt_emit_pace_hint() {
  node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");
    const hint = data.paceHint;
    if (!hint || !hint.message) return;
    const prefix = hint.level === "WARN" ? "PACE_HINT" : "PACE_INFO";
    process.stderr.write(`${prefix}: ${hint.message}\n`);
  } catch {
    // Best effort only; pace hints must never affect execution.
  }
});
'
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
  ok: false,
  failureCode: status === 64 ? "PLATFORM_UNIMPLEMENTED" : "TOOL_ERROR",
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

mavt_action_request_json() {
  node -e '
const values = process.argv.slice(1);
const [type, target, x, y, text, fromX, fromY, toX, toY, durationMs, ms, reason, velocity, coordinateSource, targetBounds, coordinateEvidence, mode] = values;
const request = { type };
function addString(key, value) { if (value !== "") request[key] = value; }
function addNumber(key, value) {
  if (value === "") return;
  const number = Number(value);
  request[key] = Number.isFinite(number) ? number : value;
}
addString("target", target);
addNumber("x", x);
addNumber("y", y);
addString("text", text);
addString("mode", mode);
addNumber("fromX", fromX);
addNumber("fromY", fromY);
addNumber("toX", toX);
addNumber("toY", toY);
addNumber("durationMs", durationMs);
addNumber("ms", ms);
addString("reason", reason);
addNumber("velocity", velocity);
addString("coordinateSource", coordinateSource);
if (targetBounds) {
  const bounds = targetBounds.split(",").map((item) => Number(item.trim()));
  if (bounds.length !== 4 || bounds.some((item) => !Number.isFinite(item))) throw new Error(`Invalid --target-bounds: ${targetBounds}`);
  request.targetBounds = bounds;
}
addString("coordinateEvidence", coordinateEvidence);
process.stdout.write(JSON.stringify(request));
' "$@"
}

mavt_validate_action_request() {
  node -e '
const { validateAction, validateActionExecution } = require(process.argv[1]);
try {
  const action = JSON.parse(process.argv[2]);
  const context = process.argv[3] || "action.sh";
  const platform = process.argv[4] || "";
  const scope = process.argv[5] || "formal-execution";
  if (platform) validateActionExecution(action, { context, platform, scope });
  else validateAction(action, { context });
} catch (error) {
  console.error(error.message || String(error));
  process.exit(error.exitCode || 2);
}
' "$1" "$2" "${3:-action.sh}" "${4:-}" "${5:-formal-execution}"
}

mavt_resolve_swipe_velocity() {
  node -e '
const { resolveSwipeVelocity } = require(process.argv[1]);
process.stdout.write(String(resolveSwipeVelocity(JSON.parse(process.argv[2]))));
' "$1" "$2"
}

mavt_add_requested_action() {
  node -e '
const event = JSON.parse(process.argv[1]);
event.requestedAction = JSON.parse(process.argv[2]);
console.log(JSON.stringify(event, null, 2));
' "$1" "$2"
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
event.source = "action.sh";
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
