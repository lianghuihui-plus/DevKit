#!/usr/bin/env bash
set -euo pipefail

platform=""
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    --app|--bundle|--entry|--ability)
      cat >&2 <<'EOF'
probe-env 只探测平台/设备能力，不接收 --app/--entry/--bundle/--ability。
目标 App 环境确认请在用户确认后使用 scripts/update-env.js 固化；
目标 App 当前前台状态请使用 scripts/observe.sh 采集观察证据。
EOF
      exit 2
      ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$platform" ]]; then
  echo "probe-env 需要显式传 --platform <harmony|android|ios>，不能默认选择平台。" >&2
  exit 2
fi

adapter="$(cd "$(dirname "$0")" && pwd)/adapters/${platform}/probe.sh"
if [[ ! -x "$adapter" ]]; then
  echo "未找到平台探测适配器: ${platform}" >&2
  exit 2
fi

if [[ ${#args[@]} -gt 0 ]]; then
  exec "$adapter" "${args[@]}"
else
  exec "$adapter"
fi
