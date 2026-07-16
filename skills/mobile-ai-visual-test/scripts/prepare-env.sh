#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/lib/action-common.sh"

case_dir=""
platform=""
has_platform=0
has_device=0
has_app=0
has_entry=0
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case-dir) case_dir="${2:-}"; shift 2 ;;
    --platform) platform="${2:-}"; has_platform=1; args+=("$1" "$2"); shift 2 ;;
    --device) has_device=1; args+=("$1" "$2"); shift 2 ;;
    --app|--bundle) has_app=1; args+=("$1" "$2"); shift 2 ;;
    --entry|--ability) has_entry=1; args+=("$1" "$2"); shift 2 ;;
    *) echo "prepare-env 未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$platform" ]]; then
  echo "prepare-env 需要显式传 --platform <harmony|android|ios>" >&2
  exit 2
fi

if [[ -n "$case_dir" ]]; then
  env_args=()
  while IFS= read -r item; do
    [[ -n "$item" ]] && env_args+=("$item")
  done < <(mavt_case_env_args "$case_dir" "$has_platform" "$has_device" "$has_app" "$has_entry" "$platform")
  merged_args=()
  if [[ ${#env_args[@]} -gt 0 ]]; then
    merged_args+=("${env_args[@]}")
  fi
  if [[ ${#args[@]} -gt 0 ]]; then
    merged_args+=("${args[@]}")
  fi
  args=("${merged_args[@]}")
fi

prepare_output="$("$script_dir/platform/prepare-env.sh" "${args[@]}")"

if [[ -n "$case_dir" ]]; then
  node -e '
const fs = require("fs");
const path = require("path");
const caseDir = path.resolve(process.argv[1]);
const platform = process.argv[2];
const prepare = JSON.parse(process.argv[3]);
const runtimeDir = path.join(caseDir, "platforms", platform);
const statePath = path.join(runtimeDir, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { schemaVersion: 1 };
const dependencyMap = state.dependencies && typeof state.dependencies === "object" && !Array.isArray(state.dependencies)
  ? state.dependencies
  : {};
for (const dependency of prepare.dependencies || []) {
  if (dependency && dependency.id) dependencyMap[dependency.id] = dependency;
}
state.dependencies = dependencyMap;
state.environmentPreparedAt = prepare.time || new Date().toISOString();
state.environmentPreparation = prepare;
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const scriptDir = process.argv[4];
const {
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
} = require(path.join(scriptDir, "common.js"));
const caseJson = readJson(path.join(caseDir, "case.json"), null);
if (caseJson) {
  const notes = readJsonl(path.join(caseDir, "notes.jsonl"));
  writeCaseReports(caseDir, caseJson, state, notes, null, { platform });
  refreshIndexForCase(caseDir);
}
' "$case_dir" "$platform" "$prepare_output" "$script_dir"
fi

printf '%s\n' "$prepare_output"
