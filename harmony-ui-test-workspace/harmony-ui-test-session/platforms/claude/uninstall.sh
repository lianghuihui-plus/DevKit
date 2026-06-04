#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.claude/skills/harmony-ui-test-session"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  echo "    ✅ 已卸载 harmony-ui-test-session (claude)"
else
  echo "    ⏭  未安装 harmony-ui-test-session (claude)"
fi
