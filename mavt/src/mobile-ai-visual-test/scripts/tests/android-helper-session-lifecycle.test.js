#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { invokeScreenshotCapture } = require('../platform/device-port');
const {
  androidHelperAdapterEnvironment,
} = require('../session/android-helper-session-service');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-helper-session-'));
const workspace = path.join(root, 'workspace');
const batchDir = path.join(workspace, 'runs', 'batch-helper-session');
const execDir = path.join(batchDir, 'executions', 'execution-helper-session');
const cacheDir = path.join(root, 'secure-cache');
const sessionStatePath = path.join(cacheDir, 'helper-session.json');
fs.mkdirSync(execDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(sessionStatePath, '{}', { mode: 0o600 });

const binding = {
  platform: 'android', deviceId: 'android-device', appId: 'com.example.android',
  entry: '.MainActivity', androidUiBackend: 'helper',
};
const sessionRef = {
  schemaVersion: 2,
  batchId: 'batch-helper-session',
  statePath: path.join(batchDir, 'batch.json'),
  lockPath: path.join(batchDir, 'batch.lock'),
  eventsPath: path.join(batchDir, 'events.jsonl'),
  platformRuntimePath: path.join(batchDir, 'platform-runtime.json'),
};
const ownerKey = 'batch-owner-helper-session';

writeJsonAtomic(sessionRef.statePath, { batchId: sessionRef.batchId, ownerKey });
writeJsonAtomic(path.join(execDir, 'runtime.json'), { schemaVersion: 1, sessionRef });

function writeRuntime(overrides = {}) {
  writeJsonAtomic(sessionRef.platformRuntimePath, {
    schemaVersion: 1,
    type: 'batchPlatformRuntime',
    batchId: sessionRef.batchId,
    platform: 'android',
    bindingSha: bindingSha(binding),
    ownerKey,
    status: 'ACTIVE',
    ownership: 'FRAMEWORK_MANAGED',
    resource: {
      androidHelper: {
        backend: 'helper', sessionId: 'helper-session-1', sessionStatePath,
        protocolVersion: 2, versionCode: 7, generation: 1,
      },
    },
    ...overrides,
  });
}

writeRuntime();
const activeEnv = androidHelperAdapterEnvironment(execDir, binding, {
  baseEnv: { MAVT_ANDROID_HELPER_SESSION_STATE: '/stale/session.json', KEEP_ME: 'yes' },
});
assert.strictEqual(activeEnv.MAVT_ANDROID_HELPER_SESSION_STATE, sessionStatePath);
assert.strictEqual(activeEnv.KEEP_ME, 'yes');

const autoBinding = { ...binding, androidUiBackend: 'auto' };
writeRuntime({
  bindingSha: bindingSha(autoBinding),
  status: 'NOT_REQUIRED', ownership: 'NONE',
  resource: { androidHelper: { backend: 'uiautomator' } },
});
const fallbackEnv = androidHelperAdapterEnvironment(execDir, autoBinding, {
  baseEnv: { MAVT_ANDROID_HELPER_SESSION_STATE: '/stale/session.json' },
});
assert.strictEqual(Object.hasOwn(fallbackEnv, 'MAVT_ANDROID_HELPER_SESSION_STATE'), false);
const legacyBinding = { ...binding, androidUiBackend: 'uiautomator' };
writeRuntime({
  bindingSha: bindingSha(legacyBinding),
  status: 'NOT_REQUIRED', ownership: 'NONE',
  resource: { androidHelper: { backend: 'uiautomator' } },
});
const legacyEnv = androidHelperAdapterEnvironment(execDir, legacyBinding, {
  baseEnv: { MAVT_ANDROID_HELPER_SESSION_STATE: '/stale/session.json' },
});
assert.strictEqual(Object.hasOwn(legacyEnv, 'MAVT_ANDROID_HELPER_SESSION_STATE'), false);
fs.unlinkSync(sessionRef.platformRuntimePath);
const historicalBinding = {
  platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
};
const historicalEnv = androidHelperAdapterEnvironment(execDir, historicalBinding, {
  baseEnv: { MAVT_ANDROID_HELPER_SESSION_STATE: '/stale/session.json' },
});
assert.strictEqual(Object.hasOwn(historicalEnv, 'MAVT_ANDROID_HELPER_SESSION_STATE'), false);
assert.throws(() => androidHelperAdapterEnvironment(execDir, autoBinding), /platform runtime type is invalid/);
writeRuntime({
  status: 'NOT_REQUIRED', ownership: 'NONE',
  resource: { androidHelper: { backend: 'uiautomator' } },
});
assert.throws(() => androidHelperAdapterEnvironment(execDir, binding), /strict helper policy requires an active Helper runtime/);

for (const [name, mutate, pattern] of [
  ['batchId', (value) => { value.batchId = 'other-batch'; }, /batchId/],
  ['ownerKey', (value) => { value.ownerKey = 'other-owner'; }, /ownerKey/],
  ['bindingSha', (value) => { value.bindingSha = 'target-binding-wrong'; }, /bindingSha/],
  ['platform', (value) => { value.platform = 'ios'; }, /platform/],
  ['ownership', (value) => { value.ownership = 'EXTERNAL'; }, /ownership/],
]) {
  writeRuntime();
  const value = JSON.parse(fs.readFileSync(sessionRef.platformRuntimePath, 'utf8'));
  mutate(value);
  writeJsonAtomic(sessionRef.platformRuntimePath, value);
  assert.throws(() => androidHelperAdapterEnvironment(execDir, binding), pattern, name);
}

writeRuntime({
  resource: { androidHelper: { backend: 'helper', sessionStatePath: path.join(execDir, 'copied-secret.json') } },
});
assert.throws(() => androidHelperAdapterEnvironment(execDir, binding), /outside the execution and workspace/);
writeRuntime({
  resource: { androidHelper: { backend: 'helper', sessionStatePath: 'relative/session.json' } },
});
assert.throws(() => androidHelperAdapterEnvironment(execDir, binding), /absolute/);

writeRuntime();
const execution = {
  schemaVersion: 14,
  executionId: 'execution-helper-session',
  batchId: sessionRef.batchId,
  platform: 'android',
  startedAt: '2026-09-23T10:00:00.000Z',
  targetBinding: binding,
  targetBindingSha: bindingSha(binding),
  batchContractSha: 'batch-contract-helper-session',
};
writeJsonAtomic(path.join(execDir, 'execution.json'), execution);
writeJsonAtomic(path.join(execDir, 'binding.snapshot.json'), {
  schemaVersion: 1,
  binding,
  bindingSha: execution.targetBindingSha,
  batchContractSha: execution.batchContractSha,
});
let runnerEnvironment;
const captured = invokeScreenshotCapture(execDir, {
  context: { execution }, operationId: 'capture-helper-session',
}, {
  now: '2026-09-23T10:00:01.000Z',
  runner(_command, args, options) {
    runnerEnvironment = options.env;
    const out = args[args.indexOf('--out') + 1];
    const screenshot = 'screenshots/capture-helper-session.png';
    fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(out, screenshot), PNG);
    return { status: 0, stderr: '', stdout: JSON.stringify({
      schemaVersion: 1, type: 'capture', platform: 'android',
      device: { id: binding.deviceId }, app: { appId: binding.appId },
      artifacts: { screenshot },
    }) };
  },
});
assert.strictEqual(captured.evidence.width, 1);
assert.strictEqual(runnerEnvironment.MAVT_ANDROID_HELPER_SESSION_STATE, sessionStatePath);
assert.strictEqual(JSON.stringify(runnerEnvironment).includes('secret-token'), false);

fs.rmSync(root, { recursive: true, force: true });
console.log('android helper session lifecycle passed');
