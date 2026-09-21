#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  COORDINATOR_CAPABILITIES,
  PUBLIC_CONTRACT,
  validateCoordinatorRequest,
} = require('../coordinator/agent-facing-contract');
const {
  advanceRun,
  cancelRun,
  confirmRun,
  loadCoordinatorState,
  prepareRun,
} = require('../coordinator/agent-facing-service');
const coordinatorAgent = require('../coordinator-agent');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { confirmEnvironment } = require('../lib/run-control');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-coordinator-facing-'));
const workspace = path.join(temp, 'workspace');
createTestWorkspace(workspace);
fs.mkdirSync(path.join(workspace, 'knowledge'));

const FORBIDDEN_RESPONSE_FIELDS = new Set([
  'template',
  'confirmTemplate',
  'retryWith',
  'usage',
  'example',
  'nextCall',
  'diagnostic',
  'resume',
]);

function assertNoEmbeddedInstructions(value, location = 'response') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedInstructions(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.strictEqual(FORBIDDEN_RESPONSE_FIELDS.has(key), false, `${location}.${key} must not embed usage instructions`);
    assertNoEmbeddedInstructions(child, `${location}.${key}`);
  }
}

function createCase(caseNo) {
  const source = `验证用例 ${caseNo} 的目标页面`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseDir = path.join(workspace, 'cases', `${caseNo}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), createCaseContract({
    caseKey, caseNo, title: `${caseNo} 用例`, sourceText: source, importPath: `/fixture/${caseNo}.md`,
  }));
  return { caseNo, caseKey, caseDir, source };
}

const case014 = createCase('014');
const case015 = createCase('015');

assert.deepStrictEqual(COORDINATOR_CAPABILITIES, ['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun']);
for (const [name, method] of Object.entries(PUBLIC_CONTRACT.methods)) {
  assert.deepStrictEqual(validateCoordinatorRequest(method.minimalExample), [], `${name} documentation example must validate`);
}

const prepared = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014', '015'] }, {
  batchId: 'batch-coordinator-facing',
  now: '2026-09-11T02:00:00.000Z',
});
assert.strictEqual(prepared.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(prepared.reason, 'CHOOSE_ENVIRONMENT');
assert.ok(prepared.commands.advance);
assert.ok(prepared.commands.confirm.command);
assert.ok(prepared.commands.confirm.requestPath);
assert.ok(prepared.commands.cancel.command);
assert.ok(fs.existsSync(prepared.statePath));
assert.strictEqual(Object.prototype.hasOwnProperty.call(loadCoordinatorState(prepared.statePath), 'schemaVersion'), false);

assert.deepStrictEqual(prepared.choices, [
  { id: 'SELECT_HARMONY', decision: 'SELECT_PLATFORM', platform: 'harmony' },
  { id: 'SELECT_ANDROID', decision: 'SELECT_PLATFORM', platform: 'android' },
  { id: 'SELECT_IOS', decision: 'SELECT_PLATFORM', platform: 'ios' },
]);
assertNoEmbeddedInstructions(prepared);

const probe = {
  schemaVersion: 1,
  type: 'environmentProbe',
  platform: 'harmony',
  ready: true,
  devices: [{ id: 'device-001', serial: 'device-001', deviceFormFactor: 'phone' }],
  diagnostics: [],
  capabilities: { screenshot: true, layout: true },
};

const unavailableRun = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-environment-unavailable',
});
const unavailable = confirmRun(unavailableRun.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'android',
}, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'android', ready: false,
    devices: [], diagnostics: [{ id: 'adbMissing', level: 'ERROR', message: '未找到 adb' }],
  }),
});
assert.strictEqual(unavailable.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(unavailable.reason, 'ENVIRONMENT_NOT_READY');
assert.strictEqual(unavailable.code, 'ENVIRONMENT_NOT_READY');
assert.match(unavailable.diagnostics[0].message, /adb/);
assert.ok(unavailable.choices.some((choice) => choice.id === 'SELECT_HARMONY'));
assert.strictEqual(loadCoordinatorState(unavailableRun.statePath).phase, 'NEED_ENVIRONMENT_DECISION');

const needBinding = confirmRun(prepared.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'harmony',
}, {
  probeEnvironment: () => probe,
  now: '2026-09-11T02:00:03.000Z',
});
assert.strictEqual(needBinding.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(needBinding.reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.deepStrictEqual(needBinding.devices, probe.devices);
assert.deepStrictEqual(needBinding.binding, {
  platform: 'harmony', deviceId: 'device-001', deviceFormFactor: 'phone',
});
assert.deepStrictEqual(needBinding.requiredUserFields, ['binding.appId', 'binding.entry']);
assert.strictEqual(JSON.stringify(needBinding).includes('probeJson'), false);
assert.deepStrictEqual(coordinatorAgent.recoveryFor([
  'confirm', '--state', prepared.statePath,
]), { phase: 'NEED_BINDING_CONFIRMATION' });
assertNoEmbeddedInstructions(needBinding);

assert.throws(() => confirmEnvironment({
  workspaceRoot: workspace,
  binding: { platform: 'harmony', deviceId: 'device-001', appId: '<target-app-id>', entry: '<entry-ability>' },
  probe,
  userConfirmation: '确认环境',
}), (error) => error.code === 'ENVIRONMENT_CONFIRMATION_INVALID');

const initCalls = [];
const confirmed = confirmRun(prepared.statePath, {
  capability: 'confirmRun',
  decision: 'CONFIRM_BINDING',
  userInstruction: '确认执行 014 和 015 用例',
  binding: {
    platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility',
    deviceFormFactor: 'phone',
  },
}, {
  batchExecute: (input) => { initCalls.push(input); return { state: { status: 'INITIALIZING' } }; },
  now: '2026-09-11T02:00:04.000Z',
});
assert.strictEqual(confirmed.status, 'CONFIRMED');
assert.deepStrictEqual(initCalls.map((item) => item.command), ['init']);
assert.strictEqual(readJson(path.join(workspace, 'runs', 'batch-coordinator-facing', 'execution-request.json'), null).targets.length, 2);
assert.strictEqual(loadCoordinatorState(prepared.statePath).phase, 'BATCH_READY');
assert.strictEqual(loadCoordinatorState(prepared.statePath).initialization.environmentFrozen.environment.binding.platform, 'harmony');
assert.ok(loadCoordinatorState(prepared.statePath).initialization.executionRequestCreated.requestSha);
assert.ok(loadCoordinatorState(prepared.statePath).initialization.batchInitialized);

const androidProbe = {
  schemaVersion: 1,
  type: 'environmentProbe',
  platform: 'android',
  ready: true,
  devices: [{ id: 'android-device', serial: 'android-device' }],
  diagnostics: [],
  capabilities: { screenshot: true, layout: true },
};
const androidPreparedRun = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-android-input-prepared',
});
confirmRun(androidPreparedRun.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'android',
}, { probeEnvironment: () => androidProbe });
const preparationCalls = [];
const androidPrepared = confirmRun(androidPreparedRun.statePath, {
  capability: 'confirmRun',
  decision: 'CONFIRM_BINDING',
  userInstruction: '确认 Android 输入能力由框架自动准备',
  binding: {
    platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
  },
}, {
  prepareEnvironment: (input) => {
    preparationCalls.push(input);
    return { schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true, dependencies: [] };
  },
  batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
});
assert.strictEqual(androidPrepared.status, 'CONFIRMED');
assert.deepStrictEqual(preparationCalls, [{
  binding: {
    platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
  },
}]);
assert.deepStrictEqual(loadCoordinatorState(androidPreparedRun.statePath).initialization.environmentPrepared, {
  platform: 'android',
  status: 'READY',
});

const androidPreparationFailureRun = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-android-input-prepare-failure',
});
confirmRun(androidPreparationFailureRun.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'android',
}, { probeEnvironment: () => androidProbe });
let preparationError;
try {
  confirmRun(androidPreparationFailureRun.statePath, {
    capability: 'confirmRun',
    decision: 'CONFIRM_BINDING',
    userInstruction: '确认 Android 输入能力失败时保持可恢复',
    binding: {
      platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
    },
  }, {
    prepareEnvironment: () => ({
      schemaVersion: 1,
      type: 'environmentPrepare',
      platform: 'android',
      ok: false,
      dependencies: [{ id: 'mavtInputIme', name: 'MAVT Input IME', ok: false }],
    }),
    batchExecute: () => { throw new Error('batch must not initialize before input capability is ready'); },
  });
} catch (error) {
  preparationError = error;
}
assert.strictEqual(preparationError?.code, 'INPUT_CAPABILITY_NOT_READY');
assert.strictEqual(preparationError?.diagnostic?.stage, 'ENVIRONMENT_PREPARE');
const preparationErrorResponse = coordinatorAgent.errorResponse(preparationError, 'confirm');
assert.strictEqual(JSON.stringify(preparationErrorResponse).includes('IME'), false);
assert.strictEqual(preparationErrorResponse.retryable, true);
assert.match(preparationErrorResponse.documentationRef, /references\/coordinator\/errors\/environment\.md#error-input-capability-not-ready$/);
assertNoEmbeddedInstructions(preparationErrorResponse);
assert.strictEqual(fs.existsSync(path.join(
  workspace, 'runs', 'batch-android-input-prepare-failure', 'execution-request.json',
)), false);
assert.strictEqual(loadCoordinatorState(androidPreparationFailureRun.statePath).phase, 'INITIALIZING_RUN');
const recoveredAndroidPreparation = advanceRun(androidPreparationFailureRun.statePath, {
  prepareEnvironment: () => ({
    schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true, dependencies: [],
  }),
  batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
});
assert.strictEqual(recoveredAndroidPreparation.status, 'CONFIRMED');

confirmEnvironment({
  workspaceRoot: workspace,
  binding: { platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility' },
  probe,
  userConfirmation: '恢复协调器测试的 HarmonyOS 环境',
});

const switchable = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-switch-existing-environment',
});
assert.strictEqual(switchable.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(switchable.reason, 'CHOOSE_ENVIRONMENT');
assert.strictEqual(switchable.binding.platform, 'harmony');
assert.deepStrictEqual(switchable.choices[0], { id: 'USE_CURRENT', decision: 'USE_CURRENT' });
assert.ok(switchable.choices.some((choice) => choice.id === 'SELECT_IOS'));
const selectedIos = confirmRun(switchable.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'ios',
}, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: true,
    devices: [{ id: 'ios-device', udid: 'ios-device', deviceType: 'realDevice' }], diagnostics: [],
  }),
});
assert.strictEqual(selectedIos.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(selectedIos.reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.strictEqual(selectedIos.binding.platform, 'ios');
assert.strictEqual(selectedIos.binding.deviceId, 'ios-device');
assertNoEmbeddedInstructions(selectedIos);

const multiIos = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-ios-multiple-devices',
});
const multiIosSelection = confirmRun(multiIos.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'ios',
}, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: true,
    deviceDetected: true, devices: [
      { id: 'ios-a', udid: 'ios-a', deviceType: 'realDevice' },
      { id: 'ios-b', udid: 'ios-b', deviceType: 'realDevice' },
    ], diagnostics: [],
  }),
});
assert.strictEqual(multiIosSelection.reason, 'SELECT_DEVICE');
assert.deepStrictEqual(multiIosSelection.choices.map((choice) => choice.deviceId), ['ios-a', 'ios-b']);
assertNoEmbeddedInstructions(multiIosSelection);
const multiIosConfirmed = confirmRun(multiIos.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'ios', deviceId: 'ios-b',
}, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: true,
    deviceDetected: true, devices: [
      { id: 'ios-a', udid: 'ios-a', deviceType: 'realDevice' },
      { id: 'ios-b', udid: 'ios-b', deviceType: 'realDevice' },
    ], diagnostics: [],
  }),
});
assert.strictEqual(multiIosConfirmed.binding.deviceId, 'ios-b');

const iosDeviceDetectedButSigningPending = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-ios-device-detected-signing-pending',
});
const iosSigningPending = confirmRun(iosDeviceDetectedButSigningPending.statePath, {
  capability: 'confirmRun', decision: 'SELECT_PLATFORM', platform: 'ios',
}, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: false,
    deviceDetected: true, confirmationReady: true, executionReady: false,
    devices: [{ id: 'ios-real-device', udid: 'ios-real-device', deviceType: 'realDevice' }],
    diagnostics: [{ id: 'iosRealDeviceSigningIncomplete', level: 'ERROR', message: '需要补充 WDA 签名参数' }],
  }),
});
assert.strictEqual(iosSigningPending.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(iosSigningPending.reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.strictEqual(iosSigningPending.executionReady, false);
assert.deepStrictEqual(iosSigningPending.devices[0], {
  id: 'ios-real-device', udid: 'ios-real-device', deviceType: 'realDevice',
});
const iosSigningMissing = confirmRun(iosDeviceDetectedButSigningPending.statePath, {
  capability: 'confirmRun', decision: 'CONFIRM_BINDING',
  userInstruction: '先尝试不带签名参数确认',
  binding: {
    platform: 'ios', deviceId: 'ios-real-device', appId: 'com.example.ios', deviceType: 'realDevice',
  },
});
assert.strictEqual(iosSigningMissing.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(iosSigningMissing.reason, 'IOS_SIGNING_REQUIRED');
assert.deepStrictEqual(iosSigningMissing.requiredBindingFields, ['xcodeOrgId', 'xcodeSigningId', 'updatedWDABundleId']);
const iosSigningConfirmed = confirmRun(iosDeviceDetectedButSigningPending.statePath, {
  capability: 'confirmRun', decision: 'CONFIRM_BINDING',
  userInstruction: '补充签名参数后确认执行',
  binding: {
    platform: 'ios', deviceId: 'ios-real-device', appId: 'com.example.ios', deviceType: 'realDevice',
    xcodeOrgId: 'TEAM', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.wda',
  },
}, {
  batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
});
assert.strictEqual(iosSigningConfirmed.status, 'CONFIRMED');
confirmEnvironment({
  workspaceRoot: workspace,
  binding: { platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility' },
  probe,
  userConfirmation: '恢复协调器测试的 HarmonyOS 环境',
});
fs.writeFileSync(selectedIos.commands.confirm.requestPath, '{');
const invalidBindingConfirmationProcess = childProcess.spawnSync(process.execPath, [
  path.resolve(__dirname, '../coordinator-agent.js'), 'confirm', '--state', selectedIos.statePath,
], { encoding: 'utf8', env: process.env });
assert.strictEqual(invalidBindingConfirmationProcess.status, 2);
const invalidBindingConfirmation = JSON.parse(invalidBindingConfirmationProcess.stderr);
assert.deepStrictEqual(invalidBindingConfirmation.facts, { phase: 'NEED_BINDING_CONFIRMATION' });
assertNoEmbeddedInstructions(invalidBindingConfirmation);

const environmentFile = path.join(workspace, 'environment-confirmation.json');
const validEnvironmentSource = fs.readFileSync(environmentFile, 'utf8');
fs.writeFileSync(environmentFile, '{');
const invalidDefaultEnvironment = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-invalid-default-environment',
});
assert.strictEqual(invalidDefaultEnvironment.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(invalidDefaultEnvironment.binding, undefined);
assert.ok(invalidDefaultEnvironment.diagnostics.length);
assert.deepStrictEqual(invalidDefaultEnvironment.choices.map((choice) => choice.id), [
  'SELECT_HARMONY', 'SELECT_ANDROID', 'SELECT_IOS',
]);
fs.writeFileSync(environmentFile, validEnvironmentSource);

const frozenOffer = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-frozen-environment-offer',
});
const concurrentBinding = {
  platform: 'android', deviceId: 'android-concurrent', appId: 'com.example.concurrent', entry: '.MainActivity',
};
confirmEnvironment({
  workspaceRoot: workspace,
  binding: concurrentBinding,
  probe: { schemaVersion: 1, platform: 'android', ready: true, devices: [{ id: 'android-concurrent' }] },
  userConfirmation: '另一个运行更新默认环境',
});
const frozenOfferRequest = { requestId: 'request-frozen-offer', requestSha: 'request-sha-frozen-offer' };
const frozenOfferResult = confirmRun(frozenOffer.statePath, {
  capability: 'confirmRun', decision: 'USE_CURRENT', userInstruction: '确认使用响应中展示的环境',
}, {
  createExecutionRequest: (input) => {
    assert.strictEqual(input.environmentConfirmation.binding.platform, 'harmony');
    assert.strictEqual(input.environmentConfirmation.binding.deviceId, 'device-001');
    return frozenOfferRequest;
  },
  batchExecute: () => ({ state: { status: 'INITIALIZING' }, contract: { contractSha: 'contract-frozen-offer' } }),
});
assert.strictEqual(frozenOfferResult.status, 'CONFIRMED');
fs.writeFileSync(environmentFile, validEnvironmentSource);

function verifyInitializationRecovery(interruptAfter, expected) {
  const suffix = interruptAfter.replace(/[^a-z]/gi, '-').toLowerCase();
  const start = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
    batchId: `batch-recover-${suffix}`,
  });
  const request = { requestId: `request-${suffix}`, requestSha: `request-sha-${suffix}` };
  const initializedBatch = {
    state: { status: 'INITIALIZING' },
    contract: { contractSha: `contract-sha-${suffix}` },
  };
  const calls = { create: 0, load: 0, batch: 0 };
  const options = {
    interruptAfter,
    createExecutionRequest: (input) => {
      calls.create += 1;
      assert.strictEqual(input.environmentConfirmation.binding.platform, 'harmony');
      return request;
    },
    loadExecutionRequest: () => { calls.load += 1; return request; },
    batchExecute: (input) => {
      calls.batch += 1;
      assert.strictEqual(input.command, 'init');
      return initializedBatch;
    },
  };
  assert.throws(() => confirmRun(start.statePath, {
    capability: 'confirmRun', decision: 'USE_CURRENT', userInstruction: `确认恢复 ${suffix}`,
  }, options), new RegExp(`MAVT_COORDINATOR_INTERRUPTED: ${interruptAfter}`));
  const interrupted = loadCoordinatorState(start.statePath);
  assert.strictEqual(interrupted.phase, 'INITIALIZING_RUN');
  assert.ok(interrupted.initialization.environmentFrozen);
  assert.strictEqual(Boolean(interrupted.initialization.executionRequestCreated), expected.requestRecorded);
  assert.strictEqual(Boolean(interrupted.initialization.batchInitialized), expected.batchRecorded);

  const resumed = advanceRun(start.statePath, { ...options, interruptAfter: null });
  assert.strictEqual(resumed.status, 'CONFIRMED');
  assert.strictEqual(loadCoordinatorState(start.statePath).phase, 'BATCH_READY');
  assert.deepStrictEqual(calls, expected.calls);
}

verifyInitializationRecovery('environmentFrozen', {
  requestRecorded: false, batchRecorded: false, calls: { create: 1, load: 0, batch: 1 },
});
verifyInitializationRecovery('executionRequestCreated', {
  requestRecorded: true, batchRecorded: false, calls: { create: 1, load: 1, batch: 1 },
});
verifyInitializationRecovery('batchInitialized', {
  requestRecorded: true, batchRecorded: true, calls: { create: 1, load: 1, batch: 2 },
});

const calls = [];
const sequence = [
  { action: 'BOOTSTRAP' },
  { action: 'NEED_CASE_AGENT', batchAction: 'START_CASE', batchId: 'batch-coordinator-facing', caseKey: case014.caseKey },
];
const needsCaseAgent = advanceRun(prepared.statePath, {
  batchExecute: (input) => {
    calls.push(input.command);
    if (input.command === 'reconcile') return sequence.shift();
    if (input.command === 'bootstrap') return { state: { status: 'RUNNING' } };
    if (input.command === 'start') return {
      action: 'DELEGATE_CASE_AGENT', agentRequired: true, batchId: 'batch-coordinator-facing',
      caseKey: case014.caseKey, executionId: 'execution-014',
      handoff: { loaderCommand: 'opaque-case-loader', path: '/must/not/leak', sha256: 'must-not-leak' },
    };
    throw new Error(`unexpected command ${input.command}`);
  },
  now: '2026-09-11T02:00:05.000Z',
});
assert.strictEqual(needsCaseAgent.status, 'NEED_CASE_AGENT');
assert.strictEqual(needsCaseAgent.loaderCommand, 'opaque-case-loader');
assert.match(needsCaseAgent.delegationPrompt, /独立 Case Agent/);
assert.deepStrictEqual(calls, ['reconcile', 'bootstrap', 'reconcile', 'start']);
for (const hidden of ['handoff', 'path', 'sha256', 'brief', 'source']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(needsCaseAgent, hidden), false, `dispatch response must not expose ${hidden}`);
}

const waiting = advanceRun(prepared.statePath, {
  batchExecute: () => ({
    action: 'WAIT_EXECUTION_RESULT', batchId: 'batch-coordinator-facing', caseKey: case014.caseKey, executionId: 'execution-014',
    progress: {
      executionPhase: 'HANDOFF_CONSUMED', lastEventType: 'actionOutcomeUnknown', lastEventAt: '2026-09-11T02:00:06.000Z',
      resultArtifacts: { result: false, metrics: false, executionFinalized: false, runtimeCompleted: false },
    },
  }),
});
assert.deepStrictEqual(waiting.status, 'WAITING');
assert.strictEqual(waiting.reason, 'WAIT_EXECUTION_RESULT');
assert.strictEqual(waiting.waitFor, 'EXECUTION_RESULT');
assert.strictEqual(waiting.caseNo, '014');
assert.strictEqual(waiting.caseKey, case014.caseKey);
assert.strictEqual(waiting.executionId, 'execution-014');
assert.strictEqual(waiting.progress.executionPhase, 'HANDOFF_CONSUMED');
assert.strictEqual(waiting.progress.lastEventType, 'actionOutcomeUnknown');
assert.strictEqual(waiting.commands.advance, prepared.commands.advance);

const complete = advanceRun(prepared.statePath, {
  batchExecute: () => ({ action: 'BATCH_COMPLETE', state: { status: 'COMPLETED' }, publicationState: { status: 'PUBLISHED' } }),
});
assert.strictEqual(complete.status, 'COMPLETE');
assert.strictEqual(complete.outcome, 'COMPLETED');
assert.strictEqual(complete.reportPath, path.join(workspace, 'index.html'));
assert.strictEqual(loadCoordinatorState(prepared.statePath).phase, 'COMPLETE');

const retryPublicationRun = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-report-retry-terminal',
});
confirmRun(retryPublicationRun.statePath, {
  capability: 'confirmRun', decision: 'USE_CURRENT', userInstruction: '确认执行报告重试终态用例',
}, { batchExecute: () => ({ state: { status: 'INITIALIZING' } }) });
const completeWithReportRetry = advanceRun(retryPublicationRun.statePath, {
  batchExecute: () => ({
    action: 'BATCH_COMPLETE',
    state: { status: 'COMPLETED' },
    publicationState: { status: 'RETRY_REQUIRED', errorCode: 'EXECUTION_LOCKED', reason: '报告锁冲突' },
  }),
});
assert.strictEqual(completeWithReportRetry.status, 'COMPLETE');
assert.strictEqual(completeWithReportRetry.outcome, 'COMPLETED');
assert.strictEqual(completeWithReportRetry.reportStatus, 'RETRY_REQUIRED');
assert.strictEqual(completeWithReportRetry.reportPath, undefined);
writeJsonAtomic(path.join(workspace, 'runs', 'batch-report-retry-terminal', 'report-publication.json'), {
  schemaVersion: 1,
  batchId: 'batch-report-retry-terminal',
  status: 'PUBLISHED',
  attempts: [],
});
const completeAfterReportRecovery = advanceRun(retryPublicationRun.statePath);
assert.strictEqual(completeAfterReportRecovery.status, 'COMPLETE');
assert.strictEqual(completeAfterReportRecovery.outcome, 'COMPLETED');
assert.strictEqual(completeAfterReportRecovery.reportStatus, 'PUBLISHED');
assert.strictEqual(completeAfterReportRecovery.reportPath, path.join(workspace, 'index.html'));

function prepareConfirmedRun(batchId) {
  const start = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, { batchId });
  const ready = confirmRun(start.statePath, {
    capability: 'confirmRun', decision: 'USE_CURRENT', userInstruction: `确认执行 ${batchId}`,
  }, { batchExecute: () => ({ state: { status: 'INITIALIZING' } }) });
  assert.strictEqual(ready.status, 'CONFIRMED');
  return start;
}

const cancelledRun = prepareConfirmedRun('batch-coordinator-cancelled');
const cancelCalls = [];
const cancelled = cancelRun(cancelledRun.statePath, { capability: 'cancelRun', reason: '用户取消测试' }, {
  now: '2026-09-11T04:00:00.000Z',
  batchExecute: (input) => {
    cancelCalls.push(input.command);
    if (input.command === 'cancel') return { state: { status: 'CANCELLING' } };
    return {
      action: 'BATCH_CANCELLED', state: { status: 'CANCELLED' },
      publicationState: { status: 'DEGRADED', errorCode: 'REPORT_RENDERER_INVALID', reason: '报告渲染失败' },
    };
  },
});
assert.strictEqual(cancelled.status, 'COMPLETE');
assert.strictEqual(cancelled.outcome, 'CANCELLED');
assert.strictEqual(cancelled.reportStatus, 'DEGRADED');
assert.strictEqual(cancelled.reportPath, undefined);
assert.strictEqual(cancelled.reportErrorCode, 'REPORT_RENDERER_INVALID');
assert.deepStrictEqual(cancelCalls, ['cancel', 'reconcile']);
assert.strictEqual(loadCoordinatorState(cancelledRun.statePath).updatedAt, '2026-09-11T04:00:00.000Z');

const interruptedCancellationRun = prepareConfirmedRun('batch-coordinator-cancel-interrupted');
assert.throws(() => cancelRun(interruptedCancellationRun.statePath, {
  capability: 'cancelRun', reason: '取消落盘后模拟进程中断',
}, {
  batchExecute: (input) => {
    if (input.command === 'cancel') return { state: { status: 'CANCELLING' } };
    throw new Error('MAVT_TEST_INTERRUPT_AFTER_CANCELLING');
  },
}), /MAVT_TEST_INTERRUPT_AFTER_CANCELLING/);
assert.strictEqual(loadCoordinatorState(interruptedCancellationRun.statePath).phase, 'CANCELLING');
const resumedCancellation = advanceRun(interruptedCancellationRun.statePath, {
  batchExecute: (input) => {
    assert.strictEqual(input.command, 'reconcile');
    return {
      action: 'BATCH_CANCELLED', state: { status: 'CANCELLED' },
      publicationState: { status: 'PUBLISHED' },
    };
  },
});
assert.strictEqual(resumedCancellation.status, 'COMPLETE');
assert.strictEqual(resumedCancellation.outcome, 'CANCELLED');
assert.strictEqual(loadCoordinatorState(interruptedCancellationRun.statePath).phase, 'COMPLETE');

const blockedRun = prepareConfirmedRun('batch-coordinator-blocked');
const blocked = advanceRun(blockedRun.statePath, {
  batchExecute: () => ({ action: 'BATCH_BLOCKED', state: { status: 'BLOCKED' }, failureCode: 'PLATFORM_UNAVAILABLE', reason: '设备不可用' }),
});
assert.strictEqual(blocked.status, 'BLOCKED');
assert.strictEqual(blocked.code, 'PLATFORM_UNAVAILABLE');
assert.strictEqual(blocked.reason, '设备不可用');
assert.strictEqual(blocked.reportStatus, 'DEGRADED');
assert.strictEqual(blocked.reportPath, undefined);
assert.deepStrictEqual(blocked.facts, {
  batchId: 'batch-coordinator-blocked',
  statePath: blockedRun.statePath,
  technical: { code: 'PLATFORM_UNAVAILABLE', stage: 'BATCH' },
});
assert.match(blocked.documentationRef, /references\/coordinator\/errors\/environment\.md#error-platform-unavailable$/);
assertNoEmbeddedInstructions(blocked);
const blockedAgain = advanceRun(blockedRun.statePath, {
  batchExecute: () => { throw new Error('stable BLOCKED must not re-enter Batch'); },
});
assert.strictEqual(blockedAgain.status, 'BLOCKED');
assert.strictEqual(blockedAgain.code, blocked.code);
assert.strictEqual(blockedAgain.reason, blocked.reason);
assert.strictEqual(blockedAgain.reportStatus, blocked.reportStatus);
assert.strictEqual(blockedAgain.reportPath, undefined);

const stateOnlyBlockedRun = prepareConfirmedRun('batch-coordinator-state-only-blocked');
const stateOnlyBlocked = advanceRun(stateOnlyBlockedRun.statePath, {
  batchExecute: () => ({
    action: 'BATCH_BLOCKED',
    state: {
      status: 'BLOCKED',
      failureCode: 'IOS_WDA_START_TIMEOUT',
      reason: 'WDA 启动超过等待期限',
      diagnostic: {
        code: 'IOS_WDA_START_TIMEOUT',
        stage: 'WDA_BUILD',
        summary: 'WDA 启动超过等待期限',
        retryable: true,
      },
    },
  }),
});
assert.strictEqual(stateOnlyBlocked.code, 'IOS_WDA_START_TIMEOUT');
assert.strictEqual(stateOnlyBlocked.reason, 'WDA 启动超过等待期限');
assert.strictEqual(stateOnlyBlocked.diagnostic, undefined);
assert.deepStrictEqual(stateOnlyBlocked.facts.technical, {
  code: 'IOS_WDA_START_TIMEOUT', stage: 'WDA_BUILD',
});
assertNoEmbeddedInstructions(stateOnlyBlocked);

const waitingRuntimeRun = prepareConfirmedRun('batch-coordinator-waiting-runtime');
const waitingRuntime = advanceRun(waitingRuntimeRun.statePath, {
  batchExecute: (input) => input.command === 'reconcile'
    ? { action: 'BOOTSTRAP', state: { status: 'INITIALIZING' } }
    : {
      action: 'WAIT_PLATFORM_RUNTIME',
      waitFor: 'PLATFORM_RUNTIME',
      technical: {
        code: 'DEVICE_ADAPTER_TIMEOUT',
        stage: 'PLATFORM_RUNTIME_ACQUIRE',
        summary: 'WDA 仍在启动',
        retryable: true,
      },
    },
});
assert.strictEqual(waitingRuntime.status, 'WAITING');
assert.strictEqual(waitingRuntime.waitFor, 'PLATFORM_RUNTIME');
assert.strictEqual(waitingRuntime.diagnostic, undefined);
assert.strictEqual(waitingRuntime.facts.technical.code, 'DEVICE_ADAPTER_TIMEOUT');
assertNoEmbeddedInstructions(waitingRuntime);

const waitingOwnerRun = prepareConfirmedRun('batch-coordinator-waiting-owner');
const waitingOwner = advanceRun(waitingOwnerRun.statePath, {
  batchExecute: (input) => input.command === 'reconcile'
    ? { action: 'BOOTSTRAP', state: { status: 'INITIALIZING' } }
    : {
      action: 'WAIT_PLATFORM_RUNTIME',
      waitFor: 'OWNER_BATCH_TERMINAL',
      technical: {
        code: 'IOS_APPIUM_SERVICE_IN_USE',
        stage: 'PLATFORM_RUNTIME_ACQUIRE',
        summary: 'Appium is owned by an active batch',
        retryable: true,
        recovery: { kind: 'WAIT_OR_CANCEL_OWNER_BATCH' },
      },
    },
});
assert.strictEqual(waitingOwner.status, 'WAITING');
assert.strictEqual(waitingOwner.waitFor, 'OWNER_BATCH_TERMINAL');
assert.strictEqual(waitingOwner.reason, 'PLATFORM_RUNTIME_OWNER_ACTIVE');
assert.strictEqual(waitingOwner.recovery, undefined);
assert.strictEqual(waitingOwner.facts.technical.code, 'IOS_APPIUM_SERVICE_IN_USE');
assertNoEmbeddedInstructions(waitingOwner);

const invalidConfirmRun = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-coordinator-invalid-confirm',
});
fs.writeFileSync(invalidConfirmRun.commands.confirm.requestPath, '{');
const invalidConfirmProcess = childProcess.spawnSync(process.execPath, [
  path.resolve(__dirname, '../coordinator-agent.js'), 'confirm', '--state', invalidConfirmRun.statePath,
], { encoding: 'utf8', env: process.env });
assert.strictEqual(invalidConfirmProcess.status, 2);
const invalidConfirm = JSON.parse(invalidConfirmProcess.stderr);
assert.strictEqual(invalidConfirm.status, 'REQUEST_INVALID');
assert.deepStrictEqual(invalidConfirm.facts, { phase: 'NEED_ENVIRONMENT_DECISION' });
assertNoEmbeddedInstructions(invalidConfirm);

const technicalError = new Error('probe failed before environment selection completed');
technicalError.code = 'ENVIRONMENT_PROBE_FAILED';
technicalError.diagnostic = {
  code: 'ENVIRONMENT_PROBE_FAILED',
  stage: 'ENVIRONMENT_PROBE',
  summary: '设备探测失败',
  retryable: true,
};
const technicalResponse = coordinatorAgent.errorResponse(
  technicalError,
  'confirm',
  { phase: 'NEED_ENVIRONMENT_DECISION' },
);
assert.strictEqual(technicalResponse.status, 'TECHNICAL');
assert.strictEqual(technicalResponse.diagnostic, undefined);
assert.deepStrictEqual(technicalResponse.facts, {
  phase: 'NEED_ENVIRONMENT_DECISION',
  technical: { code: 'ENVIRONMENT_PROBE_FAILED', stage: 'ENVIRONMENT_PROBE' },
});
assertNoEmbeddedInstructions(technicalResponse);

const staleConfirmationState = loadCoordinatorState(invalidConfirmRun.statePath);
staleConfirmationState.phase = 'BATCH_READY';
staleConfirmationState.bindingConfirmationTemplate = {
  capability: 'confirmRun', decision: 'CONFIRM_BINDING', userInstruction: '旧确认模板',
  binding: { platform: 'ios', deviceId: 'old-ios', appId: 'com.example.old' },
};
writeJsonAtomic(invalidConfirmRun.statePath, staleConfirmationState);
assert.deepStrictEqual(coordinatorAgent.recoveryFor([
  'confirm', '--state', invalidConfirmRun.statePath,
]), {});
staleConfirmationState.phase = 'NEED_ENVIRONMENT_DECISION';
writeJsonAtomic(invalidConfirmRun.statePath, staleConfirmationState);

fs.writeFileSync(invalidConfirmRun.commands.confirm.requestPath, '{');
const repeatedInvalidConfirmProcess = childProcess.spawnSync(process.execPath, [
  path.resolve(__dirname, '../coordinator-agent.js'), 'confirm', '--state', invalidConfirmRun.statePath,
], { encoding: 'utf8', env: process.env });
assert.strictEqual(repeatedInvalidConfirmProcess.status, 2);
const repeatedInvalidConfirm = JSON.parse(repeatedInvalidConfirmProcess.stderr);
assert.strictEqual(repeatedInvalidConfirm.status, 'AGENT_INPUT_STALLED');
assert.strictEqual(repeatedInvalidConfirm.code, 'AGENT_INPUT_STALLED');
assertNoEmbeddedInstructions(repeatedInvalidConfirm);

const advanceProcess = childProcess.spawnSync(process.execPath, [
  path.resolve(__dirname, '../coordinator-agent.js'), 'advance', '--state', invalidConfirmRun.statePath,
], { encoding: 'utf8', env: process.env });
assert.strictEqual(advanceProcess.status, 0, advanceProcess.stderr || advanceProcess.stdout);
assert.deepStrictEqual(JSON.parse(advanceProcess.stderr), {
  event: 'COORDINATOR_COMMAND_STARTED',
  capability: 'advanceRun',
  status: 'RUNNING',
});

const cancelledBeforeBatch = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-coordinator-cancelled-before-init',
});
fs.writeFileSync(cancelledBeforeBatch.commands.cancel.requestPath, JSON.stringify({
  capability: 'cancelRun', reason: '确认前取消',
}));
const preBatchCancelled = coordinatorAgent.execute({
  command: 'cancel', statePath: cancelledBeforeBatch.statePath,
});
assert.strictEqual(preBatchCancelled.status, 'COMPLETE');
assert.strictEqual(preBatchCancelled.outcome, 'CANCELLED');
assert.strictEqual(fs.existsSync(cancelledBeforeBatch.commands.cancel.requestPath), false);
assert.strictEqual(preBatchCancelled.reportStatus, 'DEGRADED');
assert.strictEqual(preBatchCancelled.reportPath, undefined);

const sameTimeA = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  now: '2026-09-11T03:00:00.000Z',
});
const sameTimeB = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  now: '2026-09-11T03:00:00.000Z',
});
assert.notStrictEqual(sameTimeA.statePath, sameTimeB.statePath);

assert.throws(
  () => prepareRun({ capability: 'prepareRun', workspace, caseNos: ['999'] }, { batchId: 'batch-missing-case' }),
  (error) => error.code === 'COORDINATOR_INPUT_INVALID' && error.issues.some((item) => item.field === 'caseNos[0]'),
);

fs.rmSync(temp, { recursive: true, force: true });
console.log('coordinator Agent-facing facade passed');
