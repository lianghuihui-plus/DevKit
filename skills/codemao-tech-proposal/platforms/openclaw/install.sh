#!/usr/bin/env bash
# 安装 codemao-tech-proposal 到 OpenClaw workspace skills
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DST_DIR="${HOME}/.openclaw/skills/codemao-tech-proposal"

name=$(awk '/^---$/{n++; next} n==1 && /^name:/{sub(/^name: */,""); print; exit}' "$SKILL_DIR/SKILL.md")
desc=$(awk '/^---$/{n++; next} n==1 && /^description:/{sub(/^description: *"?/,""); sub(/"?$/,""); print; exit}' "$SKILL_DIR/SKILL.md")
body=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$SKILL_DIR/SKILL.md")

mkdir -p "$DST_DIR"

cat > "$DST_DIR/SKILL.md" << SKILLEOF
---
name: $name
description: $desc
user-invocable: true
---

$body
SKILLEOF

if [ -d "$SKILL_DIR/templates" ]; then
  mkdir -p "$DST_DIR/templates"
  cp "$SKILL_DIR/templates"/* "$DST_DIR/templates/" 2>/dev/null || true
fi

echo "✅ ${name} → OpenClaw"
