#!/usr/bin/env bash
# DevKit Skill 软链安装脚本
# 用法:
#   ./skill-link.sh <skill绝对路径> [平台...]
#   ./skill-link.sh /path/to/skills/cm-ai-git-commit              # 全平台
#   ./skill-link.sh /path/to/skills/cm-ai-git-commit hermes       # 只装 Hermes
set -euo pipefail

CONF_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${CONF_DIR}/platforms.conf"

platform_dir() {
  local varname="${1}_dir"
  echo "${!varname:-}"
}

usage() {
  echo "用法: $0 <skill绝对路径> [平台...]"
  echo ""
  echo "平台: ${PLATFORM_LIST}（默认全部）"
  exit 1
}

[ $# -lt 1 ] && usage

SKILL_PATH="$1"; shift

# 支持相对路径，实时转绝对路径
SKILL_PATH="$(cd "$SKILL_PATH" && pwd)"
SKILL_NAME="$(basename "$SKILL_PATH")"

[ -f "${SKILL_PATH}/SKILL.md" ] || { echo "❌ ${SKILL_PATH} 下没有 SKILL.md"; exit 1; }

if [ $# -eq 0 ]; then
  PLATFORMS=($PLATFORM_LIST)
else
  PLATFORMS=("$@")
fi

for platform in "${PLATFORMS[@]}"; do
  dest_base="$(platform_dir "$platform")"
  if [ -z "$dest_base" ]; then
    echo "❌ 未知平台: ${platform}"
    echo "可用: ${PLATFORM_LIST}"
    continue
  fi
  dest="${dest_base}/${SKILL_NAME}"
  rm -rf "$dest"
  mkdir -p "$dest_base"
  ln -s "$SKILL_PATH" "$dest"
  echo "✅ ${SKILL_NAME} → ${platform}"
done
