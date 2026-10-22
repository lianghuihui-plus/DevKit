#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  acquireBatchPlatformRuntime,
  releaseBatchPlatformRuntime,
  runtimePaths,
} = require('../batch/platform-runtime');
const { execute: executeBatch } = require('../batch');
const { reconcileWithFinalization } = require('../batch');
const { batchPaths, bootstrapBatch, initializeBatch } = require('../batch/core');
const { buildContract } = require('../build-agent-contract');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const {
  acquireAppium,
  releaseAppium,
} = require('../platform/adapters/ios/lib/service-lifecycle');
const { stopBatch } = require('../batch/service-support');
const { deleteSession, withSession } = require('../platform/adapters/ios/lib/appium-client');
const {
  acquireIosRuntime,
  refreshIosSession,
  releaseIosRuntime,
} = require('../platform/adapters/ios/lib/runtime-lifecycle');
const {
  acquireWda,
  commandMatchesWda,
  releaseWda,
} = require('../platform/adapters/ios/lib/wda-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./support/workspace-fixture');
const { markBootstrapFailed } = require('../lib/warm-session-contract');

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
  writeJsonAtomic(paths.state, {
    ...state,
    status: 'BLOCKING',
    cases: state.cases.map((item) => ({ ...item, status: 'SKIPPED' })),
    failureCode: 'TEST_STOP',
    reason: 'test terminal state',
    finalization: { cause: 'BLOCKED', executionsSettled: true, platformReleased: false },
  });
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

const diagnosticFixture = fixture('diagnostic-envelope');
const diagnosticPaths = batchPaths(diagnosticFixture.root, diagnosticFixture.batchId);
const diagnosticState = readJson(diagnosticPaths.state);
diagnosticState.warmSession = markBootstrapFailed(diagnosticState.warmSession, T0);
const diagnosticStop = stopBatch(
  diagnosticPaths,
  diagnosticState,
  'BOOTSTRAP_FAILED',
  'IOS_WDA_START_TIMEOUT',
  'WDA 启动超过等待期限',
  { now: T0, stage: 'WDA_BUILD', retryable: true, attempt: 1, maxAttempts: 3 },
);
assert.strictEqual(diagnosticStop.failureCode, 'IOS_WDA_START_TIMEOUT');
assert.strictEqual(diagnosticStop.stage, 'WDA_BUILD');
assert.strictEqual(diagnosticStop.retryable, true);
assert.deepStrictEqual(diagnosticStop.diagnostic, {
  code: 'IOS_WDA_START_TIMEOUT',
  stage: 'WDA_BUILD',
  summary: 'WDA 启动超过等待期限',
  retryable: true,
  attempt: 1,
  maxAttempts: 3,
});

