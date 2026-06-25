#!/usr/bin/env bash
set -euo pipefail

node -e '
console.log(JSON.stringify({
  schemaVersion: 1,
  type: "environmentProbe",
  platform: "ios",
  device: null,
  targets: [],
  capabilities: {
    connector: "xcrun/idb",
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
  reason: "iOS 适配器接口已预留；当前版本尚未实现。"
}, null, 2));
'
