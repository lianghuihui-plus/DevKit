#!/usr/bin/env bash
set -euo pipefail

atom="${1:-ios-atom}"
echo "iOS atom 不支持: $atom" >&2
exit 64
