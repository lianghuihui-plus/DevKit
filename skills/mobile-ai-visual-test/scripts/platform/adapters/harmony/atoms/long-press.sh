#!/usr/bin/env bash
set -euo pipefail

device=""
x=""
y=""
duration_ms=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; shift 2 ;;
    --y) y="${2:-}"; shift 2 ;;
    --duration-ms) duration_ms="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$x" && -n "$y" && -n "$duration_ms" ]] || { echo "longPress 需要 --x、--y 和 --duration-ms" >&2; exit 2; }
node -e '
const value = Number(process.argv[1]);
process.exit(Number.isInteger(value) && value > 0 && value <= 61000 ? 0 : 1);
' "$duration_ms" || { echo "longPress 需要 1 到 61000 之间的正整数 --duration-ms" >&2; exit 2; }

# A stationary DOWN/UP sequence is not recognized as a long press on all
# HarmonyOS devices. Keep MOVE events flowing across one pixel instead.
move_x="$(( x > 0 ? x - 1 : x + 1 ))"
smooth_ms="$(( duration_ms < 1000 ? duration_ms : 1000 ))"
keep_ms="$(( duration_ms - smooth_ms ))"

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
output="$("${hdc_prefix[@]}" shell uinput -T -m "$x" "$y" "$move_x" "$y" -k "$keep_ms" "$smooth_ms" 2>&1)" || { printf '%s\n' "$output" >&2; exit 1; }
elapsed_ms="$(( $(node -e 'process.stdout.write(String(Date.now()))') - started_ms ))"
if printf '%s\n' "$output" | grep -Eiq 'Missing parameter|Invalid parameters|Please confirm|unrecognized option|Illegal argument|USAGE'; then
  printf '%s\n' "$output" >&2
  exit 1
fi
remaining_ms="$(( duration_ms > elapsed_ms ? duration_ms - elapsed_ms : 0 ))"
if [[ "$remaining_ms" -gt 0 ]]; then
  node -e 'setTimeout(() => {}, Number(process.argv[1]))' "$remaining_ms"
fi
adapter_elapsed_ms="$(( $(node -e 'process.stdout.write(String(Date.now()))') - started_ms ))"

node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"harmony",time:localIso(),action:"longPress",ok:true,durationMs:Number(process.argv[1]),executedPoint:{x:Number(process.argv[2]),y:Number(process.argv[3])},command:{status:"ACCEPTED",transport:"HDC_UINPUT",elapsedMs:Number(process.argv[4])},timing:{requestedDurationMs:Number(process.argv[1]),dispatchElapsedMs:Number(process.argv[4]),completionBarrierWaitMs:Number(process.argv[5]),adapterElapsedMs:Number(process.argv[6])}}, null, 2));
' "$duration_ms" "$x" "$y" "$elapsed_ms" "$remaining_ms" "$adapter_elapsed_ms"
