#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
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
const {
  createDeviceSessionAdapter,
  normalizeRestartResult,
  probeSession,
  restartApp,
  restartTimeoutMs,
  runtimeTimeoutMs,
  run: runDeviceAdapter,
} = require('../batch/device-session');
const { classifyRuntimeDisplay, startupDisplayRequirement } = require('../lib/startup-display');

const platforms = ['harmony', 'android', 'ios'];
const commonActions = ['launchApp', 'restartApp', 'tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait'];

const emptyProbePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-empty-probe-path-'));
const emptyProbeHdc = path.join(emptyProbePath, 'hdc');
fs.writeFileSync(emptyProbeHdc, '#!/bin/sh\nexit 0\n');
fs.chmodSync(emptyProbeHdc, 0o755);
const emptyProbe = childProcess.spawnSync('/bin/bash', [
  'scripts/platform/probe-env.sh', '--platform', 'harmony',
], {
  cwd: path.resolve(__dirname, '../..'),
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${emptyProbePath}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  },
});
fs.rmSync(emptyProbePath, { recursive: true, force: true });
assert.strictEqual(emptyProbe.status, 0, emptyProbe.stderr);
assert.strictEqual(JSON.parse(emptyProbe.stdout).platform, 'harmony');

for (const platform of platforms) {
  const constraints = describeActionConstraints(platform, 'formal-execution');
  assert.strictEqual(constraints.schemaVersion, 1, `${platform}: action contract schema`);
  const expectedActions = platform === 'ios'
    ? [...commonActions.slice(0, -1), 'dismissKeyboard', 'wait']
    : commonActions;
  assert.deepStrictEqual(constraints.actionTypes, expectedActions, `${platform}: platform action types`);
  assert.deepStrictEqual(constraints.inputText.modes, ['replace', 'append'], `${platform}: input modes`);

  const waitResult = JSON.parse(run(`./scripts/platform/adapters/${platform}/action.sh`, ['--device', `${platform}-device`, '--app', `com.example.${platform}`, '--type', 'wait', '--ms', '0']));
  assert.strictEqual(waitResult.schemaVersion, 2, `${platform}: action result schema`);
  assert.strictEqual(waitResult.type, 'actionResult', `${platform}: action result type`);
  assert.strictEqual(waitResult.platform, platform, `${platform}: action result platform`);
  assert.strictEqual(waitResult.action, 'wait', `${platform}: wait action`);
  assert.strictEqual(waitResult.command.status, 'ACCEPTED', `${platform}: wait command result`);
  assert.strictEqual(waitResult.deviceExecution.status, 'UNVERIFIED', `${platform}: wait device result`);
  assert.strictEqual(Object.hasOwn(waitResult, 'ok'), false, `${platform}: action result must not expose ambiguous ok`);
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

  const missingLongPressDuration = runAllowFailure(`./scripts/platform/adapters/${platform}/action.sh`, [
    '--device', `${platform}-device`, '--app', `com.example.${platform}`, '--type', 'longPress', '--x', '120', '--y', '240',
  ], { env: { ...process.env, MAVT_IOS_FAKE: '1' } });
  assert.strictEqual(missingLongPressDuration.status, platform === 'ios' ? 1 : 2, `${platform}: longPress duration is required before dispatch`);
  assert.match(missingLongPressDuration.stderr || missingLongPressDuration.stdout, /durationMs|duration-ms/, `${platform}: missing longPress duration is explained`);
  if (platform === 'ios') {
    const rejected = JSON.parse(missingLongPressDuration.stdout);
    assert.strictEqual(rejected.command.status, 'REJECTED');
    assert.strictEqual(rejected.deviceExecution.status, 'NOT_EXECUTED');
  }
}

const fakeHdcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-harmony-long-press-'));
const fakeHdcLog = path.join(fakeHdcDir, 'hdc-args.txt');
const fakeHdc = path.join(fakeHdcDir, 'hdc');
fs.writeFileSync(fakeHdc, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$MAVT_HDC_ARGS_OUT"\n');
fs.chmodSync(fakeHdc, 0o755);
const harmonyLongPress = JSON.parse(run('./scripts/platform/adapters/harmony/action.sh', [
  '--device', 'harmony-device', '--app', 'com.example.harmony', '--type', 'longPress',
  '--x', '120', '--y', '240', '--duration-ms', '25',
], { env: { ...process.env, PATH: `${fakeHdcDir}:${process.env.PATH}`, MAVT_HDC_ARGS_OUT: fakeHdcLog } }));
assert.deepStrictEqual(fs.readFileSync(fakeHdcLog, 'utf8').trim().split('\n'), [
  '-t', 'harmony-device', 'shell', 'uinput', '-T', '-m', '120', '240', '119', '240', '-k', '0', '25',
]);
assert.strictEqual(harmonyLongPress.durationMs, 25);
assert.strictEqual(harmonyLongPress.command.status, 'ACCEPTED');
assert.strictEqual(harmonyLongPress.command.transport, 'HDC_UINPUT');
assert.ok(Number.isInteger(harmonyLongPress.command.elapsedMs));
assert.strictEqual(harmonyLongPress.timing.requestedDurationMs, 25);
assert.strictEqual(harmonyLongPress.timing.dispatchElapsedMs, harmonyLongPress.command.elapsedMs);
assert.ok(harmonyLongPress.timing.completionBarrierWaitMs >= 0);
assert.ok(harmonyLongPress.timing.adapterElapsedMs >= 25);
assert.strictEqual(harmonyLongPress.deviceExecution.verification, 'REQUEST_ECHO');
assert.deepStrictEqual(harmonyLongPress.deviceExecution.dispatchedPoint, { x: 120, y: 240 });

const fakeAdbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-targeted-input-'));
const fakeAdbLog = path.join(fakeAdbDir, 'adb.log');
const fakeAdb = path.join(fakeAdbDir, 'adb');
fs.writeFileSync(fakeAdb, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MAVT_FAKE_ADB_LOG"
case "$*" in
  *"shell pm path mavt.android.ime"*) echo "package:/data/app/mavt.android.ime/base.apk" ;;
  *"shell ime list -s"*) echo "mavt.android.ime/.MavtInputMethodService" ;;
  *"shell settings get secure default_input_method"*) echo "com.example/.OriginalIme" ;;
  *"shell dumpsys input_method"*) echo "editorInfo: inputType=1 fieldId (viewId)=42" ;;
  *"shell am broadcast"*) echo "Broadcast completed: result=-1" ;;
