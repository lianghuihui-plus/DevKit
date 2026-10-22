#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { invokeDeviceOperation } = require('../platform/device-port');
const { recordObservationError } = require('../platform/adapters/ios/lib/ios-driver');
const {
  isInvalidIosSessionFailure,
  refreshThroughAdapter,
  withCurrentIosSession,
} = require('../session/ios-session-service');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-session-'));
const batchDir = path.join(root, 'runs', 'batch-ios-session');
const statePath = path.join(batchDir, 'batch.json');
const lockPath = path.join(batchDir, 'batch.lock');
const eventsPath = path.join(batchDir, 'events.jsonl');
const platformRuntimePath = path.join(batchDir, 'platform-runtime.json');
fs.mkdirSync(batchDir, { recursive: true });
writeJsonAtomic(statePath, { batchId: 'batch-ios-session' });

const sessionRef = {
  schemaVersion: 2,
  batchId: 'batch-ios-session',
  statePath,
  lockPath,
  eventsPath,
  platformRuntimePath,
};
const binding = {
  platform: 'ios',
  deviceId: 'ios-device',
  appId: 'com.example.ios',
  deviceType: 'realDevice',
  appiumServer: 'http://127.0.0.1:4723',
};

function resetRuntime(sessionId = 'expired-session', generation = 1) {
  writeJsonAtomic(platformRuntimePath, {
    schemaVersion: 1,
    type: 'batchPlatformRuntime',
    batchId: sessionRef.batchId,
    platform: 'ios',
    status: 'ACTIVE',
    ownership: 'FRAMEWORK_MANAGED',
    resource: {
      session: {
        sessionId,
        server: binding.appiumServer,
        ownership: 'FRAMEWORK_MANAGED',
        capabilities: { platformName: 'iOS' },
        generation,
      },
    },
  });
}

function invalidSession(message = '404 invalid session id: A session is either terminated or not started') {
  const error = new Error(message);
  error.code = 'DEVICE_ADAPTER_FAILED';
  error.adapterDiagnostics = { status: 1, stderr: message };
  return error;
}

resetRuntime();
let observeCalls = 0;
let refreshCalls = 0;
const observed = withCurrentIosSession(sessionRef, 'OBSERVE', (session) => {
  observeCalls += 1;
  if (observeCalls === 1) {
    assert.strictEqual(session.sessionId, 'expired-session');
    throw invalidSession();
  }
  assert.strictEqual(session.sessionId, 'replacement-session');
  assert.strictEqual(session.generation, 2);
  return { ok: true, sessionId: session.sessionId };
}, {
  binding,
  now: '2026-09-14T10:02:00.000Z',
  refreshSession: ({ previousSession }) => {
    refreshCalls += 1;
    assert.strictEqual(previousSession.sessionId, 'expired-session');
    return {
      sessionId: 'replacement-session',
      server: binding.appiumServer,
      ownership: 'FRAMEWORK_MANAGED',
      capabilities: { platformName: 'iOS' },
    };
  },
});
assert.deepStrictEqual(observed, { ok: true, sessionId: 'replacement-session' });
assert.strictEqual(observeCalls, 2);
assert.strictEqual(refreshCalls, 1);
let runtime = JSON.parse(fs.readFileSync(platformRuntimePath, 'utf8'));
assert.strictEqual(runtime.resource.session.sessionId, 'replacement-session');
assert.strictEqual(runtime.resource.session.generation, 2);
assert.strictEqual(runtime.resource.session.refreshedAt, '2026-09-14T10:02:00.000Z');
const recoveryEvents = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
assert.strictEqual(recoveryEvents.some((event) => event.type === 'iosSessionInvalidated'
  && event.reason.includes('invalid session id')), true);
assert.strictEqual(recoveryEvents.some((event) => event.type === 'iosSessionRefreshed'
  && event.generation === 2), true);

resetRuntime();
let repeatedObserveCalls = 0;
assert.throws(() => withCurrentIosSession(sessionRef, 'OBSERVE', () => {
  repeatedObserveCalls += 1;
  throw invalidSession(`invalid session id attempt ${repeatedObserveCalls}`);
}, {
  binding,
  refreshSession: () => ({
    sessionId: 'replacement-session', server: binding.appiumServer, ownership: 'FRAMEWORK_MANAGED', capabilities: {},
  }),
}), (error) => error.message.includes('attempt 2'));
assert.strictEqual(repeatedObserveCalls, 2);

