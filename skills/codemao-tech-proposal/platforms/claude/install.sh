#!/usr/bin/env bash
# 注册 codemao-tech-proposal 到 Claude Code skills
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DST_DIR="${HOME}/.claude/skills/codemao-tech-proposal"

name=$(awk '/^---$/{n++; next} n==1 && /^name:/{sub(/^name: */,""); print; exit}' "$SKILL_DIR/SKILL.md")
desc=$(awk '/^---$/{n++; next} n==1 && /^description:/{sub(/^description: *"?/,""); sub(/"?$/,""); print; exit}' "$SKILL_DIR/SKILL.md")
body=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$SKILL_DIR/SKILL.md" | sed "s|templates/|${DST_DIR}/templates/|g")

mkdir -p "$DST_DIR"

cat > "$DST_DIR/SKILL.md" << SKILLEOF
---
name: $name
description: $desc
---

$body
SKILLEOF

if [ -d "$SKILL_DIR/templates" ]; then
  mkdir -p "$DST_DIR/templates"
  cp "$SKILL_DIR/templates"/* "$DST_DIR/templates/" 2>/dev/null || true
fi

echo "✅ ${name} → Claude Code"