esac
`);
fs.chmodSync(fakeAdb, 0o755);
const androidTargetedInput = JSON.parse(run('./scripts/platform/adapters/android/action.sh', [
  '--device', 'android-device', '--app', 'com.example.android', '--type', 'inputText',
  '--x', '120', '--y', '240', '--text', 'account-value', '--mode', 'replace',
], { env: { ...process.env, PATH: `${fakeAdbDir}:${process.env.PATH}`, MAVT_FAKE_ADB_LOG: fakeAdbLog } }));
assert.strictEqual(androidTargetedInput.action, 'inputText');
assert.strictEqual(androidTargetedInput.inputTarget, 'target-point');
assert.deepStrictEqual(androidTargetedInput.deviceExecution.dispatchedPoint, { x: 120, y: 240 });
const androidInputCommands = fs.readFileSync(fakeAdbLog, 'utf8').trim().split('\n');
const androidTapIndex = androidInputCommands.findIndex((line) => line.includes('shell input tap 120 240'));
const androidBroadcastIndex = androidInputCommands.findIndex((line) => line.includes('shell am broadcast'));
assert.ok(androidTapIndex >= 0 && androidBroadcastIndex > androidTapIndex, 'Android target input should focus before text dispatch');
const androidFocusedInput = JSON.parse(run('./scripts/platform/adapters/android/action.sh', [
  '--device', 'android-device', '--app', 'com.example.android', '--type', 'inputText',
  '--text', 'focused-value', '--mode', 'replace',
], { env: { ...process.env, PATH: `${fakeAdbDir}:${process.env.PATH}`, MAVT_FAKE_ADB_LOG: fakeAdbLog } }));
assert.strictEqual(androidFocusedInput.inputTarget, 'current-focus');
assert.strictEqual(androidFocusedInput.deviceExecution.dispatchedPoint, undefined);
fs.rmSync(fakeAdbDir, { recursive: true, force: true });

const recoveringAdbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-input-recovery-'));
const recoveringAdbLog = path.join(recoveringAdbDir, 'adb.log');
const recoveringAdbState = path.join(recoveringAdbDir, 'ime-state');
const recoveringImeCache = path.join(recoveringAdbDir, 'ime-cache');
const recoveringAdb = path.join(recoveringAdbDir, 'adb');
fs.mkdirSync(recoveringImeCache, { recursive: true });
fs.writeFileSync(path.join(recoveringImeCache, 'mavt-input.apk'), 'fixture apk');
const imeSourceRoot = path.resolve(__dirname, '../platform/adapters/android/ime');
const imeSourceHash = crypto.createHash('sha256');
function hashAndroidImeSources(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) hashAndroidImeSources(file);
    else {
      imeSourceHash.update(path.relative(imeSourceRoot, file));
      imeSourceHash.update('\0');
      imeSourceHash.update(fs.readFileSync(file));
      imeSourceHash.update('\0');
    }
  }
}
hashAndroidImeSources(imeSourceRoot);
fs.writeFileSync(path.join(recoveringImeCache, 'source.sha256'), imeSourceHash.digest('hex'));
fs.writeFileSync(recoveringAdb, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MAVT_FAKE_ADB_LOG"
case "$*" in
  "devices") printf 'List of devices attached\\nandroid-device\\tdevice\\n' ;;
  *"shell pm path mavt.android.ime"*) [[ -f "$MAVT_FAKE_IME_STATE.installed" ]] && echo "package:/data/app/mavt.android.ime/base.apk" ;;
  *"shell ime list -s"*) [[ -f "$MAVT_FAKE_IME_STATE.enabled" ]] && echo "mavt.android.ime/.MavtInputMethodService" ;;
  *" install -r "*)
    if [[ "\${MAVT_FAKE_IME_INSTALL_FAIL:-}" == "1" ]]; then echo "fixture install failed" >&2; exit 1; fi
    touch "$MAVT_FAKE_IME_STATE.installed"; echo "Success"
    ;;
  *"shell ime enable mavt.android.ime/.MavtInputMethodService"*) touch "$MAVT_FAKE_IME_STATE.enabled"; echo "Input method enabled" ;;
  *"shell settings get secure default_input_method"*) echo "com.example/.OriginalIme" ;;
  *"shell dumpsys input_method"*) echo "editorInfo: inputType=1 fieldId (viewId)=42" ;;
  *"shell am broadcast"*)
    if [[ "\${MAVT_FAKE_INPUT_BROADCAST_FAIL:-}" == "1" ]]; then echo "fixture broadcast failed" >&2; exit 1; fi
    echo "Broadcast completed: result=-1"
    ;;
  *"shell wm size"*) echo "Physical size: 1080x2400" ;;
esac
`);
fs.chmodSync(recoveringAdb, 0o755);
const recoveringEnv = {
  ...process.env,
  PATH: `${recoveringAdbDir}:${process.env.PATH}`,
  MAVT_FAKE_ADB_LOG: recoveringAdbLog,
  MAVT_FAKE_IME_STATE: recoveringAdbState,
  MAVT_ANDROID_IME_BUILD_DIR: recoveringImeCache,
};
const unpreparedAndroidProbe = JSON.parse(run('./scripts/platform/probe-env.sh', [
  '--platform', 'android', '--device', 'android-device',
], { env: recoveringEnv }));
assert.strictEqual(unpreparedAndroidProbe.capabilities.dependencies[0].ok, false);
assert.strictEqual(JSON.stringify(unpreparedAndroidProbe.diagnostics).includes('IME'), false);
assert.strictEqual(JSON.stringify(unpreparedAndroidProbe.diagnostics).includes('输入法'), false);
const recoveredAndroidInput = JSON.parse(run('./scripts/platform/adapters/android/action.sh', [
  '--device', 'android-device', '--app', 'com.example.android', '--type', 'inputText',
  '--text', '自动恢复输入', '--mode', 'replace',
], { env: recoveringEnv }));
assert.strictEqual(recoveredAndroidInput.action, 'inputText');
assert.strictEqual(recoveredAndroidInput.command.status, 'ACCEPTED');
assert.strictEqual(recoveredAndroidInput.inputMethod, 'platform-managed');
const recoveringCommands = fs.readFileSync(recoveringAdbLog, 'utf8').trim().split('\n');
assert.ok(recoveringCommands.some((line) => line.includes(' install -r ')), 'Android input should prepare its private backend');
assert.ok(recoveringCommands.some((line) => line.includes('shell ime enable')), 'Android input should enable its private backend');
assert.ok(recoveringCommands.some((line) => line.includes('shell am broadcast')), 'Android input should continue after recovery');
fs.rmSync(`${recoveringAdbState}.installed`, { force: true });
fs.rmSync(`${recoveringAdbState}.enabled`, { force: true });
const unavailableAndroidInput = JSON.parse(run('./scripts/platform/adapters/android/action.sh', [
  '--device', 'android-device', '--app', 'com.example.android', '--type', 'inputText',
  '--text', '不会执行', '--mode', 'replace',
], { env: { ...recoveringEnv, MAVT_FAKE_IME_INSTALL_FAIL: '1' } }));
assert.strictEqual(unavailableAndroidInput.command.status, 'REJECTED');
assert.strictEqual(unavailableAndroidInput.command.failureCode, 'INPUT_CAPABILITY_NOT_READY');
assert.strictEqual(JSON.stringify(unavailableAndroidInput).includes('IME'), false);
const rejectedAndroidInput = JSON.parse(run('./scripts/platform/adapters/android/action.sh', [
  '--device', 'android-device', '--app', 'com.example.android', '--type', 'inputText',
  '--text', '不会写入', '--mode', 'replace',
], { env: { ...recoveringEnv, MAVT_FAKE_INPUT_BROADCAST_FAIL: '1' } }));
assert.strictEqual(rejectedAndroidInput.command.status, 'REJECTED');
assert.strictEqual(rejectedAndroidInput.command.failureCode, 'ANDROID_INPUT_TEXT_FAILED');
fs.rmSync(recoveringAdbDir, { recursive: true, force: true });
run('./scripts/platform/adapters/harmony/atoms/long-press.sh', [
  '--device', 'harmony-device', '--x', '120', '--y', '240', '--duration-ms', '1025',
], { env: { ...process.env, PATH: `${fakeHdcDir}:${process.env.PATH}`, MAVT_HDC_ARGS_OUT: fakeHdcLog } });
assert.deepStrictEqual(fs.readFileSync(fakeHdcLog, 'utf8').trim().split('\n'), [
  '-t', 'harmony-device', 'shell', 'uinput', '-T', '-m', '120', '240', '119', '240', '-k', '25', '1000',
]);
run('./scripts/platform/adapters/harmony/atoms/long-press.sh', [
  '--device', 'harmony-device', '--x', '0', '--y', '240', '--duration-ms', '1',
], { env: { ...process.env, PATH: `${fakeHdcDir}:${process.env.PATH}`, MAVT_HDC_ARGS_OUT: fakeHdcLog } });
assert.deepStrictEqual(fs.readFileSync(fakeHdcLog, 'utf8').trim().split('\n'), [
  '-t', 'harmony-device', 'shell', 'uinput', '-T', '-m', '0', '240', '1', '240', '-k', '0', '1',
]);
const harmonyVelocityAlias = runAllowFailure('./scripts/platform/adapters/harmony/atoms/long-press.sh', [
  '--x', '120', '--y', '240', '--velocity', '5000',
]);
assert.strictEqual(harmonyVelocityAlias.status, 2);
assert.match(harmonyVelocityAlias.stderr, /未知参数/);
const harmonyFractionalDuration = runAllowFailure('./scripts/platform/adapters/harmony/atoms/long-press.sh', [
  '--x', '120', '--y', '240', '--duration-ms', '2.5',
]);
assert.strictEqual(harmonyFractionalDuration.status, 2);
assert.match(harmonyFractionalDuration.stderr, /正整数/);
const harmonyExcessiveDuration = runAllowFailure('./scripts/platform/adapters/harmony/atoms/long-press.sh', [
  '--x', '120', '--y', '240', '--duration-ms', '61001',
]);
assert.strictEqual(harmonyExcessiveDuration.status, 2);
assert.match(harmonyExcessiveDuration.stderr, /61000/);