resetRuntime();
let actionCalls = 0;
let actionRefreshCalls = 0;
assert.throws(() => withCurrentIosSession(sessionRef, 'ACTION', () => {
  actionCalls += 1;
  throw invalidSession('POST /actions -> 404: invalid session id');
}, {
  binding,
  refreshSession: () => {
    actionRefreshCalls += 1;
    return { sessionId: 'must-not-be-used' };
  },
}), (error) => error.actionOutcomeUnknown === true && error.message.includes('invalid session id'));
assert.strictEqual(actionCalls, 1);
assert.strictEqual(actionRefreshCalls, 0);
assert.strictEqual(JSON.parse(fs.readFileSync(platformRuntimePath, 'utf8')).resource.session.sessionId, 'expired-session');

resetRuntime('current-session', 4);
let concurrentObserveCalls = 0;
const concurrentResult = withCurrentIosSession(sessionRef, 'OBSERVE', (session) => {
  concurrentObserveCalls += 1;
  if (concurrentObserveCalls === 1) throw invalidSession();
  assert.strictEqual(session.sessionId, 'concurrent-session');
  return { ok: true, sessionId: session.sessionId };
}, {
  binding,
  beforeRefreshCommit: () => {
    const changed = JSON.parse(fs.readFileSync(platformRuntimePath, 'utf8'));
    changed.resource.session = { ...changed.resource.session, sessionId: 'concurrent-session', generation: 5 };
    writeJsonAtomic(platformRuntimePath, changed);
  },
  refreshSession: () => ({ sessionId: 'candidate-session', server: binding.appiumServer, ownership: 'FRAMEWORK_MANAGED', capabilities: {} }),
});
assert.deepStrictEqual(concurrentResult, { ok: true, sessionId: 'concurrent-session' });
runtime = JSON.parse(fs.readFileSync(platformRuntimePath, 'utf8'));
assert.strictEqual(runtime.resource.session.sessionId, 'concurrent-session');
assert.strictEqual(runtime.resource.session.generation, 5);

assert.strictEqual(isInvalidIosSessionFailure(invalidSession()), true);
assert.strictEqual(isInvalidIosSessionFailure(new Error('OBSERVATION_SCREENSHOT_INVALID')), false);
for (const channel of ['layout', 'windowRect']) {
  assert.throws(() => recordObservationError([], channel, invalidSession()),
    (error) => error.message.includes(`[${channel}]`) && error.message.includes('invalid session id'));
}
assert.throws(() => recordObservationError([], 'screenshot', new Error('Appium screenshot request failed'), { required: true }),
  (error) => error.message.includes('[screenshot] Appium screenshot request failed'));
const optionalErrors = [];
recordObservationError(optionalErrors, 'layout', new Error('optional layout unavailable'));
assert.deepStrictEqual(optionalErrors, ['[layout] optional layout unavailable']);

resetRuntime('lock-session', 6);
withCurrentIosSession(sessionRef, 'OBSERVE', () => {
  assert.throws(() => withFileLock(lockPath, () => {}), (error) => error.code === 'EXECUTION_LOCKED');
  return { ok: true };
}, { binding });

const previousFake = process.env.MAVT_IOS_FAKE;
process.env.MAVT_IOS_FAKE = '1';
try {
  resetRuntime('fake-expired-session', 7);
  const fakeRuntime = JSON.parse(fs.readFileSync(platformRuntimePath, 'utf8'));
  const replacement = refreshThroughAdapter(binding, fakeRuntime);
  assert.match(replacement.sessionId, /^fake-session-refreshed-/);
  assert.strictEqual(replacement.ownership, 'FRAMEWORK_MANAGED');
} finally {
  if (previousFake === undefined) delete process.env.MAVT_IOS_FAKE;
  else process.env.MAVT_IOS_FAKE = previousFake;
}

