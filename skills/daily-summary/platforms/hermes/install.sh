#!/usr/bin/env bash
# 安装 daily-summary 到 Hermes skills
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DST_DIR="${HOME}/.hermes/skills/daily-summary"

rm -rf "$DST_DIR"
mkdir -p "$DST_DIR"
cp "$SKILL_DIR/SKILL.md" "$DST_DIR/SKILL.md"
cp "$SKILL_DIR/config.yaml" "$DST_DIR/config.yaml"
cp -r "$SKILL_DIR/scripts" "$DST_DIR/scripts"

echo "✅ daily-summary → Hermes"
