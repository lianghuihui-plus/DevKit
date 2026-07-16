#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"

platform=""
device=""
device_type=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    --device) device="${2:-}"; shift 2 ;;
    --device-type) device_type="${2:-}"; shift 2 ;;
    --app|--bundle|--entry|--ability)
      cat >&2 <<'EOF'
probe-env 只探测平台/设备能力，不接收 --app/--entry/--bundle/--ability。
目标 App 环境确认请在用户确认后使用 scripts/update-env.js 固化；
目标 App 当前前台状态请使用 scripts/observe.sh 采集观察证据。
EOF
      exit 2
      ;;
    *) echo "probe-env 未知参数: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$platform" ]]; then
  echo "probe-env 需要显式传 --platform <harmony|android|ios>，不能默认选择平台。" >&2
  exit 2
fi
if [[ -n "$device_type" && "$platform" != "ios" ]]; then
  echo "probe-env 的 --device-type 仅适用于 iOS。" >&2
  exit 2
fi

args=(--platform "$platform")
[[ -n "$device" ]] && args+=(--device "$device")
[[ -n "$device_type" ]] && args+=(--device-type "$device_type")
exec "$script_dir/platform/probe-env.sh" "${args[@]}"
