#!/usr/bin/env bash
# 安装 harmony-ui-test-case-gen 到 OpenClaw skills
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
DST_DIR="${HOME}/.openclaw/skills/harmony-ui-test-case-gen"
[ -f "$SKILL_FILE" ] || { echo "    ❌ 找不到 SKILL: $SKILL_FILE"; exit 1; }
name=$(awk '/^---$/{n++; next} n==1 && /^name:/{sub(/^name: */,""); print; exit}' "$SKILL_FILE")
desc=$(awk '/^---$/{n++; next} n==1 && /^description:/{sub(/^description: *"?/,""); sub(/"?$/,""); print; exit}' "$SKILL_FILE")
body=$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$SKILL_FILE")
mkdir -p "$DST_DIR"
cat > "$DST_DIR/SKILL.md" << SKILLEOF
---
name: $name
description: $desc
user-invocable: true
disable-model-invocation: true
---
$body
SKILLEOF
for f in templates references agents scripts assets; do
  [ -e "${SKILL_DIR}/$f" ] && cp -r "${SKILL_DIR}/$f" "$DST_DIR/"
done

echo "    ✅ /$name"