const pendingFixture = fixture('retryable-acquire');
let pendingAttempts = 0;
const retryableAcquireAdapter = {
  acquirePlatformRuntime: () => {
    pendingAttempts += 1;
    if (pendingAttempts === 1) {
      return {
        ok: false,
        status: 'ACQUIRE_FAILED',
        ownership: 'NONE',
        failureCode: 'DEVICE_ADAPTER_TIMEOUT',
        reason: 'WDA 仍在启动',
        retryable: true,
        diagnostic: {
          code: 'DEVICE_ADAPTER_TIMEOUT',
          stage: 'PLATFORM_RUNTIME_ACQUIRE',
          summary: 'WDA 仍在启动',
          retryable: true,
        },
      };
    }
    return { ok: true, status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED', resource: { pid: 123 } };
  },
};
const pendingFirst = acquireBatchPlatformRuntime(common(pendingFixture, retryableAcquireAdapter));
assert.strictEqual(pendingFirst.status, 'ACQUIRE_PENDING');
assert.strictEqual(pendingFirst.retryable, true);
assert.strictEqual(fs.existsSync(runtimePaths(batchPaths(pendingFixture.root, pendingFixture.batchId).batchDir).state), false);
const pendingSecond = acquireBatchPlatformRuntime(common(pendingFixture, retryableAcquireAdapter));
assert.strictEqual(pendingSecond.status, 'ACTIVE');
assert.strictEqual(pendingAttempts, 2);
const pendingBootstrap = bootstrapBatch({
  workspaceRoot: pendingFixture.root,
  batchId: pendingFixture.batchId,
  adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
  platformRuntime: {
    ok: false,
    status: 'ACQUIRE_PENDING',
    ownership: 'NONE',
    retryable: true,
    failureCode: 'DEVICE_ADAPTER_TIMEOUT',
    reason: 'WDA 仍在启动',
    diagnostic: { code: 'DEVICE_ADAPTER_TIMEOUT', stage: 'PLATFORM_RUNTIME_ACQUIRE', summary: 'WDA 仍在启动', retryable: true },
  },
});
assert.strictEqual(pendingBootstrap.action, 'WAIT_PLATFORM_RUNTIME');
const readyBootstrap = bootstrapBatch({
  workspaceRoot: pendingFixture.root,
  batchId: pendingFixture.batchId,
  adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
  platformRuntime: pendingSecond,
});
assert.strictEqual(readyBootstrap.state.status, 'RUNNING');

const exhaustedFixture = fixture('retryable-acquire-exhausted');
let exhaustedAttempts = 0;
const exhaustedAdapter = {
  acquirePlatformRuntime: () => {
    exhaustedAttempts += 1;
    return {
      ok: false,
      status: 'ACQUIRE_FAILED',
      ownership: 'NONE',
      failureCode: 'DEVICE_ADAPTER_TIMEOUT',
      reason: '仍未完成',
      retryable: true,
      diagnostic: { code: 'DEVICE_ADAPTER_TIMEOUT', stage: 'PLATFORM_RUNTIME_ACQUIRE', summary: '仍未完成', retryable: true },
    };
  },
};
assert.strictEqual(acquireBatchPlatformRuntime(common(exhaustedFixture, exhaustedAdapter)).status, 'ACQUIRE_PENDING');
assert.strictEqual(acquireBatchPlatformRuntime(common(exhaustedFixture, exhaustedAdapter)).status, 'ACQUIRE_PENDING');
const exhausted = acquireBatchPlatformRuntime(common(exhaustedFixture, exhaustedAdapter));
assert.strictEqual(exhausted.status, 'ACQUIRE_FAILED');
assert.strictEqual(exhausted.retryable, false);
assert.strictEqual(exhaustedAttempts, 3);

const ownerWaitFixture = fixture('owner-state-wait');
let ownerWaitAttempts = 0;
let ownerTerminal = false;
const ownerWaitAdapter = {
  acquirePlatformRuntime: () => {
    ownerWaitAttempts += 1;
    if (!ownerTerminal) {
      return {
        ok: false,
        status: 'ACQUIRE_FAILED',
        ownership: 'NONE',
        failureCode: 'IOS_APPIUM_SERVICE_IN_USE',
        reason: 'Appium is owned by an active batch',
        retryable: true,
        diagnostic: {
          code: 'IOS_APPIUM_SERVICE_IN_USE',
          stage: 'PLATFORM_RUNTIME_ACQUIRE',
          summary: 'Appium is owned by an active batch',
          retryable: true,
          recovery: { kind: 'WAIT_OR_CANCEL_OWNER_BATCH' },
        },
      };
    }
    return { ok: true, status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED', resource: { pid: 456 } };
  },
};
for (let attempt = 1; attempt <= 4; attempt += 1) {
  const waiting = acquireBatchPlatformRuntime(common(ownerWaitFixture, ownerWaitAdapter));
  assert.strictEqual(waiting.status, 'ACQUIRE_PENDING');
  assert.strictEqual(waiting.waitFor, 'OWNER_BATCH_TERMINAL');
  assert.strictEqual(waiting.attempt, attempt);
  assert.strictEqual(fs.existsSync(runtimePaths(batchPaths(ownerWaitFixture.root, ownerWaitFixture.batchId).batchDir).state), false);
}
ownerTerminal = true;
assert.strictEqual(acquireBatchPlatformRuntime(common(ownerWaitFixture, ownerWaitAdapter)).status, 'ACTIVE');
assert.strictEqual(ownerWaitAttempts, 5);

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

const changedImplementation = fixture('changed-implementation-release');
acquireBatchPlatformRuntime(common(changedImplementation, managedAdapter));
terminal(changedImplementation);
const releasedByChangedImplementation = releaseBatchPlatformRuntime({
  ...common(changedImplementation, managedAdapter),
  runtimeSha: 'case-runtime-current-implementation',
  adapterSha: 'platform-adapter-current-implementation',
  coordinatorSha: 'batch-coordinator-current-implementation',
});
assert.strictEqual(releasedByChangedImplementation.status, 'RELEASED');

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

const deferred = fixture('deferred-cleanup');
const deferredAdapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding: BINDING }),
  acquirePlatformRuntime: ({ ownerKey }) => ({
    ok: true, status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED', resource: { ownerKey, ownerToken: 'deferred-token', pid: 6789 },
  }),
  releasePlatformRuntime: () => ({
    ok: false, status: 'RELEASE_FAILED', ownership: 'FRAMEWORK_MANAGED',
    failureCode: 'TEST_RELEASE_TIMEOUT', reason: 'simulated cleanup timeout',
  }),
};
acquireBatchPlatformRuntime(common(deferred, deferredAdapter));
bootstrapBatch({ ...common(deferred, deferredAdapter), adapter: deferredAdapter });
terminal(deferred);
const deferredResult = reconcileWithFinalization(common(deferred, deferredAdapter), { adapter: deferredAdapter });
assert.strictEqual(deferredResult.action, 'BATCH_BLOCKED');
assert.deepStrictEqual(deferredResult.progress, ['RELEASE_PLATFORM', 'PUBLISH_REPORTS', 'BATCH_BLOCKED']);
assert.strictEqual(readJson(batchPaths(deferred.root, deferred.batchId).state).finalization.platformCleanupDeferred, true);

