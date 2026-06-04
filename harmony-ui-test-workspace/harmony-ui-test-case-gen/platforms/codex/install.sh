#!/usr/bin/env bash
# 安装 harmony-ui-test-case-gen 到 Codex skills
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
DST="${HOME}/.codex/skills/harmony-ui-test-case-gen"

[ -f "$SKILL_FILE" ] || { echo "    ❌ 找不到 SKILL: $SKILL_FILE"; exit 1; }

mkdir -p "$DST"
for f in SKILL.md templates references agents scripts assets; do
  [ -e "${SKILL_DIR}/$f" ] && cp -r "${SKILL_DIR}/$f" "$DST/"
done

echo "    ✅ harmony-ui-test-case-gen"