assert.strictEqual(describeActionConstraints('harmony').inputText.coordinates, 'required');
assert.strictEqual(describeActionConstraints('android').inputText.coordinates, 'optional-target');
assert.strictEqual(describeActionConstraints('ios').inputText.coordinates, 'optional-target');
for (const platform of ['android', 'ios']) {
  assert.strictEqual(validateActionExecution({
    type: 'inputText', x: 120, y: 240, text: 'account-value', mode: 'replace',
    coordinateSource: 'layout', coordinateEvidence: '控件树 bounds', coordinateArtifactRef: 'layouts/current.xml',
  }, { platform, scope: 'case-business' }).x, 120);
  assert.strictEqual(validateActionExecution({
    type: 'inputText', text: 'focused-value', mode: 'replace',
  }, { platform, scope: 'case-business' }).text, 'focused-value');
}
assert.ok(describeActionConstraints('ios').actionTypes.includes('dismissKeyboard'));
assert.ok(!describeActionConstraints('android').actionTypes.includes('dismissKeyboard'));
assert.strictEqual(validateActionExecution({
  type: 'doubleTap', x: 10, y: 20, intervalMs: 120,
  coordinateSource: 'layout', coordinateEvidence: '控件树 bounds', coordinateArtifactRef: 'layouts/current.xml',
}, { platform: 'android', scope: 'case-business' }).intervalMs, 120);
assert.throws(() => validateActionExecution({
  type: 'doubleTap', x: 10, y: 20, intervalMs: 10,
  coordinateSource: 'layout', coordinateEvidence: '控件树 bounds', coordinateArtifactRef: 'layouts/current.xml',
}, { platform: 'android', scope: 'case-business' }), /intervalMs/);
assert.strictEqual(normalizeActionProposal({ type: 'inputText', text: 'x', mode: 'addition' }).action.mode, 'append');
assert.strictEqual(normalizeActionProposal({ type: 'inputText', text: 'x' }).action.mode, 'replace');
assert.throws(() => validateActionExecution({
  type: 'tap', x: 10, y: 20, coordinateSource: 'layout',
}, { platform: 'android', scope: 'case-business' }), /coordinateEvidence is required/);
assert.throws(() => validateActionExecution({
  type: 'restartApp', reason: 'business navigation',
}, { platform: 'harmony', scope: 'case-business' }), /restartApp is not allowed for case-business/);