const bootstrapTimeout = fixture('bootstrap-timeout');
assert.throws(() => bootstrapBatch({
  ...common(bootstrapTimeout, {
    restartApp: () => ({
      ok: false,
      coldStartVerified: false,
      startupDisplayVerified: false,
      failureCode: 'DEVICE_ADAPTER_TIMEOUT',
      reason: 'adapter timed out',
      diagnostic: { code: 'DEVICE_ADAPTER_TIMEOUT', stage: 'BOOTSTRAP_ACTION', retryable: false },
    }),
  }),
  adapter: {
    restartApp: () => ({
      ok: false,
      coldStartVerified: false,
      startupDisplayVerified: false,
      failureCode: 'DEVICE_ADAPTER_TIMEOUT',
      reason: 'adapter timed out',
      diagnostic: { code: 'DEVICE_ADAPTER_TIMEOUT', stage: 'BOOTSTRAP_ACTION', retryable: false },
    }),
  },
}), /adapter timed out/);
assert.strictEqual(readJson(batchPaths(bootstrapTimeout.root, bootstrapTimeout.batchId).state).failureCode, 'BATCH_BOOTSTRAP_TIMEOUT');

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
  writeJsonAtomic(iosBatchPaths.state, {
    ...iosBatchState,
    status: 'BLOCKING',
    cases: iosBatchState.cases.map((item) => ({ ...item, status: 'SKIPPED' })),
    failureCode: 'TEST_STOP',
    reason: 'test terminal state',
    finalization: { cause: 'BLOCKED', executionsSettled: false, platformReleased: false },
  });
  const finalized = executeBatch({ command: 'reconcile', workspace: iosRoot, batchId: iosBatchId });
  assert.strictEqual(finalized.action, 'BATCH_BLOCKED');
  assert.deepStrictEqual(finalized.progress, ['SETTLE_EXECUTIONS', 'RELEASE_PLATFORM', 'PUBLISH_REPORTS', 'BATCH_BLOCKED']);
  assert.strictEqual(executeBatch({ command: 'reconcile', workspace: iosRoot, batchId: iosBatchId }).action, 'BATCH_BLOCKED');
} finally {
  if (previousIosFake === undefined) delete process.env.MAVT_IOS_FAKE;
  else process.env.MAVT_IOS_FAKE = previousIosFake;
}

