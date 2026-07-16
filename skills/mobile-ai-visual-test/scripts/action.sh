#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/lib/action-common.sh"
case_dir=""
execution_id=""
step_id=""
scope=""
precondition_id=""
flow_id=""
flow_step_id=""
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
duration_ms=""
wait_ms=""
reason=""
velocity=""
coordinate_source=""
target_bounds=""
coordinate_evidence=""
args=()
platform=""
has_platform=0
has_device=0
has_app=0
has_entry=0

mavt_add_precondition_flow_scope() {
  local value="$1"
  if [[ "$scope" != "precondition-flow" ]]; then
    printf '%s' "$value"
    return
  fi
  node -e '
const event = JSON.parse(process.argv[1]);
event.scope = "precondition-flow";
event.preconditionId = process.argv[2];
event.flowId = process.argv[3];
event.flowStepId = process.argv[4];
if (process.argv[5]) event.failureCode = process.argv[5];
console.log(JSON.stringify(event, null, 2));
' "$value" "$precondition_id" "$flow_id" "$flow_step_id" "${2:-}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case-dir) case_dir="${2:-}"; shift 2 ;;
    --execution-id) execution_id="${2:-}"; shift 2 ;;
    --step-id) step_id="${2:-}"; shift 2 ;;
    --scope) scope="${2:-}"; shift 2 ;;
    --precondition-id) precondition_id="${2:-}"; shift 2 ;;
    --flow-id) flow_id="${2:-}"; shift 2 ;;
    --flow-step-id) flow_step_id="${2:-}"; shift 2 ;;
    --platform) platform="${2:-}"; has_platform=1; args+=("$1" "$2"); shift 2 ;;
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
    --duration-ms) duration_ms="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --ms) wait_ms="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --reason) reason="${2:-}"; shift 2 ;;
    --velocity) velocity="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    --coordinate-source) coordinate_source="${2:-}"; shift 2 ;;
    --target-bounds) target_bounds="${2:-}"; shift 2 ;;
    --coordinate-evidence) coordinate_evidence="${2:-}"; shift 2 ;;
    --settle-ms) settle_ms="${2:-}"; shift 2 ;;
    *) echo "action.sh 未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$case_dir" ]]; then
  if [[ -z "$platform" ]]; then
    echo "Missing --platform. 正式执行必须写入 cases/<case>/platforms/<platform>/。" >&2
    exit 2
  fi
  if [[ -z "$action_type" ]]; then
    echo "缺少 --type" >&2
    exit 2
  fi
  if [[ "$action_type" == "restartApp" && -n "$step_id" ]]; then
    echo "STEP_ORDER_VIOLATION: restartApp 是 execution 级隔离动作，不能绑定步骤 stepId 或作为步骤证据。" >&2
    exit 2
  fi
  if [[ -n "$step_id" && "$scope" == "precondition-flow" ]]; then
    echo "PRECONDITION_FLOW_SCOPE_INVALID: precondition-flow action 不能绑定 --step-id。" >&2
    exit 2
  fi
  if [[ "$scope" == "precondition-flow" && ( -z "$precondition_id" || -z "$flow_id" || -z "$flow_step_id" ) ]]; then
    echo "PRECONDITION_FLOW_SCOPE_REQUIRED: precondition-flow action 必须传 --precondition-id、--flow-id 和 --flow-step-id。" >&2
    exit 2
  fi
  mavt_validate_coordinate_action case "$action_type" "$x" "$y" "$coordinate_source" "$coordinate_evidence" "$target_bounds"
  requested_action="$(mavt_action_request_json "$action_type" "$target" "$x" "$y" "$text" "$from_x" "$from_y" "$to_x" "$to_y" "$duration_ms" "$wait_ms" "$reason" "$velocity" "$coordinate_source" "$target_bounds" "$coordinate_evidence")"
  mavt_validate_action_request "$script_dir/lib/action-contract.js" "$requested_action"
  if [[ "$action_type" == "swipe" && -z "$velocity" ]]; then
    velocity="$(mavt_resolve_swipe_velocity "$script_dir/lib/action-contract.js" "$requested_action")"
    args+=(--velocity "$velocity")
  fi
  runtime_dir="$case_dir"
  if [[ -n "$platform" ]]; then
    runtime_dir="$case_dir/platforms/$platform"
  fi
  if [[ -z "$execution_id" ]]; then
    execution_id="$(mavt_latest_execution_id "$runtime_dir")"
  fi
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
  args=()
  if [[ ${#merged_args[@]} -gt 0 ]]; then
    args=("${merged_args[@]}")
  fi
  run_case_args=("$case_dir")
  if [[ -n "$platform" ]]; then
    run_case_args+=(--platform "$platform")
  fi
  precheck_args=("$case_dir")
  if [[ -n "$platform" ]]; then
    precheck_args+=(--platform "$platform")
  fi
  precheck_args+=(--check-budget --event-type actionResult --action "$action_type" --action-json "$requested_action" --execution-id "$execution_id")
  if [[ -n "$step_id" ]]; then
    precheck_args+=(--step-id "$step_id")
  elif [[ "$scope" == "precondition-flow" ]]; then
    precheck_args+=(--scope precondition-flow --precondition-id "$precondition_id" --flow-id "$flow_id" --flow-step-id "$flow_step_id")
  fi
  set +e
  precheck_output="$("$script_dir/run-case.js" "${precheck_args[@]}" 2>&1)"
  precheck_status=$?
  set -e
  if [[ $precheck_status -ne 0 ]]; then
    if [[ $precheck_status -eq 3 ]]; then
      printf '%s\n' "$precheck_output" >&2
      exit "$precheck_status"
    fi
    if [[ "$precheck_output" == *"STEP_ORDER_VIOLATION"* ]]; then
      printf '%s\n' "$precheck_output" >&2
      exit "$precheck_status"
    fi
    if [[ "$precheck_output" == *"PRECONDITION_FLOW_ACTION_MISMATCH"* && "$scope" == "precondition-flow" ]]; then
      result="$(mavt_action_failure_json "$action_type" "$precheck_output" "$precheck_status")"
      result="$(mavt_add_action_metadata "$result" "$x" "$y" "$target" "$coordinate_source" "$target_bounds" "$coordinate_evidence" "$duration_ms" "$settle_ms" "$action_type")"
      result="$(mavt_add_requested_action "$result" "$requested_action")"
      result="$(mavt_add_precondition_flow_scope "$result" "PRECONDITION_FLOW_ACTION_MISMATCH")"
      MAVT_ACTION_WRITER=1 "$script_dir/run-case.js" "${run_case_args[@]}" --record-action-json "$result" --execution-id "$execution_id" >/dev/null
      printf '%s\n' "$result"
      exit "$precheck_status"
    fi
    if [[ "$precheck_output" == *"PRECONDITION_"* ]]; then
      printf '%s\n' "$precheck_output" >&2
      exit "$precheck_status"
    fi
    failure_code="TOOL_ERROR"
    result="$(mavt_action_failure_json "$action_type" "$precheck_output" "$precheck_status")"
    result="$(node -e '
const event = JSON.parse(process.argv[1]);
event.failureCode = process.argv[2];
console.log(JSON.stringify(event, null, 2));
' "$result" "$failure_code")"
    result="$(mavt_add_action_metadata "$result" "$x" "$y" "$target" "$coordinate_source" "$target_bounds" "$coordinate_evidence" "$duration_ms" "$settle_ms" "$action_type")"
    result="$(mavt_add_requested_action "$result" "$requested_action")"
    if [[ -n "$step_id" ]]; then
      result="$(node -e '
const event = JSON.parse(process.argv[1]);
event.stepId = process.argv[2];
console.log(JSON.stringify(event, null, 2));
' "$result" "$step_id")"
    fi
    result="$(mavt_add_precondition_flow_scope "$result")"
    MAVT_ACTION_WRITER=1 "$script_dir/run-case.js" "${run_case_args[@]}" --record-action-json "$result" --execution-id "$execution_id" >/dev/null
    finalize_args=("${run_case_args[@]}" --finalize --status BLOCKED --failure-code "$failure_code" --reason "$precheck_output" --execution-id "$execution_id")
    if [[ -n "$step_id" ]]; then
      finalize_args+=(--failed-step "$step_id")
    fi
    "$script_dir/run-case.js" "${finalize_args[@]}" >/dev/null
	    printf '%s\n' "$result"
	    exit "$precheck_status"
	  fi
	  printf '%s' "$precheck_output" | mavt_emit_pace_hint
	  set +e
  adapter_output="$("$script_dir/platform/action.sh" "${args[@]}" 2>&1)"
  adapter_status=$?
  set -e
  if [[ $adapter_status -eq 0 ]]; then
    if [[ "$action_type" != "wait" ]]; then
      mavt_sleep_ms "$settle_ms"
    fi
    result="$adapter_output"
  else
    result="$(mavt_action_failure_json "$action_type" "$adapter_output" "$adapter_status")"
  fi
  result="$(mavt_add_action_metadata "$result" "$x" "$y" "$target" "$coordinate_source" "$target_bounds" "$coordinate_evidence" "$duration_ms" "$settle_ms" "$action_type")"
  result="$(mavt_add_requested_action "$result" "$requested_action")"
  if [[ -n "$step_id" ]]; then
    result="$(node -e '
const event = JSON.parse(process.argv[1]);
event.stepId = process.argv[2];
console.log(JSON.stringify(event, null, 2));
' "$result" "$step_id")"
  fi
  if [[ $adapter_status -ne 0 && "$scope" == "precondition-flow" ]]; then
    result="$(mavt_add_precondition_flow_scope "$result" "PRECONDITION_FLOW_ACTION_FAILED")"
  else
    result="$(mavt_add_precondition_flow_scope "$result")"
  fi
  MAVT_ACTION_WRITER=1 "$script_dir/run-case.js" "${run_case_args[@]}" --record-action-json "$result" --execution-id "$execution_id" >/dev/null
  if [[ $adapter_status -ne 0 ]]; then
    if [[ "$scope" == "precondition-flow" ]]; then
      printf '%s\n' "$result"
      exit "$adapter_status"
    fi
    failure_code="TOOL_ERROR"
    if [[ $adapter_status -eq 64 ]]; then
      failure_code="PLATFORM_UNIMPLEMENTED"
    fi
    if [[ "$action_type" == "restartApp" && "${MAVT_RESTART_FAILURE_NON_TERMINAL:-}" == "1" ]]; then
      printf '%s\n' "$result"
      exit 0
    fi
    finalize_args=("${run_case_args[@]}" --finalize --status BLOCKED --failure-code "$failure_code" --reason "$adapter_output" --execution-id "$execution_id")
    if [[ -n "$step_id" ]]; then
      finalize_args+=(--failed-step "$step_id")
    fi
    "$script_dir/run-case.js" "${finalize_args[@]}" >/dev/null
  fi
  printf '%s\n' "$result"
  if [[ $adapter_status -ne 0 ]]; then
    exit "$adapter_status"
  fi
else
  exec "$script_dir/platform/action.sh" "${args[@]}"
fi
