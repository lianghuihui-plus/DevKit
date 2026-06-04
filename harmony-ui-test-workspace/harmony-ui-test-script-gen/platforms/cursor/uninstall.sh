#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.cursor/commands/harmony-ui-test-script-gen.md"
if [ -f "$DST" ]; then
  rm -f "$DST"
  echo "    ✅ 已卸载 /harmony-ui-test-script-gen (cursor)"
else
  echo "    ⏭  未安装 /harmony-ui-test-script-gen (cursor)"
fi
