#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
GLOBAL_COMMANDS="${HOME}/.cursor/commands"
[ -f "$SKILL_FILE" ] || { echo "    ❌ 找不到 SKILL: $SKILL_FILE"; exit 1; }
mkdir -p "$GLOBAL_COMMANDS"
skill_name=$(awk '/^---$/{n++; next} n==1 && /^name:/{sub(/^name: */,""); print; exit}' "$SKILL_FILE")
description=$(awk '/^---$/{n++; next} n==1 && /^description:/{sub(/^description: *"?/,""); sub(/"?$/,""); print; exit}' "$SKILL_FILE")
body=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$SKILL_FILE")
cat > "${GLOBAL_COMMANDS}/${skill_name}.md" << EOF
# /${skill_name} Command

${description}

${body}
EOF
echo "    ✅ /${skill_name}"
