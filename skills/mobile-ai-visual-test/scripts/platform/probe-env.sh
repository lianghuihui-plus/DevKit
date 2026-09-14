#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
platform=""
args=()

cli_error() {
  node "$script_dir/../lib/coordinator-interface-contract.js" --error-entrypoint scripts/probe-env.sh --message "$1" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    --app|--bundle|--entry|--ability)
      cli_error "probe-env 只探测平台/设备能力，不接收 $1；目标 App 写入 environment confirmation binding"
      ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$platform" ]]; then
  cli_error "probe-env 需要显式传 --platform <harmony|android|ios>，不能默认选择平台"
fi

adapter="$script_dir/adapters/${platform}/probe.sh"
if [[ ! -x "$adapter" ]]; then
  cli_error "无效 --platform 或未找到平台探测适配器: ${platform}"
fi

error_file="$(mktemp "${TMPDIR:-/tmp}/mavt-probe-cli.XXXXXX")"
trap 'rm -f "$error_file"' EXIT
set +e
if [[ ${#args[@]} -gt 0 ]]; then
  "$adapter" "${args[@]}" 2>"$error_file"
else
  "$adapter" 2>"$error_file"
fi
status=$?
set -e
if [[ $status -eq 2 ]]; then
  cli_error "$(tr '\n' ' ' < "$error_file")"
fi
cat "$error_file" >&2
exit "$status"
