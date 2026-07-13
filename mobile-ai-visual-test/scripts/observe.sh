#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/lib/action-common.sh"
case_dir=""
execution_id=""
label=""
has_label=0
step_id=""
scope=""
precondition_id=""
flow_id=""
flow_step_id=""
phase=""
out=""
args=()
platform=""
has_platform=0
has_device=0
has_app=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --case-dir) case_dir="${2:-}"; shift 2 ;;
    --execution-id) execution_id="${2:-}"; shift 2 ;;
    --step-id) step_id="${2:-}"; shift 2 ;;
    --scope) scope="${2:-}"; shift 2 ;;
    --precondition-id) precondition_id="${2:-}"; shift 2 ;;
    --flow-id) flow_id="${2:-}"; shift 2 ;;
    --flow-step-id) flow_step_id="${2:-}"; shift 2 ;;
    --phase) phase="${2:-}"; shift 2 ;;
    --global-observation) scope="global"; shift ;;
    --platform) platform="${2:-}"; has_platform=1; args+=("$1" "$2"); shift 2 ;;
    --device) has_device=1; args+=("$1" "$2"); shift 2 ;;
    --app|--bundle) has_app=1; args+=("$1" "$2"); shift 2 ;;
    --label) label="${2:-}"; has_label=1; shift 2 ;;
    --out) out="${2:-}"; args+=("$1" "$2"); shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -n "$case_dir" ]]; then
  if [[ -z "$platform" ]]; then
    echo "Missing --platform. 正式执行必须写入 cases/<case>/platforms/<platform>/。" >&2
    exit 2
  fi
  runtime_dir="$case_dir"
  if [[ -n "$platform" ]]; then
    runtime_dir="$case_dir/platforms/$platform"
  fi
  if [[ -z "$execution_id" ]]; then
    execution_id="$(mavt_latest_execution_id "$runtime_dir")"
  fi
  if [[ -n "$step_id" && "$scope" == "precondition-flow" ]]; then
    echo "PRECONDITION_FLOW_SCOPE_INVALID: precondition-flow observation 不能绑定 --step-id。" >&2
    exit 2
  fi
  if [[ "$scope" == "precondition-flow" && ( -z "$precondition_id" || -z "$flow_id" || -z "$phase" ) ]]; then
    echo "PRECONDITION_FLOW_SCOPE_REQUIRED: precondition-flow observation 必须传 --precondition-id、--flow-id 和 --phase。" >&2
    exit 2
  fi
  if [[ -z "$step_id" && "$scope" != "global" && "$scope" != "precondition-flow" ]]; then
    echo "OBSERVATION_SCOPE_REQUIRED: case-bound observe 必须传 --step-id；全局诊断观察传 --scope global；前置 Flow 观察传 --scope precondition-flow。" >&2
    exit 2
  fi
  env_args=()
  while IFS= read -r item; do
    [[ -n "$item" ]] && env_args+=("$item")
  done < <(mavt_case_env_args "$case_dir" "$has_platform" "$has_device" "$has_app" "1" "$platform")
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
    out="$runtime_dir/executions/$execution_id"
    args+=("--out" "$out")
  fi
  run_case_args=("$case_dir")
  if [[ -n "$platform" ]]; then
    run_case_args+=(--platform "$platform")
  fi
  precheck_args=("${run_case_args[@]}" --check-budget --event-type observation --execution-id "$execution_id")
  if [[ -n "$step_id" ]]; then
    precheck_args+=(--step-id "$step_id")
  elif [[ "$scope" == "global" ]]; then
    precheck_args+=(--scope global)
  elif [[ "$scope" == "precondition-flow" ]]; then
    precheck_args+=(--scope precondition-flow --precondition-id "$precondition_id" --flow-id "$flow_id" --phase "$phase")
    if [[ -n "$flow_step_id" ]]; then
      precheck_args+=(--flow-step-id "$flow_step_id")
    fi
  fi
	  set +e
	  precheck_output="$("$script_dir/run-case.js" "${precheck_args[@]}" 2>&1)"
	  precheck_status=$?
	  set -e
	  if [[ $precheck_status -ne 0 ]]; then
	    printf '%s\n' "$precheck_output" >&2
	    exit "$precheck_status"
	  fi
	  printf '%s' "$precheck_output" | mavt_emit_pace_hint
  if [[ "$scope" == "precondition-flow" && $has_label -eq 0 ]]; then
    label="${precondition_id}-${flow_step_id:-flow}-${phase}"
  fi
  numbered_label="$(mavt_numbered_observe_label "$case_dir" "$execution_id" "$label" "$platform")"
  args+=("--label" "$numbered_label")
  set +e
  adapter_output="$("$script_dir/platform/observe.sh" "${args[@]}" 2>&1)"
  adapter_status=$?
  set -e
  if [[ $adapter_status -eq 0 ]]; then
    observation="$adapter_output"
  else
    observation="$(mavt_observation_failure_json "$numbered_label" "$adapter_output" "$adapter_status")"
  fi
  if [[ -n "$step_id" ]]; then
    observation="$(printf '%s' "$observation" | node -e '
