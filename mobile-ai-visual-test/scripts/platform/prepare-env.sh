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
  echo "prepare-env 需要显式传 --platform <harmony|android|ios>" >&2
  exit 2
fi

adapter="$(cd "$(dirname "$0")" && pwd)/adapters/${platform}/prepare-env.sh"
if [[ ! -x "$adapter" ]]; then
  echo "未找到平台环境准备适配器: ${platform}" >&2
  exit 2
fi

exec "$adapter" "${args[@]}"
