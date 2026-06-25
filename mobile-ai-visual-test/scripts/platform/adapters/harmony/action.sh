#!/usr/bin/env bash
set -euo pipefail

device=""
bundle=""
ability=""
app=""
entry=""
type=""
x=""
y=""
text=""
from_x=""
from_y=""
to_x=""
to_y=""
ms=""
velocity="600"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app) app="${2:-}"; shift 2 ;;
    --entry) entry="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
    --ability) ability="${2:-}"; shift 2 ;;
    --type) type="${2:-}"; shift 2 ;;
    --x) x="${2:-}"; shift 2 ;;
    --y) y="${2:-}"; shift 2 ;;
    --text) text="${2:-}"; shift 2 ;;
    --from-x) from_x="${2:-}"; shift 2 ;;
    --from-y) from_y="${2:-}"; shift 2 ;;
    --to-x) to_x="${2:-}"; shift 2 ;;
    --to-y) to_y="${2:-}"; shift 2 ;;
    --ms) ms="${2:-}"; shift 2 ;;
    --velocity) velocity="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$bundle" && -n "$app" ]]; then
  bundle="$app"
fi
if [[ -z "$ability" && -n "$entry" ]]; then
  ability="$entry"
fi

if [[ -z "$type" ]]; then
  echo "缺少 --type" >&2
  exit 2
fi

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

case "$type" in
  launchApp)
    [[ -n "$bundle" && -n "$ability" ]] || { echo "launchApp 需要 --bundle 和 --ability" >&2; exit 2; }
    "${hdc_prefix[@]}" shell aa start -b "$bundle" -a "$ability" >/dev/null
    ;;
  tap)
    [[ -n "$x" && -n "$y" ]] || { echo "tap 需要 --x 和 --y" >&2; exit 2; }
    "${hdc_prefix[@]}" shell uitest uiInput click "$x" "$y" >/dev/null
    ;;
  toggle)
    [[ -n "$x" && -n "$y" ]] || { echo "toggle 需要 --x 和 --y" >&2; exit 2; }
    "${hdc_prefix[@]}" shell uitest uiInput click "$x" "$y" >/dev/null
    ;;
  inputText)
    [[ -n "$text" ]] || { echo "inputText 需要 --text" >&2; exit 2; }
    if [[ -n "$x" && -n "$y" ]]; then
      "${hdc_prefix[@]}" shell uitest uiInput inputText "$x" "$y" "$text" >/dev/null
    else
      "${hdc_prefix[@]}" shell uitest uiInput text "$text" >/dev/null
    fi
    ;;
  swipe)
    [[ -n "$from_x" && -n "$from_y" && -n "$to_x" && -n "$to_y" ]] || { echo "swipe 需要 --from-x --from-y --to-x --to-y" >&2; exit 2; }
    "${hdc_prefix[@]}" shell uitest uiInput swipe "$from_x" "$from_y" "$to_x" "$to_y" "$velocity" >/dev/null
    ;;
  back)
    "${hdc_prefix[@]}" shell uitest uiInput keyEvent Back >/dev/null
    ;;
  home)
    "${hdc_prefix[@]}" shell uitest uiInput keyEvent Home >/dev/null
    ;;
  wait)
    sleep "$(node -e 'console.log((Number(process.argv[1] || 1000) / 1000).toFixed(3))' "$ms")"
    ;;
  *)
    echo "不支持的动作类型: $type" >&2
    exit 2
    ;;
esac

node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"actionResult",platform:"harmony",time:localIso(),action:process.argv[1],ok:true}, null, 2));
' "$type"
