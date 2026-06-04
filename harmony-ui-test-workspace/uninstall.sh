#!/usr/bin/env bash
# 鸿蒙 UI 测试工作空间 — 一次性卸载四个 skill
# 用法: ./uninstall.sh [平台名]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM="${1:-all}"

SKILLS=(
  "harmony-ui-test-session"
  "harmony-ui-test-case-gen"
  "harmony-ui-test-runner"
  "harmony-ui-test-script-gen"
)

echo "🗑  卸载鸿蒙 UI 测试工作空间（${PLATFORM}）..."
echo ""

for skill in "${SKILLS[@]}"; do
  skill_dir="${SCRIPT_DIR}/${skill}"
  if [ ! -f "${skill_dir}/uninstall.sh" ]; then
    echo "⚠️  跳过 ${skill}：uninstall.sh 不存在"
    continue
  fi
  bash "${skill_dir}/uninstall.sh" "$PLATFORM"
done

echo ""
echo "✅ 全部完成"