async function verifyIosAdapterSemantics() {
  const previousFake = process.env.MAVT_IOS_FAKE;
  const previousRuntimeDir = process.env.MAVT_IOS_RUNTIME_DIR;
  const missingSessionServer = http.createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ value: { error: 'invalid session id' } }));
  });
  await new Promise((resolve) => missingSessionServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = missingSessionServer.address();
    await deleteSession(`http://127.0.0.1:${address.port}`, 'already-deleted-session');
  } finally {
    await new Promise((resolve) => missingSessionServer.close(resolve));
  }
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

  // A framework-owned Appium process from a terminal batch is safe to reclaim.
  const appiumRuntimeDir = path.join(temp, 'appium-runtime-reclaim');
  process.env.MAVT_IOS_RUNTIME_DIR = appiumRuntimeDir;
  const appiumProcesses = new Map();
  const appiumOld = { pid: 4501, parentPid: 1, processGroupId: 4501, command: 'appium --address 127.0.0.1 --port 4723' };
  appiumProcesses.set(appiumOld.pid, appiumOld);
  const appiumRegistry = {
    schemaVersion: 1,
    server: 'http://127.0.0.1:4723',
    pid: appiumOld.pid,
    processGroupId: appiumOld.processGroupId,
    ownerToken: 'old-appium-token',
    ownerKey: 'owner-terminal-batch',
  };
  fs.mkdirSync(appiumRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(appiumRuntimeDir, path.basename(require('../platform/adapters/ios/lib/service-lifecycle').registryPath('http://127.0.0.1:4723'))), `${JSON.stringify(appiumRegistry)}\n`);
  let appiumWaits = 0;
  let appiumStops = 0;
  const reclaimedAppium = await acquireAppium({ appiumServer: 'http://127.0.0.1:4723' }, 'owner-new-batch', {
    waitForServer: async () => ({ ok: ++appiumWaits === 1 || appiumWaits >= 3 }),
    processAlive: (pid) => appiumProcesses.has(pid),
    processCommand: (pid) => appiumProcesses.get(pid)?.command || '',
    stopProcessGroup: async (record) => {
      appiumStops += 1;
      appiumProcesses.delete(record.pid);
      return { ok: true, alreadyStopped: false };
    },
    resolveOwnerStatus: () => ({ status: 'TERMINAL', batchId: 'batch-terminal' }),
    spawnManagedAppium: (target) => {
      const record = {
        ...appiumRegistry,
        pid: 4502,
        processGroupId: 4502,
        ownerToken: 'new-appium-token',
        ownerKey: null,
        server: 'http://127.0.0.1:4723',
      };
      appiumProcesses.set(record.pid, { pid: record.pid, parentPid: 1, processGroupId: record.pid, command: 'appium --address 127.0.0.1 --port 4723' });
      fs.writeFileSync(require('../platform/adapters/ios/lib/service-lifecycle').registryPath(target.appiumServer), `${JSON.stringify(record)}\n`);
      return record;
    },
  });
  assert.strictEqual(reclaimedAppium.ok, true);
  assert.strictEqual(reclaimedAppium.resource.ownerKey, 'owner-new-batch');
  assert.strictEqual(appiumStops, 1);

  // An active owner must remain untouched and surface a structured conflict.
  const activeRegistry = { ...appiumRegistry, ownerKey: 'owner-active-batch', pid: 4503, processGroupId: 4503 };
  appiumProcesses.set(4503, { pid: 4503, parentPid: 1, processGroupId: 4503, command: 'appium --address 127.0.0.1 --port 4723' });
  fs.writeFileSync(require('../platform/adapters/ios/lib/service-lifecycle').registryPath('http://127.0.0.1:4723'), `${JSON.stringify(activeRegistry)}\n`);
  const activeAppium = await acquireAppium({ appiumServer: 'http://127.0.0.1:4723' }, 'owner-new-batch', {
    waitForServer: async () => ({ ok: true }),
    processAlive: (pid) => appiumProcesses.has(pid),
    processCommand: (pid) => appiumProcesses.get(pid)?.command || '',
    resolveOwnerStatus: () => ({ status: 'ACTIVE', batchId: 'batch-active' }),
  });
  assert.strictEqual(activeAppium.failureCode, 'IOS_APPIUM_SERVICE_IN_USE');
  assert.strictEqual(activeAppium.retryable, true);
  assert.strictEqual(activeAppium.diagnostic.retryable, true);
  assert.strictEqual(appiumProcesses.has(4503), true);
  const unknownAppium = await acquireAppium({ appiumServer: 'http://127.0.0.1:4723' }, 'owner-new-batch', {
    waitForServer: async () => ({ ok: true }),
    processAlive: (pid) => appiumProcesses.has(pid),
    processCommand: (pid) => appiumProcesses.get(pid)?.command || '',
    resolveOwnerStatus: () => ({ status: 'UNKNOWN', reason: 'not mapped' }),
  });
  assert.strictEqual(unknownAppium.failureCode, 'IOS_APPIUM_OWNERSHIP_UNKNOWN');
  assert.strictEqual(appiumProcesses.has(4503), true);

  // WDA ownership follows the same terminal/active policy.
  fs.rmSync(appiumRuntimeDir, { recursive: true, force: true });
  process.env.MAVT_IOS_RUNTIME_DIR = wdaRuntimeDir;
  fs.mkdirSync(wdaRuntimeDir, { recursive: true });
  const wdaStaleHarness = processHarness([wdaProcess(4601)]);
  const wdaStaleRegistry = {
    schemaVersion: 1,
    status: 'ACTIVE',
    deviceId: target.device,
    bundleId: target.updatedWDABundleId,
    pid: 4601,
    parentPid: 1,
    processGroupId: 4601,
    processStartedAt: 'start-4601',
    claimToken: 'old-wda-token',
    ownerKey: 'owner-terminal-wda',
  };
  fs.writeFileSync(require('../platform/adapters/ios/lib/wda-lifecycle').registryPath(target), `${JSON.stringify(wdaStaleRegistry)}\n`);
  const reclaimedWda = await acquireWda(target, 'owner-new-wda', {
    ...wdaStaleHarness.dependencies,
    resolveOwnerStatus: () => ({ status: 'TERMINAL', batchId: 'batch-terminal-wda' }),
  });
  assert.strictEqual(reclaimedWda.ok, true);
  assert.strictEqual(reclaimedWda.resource.ownerKey, 'owner-new-wda');
  assert.strictEqual(wdaStaleHarness.processes.has(4601), false);

  fs.rmSync(wdaRuntimeDir, { recursive: true, force: true });
  fs.mkdirSync(wdaRuntimeDir, { recursive: true });
  const wdaPendingHarness = processHarness([wdaProcess(4610)]);
  fs.writeFileSync(require('../platform/adapters/ios/lib/wda-lifecycle').registryPath(target), `${JSON.stringify({
    ...wdaStaleRegistry,
    status: 'PENDING',
    pid: undefined,
    processGroupId: undefined,
    processStartedAt: undefined,
    baselinePids: [],
    claimToken: 'pending-wda-token',
    ownerKey: 'owner-terminal-pending-wda',
  })}\n`);
  const reclaimedPendingWda = await acquireWda(target, 'owner-new-wda', {
    ...wdaPendingHarness.dependencies,
    resolveOwnerStatus: () => ({ status: 'TERMINAL', batchId: 'batch-terminal-pending-wda' }),
  });
  assert.strictEqual(reclaimedPendingWda.ok, true);
  assert.strictEqual(wdaPendingHarness.processes.has(4610), false);

  fs.rmSync(wdaRuntimeDir, { recursive: true, force: true });
  const wdaActiveHarness = processHarness([wdaProcess(4602)]);
  fs.mkdirSync(wdaRuntimeDir, { recursive: true });
  fs.writeFileSync(require('../platform/adapters/ios/lib/wda-lifecycle').registryPath(target), `${JSON.stringify({ ...wdaStaleRegistry, pid: 4602, processGroupId: 4602, ownerKey: 'owner-active-wda', processStartedAt: 'start-4602' })}\n`);
  const activeWda = await acquireWda(target, 'owner-new-wda', {
    ...wdaActiveHarness.dependencies,
    resolveOwnerStatus: () => ({ status: 'ACTIVE', batchId: 'batch-active-wda' }),
  });
  assert.strictEqual(activeWda.failureCode, 'IOS_WDA_SERVICE_IN_USE');
  assert.strictEqual(activeWda.retryable, true);
  assert.strictEqual(activeWda.diagnostic.retryable, true);
  assert.strictEqual(wdaActiveHarness.processes.has(4602), true);
  const unknownWda = await acquireWda(target, 'owner-new-wda', {
    ...wdaActiveHarness.dependencies,
    resolveOwnerStatus: () => ({ status: 'UNKNOWN', reason: 'not mapped' }),
  });
  assert.strictEqual(unknownWda.failureCode, 'IOS_WDA_OWNERSHIP_UNKNOWN');
  assert.strictEqual(wdaActiveHarness.processes.has(4602), true);

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
  const historicalClaim = await acquireWda(target, 'owner-new-batch', {
    ...historicalHarness.dependencies,
    resolveOwnerStatus: () => ({ status: 'TERMINAL', batchId: 'batch-old-wda' }),
  });
  assert.strictEqual(historicalClaim.ownership, 'FRAMEWORK_MANAGED');
  assert.strictEqual(historicalClaim.status, 'PENDING');
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
  const refreshedSessionDeletes = [];
  const refreshed = await refreshIosSession(target, composite, {
    createSession: async () => ({ sessionId: 'batch-session-002', capabilities: { platformName: 'iOS' } }),
    deleteSession: async (_server, sessionId) => { refreshedSessionDeletes.push(sessionId); },
  });
  assert.strictEqual(refreshed.platformSession.sessionId, 'batch-session-002');
  assert.deepStrictEqual(refreshedSessionDeletes, ['batch-session-001']);
  const refreshedComposite = {
    ...composite,
    resource: {
      ...composite.resource,
      session: { ...composite.resource.session, ...refreshed.platformSession, generation: 2 },
    },
  };
  const compositeReleased = await releaseIosRuntime({ ...refreshedComposite, ownerKey: 'owner-composite' }, {
    deleteSession: async (_server, sessionId) => {
      sessionDeletes += 1;
      assert.strictEqual(sessionId, 'batch-session-002');
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
