#!/usr/bin/env bash
# 安装 codemao-tech-proposal 到 Hermes skills
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DST_DIR="${HOME}/.hermes/skills/codemao-tech-proposal"

mkdir -p "$DST_DIR"
cp "$SKILL_DIR/SKILL.md" "$DST_DIR/SKILL.md"

if [ -d "$SKILL_DIR/templates" ]; then
  mkdir -p "$DST_DIR/templates"
  cp "$SKILL_DIR/templates"/* "$DST_DIR/templates/" 2>/dev/null || true
fi

echo "✅ codemao-tech-proposal → Hermes"
