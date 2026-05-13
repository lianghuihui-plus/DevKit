#!/usr/bin/env bash
# 注册 codemao-tech-proposal 到 Cursor 全局命令
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GLOBAL_COMMANDS="${HOME}/.cursor/commands"
TEMPLATES_DST="${GLOBAL_COMMANDS}/codemao-tech-proposal-templates"

name=$(awk '/^---$/{n++; next} n==1 && /^name:/{sub(/^name: */,""); print; exit}' "$SKILL_DIR/SKILL.md")
desc=$(awk '/^---$/{n++; next} n==1 && /^description:/{sub(/^description: *"?/,""); sub(/"?$/,""); print; exit}' "$SKILL_DIR/SKILL.md")
body=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$SKILL_DIR/SKILL.md" | sed "s|templates/|${TEMPLATES_DST}/|g")

mkdir -p "$GLOBAL_COMMANDS"

cat > "$GLOBAL_COMMANDS/${name}.md" << EOF
# /${name} Command

${desc}

${body}
EOF

if [ -d "$SKILL_DIR/templates" ]; then
  mkdir -p "$TEMPLATES_DST"
  cp "$SKILL_DIR/templates"/* "$TEMPLATES_DST/" 2>/dev/null || true
fi

echo "✅ ${name} → Cursor"
