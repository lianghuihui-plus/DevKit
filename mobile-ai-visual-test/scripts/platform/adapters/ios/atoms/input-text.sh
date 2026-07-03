#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$script_dir/lib/ios-driver.js" atom input-text "$@"
