#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.codex/skills/harmony-ui-test-case-gen"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  echo "    ✅ 已卸载 harmony-ui-test-case-gen (codex)"
else
  echo "    ⏭  未安装 harmony-ui-test-case-gen (codex)"
fi
