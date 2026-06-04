#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
DST_DIR="${HOME}/.hermes/skills/harmony-ui-test-case-gen"
[ -f "$SKILL_FILE" ] || { echo "    ❌ 找不到 SKILL: $SKILL_FILE"; exit 1; }
mkdir -p "$DST_DIR"
cp "$SKILL_FILE" "$DST_DIR/SKILL.md"
[ -d "${SKILL_DIR}/references" ] && cp -r "${SKILL_DIR}/references" "$DST_DIR/"
[ -d "${SKILL_DIR}/templates" ] && cp -r "${SKILL_DIR}/templates" "$DST_DIR/"
echo "    ✅ harmony-ui-test-case-gen"
