#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-test.sh --hdc PATH --bundle NAME --test-module NAME --class DESCRIBE#IT [options]

Options:
  --runner NAME      Test runner. Defaults to OpenHarmonyTestRunner.
  --timeout MS       Test timeout. Defaults to 60000.
  --help             Show this help.
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
bundle_name=""
test_module_name=""
class_filter=""
runner="OpenHarmonyTestRunner"
timeout_ms="60000"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hdc) [[ $# -ge 2 ]] || die "--hdc requires a value"; hdc_path="$2"; shift 2 ;;
    --bundle) [[ $# -ge 2 ]] || die "--bundle requires a value"; bundle_name="$2"; shift 2 ;;
    --test-module) [[ $# -ge 2 ]] || die "--test-module requires a value"; test_module_name="$2"; shift 2 ;;
    --class) [[ $# -ge 2 ]] || die "--class requires a value"; class_filter="$2"; shift 2 ;;
    --runner) [[ $# -ge 2 ]] || die "--runner requires a value"; runner="$2"; shift 2 ;;
    --timeout) [[ $# -ge 2 ]] || die "--timeout requires a value"; timeout_ms="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$hdc_path" ]] || die "--hdc is required"
[[ -n "$bundle_name" ]] || die "--bundle is required"
[[ -n "$test_module_name" ]] || die "--test-module is required"
[[ -n "$class_filter" ]] || die "--class is required"
[[ -x "$hdc_path" ]] || die "hdc is not executable: $hdc_path"
[[ "$timeout_ms" =~ ^[0-9]+$ ]] || die "--timeout must be an integer number of milliseconds"

cmd=(
  "$hdc_path" shell aa test
  -b "$bundle_name"
  -m "$test_module_name"
  -s unittest "$runner"
  -s class "$class_filter"
  -s timeout "$timeout_ms"
)

print_command "${cmd[@]}"
"${cmd[@]}"
