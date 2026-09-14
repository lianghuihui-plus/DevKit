#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-probe-'));
const bin = path.join(temp, 'bin');
fs.mkdirSync(bin);

function executable(name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

executable('xcodebuild', 'printf "Xcode 15.4\\nBuild version 15F31d\\n"');
executable('appium', `
if [ "$1" = "-v" ]; then printf '2.5.1\\n'; exit 0; fi
if [ "$1" = "driver" ]; then printf '{"xcuitest":{"installed":true,"version":"5.1.0"}}\\n'; exit 0; fi
`);
executable('xcrun', `
if [ "$1" = "simctl" ]; then
  printf '    iPhone 15 (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE) (Booted)\\n'
  exit 0
fi
if [ "$1" = "xcdevice" ]; then
  printf '%s\\n' '[
    {"name":"AAA iPad pro","identifier":"00008027-001120DE3A40402E","simulator":false,"available":true,"platform":"com.apple.platform.iphoneos"},
    {"name":"BBB iPhone","identifier":"00008030-001120DE3A40403F","simulator":false,"available":true,"platform":"com.apple.platform.iphoneos"}
]'
  exit 0
fi
exit 1
`);

function probe(args = []) {
  const result = childProcess.spawnSync('/bin/bash', ['scripts/probe-env.sh', '--platform', 'ios', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  const discovered = probe();
  assert.strictEqual(discovered.deviceDetected, true);
  assert.strictEqual(discovered.device, null);
  assert.strictEqual(discovered.ready, false);
  assert.strictEqual(discovered.executionReady, false);
  assert.strictEqual(discovered.deviceSelectionRequired, true);
  assert.ok(discovered.devices.some((item) => item.deviceType === 'realDevice'));
  assert.ok(discovered.diagnostics.some((item) => item.id === 'iosDeviceSelectionRequired'));

  const selected = probe(['--device', '00008027-001120DE3A40402E']);
  assert.strictEqual(selected.device, '00008027-001120DE3A40402E');
  assert.strictEqual(selected.capabilities.deviceType, 'realDevice');
  assert.strictEqual(selected.deviceSelectionRequired, false);
  assert.strictEqual(selected.deviceDetected, true);
  assert.strictEqual(selected.executionReady, false);
  assert.ok(selected.diagnostics.some((item) => item.id === 'iosRealDeviceSigningIncomplete'));
  assert.ok(!selected.diagnostics.some((item) => item.id === 'iosDeviceUnavailable'));

  const explicitType = probe([
    '--device', '00008027-001120DE3A40402E', '--device-type', 'realDevice',
  ]);
  assert.strictEqual(explicitType.capabilities.deviceType, 'realDevice');
  assert.ok(!explicitType.diagnostics.some((item) => item.id === 'iosDeviceTypeMismatch'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('ios probe passed');
