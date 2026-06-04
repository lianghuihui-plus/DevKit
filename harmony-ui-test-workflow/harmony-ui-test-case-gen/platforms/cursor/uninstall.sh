#!/usr/bin/env bash
set -euo pipefail
DST="${HOME}/.cursor/skills/harmony-ui-test-case-gen"
LEGACY_COMMAND="${HOME}/.cursor/commands/harmony-ui-test-case-gen.md"
if [ -d "$DST" ]; then
  rm -rf "$DST"
  [ -f "$LEGACY_COMMAND" ] && rm -f "$LEGACY_COMMAND"
  echo "    ✅ 已卸载 harmony-ui-test-case-gen (cursor)"
else
  [ -f "$LEGACY_COMMAND" ] && rm -f "$LEGACY_COMMAND"
  echo "    ⏭  未安装 harmony-ui-test-case-gen (cursor)"
fi