const execDir = path.join(root, 'execution-ios-session');
fs.mkdirSync(execDir, { recursive: true });
const execution = {
  executionId: 'execution-ios-session',
  batchId: sessionRef.batchId,
  platform: 'ios',
  startedAt: '2026-09-14T10:00:00.000Z',
  targetBinding: binding,
  targetBindingSha: bindingSha(binding),
  batchContractSha: 'batch-contract-test',
};
writeJsonAtomic(path.join(execDir, 'execution.json'), execution);
writeJsonAtomic(path.join(execDir, 'binding.snapshot.json'), {
  schemaVersion: 1,
  binding,
  bindingSha: execution.targetBindingSha,
  batchContractSha: execution.batchContractSha,
});
writeJsonAtomic(path.join(execDir, 'runtime.json'), { schemaVersion: 1, executionId: execution.executionId, sessionRef });

resetRuntime();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let deviceObserveCalls = 0;
let deviceRefreshCalls = 0;
const observation = invokeDeviceOperation(execDir, {
  context: { execution },
  operationId: 'observation-0001',
  request: { purpose: 'CURRENT_SCENE' },
}, 'OBSERVE', {
  now: '2026-09-14T10:02:00.000Z',
  runner: (_command, args, options) => {
    if (options.kind === 'SESSION_REFRESH') {
      deviceRefreshCalls += 1;
      return { status: 0, stderr: '', stdout: JSON.stringify({
        schemaVersion: 1,
        type: 'platformRuntimeResult',
        platform: 'ios',
        operation: 'refresh-session',
        ok: true,
        status: 'ACTIVE',
        ownership: 'FRAMEWORK_MANAGED',
        platformSession: { sessionId: 'device-port-session', server: binding.appiumServer, ownership: 'FRAMEWORK_MANAGED', capabilities: {} },
      }) };
    }
    deviceObserveCalls += 1;
    const sessionId = args[args.indexOf('--appium-session-id') + 1];
    if (deviceObserveCalls === 1) {
      assert.strictEqual(sessionId, 'expired-session');
      return { status: 1, stdout: '', stderr: 'GET /screenshot -> 404: invalid session id' };
    }
    assert.strictEqual(sessionId, 'device-port-session');
    const out = args[args.indexOf('--out') + 1];
    const screenshot = 'screenshots/observation-0001.png';
    fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(out, screenshot), png);
    return { status: 0, stderr: '', stdout: JSON.stringify({
      schemaVersion: 1,
      type: 'observation',
      platform: 'ios',
      device: { id: binding.deviceId },
      app: { appId: binding.appId, inTargetApp: true },
      artifacts: { screenshot, layout: null, logs: [] },
    }) };
  },
});
assert.strictEqual(observation.binding.appiumSessionId, 'device-port-session');
assert.strictEqual(deviceObserveCalls, 2);
assert.strictEqual(deviceRefreshCalls, 1);

resetRuntime();
let deviceActionCalls = 0;
let actionSessionRefreshCalls = 0;
assert.throws(() => invokeDeviceOperation(execDir, {
  context: { execution },
  operationId: 'action-0001',
  action: { type: 'tap', x: 10, y: 20 },
  request: {},
}, 'ACTION', {
  now: '2026-09-14T10:02:00.000Z',
  runner: (_command, _args, options) => {
    if (options.kind === 'SESSION_REFRESH') {
      actionSessionRefreshCalls += 1;
      throw new Error('action failure must not trigger eager refresh');
    }
    deviceActionCalls += 1;
    return { status: 1, stderr: 'POST /actions -> 404: invalid session id', stdout: JSON.stringify({
      schemaVersion: 2,
      type: 'actionResult',
      platform: 'ios',
      action: 'tap',
      device: { id: binding.deviceId },
      app: { appId: binding.appId },
      command: { status: 'REJECTED', transport: 'APPIUM_W3C', message: 'POST /actions -> 404: invalid session id' },
      deviceExecution: { status: 'NOT_EXECUTED', verification: 'NONE', actualTouchPoint: null },
      adapterError: { stage: 'atom', exitCode: 1, message: 'POST /actions -> 404: invalid session id' },
    }) };
  },
}), (error) => error.code === 'IOS_ACTION_OUTCOME_UNKNOWN'
  && error.actionOutcomeUnknown === true
  && error.message.includes('invalid session id')
  && !error.message.includes('OBSERVATION_SCREENSHOT'));
assert.strictEqual(deviceActionCalls, 1);
assert.strictEqual(actionSessionRefreshCalls, 0);

fs.rmSync(root, { recursive: true, force: true });
console.log('ios session lifecycle passed');
