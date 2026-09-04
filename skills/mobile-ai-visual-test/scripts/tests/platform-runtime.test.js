#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireBatchPlatformRuntime,
  releaseBatchPlatformRuntime,
  runtimePaths,
} = require('../batch/platform-runtime');
const { execute: executeBatch } = require('../batch');
const { batchPaths, initializeBatch } = require('../batch/core');
const { buildContract } = require('../build-agent-contract');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const {
  acquireAppium,
  releaseAppium,
} = require('../platform/adapters/ios/lib/service-lifecycle');
const { withSession } = require('../platform/adapters/ios/lib/appium-client');
const {
  acquireIosRuntime,
  releaseIosRuntime,
} = require('../platform/adapters/ios/lib/runtime-lifecycle');
const {
  acquireWda,
  commandMatchesWda,
  releaseWda,
} = require('../platform/adapters/ios/lib/wda-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const T0 = '2026-08-26T10:00:00.000+08:00';
const BINDING = Object.freeze({ platform: 'harmony', deviceId: 'runtime-device', appId: 'com.example.runtime', entry: 'EntryAbility' });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-platform-runtime-'));
const implementationSha = buildContract({
  skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony',
}).implementationSha;

function fixture(name) {
  const root = path.join(temp, name);
  createTestWorkspace(root);
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  const sourceText = `验证 ${name} 平台运行资源生命周期`;
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), createCaseContract({
    caseKey, title: name, sourceText, importPath: `/fixtures/${name}.md`,
  }));
  const batchId = `batch-${name}`;
  createTestExecutionRequest(root, batchId, BINDING, [{ caseKey, caseDir }], { now: T0 });
  initializeBatch({ workspaceRoot: root, batchId, implementationSha, now: T0 });
  return { root, batchId };
}

function terminal(fix) {
  const paths = batchPaths(fix.root, fix.batchId);
  const state = readJson(paths.state);
  writeJsonAtomic(paths.state, { ...state, status: 'BLOCKED', failureCode: 'TEST_STOP', reason: 'test terminal state' });
}

function common(fix, adapter) {
  return { workspaceRoot: fix.root, batchId: fix.batchId, implementationSha, adapter, now: T0 };
}

const noResource = fixture('no-resource');
const noResourceAdapter = {
  acquirePlatformRuntime: () => ({ ok: true, status: 'NOT_REQUIRED', ownership: 'NONE' }),
  releasePlatformRuntime: () => ({ ok: true, status: 'NOT_REQUIRED', ownership: 'NONE' }),
};
assert.strictEqual(acquireBatchPlatformRuntime(common(noResource, noResourceAdapter)).status, 'NOT_REQUIRED');
terminal(noResource);
assert.strictEqual(releaseBatchPlatformRuntime(common(noResource, noResourceAdapter)).alreadyFinalized, true);

const managed = fixture('managed');
let managedReleaseCalls = 0;
const managedAdapter = {
  acquirePlatformRuntime: ({ ownerKey }) => ({
    ok: true,
    status: 'ACTIVE',
    ownership: 'FRAMEWORK_MANAGED',
    resource: { server: 'http://127.0.0.1:4723', pid: 1234, ownerToken: 'managed-token', ownerKey },
  }),
  releasePlatformRuntime: ({ runtime }) => {
    managedReleaseCalls += 1;
    assert.strictEqual(runtime.ownership, 'FRAMEWORK_MANAGED');
    return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' };
  },
};
assert.strictEqual(acquireBatchPlatformRuntime(common(managed, managedAdapter)).ownership, 'FRAMEWORK_MANAGED');
terminal(managed);
assert.strictEqual(releaseBatchPlatformRuntime(common(managed, managedAdapter)).status, 'RELEASED');
assert.strictEqual(releaseBatchPlatformRuntime(common(managed, managedAdapter)).alreadyFinalized, true);
assert.strictEqual(managedReleaseCalls, 1);

const external = fixture('external');
let externalStopAttempted = false;
const externalAdapter = {
  acquirePlatformRuntime: () => ({
    ok: true, status: 'ACTIVE', ownership: 'EXTERNAL', resource: { server: 'http://127.0.0.1:4723' },
  }),
  releasePlatformRuntime: ({ runtime }) => {
    assert.strictEqual(runtime.ownership, 'EXTERNAL');
    externalStopAttempted = false;
    return { ok: true, status: 'RETAINED', ownership: 'EXTERNAL' };
  },
};
acquireBatchPlatformRuntime(common(external, externalAdapter));
terminal(external);
assert.strictEqual(releaseBatchPlatformRuntime(common(external, externalAdapter)).status, 'RETAINED');
assert.strictEqual(externalStopAttempted, false);

