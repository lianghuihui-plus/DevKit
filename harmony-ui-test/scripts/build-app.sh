#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  build-app.sh --deveco-sdk-home PATH --node PATH --hvigor PATH --product NAME [options]

Options:
  --project-root PATH       HarmonyOS project root. Defaults to current directory.
  --build-mode MODE         App build mode. Defaults to debug.
  --task NAME               Hvigor app build task. Defaults to assembleApp.
  --hvigor-flag FLAG        Extra safe hvigor flag. Repeatable. Allowed: --no-daemon.
  --no-parallel             Do not pass --parallel.
  --no-incremental          Do not pass --incremental.
  --help                    Show this help.

Notes:
  - DEVECO_SDK_HOME is passed only to the hvigor command process.
  - This script never writes shell profiles, global PATH, IDE config, or daemon config.
  - This script never adds --daemon.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 2
}

print_command() {
  printf 'COMMAND:'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

project_root="$(pwd)"
build_mode="debug"
task="assembleApp"
parallel=1
incremental=1
extra_hvigor_flags=()
deveco_sdk_home=""
node_path=""
hvigorw_path=""
product=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) [[ $# -ge 2 ]] || die "--project-root requires a value"; project_root="$2"; shift 2 ;;
    --deveco-sdk-home) [[ $# -ge 2 ]] || die "--deveco-sdk-home requires a value"; deveco_sdk_home="$2"; shift 2 ;;
    --node) [[ $# -ge 2 ]] || die "--node requires a value"; node_path="$2"; shift 2 ;;
    --hvigor) [[ $# -ge 2 ]] || die "--hvigor requires a value"; hvigorw_path="$2"; shift 2 ;;
    --product) [[ $# -ge 2 ]] || die "--product requires a value"; product="$2"; shift 2 ;;
    --build-mode) [[ $# -ge 2 ]] || die "--build-mode requires a value"; build_mode="$2"; shift 2 ;;
    --task) [[ $# -ge 2 ]] || die "--task requires a value"; task="$2"; shift 2 ;;
    --hvigor-flag)
      [[ $# -ge 2 ]] || die "--hvigor-flag requires a value"
      case "$2" in
        --no-daemon) extra_hvigor_flags+=("$2") ;;
        *) die "unsupported --hvigor-flag value: $2" ;;
      esac
      shift 2
      ;;
    --no-parallel) parallel=0; shift ;;
    --no-incremental) incremental=0; shift ;;
    --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$deveco_sdk_home" ]] || die "--deveco-sdk-home is required"
[[ -n "$node_path" ]] || die "--node is required"
[[ -n "$hvigorw_path" ]] || die "--hvigor is required"
[[ -n "$product" ]] || die "--product is required"
[[ -d "$project_root" ]] || die "project root not found: $project_root"
[[ -d "$deveco_sdk_home" ]] || die "DevEco SDK home not found: $deveco_sdk_home"
[[ -x "$node_path" ]] || die "node is not executable: $node_path"
[[ -f "$hvigorw_path" ]] || die "hvigorw.js not found: $hvigorw_path"

cd "$project_root"

cmd=(
  "$node_path" "$hvigorw_path"
  --mode project
  -p "product=$product"
  -p "buildMode=$build_mode"
  "$task"
  --analyze=normal
)

if [[ "${#extra_hvigor_flags[@]}" -gt 0 ]]; then
  cmd=("$node_path" "$hvigorw_path" "${extra_hvigor_flags[@]}" "${cmd[@]:2}")
fi

if [[ "$parallel" -eq 1 ]]; then
  cmd+=(--parallel)
fi
if [[ "$incremental" -eq 1 ]]; then
  cmd+=(--incremental)
fi

print_command "DEVECO_SDK_HOME=$deveco_sdk_home" "${cmd[@]}"
DEVECO_SDK_HOME="$deveco_sdk_home" "${cmd[@]}"
