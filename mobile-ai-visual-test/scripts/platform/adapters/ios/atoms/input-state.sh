#!/usr/bin/env bash
set -euo pipefail
node -e '
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  console.log(JSON.stringify({schemaVersion:1,type:"inputState",platform:"ios",time:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(),3)}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`,hasEditableConnection:null,inputType:null}, null, 2));
}
localIso();
'
