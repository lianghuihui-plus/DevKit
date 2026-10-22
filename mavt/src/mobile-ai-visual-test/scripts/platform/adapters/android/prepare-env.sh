#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
atoms_dir="$script_dir/atoms"

device=""
android_ui_backend="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --android-ui-backend) android_ui_backend="${2:-}"; shift 2 ;;
    --app|--bundle|--entry|--ability) shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
case "$android_ui_backend" in
  auto|helper|uiautomator) ;;
  *) echo "无效 --android-ui-backend: $android_ui_backend" >&2; exit 2 ;;
esac

device_args=()
if [[ -n "$device" ]]; then
  device_args=(--device "$device")
fi

if [[ "$android_ui_backend" == "helper" ]]; then
  ime_dependency='{"id":"mavtInputIme","name":"MAVT Input IME","platform":"android","required":false,"ok":true,"stage":"disabled"}'
else
  ime_dependency="$("$atoms_dir/mavt-ime.sh" "${device_args[@]}" --prepare | node -e '
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk});
process.stdin.on("end",()=>{const value=JSON.parse(input);process.stdout.write(JSON.stringify(value.dependency));});
')"
fi

if [[ "$android_ui_backend" == "uiautomator" ]]; then
  helper_dependency='{"id":"androidAccessibilityHelper","ok":true,"required":false,"stage":"disabled"}'
elif [[ -z "$device" ]]; then
  helper_dependency="$(node -e '
console.log(JSON.stringify({id:"androidAccessibilityHelper",ok:false,required:process.argv[1]==="helper",stage:"failed",failureCode:"ANDROID_DEVICE_REQUIRED"}));
' "$android_ui_backend")"
else
  helper_dependency="$(node "$atoms_dir/helper-provision.js" --device "$device" --android-ui-backend "$android_ui_backend")"
fi

node -e '
const imeDependency = JSON.parse(process.argv[1]);
const helperDependency = JSON.parse(process.argv[2]);
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const dependencies = [imeDependency, helperDependency];
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "environmentPrepare",
  platform: "android",
  time: localIso(),
  ok: dependencies.every((item) => item && (item.ok || item.required === false)),
  dependencies
}, null, 2));
' "$ime_dependency" "$helper_dependency"
