#!/usr/bin/env bash

mavt_sleep_ms() {
  sleep "$(node -e '
const value = Number(process.argv[1] || 0);
if (!Number.isFinite(value) || value < 0) process.exit(2);
console.log((value / 1000).toFixed(3));
' "$1")"
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
