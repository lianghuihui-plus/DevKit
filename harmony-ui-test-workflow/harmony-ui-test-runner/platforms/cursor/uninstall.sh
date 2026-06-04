#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.cursor/skills/harmony-ui-test-runner"
LEGACY_COMMAND="${HOME}/.cursor/commands/harmony-ui-test-runner.md"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  [ -f "$LEGACY_COMMAND" ] && rm -f "$LEGACY_COMMAND"
  echo "    ✅ 已卸载 harmony-ui-test-runner (cursor)"
else
  [ -f "$LEGACY_COMMAND" ] && rm -f "$LEGACY_COMMAND"
  echo "    ⏭  未安装 harmony-ui-test-runner (cursor)"
fi
