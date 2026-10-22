#!/usr/bin/env bash
set -euo pipefail

platform=""
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$platform" ]]; then
  echo "platform/observe.sh 需要显式传 --platform <harmony|android|ios>，不能默认选择平台。" >&2
  exit 2
fi

adapter="$(cd "$(dirname "$0")" && pwd)/adapters/${platform}/observe.sh"
if [[ ! -x "$adapter" ]]; then
  echo "未找到平台观察适配器: ${platform}" >&2
  exit 2
fi

if [[ ${#args[@]} -gt 0 ]]; then
  exec "$adapter" "${args[@]}"
else
  exec "$adapter"
fi