assert.deepStrictEqual(classifyRuntimeDisplay(2232, 1008), {
  displayClass: 'PHONE_LIKE', width: 2232, height: 1008, aspectRatio: 2.2143, threshold: 1.7,
});
assert.strictEqual(classifyRuntimeDisplay(1008, 2232).displayClass, 'PHONE_LIKE');
assert.strictEqual(classifyRuntimeDisplay(1600, 1200).displayClass, 'TABLET_LIKE');
assert.strictEqual(classifyRuntimeDisplay(0, 1200).displayClass, 'UNKNOWN');
assert.strictEqual(startupDisplayRequirement(undefined, 'triplefold', {
  platform: 'harmony', runtimeDisplayClass: 'PHONE_LIKE',
}).reason, 'RUNTIME_DISPLAY_PHONE_LIKE');
assert.strictEqual(startupDisplayRequirement(undefined, 'phone', {
  platform: 'harmony', runtimeDisplayClass: 'TABLET_LIKE',
}).reason, 'RUNTIME_DISPLAY_TABLET_LIKE');

const androidRestartWithoutDisplay = normalizeRestartResult({
  command: { status: 'ACCEPTED' }, coldStartVerified: true, platform: 'android',
}, { platform: 'android' });
assert.strictEqual(androidRestartWithoutDisplay.coldStartVerified, true);
assert.strictEqual(androidRestartWithoutDisplay.startupDisplayVerified, true);
assert.strictEqual(androidRestartWithoutDisplay.startupDisplayValidation.reason, 'POLICY_PRESERVE');
const androidRestartWithSkippedDisplay = normalizeRestartResult({
  command: { status: 'ACCEPTED' },
  coldStartVerified: true,
  platform: 'android',
  startupDisplay: {
    status: 'SKIPPED', verified: false, requestedOrientation: 'preserve', enforcement: 'none',
    appliesTo: [], required: false, skippedReason: 'POLICY_PRESERVE',
  },
}, { platform: 'android' });
assert.strictEqual(androidRestartWithSkippedDisplay.startupDisplayVerified, true);
assert.strictEqual(normalizeRestartResult({ command: { status: 'ACCEPTED' }, platform: 'android' }, { platform: 'android' }).coldStartVerified, false);
assert.strictEqual(normalizeRestartResult({
  command: { status: 'ACCEPTED' }, coldStartVerified: true, platform: 'harmony',
}, { platform: 'harmony', deviceFormFactor: 'phone' }).startupDisplayVerified, false);

