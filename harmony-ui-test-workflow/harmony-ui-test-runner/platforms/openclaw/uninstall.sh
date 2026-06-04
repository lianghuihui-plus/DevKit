#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.openclaw/skills/harmony-ui-test-runner"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  echo "    ✅ 已卸载 harmony-ui-test-runner (openclaw)"
else
  echo "    ⏭  未安装 harmony-ui-test-runner (openclaw)"
fi
