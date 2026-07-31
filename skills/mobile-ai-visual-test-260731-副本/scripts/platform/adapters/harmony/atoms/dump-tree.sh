#!/usr/bin/env bash
set -euo pipefail

device=""
bundle=""
out=""
remote="/data/local/tmp/mavt-dump-tree.json"
log_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="${2:-}"; shift 2 ;;
    --app|--bundle) bundle="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --remote) remote="${2:-}"; shift 2 ;;
    --log) log_file="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$out" ]] || { echo "dump-tree 需要 --out" >&2; exit 2; }
mkdir -p "$(dirname "$out")"
if [[ -z "$log_file" ]]; then
  log_file="$(dirname "$out")/dump-tree.log"
fi
mkdir -p "$(dirname "$log_file")"
: >"$log_file"

hdc_prefix=(hdc)
if [[ -n "$device" ]]; then
  hdc_prefix=(hdc -t "$device")
fi

dump_variants=("with-m")
if [[ -n "$bundle" ]]; then
  dump_variants=("with-m-bundle" "with-m" "bundle")
fi
dump_variants+=("default")

for variant in "${dump_variants[@]}"; do
  dump_args=(shell uitest dumpLayout -p "$remote")
  if [[ "$variant" == "with-m" || "$variant" == "with-m-bundle" ]]; then
    dump_args+=( -m true )
  fi
  if [[ "$variant" == "bundle" || "$variant" == "with-m-bundle" ]]; then
    dump_args+=( -b "$bundle" )
  fi

  printf '[layout] trying: uitest dumpLayout' >>"$log_file"
  printf ' %q' "${dump_args[@]:3}" >>"$log_file"
  printf '\n' >>"$log_file"
  "${hdc_prefix[@]}" shell rm -f "$remote" >>"$log_file" 2>&1 || true
  "${hdc_prefix[@]}" "${dump_args[@]}" >>"$log_file" 2>&1 || true
  rm -f "$out"
  if "${hdc_prefix[@]}" file recv "$remote" "$out" >>"$log_file" 2>&1 && [[ -s "$out" ]]; then
    printf '[layout] success with variant: %s\n' "$variant" >>"$log_file"
    node -e '
const path = require("path");
function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
console.log(JSON.stringify({schemaVersion:1,type:"atomResult",atom:"dump-tree",platform:"harmony",time:localIso(),ok:true,path:path.resolve(process.argv[1]),variant:process.argv[2]}, null, 2));
' "$out" "$variant"
    exit 0
  fi
done

rm -f "$out"
echo "Harmony dump-tree failed. See $log_file" >&2
exit 1
