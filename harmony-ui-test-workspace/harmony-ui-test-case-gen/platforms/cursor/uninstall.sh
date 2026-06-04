#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.cursor/commands/harmony-ui-test-case-gen.md"
if [ -f "$DST" ]; then
  rm -f "$DST"
  echo "    ✅ 已卸载 /harmony-ui-test-case-gen (cursor)"
else
  echo "    ⏭  未安装 /harmony-ui-test-case-gen (cursor)"
fi