const stepId = process.argv[1] || "";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const event = JSON.parse(input);
  event.source = "observe.sh";
  event.stepId = stepId;
  if (event.observation && typeof event.observation === "object" && !event.observation.stepId) {
    event.observation.stepId = stepId;
  }
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
});
' "$step_id")"
  elif [[ "$scope" == "global" ]]; then
    observation="$(printf '%s' "$observation" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const event = JSON.parse(input);
  event.source = "observe.sh";
  event.scope = "global";
  if (event.observation && typeof event.observation === "object" && !event.observation.scope) {
    event.observation.scope = "global";
  }
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
});
')"
  elif [[ "$scope" == "precondition-flow" ]]; then
    observation="$(printf '%s' "$observation" | node -e '
const [preconditionId, flowId, flowStepId, phase] = process.argv.slice(1);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const event = JSON.parse(input);
  event.source = "observe.sh";
  event.scope = "precondition-flow";
  event.preconditionId = preconditionId;
  event.flowId = flowId;
  if (flowStepId) event.flowStepId = flowStepId;
  event.phase = phase;
  const artifacts = event.observation?.artifacts || event.artifacts || {};
  const app = event.observation?.app || event.app || {};
  const usable = Boolean(artifacts.screenshot || artifacts.layout || typeof app.inTargetApp === "boolean" || app.foregroundApp || app.activity);
  if (event.ok === undefined) event.ok = usable;
  if (event.ok === false || !usable) event.failureCode = "PRECONDITION_FLOW_OBSERVATION_FAILED";
  if (event.observation && typeof event.observation === "object") {
    event.observation.scope = "precondition-flow";
    event.observation.preconditionId = preconditionId;
    event.observation.flowId = flowId;
    if (flowStepId) event.observation.flowStepId = flowStepId;
    event.observation.phase = phase;
  }
  process.stdout.write(`${JSON.stringify(event, null, 2)}\n`);
});
' "$precondition_id" "$flow_id" "$flow_step_id" "$phase")"
  fi
	if [[ "$scope" == "precondition-flow" && $adapter_status -eq 0 ]]; then
	  flow_observation_ok="$(printf '%s' "$observation" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => process.stdout.write(JSON.parse(input).ok === false ? "false" : "true"));
')"
	  if [[ "$flow_observation_ok" == "false" ]]; then
	    adapter_status=1
	  fi
	fi
	  MAVT_OBSERVATION_WRITER=1 "$script_dir/run-case.js" "${run_case_args[@]}" --record-observation-json "$observation" --execution-id "$execution_id" >/dev/null
  if [[ $adapter_status -ne 0 ]]; then
    if [[ "$scope" == "precondition-flow" ]]; then
      printf '%s\n' "$observation"
      exit "$adapter_status"
    fi
    failure_code="TOOL_ERROR"
    if [[ $adapter_status -eq 64 ]]; then
      failure_code="PLATFORM_UNIMPLEMENTED"
    fi
    finalize_args=("${run_case_args[@]}" --finalize --status BLOCKED --failure-code "$failure_code" --reason "$adapter_output" --execution-id "$execution_id")
    if [[ -n "$step_id" ]]; then
      finalize_args+=(--failed-step "$step_id")
    fi
    "$script_dir/run-case.js" "${finalize_args[@]}" >/dev/null
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
