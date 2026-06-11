#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install-hap.sh --hdc PATH [--app-hap PATH] [--test-hap PATH]

Options:
  --hdc PATH        hdc executable.
  --app-hap PATH    Signed app HAP to install first.
  --test-hap PATH   Signed ohosTest HAP to install second.
  --help            Show this help.

At least one of --app-hap or --test-hap is required.
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

hdc_path=""
app_hap=""
test_hap=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hdc) [[ $# -ge 2 ]] || die "--hdc requires a value"; hdc_path="$2"; shift 2 ;;
    --app-hap) [[ $# -ge 2 ]] || die "--app-hap requires a value"; app_hap="$2"; shift 2 ;;
    --test-hap) [[ $# -ge 2 ]] || die "--test-hap requires a value"; test_hap="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$hdc_path" ]] || die "--hdc is required"
[[ -x "$hdc_path" ]] || die "hdc is not executable: $hdc_path"
[[ -n "$app_hap" || -n "$test_hap" ]] || die "at least one of --app-hap or --test-hap is required"

if [[ -n "$app_hap" ]]; then
  [[ -f "$app_hap" ]] || die "app HAP not found: $app_hap"
  cmd=("$hdc_path" install -r "$app_hap")
  print_command "${cmd[@]}"
  "${cmd[@]}"
fi

if [[ -n "$test_hap" ]]; then
  [[ -f "$test_hap" ]] || die "test HAP not found: $test_hap"
  cmd=("$hdc_path" install -r "$test_hap")
  print_command "${cmd[@]}"
  "${cmd[@]}"
fi
