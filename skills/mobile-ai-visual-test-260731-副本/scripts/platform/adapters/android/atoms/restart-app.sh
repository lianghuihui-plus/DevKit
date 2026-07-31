#!/usr/bin/env bash
set -euo pipefail

device=""
app=""
entry=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app|--bundle) app="${2:-}"; shift 2 ;;
    --entry|--ability) entry="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$app" ]] || { echo "restart-app 需要 --app 或 --bundle" >&2; exit 2; }

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

component_name() {
  node -e '
const pkg = process.argv[1] || "";
const entry = process.argv[2] || "";
if (!pkg || !entry) process.exit(1);
if (entry.includes("/")) process.stdout.write(entry);
else if (entry.startsWith(".")) process.stdout.write(`${pkg}/${entry}`);
else if (entry.includes(".")) process.stdout.write(`${pkg}/${entry}`);
else process.stdout.write(`${pkg}/.${entry}`);
' "$1" "$2"
}

command_failed() {
  grep -Eiq 'Error|Exception|Failure|failed|not found|Unknown package|SecurityException|Permission Denial'
}

pidof_app() {
  local output
  local status
  set +e
  output="$("${adb_prefix[@]}" shell pidof "$app" 2>/dev/null)"
  status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    printf '%s' "$output" | tr -d '\r' | awk 'NF { print $1; exit }'
  fi
}

old_pid="$(pidof_app || true)"

stop_output="$("${adb_prefix[@]}" shell am force-stop "$app" 2>&1)" || { printf '%s\n' "$stop_output" >&2; exit 1; }
if printf '%s\n' "$stop_output" | command_failed; then
  printf '%s\n' "$stop_output" >&2
  exit 1
fi

stopped=0
for _ in 1 2 3 4 5; do
  current_pid="$(pidof_app || true)"
  if [[ -z "$current_pid" ]]; then
    stopped=1
    break
  fi
  sleep 0.2
done
if [[ $stopped -ne 1 ]]; then
  echo "force-stop did not stop target process: $app pid=${current_pid:-unknown}" >&2
  exit 1
fi

launch_method="cold-start-monkey"
fallback_reason=""
if [[ -n "$entry" ]]; then
  component="$(component_name "$app" "$entry")"
  set +e
  start_output="$("${adb_prefix[@]}" shell am start -n "$component" 2>&1)"
  start_status=$?
  set -e
  if [[ $start_status -eq 0 ]] && ! printf '%s\n' "$start_output" | command_failed; then
    launch_method="cold-start-am-start"
  else
    fallback_reason="$start_output"
    "${adb_prefix[@]}" shell monkey -p "$app" 1 >/dev/null 2>&1
    launch_method="cold-start-monkey-fallback"
  fi
else
  "${adb_prefix[@]}" shell monkey -p "$app" 1 >/dev/null 2>&1
fi

new_pid=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  new_pid="$(pidof_app || true)"
  if [[ -n "$new_pid" ]]; then
    break
  fi
  sleep 0.3
done
if [[ -z "$new_pid" ]]; then
  echo "start did not create target process: $app" >&2
  exit 1
fi
if [[ -n "$old_pid" && "$new_pid" == "$old_pid" ]]; then
  echo "restart did not create a new process: $app pid=$new_pid" >&2
  exit 1
fi

node -e '
const method = process.argv[1] || "cold-start-monkey";
const fallbackReason = process.argv[2] || "";
const oldPid = process.argv[3] || null;
const newPid = process.argv[4] || null;
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const event = {schemaVersion:1,type:"actionResult",platform:"android",time:localIso(),action:"restartApp",ok:true,restart:true,coldStartVerified:true,oldPid,newPid,stopMethod:"am-force-stop",launchMethod:method};
if (fallbackReason) event.fallbackReason = fallbackReason;
console.log(JSON.stringify(event, null, 2));
' "$launch_method" "$fallback_reason" "$old_pid" "$new_pid"
