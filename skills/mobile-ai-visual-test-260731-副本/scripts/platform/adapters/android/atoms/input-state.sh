#!/usr/bin/env bash
set -euo pipefail

device=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

adb_prefix=(adb)
if [[ -n "$device" ]]; then
  adb_prefix=(adb -s "$device")
fi

dump="$("${adb_prefix[@]}" shell dumpsys input_method 2>/dev/null || true)"

node -e '
const text = process.argv[1] || "";
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const currentIme = (text.match(/imeToken=.*?\[([^\]]+)\]/g) || []).at(-1)?.match(/\[([^\]]+)\]/)?.[1] || null;
const editorMatches = [...text.matchAll(/(?:curEditorInfo:[\s\S]*?inputType=(0x[0-9a-fA-F]+|\d+)[\s\S]*?fieldId=(?:0x)?([0-9a-fA-F]+|\d+)|editorInfo:\s*inputType=(\d+)[\s\S]*?fieldId \(viewId\)=(\d+))/g)];
const last = editorMatches.at(-1);
const inputTypeText = last ? (last[1] || last[3]) : "";
const inputType = inputTypeText ? Number(inputTypeText.startsWith("0x") ? BigInt(inputTypeText) : Number(inputTypeText)) : 0;
const fieldId = last ? (last[2] || last[4] || null) : null;
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "inputState",
  platform: "android",
  time: localIso(),
  currentInputMethod: currentIme,
  inputType,
  fieldId,
  hasEditableConnection: !!inputType
}, null, 2));
' "$dump"
