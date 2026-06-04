#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DST="${HOME}/.claude/skills/harmony-ui-test-runner"
mkdir -p "$DST"
for f in SKILL.md templates references; do
  [ -e "${SKILL_DIR}/$f" ] && cp -r "${SKILL_DIR}/$f" "$DST/"
done
echo "    ✅ harmony-ui-test-runner"
