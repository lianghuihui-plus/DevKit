#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  describeActionConstraints,
  normalizeActionProposal,
  validateActionExecution,
} = require('../lib/action-contract');
const { run, runAllowFailure } = require('./helpers');
const { sessionCapabilities } = require('../platform/adapters/ios/lib/appium-client');
const { pngSize, scaleVisualPoint, sourceViewport } = require('../platform/adapters/ios/lib/screen-space');
const {
  environmentAdapterArgs,
  executionEnvironmentSha,
  normalizeEnvironmentBinding,
  validateExecutionEnvironment,
} = require('../lib/execution-environment');
const { normalizeRestartResult, probeSession } = require('../batch/device-session');

const platforms = ['harmony', 'android', 'ios'];
const commonActions = ['launchApp', 'restartApp', 'tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait'];

for (const platform of platforms) {
  const constraints = describeActionConstraints(platform, 'formal-execution');
  assert.strictEqual(constraints.schemaVersion, 1, `${platform}: action contract schema`);
  const expectedActions = platform === 'ios'
    ? [...commonActions.slice(0, -1), 'dismissKeyboard', 'wait']
    : commonActions;
  assert.deepStrictEqual(constraints.actionTypes, expectedActions, `${platform}: platform action types`);
  assert.deepStrictEqual(constraints.inputText.modes, ['replace', 'append'], `${platform}: input modes`);

  const waitResult = JSON.parse(run(`./scripts/platform/adapters/${platform}/action.sh`, ['--device', `${platform}-device`, '--app', `com.example.${platform}`, '--type', 'wait', '--ms', '0']));
  assert.strictEqual(waitResult.schemaVersion, 1, `${platform}: action result schema`);
  assert.strictEqual(waitResult.type, 'actionResult', `${platform}: action result type`);
  assert.strictEqual(waitResult.platform, platform, `${platform}: action result platform`);
  assert.strictEqual(waitResult.action, 'wait', `${platform}: wait action`);
  assert.strictEqual(waitResult.ok, true, `${platform}: wait result`);
  assert.strictEqual(waitResult.device.id, `${platform}-device`, `${platform}: action result device binding`);
  assert.strictEqual(waitResult.app.appId, `com.example.${platform}`, `${platform}: action result App binding`);
  assert.match(waitResult.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, `${platform}: local timestamp`);

  const runtimeResult = JSON.parse(run('./scripts/platform/runtime.sh', [
    '--platform', platform,
    '--device', `${platform}-device`,
    '--app', `com.example.${platform}`,
    '--operation', 'acquire',
    '--owner-key', `test-${platform}`,
  ], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
  assert.strictEqual(runtimeResult.ok, true, `${platform}: platform runtime acquisition`);
  assert.strictEqual(runtimeResult.platform, platform, `${platform}: platform runtime binding`);
  assert.match(runtimeResult.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, `${platform}: runtime local timestamp`);

  for (const script of ['probe-env.sh', 'platform/action.sh', 'platform/observe.sh']) {
    const result = runAllowFailure(`./scripts/${script}`, ['--platform', platform, '--definitely-unknown', 'value']);
    const expectedStatus = platform === 'ios' && script === 'platform/action.sh' ? 64 : 2;
    assert.strictEqual(result.status, expectedStatus, `${platform}: ${script} rejects unknown arguments`);
    assert.match(result.stderr, /未知参数|不支持的动作/, `${platform}: ${script} explains unknown argument`);
  }
}

assert.strictEqual(describeActionConstraints('harmony').inputText.coordinates, 'required');
assert.strictEqual(describeActionConstraints('android').inputText.coordinates, 'forbidden');
assert.strictEqual(describeActionConstraints('ios').inputText.focusedFieldRequired, true);
assert.ok(describeActionConstraints('ios').actionTypes.includes('dismissKeyboard'));
assert.ok(!describeActionConstraints('android').actionTypes.includes('dismissKeyboard'));
assert.strictEqual(normalizeActionProposal({ type: 'inputText', text: 'x', mode: 'addition' }).action.mode, 'append');
assert.strictEqual(normalizeActionProposal({ type: 'inputText', text: 'x' }).action.mode, 'replace');
assert.throws(() => validateActionExecution({
  type: 'tap', x: 10, y: 20, coordinateSource: 'layout',
}, { platform: 'android', scope: 'case-business' }), /coordinateEvidence is required/);
assert.throws(() => validateActionExecution({
  type: 'restartApp', reason: 'business navigation',
}, { platform: 'harmony', scope: 'case-business' }), /restartApp is not allowed for case-business/);

const androidRestartWithoutDisplay = normalizeRestartResult({
  ok: true, coldStartVerified: true, platform: 'android',
}, { platform: 'android' });
assert.strictEqual(androidRestartWithoutDisplay.coldStartVerified, true);
assert.strictEqual(androidRestartWithoutDisplay.startupDisplayVerified, true);
assert.strictEqual(androidRestartWithoutDisplay.startupDisplayValidation.reason, 'POLICY_PRESERVE');
const androidRestartWithSkippedDisplay = normalizeRestartResult({
  ok: true,
  coldStartVerified: true,
  platform: 'android',
  startupDisplay: {
    status: 'SKIPPED', verified: false, requestedOrientation: 'preserve', enforcement: 'none',
    appliesTo: [], required: false, skippedReason: 'POLICY_PRESERVE',
  },
}, { platform: 'android' });
assert.strictEqual(androidRestartWithSkippedDisplay.startupDisplayVerified, true);
assert.strictEqual(normalizeRestartResult({ ok: true, platform: 'android' }, { platform: 'android' }).coldStartVerified, false);
assert.strictEqual(normalizeRestartResult({
  ok: true, coldStartVerified: true, platform: 'harmony',
}, { platform: 'harmony', deviceFormFactor: 'phone' }).startupDisplayVerified, false);

assert.deepStrictEqual(normalizeEnvironmentBinding({
  platform: 'android', device: 'legacy-device', appId: 'com.example.android', entry: '.MainActivity',
}, 'android'), {
  platform: 'android', deviceId: 'legacy-device', appId: 'com.example.android', entry: '.MainActivity',
  startupDisplayPolicy: { orientation: 'preserve', enforcement: 'none', appliesTo: [] },
});
const legacyEnvironmentSnapshot = {
  binding: { platform: 'android', device: 'legacy-device', appId: 'com.example.android', entry: '.MainActivity' },
  probe: null,
  dependencies: {},
  confirmedAt: '2026-08-27T10:00:00.000+08:00',
};
const normalizedLegacySnapshot = validateExecutionEnvironment({
  environmentSnapshot: legacyEnvironmentSnapshot,
  environmentSha: executionEnvironmentSha(legacyEnvironmentSnapshot),
}, 'android');
assert.strictEqual(normalizedLegacySnapshot.binding.deviceId, 'legacy-device');
assert.strictEqual(Object.hasOwn(normalizedLegacySnapshot.binding, 'device'), false);

const originalSpawnSync = childProcess.spawnSync;
try {
  childProcess.spawnSync = (command, args) => {
    assert.ok(command.endsWith('/scripts/platform/probe-env.sh'));
    assert.deepStrictEqual(args, ['--platform', 'android', '--device', 'legacy-batch-device']);
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify({ ready: true, devices: [{ id: 'legacy-batch-device' }] }),
    };
  };
  const legacyBatchProbe = probeSession({ binding: { platform: 'android', device: 'legacy-batch-device' } });
  assert.strictEqual(legacyBatchProbe.ok, true);
  assert.deepStrictEqual(legacyBatchProbe.binding, { platform: 'android', device: 'legacy-batch-device' });
} finally {
  childProcess.spawnSync = originalSpawnSync;
}

const landscapeSource = '<AppiumAUT><XCUIElementTypeApplication width="834" height="1194"><XCUIElementTypeWindow visible="true" width="1194" height="834"/></XCUIElementTypeApplication></AppiumAUT>';
assert.deepStrictEqual(sourceViewport(landscapeSource), { width: 1194, height: 834, source: 'window' });
const pngHeader = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(pngHeader);
pngHeader.writeUInt32BE(2388, 16);
pngHeader.writeUInt32BE(1668, 20);
assert.deepStrictEqual(pngSize(pngHeader), { width: 2388, height: 1668 });
assert.deepStrictEqual(scaleVisualPoint({ x: 1194, y: 834 }, { width: 2388, height: 1668 }, { width: 1194, height: 834 }), {
  x: 597, y: 417, screenshot: { width: 2388, height: 1668 }, viewport: { width: 1194, height: 834 },
});
assert.strictEqual(sessionCapabilities({ appId: 'com.example.ios' }, { autoLaunch: false })['appium:autoLaunch'], false);
const iosProbeArgs = environmentAdapterArgs({
  platform: 'ios', deviceId: 'ios-device', appId: 'com.example.ios', deviceType: 'realDevice',
  xcodeOrgId: 'TEAM', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.wda',
}, 'probe');
assert.strictEqual(iosProbeArgs.includes('--app'), false);
for (const flag of ['--device-type', '--xcode-org-id', '--xcode-signing-id', '--updated-wda-bundle-id']) assert.ok(iosProbeArgs.includes(flag), flag);

const iosRestart = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'restartApp',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosRestart.coldStartVerified, true);
assert.deepStrictEqual(iosRestart.startupDisplay, {
  status: 'SKIPPED',
  verified: false,
  requestedOrientation: 'preserve',
  enforcement: 'none',
  appliesTo: [],
  required: false,
  skippedReason: 'POLICY_PRESERVE',
});

const iosDismissKeyboard = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'dismissKeyboard',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosDismissKeyboard.ok, true);
assert.strictEqual(iosDismissKeyboard.action, 'dismissKeyboard');
const iosObservationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-observe-'));
const iosObservation = JSON.parse(run('./scripts/platform/adapters/ios/observe.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--out', iosObservationDir, '--label', 'signals',
], { env: { ...process.env, MAVT_IOS_FAKE: '1', MAVT_IOS_FAKE_KEYBOARD_SHOWN: '1' } }));
assert.deepStrictEqual(iosObservation.technicalSignals, {
  keyboardShown: true,
  windowRect: { x: 0, y: 0, width: 393, height: 852 },
});
assert.throws(() => validateActionExecution({ type: 'dismissKeyboard' }, {
  platform: 'android', scope: 'case-business',
}), /dismissKeyboard is not allowed/);

console.log('platform-contract passed');
