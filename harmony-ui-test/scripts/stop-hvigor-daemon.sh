#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  stop-hvigor-daemon.sh --node PATH --hvigor PATH [options]

Options:
  --project-root PATH   HarmonyOS project root. Defaults to current directory.
  --all                 Stop all hvigor daemons with --stop-daemon-all.
  --help                Show this help.

Use only when hvigor daemon is suspected to have cached an invalid SDK or environment.
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
node_path=""
hvigorw_path=""
stop_all=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) [[ $# -ge 2 ]] || die "--project-root requires a value"; project_root="$2"; shift 2 ;;
    --node) [[ $# -ge 2 ]] || die "--node requires a value"; node_path="$2"; shift 2 ;;
    --hvigor) [[ $# -ge 2 ]] || die "--hvigor requires a value"; hvigorw_path="$2"; shift 2 ;;
    --all) stop_all=1; shift ;;
    --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$node_path" ]] || die "--node is required"
[[ -n "$hvigorw_path" ]] || die "--hvigor is required"
[[ -d "$project_root" ]] || die "project root not found: $project_root"
[[ -x "$node_path" ]] || die "node is not executable: $node_path"
[[ -f "$hvigorw_path" ]] || die "hvigorw.js not found: $hvigorw_path"

cd "$project_root"

if [[ "$stop_all" -eq 1 ]]; then
  cmd=("$node_path" "$hvigorw_path" --stop-daemon-all)
else
  cmd=("$node_path" "$hvigorw_path" --stop-daemon)
fi

print_command "${cmd[@]}"
"${cmd[@]}"