assert.throws(() => normalizeEnvironmentBinding({
  platform: 'android', device: 'fixture-device', appId: 'com.example.android', entry: '.MainActivity',
}, 'android'), /use binding.deviceId/);
const fixtureEnvironmentSnapshot = {
  binding: { platform: 'android', device: 'fixture-device', appId: 'com.example.android', entry: '.MainActivity' },
  probe: null,
  dependencies: {},
  confirmedAt: '2026-08-27T10:00:00.000+08:00',
};
assert.throws(() => validateExecutionEnvironment({
  environmentSnapshot: fixtureEnvironmentSnapshot,
  environmentSha: executionEnvironmentSha(fixtureEnvironmentSnapshot),
}, 'android'), /use binding.deviceId/);

const originalSpawnSync = childProcess.spawnSync;
try {
  childProcess.spawnSync = (command, args) => {
    assert.ok(command.endsWith('/scripts/platform/probe-env.sh'));
    assert.deepStrictEqual(args, ['--platform', 'android', '--device', 'android-device']);
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify({ ready: true, devices: [{ id: 'android-device' }] }),
    };
  };
  const androidBatchProbe = probeSession({ binding: { platform: 'android', deviceId: 'android-device' } });
  assert.strictEqual(androidBatchProbe.ok, true);
  assert.deepStrictEqual(androidBatchProbe.binding, { platform: 'android', deviceId: 'android-device' });
} finally {
  childProcess.spawnSync = originalSpawnSync;
}

