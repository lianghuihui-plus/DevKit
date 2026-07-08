#!/usr/bin/env bash
set -euo pipefail

device=""
bundle=""
ability=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app|--bundle) bundle="${2:-}"; shift 2 ;;
    --entry|--ability) ability="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$bundle" && -n "$ability" ]] || { echo "restart-app 需要 --bundle/--app 和 --ability/--entry" >&2; exit 2; }

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

command_failed() {
  grep -Eiq 'failed|Error Code|not installed|Missing parameter|Invalid parameters|Please confirm|unrecognized option|Illegal argument|USAGE'
}

pidof_bundle() {
  local output
  local status
  set +e
  output="$("${hdc_prefix[@]}" shell pidof "$bundle" 2>/dev/null)"
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    printf '%s' "$output" | tr -d '\r' | awk 'NF { print $1; exit }'
  fi
}

old_pid="$(pidof_bundle || true)"

stop_output="$("${hdc_prefix[@]}" shell aa force-stop "$bundle" 2>&1)" || { printf '%s\n' "$stop_output" >&2; exit 1; }
if printf '%s\n' "$stop_output" | command_failed; then
  printf '%s\n' "$stop_output" >&2
  exit 1
fi

stopped=0
for _ in 1 2 3 4 5; do
  current_pid="$(pidof_bundle || true)"
  if [[ -z "$current_pid" ]]; then
    stopped=1
    break
  fi
  sleep 0.2
done
if [[ $stopped -ne 1 ]]; then
  echo "force-stop did not stop target process: $bundle pid=${current_pid:-unknown}" >&2
  exit 1
fi

start_output="$("${hdc_prefix[@]}" shell aa start -b "$bundle" -a "$ability" 2>&1)" || { printf '%s\n' "$start_output" >&2; exit 1; }
if printf '%s\n' "$start_output" | command_failed; then
  printf '%s\n' "$start_output" >&2
  exit 1
fi

new_pid=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  new_pid="$(pidof_bundle || true)"
  if [[ -n "$new_pid" ]]; then
    break
  fi
  sleep 0.3
done
if [[ -z "$new_pid" ]]; then
  echo "start did not create target process: $bundle" >&2
  exit 1
fi
if [[ -n "$old_pid" && "$new_pid" == "$old_pid" ]]; then
  echo "restart did not create a new process: $bundle pid=$new_pid" >&2
  exit 1
fi

node -e '
const oldPid = process.argv[1] || null;
const newPid = process.argv[2] || null;
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"harmony",time:localIso(),action:"restartApp",ok:true,restart:true,coldStartVerified:true,oldPid,newPid,stopMethod:"aa-force-stop",launchMethod:"cold-start-aa-start"}, null, 2));
' "$old_pid" "$new_pid"
