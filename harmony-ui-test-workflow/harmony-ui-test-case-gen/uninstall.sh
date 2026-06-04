#!/usr/bin/env bash
# harmony-ui-test-case-gen 统一卸载入口
# 用法: ./uninstall.sh [平台名]   不传则卸载所有平台

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORMS_DIR="${SCRIPT_DIR}/platforms"
SELECTED="${1:-all}"

if [ "$SELECTED" = "all" ]; then
  echo "🗑  卸载 harmony-ui-test-case-gen 从所有平台..."
  echo ""
  for platform_dir in "$PLATFORMS_DIR"/*/; do
    [ -d "$platform_dir" ] || continue
    platform="$(basename "$platform_dir")"
    uninstall_script="${platform_dir}uninstall.sh"
    if [ -f "$uninstall_script" ]; then
      echo "▶ ${platform}:"
      bash "$uninstall_script"
      echo ""
    fi
  done
else
  platform_dir="${PLATFORMS_DIR}/${SELECTED}"
  uninstall_script="${platform_dir}/uninstall.sh"
  if [ ! -d "$platform_dir" ]; then
    echo "❌ 未知平台: ${SELECTED}"
    exit 1
  fi
  if [ ! -f "$uninstall_script" ]; then
    echo "❌ ${SELECTED} 平台尚未配置卸载脚本"
    exit 1
  fi
  echo "▶ ${SELECTED}:"
  bash "$uninstall_script"
fi