assert.strictEqual(restartTimeoutMs({ platform: 'android' }), 60000);
assert.strictEqual(restartTimeoutMs({ platform: 'ios' }), 240000);
assert.strictEqual(restartTimeoutMs({ platform: 'ios', wdaLaunchTimeout: 180000 }), 240000);
assert.strictEqual(runtimeTimeoutMs({ platform: 'android' }, 'acquire'), 60000);
assert.strictEqual(runtimeTimeoutMs({ platform: 'ios' }, 'acquire'), 210000);
assert.strictEqual(runtimeTimeoutMs({ platform: 'ios', wdaLaunchTimeout: 180000 }, 'acquire'), 210000);
assert.strictEqual(runtimeTimeoutMs({ platform: 'ios' }, 'release'), 120000);
try {
  childProcess.spawnSync = (command, args, options) => {
    assert.ok(command.endsWith('/scripts/platform/runtime.sh'));
    assert.strictEqual(options.timeout, 210000);
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify({ ok: true, status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED' }),
    };
  };
  const runtime = createDeviceSessionAdapter().acquirePlatformRuntime({
    binding: { platform: 'ios', deviceId: 'ios-device', appId: 'com.example.ios', wdaLaunchTimeout: 180000 },
    ownerKey: 'runtime-timeout-test',
  });
  assert.strictEqual(runtime.ok, true);
} finally {
  childProcess.spawnSync = originalSpawnSync;
}
try {
  childProcess.spawnSync = (command, args, options) => {
    assert.ok(command.endsWith('/scripts/platform/action.sh'));
    assert.ok(args.includes('--wda-launch-timeout'));
    assert.strictEqual(options.timeout, 240000);
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify({ command: { status: 'ACCEPTED' }, coldStartVerified: true, platform: 'ios' }),
    };
  };
  const restart = restartApp({ binding: {
    platform: 'ios', deviceId: 'ios-device', appId: 'com.example.ios', wdaLaunchTimeout: 180000,
  } });
  assert.strictEqual(restart.ok, true);
  assert.strictEqual(restart.coldStartVerified, true);
} finally {
  childProcess.spawnSync = originalSpawnSync;
}
try {
  childProcess.spawnSync = () => ({
    status: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawnSync action.sh ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  });
  const timedOut = runDeviceAdapter('/tmp/action.sh', [], 195000);
  assert.strictEqual(timedOut.ok, false);
  assert.match(timedOut.reason, /^DEVICE_ADAPTER_TIMEOUT:/);
  assert.match(timedOut.reason, /195000ms/);
  assert.strictEqual(timedOut.timeoutMs, 195000);
  assert.strictEqual(timedOut.diagnostic.code, 'DEVICE_ADAPTER_TIMEOUT');
} finally {
  childProcess.spawnSync = originalSpawnSync;
}
try {
  childProcess.spawnSync = () => ({ status: 2, signal: null, stdout: '', stderr: 'adapter failed' });
  const empty = runDeviceAdapter('/tmp/action.sh', [], 60000);
  assert.strictEqual(empty.ok, false);
  assert.match(empty.reason, /^DEVICE_ADAPTER_OUTPUT_EMPTY:/);
  assert.match(empty.reason, /adapter failed/);
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

const iosLayoutTap = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'tap',
  '--x', '120', '--y', '240', '--coordinate-source', 'layout',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.deepStrictEqual(iosLayoutTap.deviceExecution.dispatchedPoint, {
  x: 120,
  y: 240,
  viewport: { width: 393, height: 852 },
});

const iosTargetedInput = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'inputText',
  '--x', '120', '--y', '240', '--text', 'account-value', '--mode', 'replace',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosTargetedInput.action, 'inputText');
assert.strictEqual(iosTargetedInput.inputTarget, 'target-point');
assert.deepStrictEqual(iosTargetedInput.deviceExecution.dispatchedPoint, {
  x: 120,
  y: 240,
  viewport: { width: 393, height: 852 },
});
const iosFocusedInput = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'inputText',
  '--text', 'focused-value', '--mode', 'replace',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosFocusedInput.inputTarget, 'current-focus');
