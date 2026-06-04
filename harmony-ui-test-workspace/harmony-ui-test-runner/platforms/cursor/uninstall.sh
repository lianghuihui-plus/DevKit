#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.cursor/commands/harmony-ui-test-runner.md"
if [ -f "$DST" ]; then
  rm -f "$DST"
  echo "    ✅ 已卸载 /harmony-ui-test-runner (cursor)"
else
  echo "    ⏭  未安装 /harmony-ui-test-runner (cursor)"
fi
