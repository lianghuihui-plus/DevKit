#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.codex/skills/harmony-ui-test-script-gen"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  echo "    ✅ 已卸载 harmony-ui-test-script-gen (codex)"
else
  echo "    ⏭  未安装 harmony-ui-test-script-gen (codex)"
fi
