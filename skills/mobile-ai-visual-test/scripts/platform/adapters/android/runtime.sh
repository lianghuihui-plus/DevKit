#!/usr/bin/env bash
set -euo pipefail

operation=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --operation) operation="${2:-}"; shift 2 ;;
    --owner-key|--runtime-json|--device|--app|--entry) shift 2 ;;
    *) echo "Android runtime 未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ "$operation" != "acquire" && "$operation" != "release" ]]; then
  echo "Android runtime 不支持的 operation: ${operation:-missing}" >&2
  exit 2
fi

node -e '
const operation = process.argv[1];
const date = new Date(); const offset = -date.getTimezoneOffset(); const sign = offset >= 0 ? "+" : "-"; const pad = (value, size = 2) => String(value).padStart(size, "0"); const abs = Math.abs(offset);
const time = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(),3)}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
console.log(JSON.stringify({schemaVersion:1,type:"platformRuntimeResult",platform:"android",operation,time,ok:true,status:"NOT_REQUIRED",ownership:"NONE",released:false}, null, 2));
' "$operation"
