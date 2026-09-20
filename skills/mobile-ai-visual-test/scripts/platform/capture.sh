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

[[ -n "$platform" ]] || { echo "platform/capture.sh 需要显式传 --platform <harmony|android|ios>。" >&2; exit 2; }
adapter="$(cd "$(dirname "$0")" && pwd)/adapters/${platform}/capture.sh"
[[ -x "$adapter" ]] || { echo "未找到平台截图适配器: ${platform}" >&2; exit 2; }
exec "$adapter" "${args[@]}"
