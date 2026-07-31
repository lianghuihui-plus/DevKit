#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
device=""
bundle=""
x=""
y=""
text=""
mode="replace"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; shift 2 ;;
    --y) y="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$text" ]] || { echo "input-text 需要 --text" >&2; exit 2; }
[[ -n "$x" && -n "$y" ]] || { echo "inputText 需要 --x 和 --y；这是 HarmonyOS uiInput inputText 的最小必需输入。" >&2; exit 2; }
[[ "$mode" == "replace" || "$mode" == "append" ]] || { echo "inputText --mode 仅支持 replace/append" >&2; exit 2; }

hdc_prefix=(hdc)
[[ -n "$device" ]] && hdc_prefix=(hdc -t "$device")

run_uitest() {
  local output status
  set +e
  output="$("${hdc_prefix[@]}" shell uitest uiInput "$@" 2>&1)"
  status=$?
  set -e
  if [[ $status -ne 0 ]] || printf '%s\n' "$output" | grep -Eiq 'Missing parameter|Invalid parameters|Please confirm|unrecognized option|Illegal argument|USAGE'; then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

if [[ "$mode" == "replace" ]]; then
  run_uitest click "$x" "$y"
  run_uitest keyEvent 2072 2017
  run_uitest keyEvent 2055
fi
run_uitest inputText "$x" "$y" "$text"

effect='{"status":"UNVERIFIABLE","reason":"layout unavailable or target input could not be identified"}'
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
dump_args=(--out "$tmp_dir/layout.json")
[[ -n "$device" ]] && dump_args+=(--device "$device")
[[ -n "$bundle" ]] && dump_args+=(--bundle "$bundle")
attempts=0
started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
max_attempts=7
while [[ $attempts -lt $max_attempts ]]; do
  attempts=$((attempts + 1))
  if "$script_dir/dump-tree.sh" "${dump_args[@]}" >/dev/null 2>&1; then
    effect="$(node "$script_dir/../lib/input-effect.js" --layout "$tmp_dir/layout.json" --x "$x" --y "$y" --text "$text" --mode "$mode")"
    effect_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$effect")"
    [[ "$effect_status" == "VERIFIED" || "$mode" == "append" ]] && break
  fi
  [[ $attempts -lt $max_attempts ]] && sleep 0.15
done
settled_ms="$(node -e 'process.stdout.write(String(Math.max(0, Date.now() - Number(process.argv[1]))))' "$started_ms")"
effect="$(node -e '
const effect = JSON.parse(process.argv[1]);
effect.attempts = Number(process.argv[2]);
effect.settledMs = Number(process.argv[3]);
console.log(JSON.stringify(effect));
' "$effect" "$attempts" "$settled_ms")"

node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset(); const sign = offset >= 0 ? "+" : "-"; const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const effect = JSON.parse(process.argv[1]);
const mode = process.argv[2];
const event = {schemaVersion:1,type:"actionResult",platform:"harmony",time:localIso(),action:"inputText",ok:effect.status !== "MISMATCH",inputMethod:mode === "replace" ? "uitest-key-replace" : "uitest-uiInput-inputText",inputMode:mode,inputEffect:effect};
if (!event.ok) event.failureCode = "ACTION_EFFECT_MISMATCH";
console.log(JSON.stringify(event, null, 2));
' "$effect" "$mode"

[[ "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$effect")" != "MISMATCH" ]]
