#!/usr/bin/env bash
set -euo pipefail

node -e '
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "environmentProbe",
  platform: "android",
  device: null,
  targets: [],
  capabilities: {
    connector: "adb",
    adb: false,
    screenshot: false,
    layout: false,
    foregroundApp: false,
    logs: false,
    launchApp: false,
    actions: [],
    screenCap: false,
    dumpLayout: false,
    implemented: false
  },
  reason: "Android 适配器接口已预留；当前版本尚未实现。"
}, null, 2));
'
