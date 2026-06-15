#!/usr/bin/env bash
# DevKit Skill 软链删除脚本
# 用法:
#   ./skill-unlink.sh <skill名> [平台...]
#   ./skill-unlink.sh cm-ai-git-commit              # 从全平台删除
#   ./skill-unlink.sh cm-ai-git-commit hermes       # 只删 Hermes
set -euo pipefail

CONF_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${CONF_DIR}/platforms.conf"

platform_dir() {
  local varname="${1}_dir"
  echo "${!varname:-}"
}

usage() {
  echo "用法: $0 <skill名> [平台...]"
  echo ""
  echo "平台: ${PLATFORM_LIST}（默认全部）"
  exit 1
}

[ $# -lt 1 ] && usage

SKILL_NAME="$1"; shift

if [ $# -eq 0 ]; then
  PLATFORMS=($PLATFORM_LIST)
else
  PLATFORMS=("$@")
fi

for platform in "${PLATFORMS[@]}"; do
  dest_base="$(platform_dir "$platform")"
  if [ -z "$dest_base" ]; then
    echo "❌ 未知平台: ${platform}"
    continue
  fi
  dest="${dest_base}/${SKILL_NAME}"
  if [ -L "$dest" ] || [ -d "$dest" ] || [ -f "$dest" ]; then
    rm -rf "$dest"
    echo "🗑  ${SKILL_NAME} ← ${platform}"
  else
    echo "⏭  ${SKILL_NAME} ${platform}（不存在）"
  fi
done
