#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
platform=""
args=()

cli_error() {
  node "$script_dir/../lib/coordinator-interface-contract.js" --error-entrypoint scripts/prepare-env.sh --message "$1" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

if [[ -z "$platform" ]]; then
  cli_error "prepare-env 需要显式传 --platform <harmony|android|ios>"
fi

adapter="$script_dir/adapters/${platform}/prepare-env.sh"
if [[ ! -x "$adapter" ]]; then
  cli_error "无效 --platform 或未找到平台环境准备适配器: ${platform}"
fi

error_file="$(mktemp "${TMPDIR:-/tmp}/mavt-prepare-cli.XXXXXX")"
trap 'rm -f "$error_file"' EXIT
set +e
"$adapter" "${args[@]}" 2>"$error_file"
status=$?
set -e
if [[ $status -eq 2 ]]; then
  cli_error "$(tr '\n' ' ' < "$error_file")"
fi
cat "$error_file" >&2
exit "$status"