const retry = fixture('retry');
let releaseAttempts = 0;
const retryAdapter = {
  acquirePlatformRuntime: ({ ownerKey }) => ({
    ok: true, status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED', resource: { ownerKey, ownerToken: 'retry-token', pid: 5678 },
  }),
  releasePlatformRuntime: () => {
    releaseAttempts += 1;
    return releaseAttempts === 1
      ? { ok: false, status: 'RELEASE_FAILED', ownership: 'FRAMEWORK_MANAGED', failureCode: 'TEST_RELEASE_FAILED', reason: 'simulated' }
      : { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' };
  },
};
acquireBatchPlatformRuntime(common(retry, retryAdapter));
terminal(retry);
const failedRelease = releaseBatchPlatformRuntime(common(retry, retryAdapter));
assert.strictEqual(failedRelease.status, 'RELEASE_FAILED');
assert.strictEqual(failedRelease.ok, false);
assert.strictEqual(releaseBatchPlatformRuntime(common(retry, retryAdapter)).status, 'RELEASED');
assert.strictEqual(releaseAttempts, 2);
assert.strictEqual(readJson(runtimePaths(batchPaths(retry.root, retry.batchId).batchDir).state).status, 'RELEASED');

const iosRoot = path.join(temp, 'ios-cli');
createTestWorkspace(iosRoot);
const iosCaseKey = `ck-${crypto.createHash('sha256').update('ios-cli').digest('hex').slice(0, 12)}`;
const iosCaseDir = path.join(iosRoot, 'cases', `ios-cli__${iosCaseKey}`);
const iosSource = '验证 iOS 批次终态自动释放框架托管服务';
fs.mkdirSync(iosCaseDir, { recursive: true });
fs.writeFileSync(path.join(iosCaseDir, 'source.md'), iosSource);
writeJsonAtomic(path.join(iosCaseDir, 'case.json'), createCaseContract({
  caseKey: iosCaseKey, title: 'iOS runtime CLI', sourceText: iosSource, importPath: '/fixtures/ios-cli.md',
}));
const iosBatchId = 'batch-ios-cli';
createTestExecutionRequest(iosRoot, iosBatchId, {
  platform: 'ios', deviceId: 'ios-runtime-device', appId: 'com.example.ios.runtime', deviceType: 'realDevice',
}, [{ caseKey: iosCaseKey, caseDir: iosCaseDir }], { now: T0 });
const previousIosFake = process.env.MAVT_IOS_FAKE;
process.env.MAVT_IOS_FAKE = '1';
try {
  executeBatch({ command: 'init', workspace: iosRoot, batchId: iosBatchId });
  const bootstrapped = executeBatch({ command: 'bootstrap', workspace: iosRoot, batchId: iosBatchId });
  assert.strictEqual(bootstrapped.state.status, 'RUNNING');
  const iosBatchPaths = batchPaths(iosRoot, iosBatchId);
  const iosBatchState = readJson(iosBatchPaths.state);
  writeJsonAtomic(iosBatchPaths.state, { ...iosBatchState, status: 'BLOCKED', failureCode: 'TEST_STOP', reason: 'test terminal state' });
  const reconciled = executeBatch({ command: 'reconcile', workspace: iosRoot, batchId: iosBatchId });
  assert.strictEqual(reconciled.action, 'BATCH_BLOCKED');
  assert.strictEqual(reconciled.platformRuntimeCleanup.status, 'RELEASED');
} finally {
  if (previousIosFake === undefined) delete process.env.MAVT_IOS_FAKE;
  else process.env.MAVT_IOS_FAKE = previousIosFake;
}

async function verifyIosAdapterSemantics() {
  const previousFake = process.env.MAVT_IOS_FAKE;
  const previousRuntimeDir = process.env.MAVT_IOS_RUNTIME_DIR;
  process.env.MAVT_IOS_FAKE = '1';
  try {
    const acquired = await acquireAppium({ appiumServer: 'http://127.0.0.1:4723' }, 'fake-batch-owner');
    assert.strictEqual(acquired.ownership, 'FRAMEWORK_MANAGED');
    assert.strictEqual((await releaseAppium({ ...acquired, ownerKey: 'fake-batch-owner' })).status, 'RELEASED');
    assert.strictEqual((await releaseAppium({
      ok: true, status: 'ACTIVE', ownership: 'EXTERNAL', resource: { server: 'http://127.0.0.1:4723' },
    })).status, 'RETAINED');
  } finally {
    if (previousFake === undefined) delete process.env.MAVT_IOS_FAKE;
    else process.env.MAVT_IOS_FAKE = previousFake;
  }

  const wdaRuntimeDir = path.join(temp, 'wda-runtime');
  process.env.MAVT_IOS_RUNTIME_DIR = wdaRuntimeDir;
  const target = {
    device: '00008027-TEST-DEVICE',
    updatedWDABundleId: 'cn.example.WebDriverAgentRunner',
    wdaLocalPort: '8100',
  };
  const wdaCommand = (device = target.device, bundle = target.updatedWDABundleId) => [
    '/usr/bin/xcodebuild',
    '-project /opt/appium-webdriveragent/WebDriverAgent.xcodeproj',
    '-scheme WebDriverAgentRunner',
    `-destination id=${device}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${bundle}`,
    'test-without-building',
  ].join(' ');
  assert.strictEqual(commandMatchesWda(wdaCommand(), { deviceId: target.device, bundleId: target.updatedWDABundleId }), true);
  assert.strictEqual(commandMatchesWda(wdaCommand('OTHER-DEVICE'), { deviceId: target.device, bundleId: target.updatedWDABundleId }), false);
  assert.strictEqual(commandMatchesWda(wdaCommand(target.device, 'cn.example.OtherRunner'), { deviceId: target.device, bundleId: target.updatedWDABundleId }), false);
  assert.strictEqual(commandMatchesWda('xcodebuild -project SomeApp.xcodeproj -scheme Tests', { deviceId: target.device, bundleId: target.updatedWDABundleId }), false);

  function processHarness(initial = []) {
    const processes = new Map(initial.map((item) => [item.pid, { ...item }]));
    const dependencies = {
      listProcesses: () => [...processes.values()],
      processAlive: (pid) => processes.has(pid),
      processCommand: (pid) => processes.get(pid)?.command || '',
      processStartedAt: (pid) => processes.has(pid) ? `start-${pid}` : '',
      stopProcessGroup: async (record) => {
        processes.delete(record.pid);
        return { ok: true, alreadyStopped: false };
      },
    };
    return { add: (item) => processes.set(item.pid, { ...item }), dependencies, processes };
  }
  const wdaProcess = (pid, command = wdaCommand()) => ({ pid, parentPid: 1, processGroupId: pid, command });

  const externalHarness = processHarness([wdaProcess(4101)]);
  const externalWda = acquireWda(target, 'owner-external-baseline', externalHarness.dependencies);
  assert.strictEqual(externalWda.ownership, 'EXTERNAL');
  const externalReleased = await releaseWda(externalWda.resource, 'owner-external-baseline', externalHarness.dependencies);
  assert.strictEqual(externalReleased.status, 'RETAINED');
  assert.strictEqual(externalHarness.processes.has(4101), true);

  fs.rmSync(wdaRuntimeDir, { recursive: true, force: true });
  const managedHarness = processHarness([wdaProcess(4200, wdaCommand('OTHER-DEVICE'))]);
  const pendingWda = acquireWda(target, 'owner-new-wda', managedHarness.dependencies);
  assert.strictEqual(pendingWda.status, 'PENDING');
  managedHarness.add(wdaProcess(4201));
  const managedReleased = await releaseWda(pendingWda.resource, 'owner-new-wda', managedHarness.dependencies);
  assert.strictEqual(managedReleased.status, 'RELEASED');
  assert.strictEqual(managedHarness.processes.has(4201), false);
  assert.strictEqual(managedHarness.processes.has(4200), true);

  fs.rmSync(wdaRuntimeDir, { recursive: true, force: true });
  const historicalHarness = processHarness();
  const historicalPending = acquireWda(target, 'owner-old-batch', historicalHarness.dependencies);
  historicalHarness.add(wdaProcess(4301));
  const firstRelease = await releaseWda(historicalPending.resource, 'owner-old-batch', {
    ...historicalHarness.dependencies,
    stopProcessGroup: async () => ({ ok: false, reason: 'simulated WDA stop failure' }),
  });
  assert.strictEqual(firstRelease.failureCode, 'IOS_WDA_STOP_FAILED');
  const historicalClaim = acquireWda(target, 'owner-new-batch', historicalHarness.dependencies);
  assert.strictEqual(historicalClaim.ownership, 'FRAMEWORK_MANAGED');
  assert.strictEqual(historicalClaim.resource.pid, 4301);
  assert.strictEqual((await releaseWda(historicalClaim.resource, 'owner-new-batch', historicalHarness.dependencies)).status, 'RELEASED');

  const order = [];
  let sessionCreates = 0;
  let sessionDeletes = 0;
  const composite = await acquireIosRuntime(target, 'owner-composite', {
    acquireAppium: async () => ({
      ok: true,
      status: 'ACTIVE',
      ownership: 'FRAMEWORK_MANAGED',
      resource: { server: 'http://127.0.0.1:4723', pid: 4401, ownerToken: 'appium-token' },
    }),
    acquireWda: () => ({
      ok: true,
      status: 'PENDING',
      ownership: 'FRAMEWORK_MANAGED',
      resource: { deviceId: target.device, bundleId: target.updatedWDABundleId, claimToken: 'wda-token', baselinePids: [] },
    }),
    listeningPorts: () => [],
    createSession: async () => {
      sessionCreates += 1;
      return { sessionId: 'batch-session-001', capabilities: { platformName: 'iOS' } };
    },
  });
  assert.strictEqual(composite.resource.appium.pid, 4401);
  assert.strictEqual(composite.resource.wda.status, 'PENDING');
  assert.strictEqual(composite.resource.session.sessionId, 'batch-session-001');
  assert.strictEqual(sessionCreates, 1);
  const reusedSessionIds = [];
  await withSession({ appiumSessionId: composite.resource.session.sessionId }, async ({ sessionId }) => { reusedSessionIds.push(sessionId); });
  await withSession({ appiumSessionId: composite.resource.session.sessionId }, async ({ sessionId }) => { reusedSessionIds.push(sessionId); });
  assert.deepStrictEqual(reusedSessionIds, ['batch-session-001', 'batch-session-001']);
  const compositeReleased = await releaseIosRuntime({ ...composite, ownerKey: 'owner-composite' }, {
    deleteSession: async (_server, sessionId) => {
      sessionDeletes += 1;
      assert.strictEqual(sessionId, 'batch-session-001');
    },
    releaseWda: async () => {
      order.push('wda');
      return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' };
    },
    releaseAppium: async () => {
      order.push('appium');
      return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' };
    },
    listeningPorts: () => [],
  });
  assert.deepStrictEqual(order, ['wda', 'appium']);
  assert.strictEqual(sessionDeletes, 1);
  assert.strictEqual(compositeReleased.status, 'RELEASED');

  const retained = await releaseIosRuntime({ ...composite, ownerKey: 'owner-composite' }, {
    deleteSession: async () => {},
    releaseWda: async () => ({ ok: true, status: 'RETAINED', ownership: 'EXTERNAL' }),
    releaseAppium: async () => ({ ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' }),
    listeningPorts: () => [],
  });
  assert.strictEqual(retained.status, 'RETAINED');
  assert.strictEqual(retained.ownership, 'EXTERNAL');

  const failedWda = await releaseIosRuntime({ ...composite, ownerKey: 'owner-composite' }, {
    deleteSession: async () => {},
    releaseWda: async () => ({
      ok: false,
      status: 'RELEASE_FAILED',
      ownership: 'FRAMEWORK_MANAGED',
      failureCode: 'IOS_WDA_STOP_FAILED',
      reason: 'simulated',
    }),
    releaseAppium: async () => ({ ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' }),
    listeningPorts: () => [],
  });
  assert.strictEqual(failedWda.status, 'RELEASE_FAILED');
  assert.strictEqual(failedWda.failureCode, 'IOS_WDA_STOP_FAILED');

  const residualPort = await releaseIosRuntime({ ...composite, ownerKey: 'owner-composite' }, {
    deleteSession: async () => {},
    releaseWda: async () => ({ ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' }),
    releaseAppium: async () => ({ ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED' }),
    listeningPorts: () => [8100],
  });
  assert.strictEqual(residualPort.status, 'RELEASE_FAILED');
  assert.strictEqual(residualPort.failureCode, 'IOS_AUTOMATION_RELEASE_INCOMPLETE');

  if (previousRuntimeDir === undefined) delete process.env.MAVT_IOS_RUNTIME_DIR;
  else process.env.MAVT_IOS_RUNTIME_DIR = previousRuntimeDir;
}

verifyIosAdapterSemantics().then(() => {
  console.log('platform-runtime passed');
}).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