assert.strictEqual(iosFocusedInput.deviceExecution.dispatchedPoint, undefined);

const iosDoubleTap = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'doubleTap',
  '--x', '120', '--y', '240', '--interval-ms', '90', '--coordinate-source', 'layout',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosDoubleTap.action, 'doubleTap');
assert.strictEqual(iosDoubleTap.intervalMs, 90);
assert.strictEqual(iosDoubleTap.deviceExecution.dispatchedPoint.x, 120);

const iosDuringDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-during-'));
const iosDuring = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'longPress',
  '--x', '120', '--y', '240', '--duration-ms', '5000',
  '--capture-out', iosDuringDir, '--capture-label', 'during-test', '--capture-at-ms', '4000',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosDuring.action, 'longPress');
assert.strictEqual(iosDuring.durationMs, 5000);
assert.deepStrictEqual(iosDuring.duringActionCapture, {
  capturedAtMs: 4000,
  artifacts: { screenshot: 'screenshots/during-test.png' },
});
assert.ok(fs.existsSync(path.join(iosDuringDir, 'screenshots', 'during-test.png')));

const iosDismissKeyboard = JSON.parse(run('./scripts/platform/adapters/ios/action.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--type', 'dismissKeyboard',
], { env: { ...process.env, MAVT_IOS_FAKE: '1' } }));
assert.strictEqual(iosDismissKeyboard.command.status, 'ACCEPTED');
assert.strictEqual(iosDismissKeyboard.deviceExecution.status, 'UNVERIFIED');
assert.strictEqual(iosDismissKeyboard.action, 'dismissKeyboard');
const iosObservationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-observe-'));
const iosObservation = JSON.parse(run('./scripts/platform/adapters/ios/observe.sh', [
  '--device', 'ios-device', '--app', 'com.example.ios', '--out', iosObservationDir, '--label', 'signals',
], { env: { ...process.env, MAVT_IOS_FAKE: '1', MAVT_IOS_FAKE_KEYBOARD_SHOWN: '1' } }));
assert.strictEqual(iosObservation.technicalSignals.keyboardShown, true);
assert.deepStrictEqual(iosObservation.technicalSignals.windowRect, { x: 0, y: 0, width: 393, height: 852 });
assert.deepStrictEqual(iosObservation.technicalSignals.captureTiming.order, ['layout', 'screenshot']);
assert.ok(Date.parse(iosObservation.technicalSignals.captureTiming.layoutCompletedAt)
  <= Date.parse(iosObservation.technicalSignals.captureTiming.screenshotCompletedAt));
assert.ok(iosObservation.technicalSignals.captureTiming.spanMs >= 0);

for (const relative of [
  '../platform/adapters/android/observe.sh',
  '../platform/adapters/harmony/observe.sh',
]) {
  const source = fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
  const layoutIndex = source.indexOf('"$atoms_dir/dump-tree.sh"');
  const screenshotIndex = source.indexOf('"$atoms_dir/screenshot.sh"');
  assert.ok(layoutIndex >= 0 && screenshotIndex > layoutIndex, `${relative}: layout must be captured before screenshot`);
  assert.match(source, /captureTiming/);
}
const iosDriverSource = fs.readFileSync(path.resolve(__dirname, '../platform/adapters/ios/lib/ios-driver.js'), 'utf8');
const iosObserveSource = iosDriverSource.slice(iosDriverSource.indexOf('async function runObserve'), iosDriverSource.indexOf('async function waitForRuntimeAppState'));
assert.ok(iosObserveSource.indexOf('`/session/${sessionId}/source`')
  < iosObserveSource.indexOf('`/session/${sessionId}/screenshot`'), 'iOS source must be captured before screenshot');
assert.throws(() => validateActionExecution({ type: 'dismissKeyboard' }, {
  platform: 'android', scope: 'case-business',
}), /dismissKeyboard is not allowed/);

console.log('platform-contract passed');
