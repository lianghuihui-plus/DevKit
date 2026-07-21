#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
case_dir=""
platform=""
execution_id=""
step_id=""
scope=""
precondition_id=""
flow_id=""
flow_step_id=""
observe_label=""
action_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case-dir) case_dir="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --platform) platform="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --execution-id) execution_id="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --step-id) step_id="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --scope) scope="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --precondition-id) precondition_id="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --flow-id) flow_id="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --flow-step-id) flow_step_id="${2:-}"; action_args+=("$1" "$2"); shift 2 ;;
    --observe-label) observe_label="${2:-}"; shift 2 ;;
    --type|--target|--x|--y|--text|--from-x|--from-y|--to-x|--to-y|--duration-ms|--ms|--reason|--velocity|--coordinate-source|--target-bounds|--coordinate-evidence|--settle-ms|--device|--app|--bundle|--entry|--ability)
      action_args+=("$1" "${2:-}"); shift 2 ;;
    *) echo "action-observe.sh 未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$case_dir" || -z "$platform" || -z "$execution_id" ]]; then
  echo "action-observe.sh 必须传 --case-dir、--platform 和 --execution-id。" >&2
  exit 2
fi
if [[ -z "$step_id" && "$scope" != "precondition-flow" ]]; then
  echo "action-observe.sh 仅支持业务 step 或 precondition-flow。" >&2
  exit 2
fi

action_stderr_file="$(mktemp "${TMPDIR:-/tmp}/mavt-action-observe.XXXXXX")"
cleanup() {
  rm -f "$action_stderr_file"
}
trap cleanup EXIT

set +e
action_output="$("$script_dir/action.sh" "${action_args[@]}" 2>"$action_stderr_file")"
action_status=$?
set -e
action_stderr="$(<"$action_stderr_file")"
if [[ -n "$action_stderr" ]]; then
  printf '%s\n' "$action_stderr" >&2
fi
if [[ $action_status -ne 0 ]]; then
  if [[ -n "$action_output" ]]; then
    printf '%s\n' "$action_output"
  fi
  exit "$action_status"
fi

observe_args=(--case-dir "$case_dir" --platform "$platform" --execution-id "$execution_id")
if [[ -n "$step_id" ]]; then
  observe_args+=(--step-id "$step_id")
else
  observe_args+=(--scope precondition-flow --precondition-id "$precondition_id" --flow-id "$flow_id" --flow-step-id "$flow_step_id" --phase after)
fi
if [[ -n "$observe_label" ]]; then
  observe_args+=(--label "$observe_label")
fi
observation_output="$("$script_dir/observe.sh" "${observe_args[@]}")"

node -e '
const actionResult = JSON.parse(process.argv[1]);
const observation = JSON.parse(process.argv[2]);
console.log(JSON.stringify({ schemaVersion: 1, actionResult, observation }, null, 2));
' "$action_output" "$observation_output"
