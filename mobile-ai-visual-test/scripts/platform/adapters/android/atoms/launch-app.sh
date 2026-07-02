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

[[ -n "$app" ]] || { echo "launch-app 需要 --app 或 --bundle" >&2; exit 2; }

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

launch_method="monkey"
fallback_reason=""
if [[ -n "$entry" ]]; then
  component="$(component_name "$app" "$entry")"
  set +e
  start_output="$("${adb_prefix[@]}" shell am start -n "$component" 2>&1)"
  start_status=$?
  set -e
  if [[ $start_status -eq 0 ]]; then
    launch_method="am-start"
  else
    fallback_reason="$start_output"
    "${adb_prefix[@]}" shell monkey -p "$app" 1 >/dev/null 2>&1
    launch_method="monkey-fallback"
  fi
else
  "${adb_prefix[@]}" shell monkey -p "$app" 1 >/dev/null 2>&1
fi

node -e '
const method = process.argv[1] || "monkey";
const fallbackReason = process.argv[2] || "";
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const event = {schemaVersion:1,type:"actionResult",platform:"android",time:localIso(),action:"launchApp",ok:true,launchMethod:method};
if (fallbackReason) event.fallbackReason = fallbackReason;
console.log(JSON.stringify(event, null, 2));
' "$launch_method" "$fallback_reason"
