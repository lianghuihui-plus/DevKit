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
  prepareRun: prepareBoundRun,
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

function prepareRun(request, options = {}) { return prepareBoundRun(request, { workspace, ...options }); }
function statePath(response) { return response.result.command.match(/ --state '([^']+)'$/)[1]; }
function content(response) { return response.data?.content || {}; }
function diagnostic(response) { return require('../coordinator/agent-resource-store').readResource(loadCoordinatorState(statePath(response)), response.resources[0].ref).data.content; }

const case014 = createCase('014');
const case015 = createCase('015');

assert.deepStrictEqual(validateCoordinatorRequest({ operation: 'prepareRun', input: { caseNos: ['014'] } }), []);
assert.ok(validateCoordinatorRequest({ operation: 'prepareRun', input: { caseNos: ['014'], workspace } }).length);

assert.deepStrictEqual(COORDINATOR_CAPABILITIES, ['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun', 'read']);
for (const [name, method] of Object.entries(PUBLIC_CONTRACT.methods)) {
  assert.deepStrictEqual(validateCoordinatorRequest(method.minimalExample), [], `${name} documentation example must validate`);
}

const prepared = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014', '015']  } }, {
  batchId: 'batch-coordinator-facing',
  now: '2026-09-11T02:00:00.000Z',
});
assert.strictEqual(prepared.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(prepared).reason, 'CHOOSE_ENVIRONMENT');
assert.ok(prepared.result.command);
assert.deepStrictEqual(Object.keys(prepared).sort(), ['data', 'operation', 'protocol', 'resources', 'result', 'status']);
assert.strictEqual(prepared.status, 'SUCCEEDED');
assert.ok(fs.existsSync(statePath(prepared)));
assert.strictEqual(Object.prototype.hasOwnProperty.call(loadCoordinatorState(statePath(prepared)), 'schemaVersion'), false);

assert.deepStrictEqual(content(prepared).choices, [
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

const unavailableRun = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-environment-unavailable',
});
const unavailable = confirmRun(statePath(unavailableRun), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'android',
 } }, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'android', ready: false,
    devices: [], diagnostics: [{ id: 'adbMissing', level: 'ERROR', message: '未找到 adb' }],
  }),
});
assert.strictEqual(unavailable.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(unavailable).reason, 'ENVIRONMENT_NOT_READY');
assert.strictEqual(content(unavailable).code, 'ENVIRONMENT_NOT_READY');
assert.match(diagnostic(unavailable).resourceFacts.diagnostics[0].message, /adb/);
assert.ok(content(unavailable).choices.some((choice) => choice.id === 'SELECT_HARMONY'));
assert.strictEqual(loadCoordinatorState(statePath(unavailableRun)).phase, 'NEED_ENVIRONMENT_DECISION');

const needBinding = confirmRun(statePath(prepared), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'harmony',
 } }, {
  probeEnvironment: () => probe,
  now: '2026-09-11T02:00:03.000Z',
});
assert.strictEqual(needBinding.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(needBinding).reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.deepStrictEqual(content(needBinding).devices, probe.devices);
assert.deepStrictEqual(content(needBinding).binding, {
  platform: 'harmony', deviceId: 'device-001', deviceFormFactor: 'phone',
});
assert.deepStrictEqual(content(needBinding).requiredUserFields, ['binding.appId', 'binding.entry']);
assert.strictEqual(JSON.stringify(needBinding).includes('probeJson'), false);
assert.strictEqual(needBinding.result.phase, 'NEED_BINDING_CONFIRMATION');
assertNoEmbeddedInstructions(needBinding);

assert.throws(() => confirmEnvironment({
  workspaceRoot: workspace,
  binding: { platform: 'harmony', deviceId: 'device-001', appId: '<target-app-id>', entry: '<entry-ability>' },
  probe,
  userConfirmation: '确认环境',
}), (error) => error.code === 'ENVIRONMENT_CONFIRMATION_INVALID');

const initCalls = [];
const confirmed = confirmRun(statePath(prepared), { operation: 'confirmRun', input: { decision: 'CONFIRM_BINDING',
  userInstruction: '确认执行 014 和 015 用例',
  binding: {
    platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility',
    deviceFormFactor: 'phone',
  },
 } }, {
  batchExecute: (input) => { initCalls.push(input); return { state: { status: 'INITIALIZING' } }; },
  now: '2026-09-11T02:00:04.000Z',
});
assert.strictEqual(confirmed.result.outcome, 'CONFIRMED');
assert.deepStrictEqual(initCalls.map((item) => item.command), ['init']);
assert.strictEqual(readJson(path.join(workspace, 'runs', 'batch-coordinator-facing', 'execution-request.json'), null).targets.length, 2);
assert.strictEqual(loadCoordinatorState(statePath(prepared)).phase, 'BATCH_READY');
assert.strictEqual(loadCoordinatorState(statePath(prepared)).initialization.environmentFrozen.environment.binding.platform, 'harmony');
assert.ok(loadCoordinatorState(statePath(prepared)).initialization.executionRequestCreated.requestSha);
assert.ok(loadCoordinatorState(statePath(prepared)).initialization.batchInitialized);

const androidProbe = {
  schemaVersion: 1,
  type: 'environmentProbe',
  platform: 'android',
  ready: true,
  devices: [{ id: 'android-device', serial: 'android-device' }],
  diagnostics: [],
  capabilities: { screenshot: true, layout: true },
};
const androidPreparedRun = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-android-input-prepared',
});
confirmRun(statePath(androidPreparedRun), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'android',
 } }, { probeEnvironment: () => androidProbe });
const preparationCalls = [];
const androidPrepared = confirmRun(statePath(androidPreparedRun), { operation: 'confirmRun', input: { decision: 'CONFIRM_BINDING',
  userInstruction: '确认 Android 输入能力由框架自动准备',
  binding: {
    platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
  },
 } }, {
  prepareEnvironment: (input) => {
    preparationCalls.push(input);
    return { schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true, dependencies: [] };
  },
  batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
});
assert.strictEqual(androidPrepared.result.outcome, 'CONFIRMED');
assert.deepStrictEqual(preparationCalls, [{
  binding: {
    platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
  },
}]);
assert.deepStrictEqual(loadCoordinatorState(statePath(androidPreparedRun)).initialization.environmentPrepared, {
  platform: 'android',
  status: 'READY',
});

const androidPreparationFailureRun = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-android-input-prepare-failure',
});
confirmRun(statePath(androidPreparationFailureRun), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'android',
 } }, { probeEnvironment: () => androidProbe });
let preparationError;
try {
  confirmRun(statePath(androidPreparationFailureRun), { operation: 'confirmRun', input: { decision: 'CONFIRM_BINDING',
    userInstruction: '确认 Android 输入能力失败时保持可恢复',
    binding: {
      platform: 'android', deviceId: 'android-device', appId: 'com.example.android', entry: '.MainActivity',
    },
   } }, {
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
assert.strictEqual(preparationErrorResponse.error.retryable, true);
assert.match(preparationErrorResponse.error.documentationRef, /references\/coordinator\/errors\/environment\.md#error-input-capability-not-ready$/);
assertNoEmbeddedInstructions(preparationErrorResponse);
assert.strictEqual(fs.existsSync(path.join(
  workspace, 'runs', 'batch-android-input-prepare-failure', 'execution-request.json',
)), false);
assert.strictEqual(loadCoordinatorState(statePath(androidPreparationFailureRun)).phase, 'INITIALIZING_RUN');
const recoveredAndroidPreparation = advanceRun(statePath(androidPreparationFailureRun), {
  prepareEnvironment: () => ({
    schemaVersion: 1, type: 'environmentPrepare', platform: 'android', ok: true, dependencies: [],
  }),
  batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
});
assert.strictEqual(recoveredAndroidPreparation.result.outcome, 'CONFIRMED');

confirmEnvironment({
  workspaceRoot: workspace,
  binding: { platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility' },
  probe,
  userConfirmation: '恢复协调器测试的 HarmonyOS 环境',
});

const switchable = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-switch-existing-environment',
});
assert.strictEqual(switchable.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(switchable).reason, 'CHOOSE_ENVIRONMENT');
assert.strictEqual(content(switchable).binding.platform, 'harmony');
assert.deepStrictEqual(content(switchable).choices[0], { id: 'USE_CURRENT', decision: 'USE_CURRENT' });
assert.ok(content(switchable).choices.some((choice) => choice.id === 'SELECT_IOS'));
const selectedIos = confirmRun(statePath(switchable), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'ios',
 } }, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: true,
    devices: [{ id: 'ios-device', udid: 'ios-device', deviceType: 'realDevice' }], diagnostics: [],
  }),
});
assert.strictEqual(selectedIos.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(selectedIos).reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.strictEqual(content(selectedIos).binding.platform, 'ios');
assert.strictEqual(content(selectedIos).binding.deviceId, 'ios-device');
assertNoEmbeddedInstructions(selectedIos);

const multiIos = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-ios-multiple-devices',
});
const multiIosSelection = confirmRun(statePath(multiIos), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'ios',
 } }, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: true,
    deviceDetected: true, devices: [
      { id: 'ios-a', udid: 'ios-a', deviceType: 'realDevice' },
      { id: 'ios-b', udid: 'ios-b', deviceType: 'realDevice' },
    ], diagnostics: [],
  }),
});
assert.strictEqual(content(multiIosSelection).reason, 'SELECT_DEVICE');
assert.deepStrictEqual(content(multiIosSelection).choices.map((choice) => choice.deviceId), ['ios-a', 'ios-b']);
assertNoEmbeddedInstructions(multiIosSelection);
const multiIosConfirmed = confirmRun(statePath(multiIos), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'ios', deviceId: 'ios-b',
 } }, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: true,
    deviceDetected: true, devices: [
      { id: 'ios-a', udid: 'ios-a', deviceType: 'realDevice' },
      { id: 'ios-b', udid: 'ios-b', deviceType: 'realDevice' },
    ], diagnostics: [],
  }),
});
assert.strictEqual(content(multiIosConfirmed).binding.deviceId, 'ios-b');

const iosDeviceDetectedButSigningPending = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-ios-device-detected-signing-pending',
});
const iosSigningPending = confirmRun(statePath(iosDeviceDetectedButSigningPending), { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'ios',
 } }, {
  probeEnvironment: () => ({
    schemaVersion: 1, type: 'environmentProbe', platform: 'ios', ready: false,
    deviceDetected: true, confirmationReady: true, executionReady: false,
    devices: [{ id: 'ios-real-device', udid: 'ios-real-device', deviceType: 'realDevice' }],
    diagnostics: [{ id: 'iosRealDeviceSigningIncomplete', level: 'ERROR', message: '需要补充 WDA 签名参数' }],
  }),
});
assert.strictEqual(iosSigningPending.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(iosSigningPending).reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.strictEqual(content(iosSigningPending).executionReady, false);
assert.deepStrictEqual(content(iosSigningPending).devices[0], {
  id: 'ios-real-device', udid: 'ios-real-device', deviceType: 'realDevice',
});
const iosSigningMissing = confirmRun(statePath(iosDeviceDetectedButSigningPending), { operation: 'confirmRun', input: { decision: 'CONFIRM_BINDING',
  userInstruction: '先尝试不带签名参数确认',
  binding: {
    platform: 'ios', deviceId: 'ios-real-device', appId: 'com.example.ios', deviceType: 'realDevice',
  },
 } });
assert.strictEqual(iosSigningMissing.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(iosSigningMissing).reason, 'IOS_SIGNING_REQUIRED');
assert.deepStrictEqual(content(iosSigningMissing).requiredBindingFields, ['xcodeOrgId', 'xcodeSigningId', 'updatedWDABundleId']);
const iosSigningConfirmed = confirmRun(statePath(iosDeviceDetectedButSigningPending), { operation: 'confirmRun', input: { decision: 'CONFIRM_BINDING',
  userInstruction: '补充签名参数后确认执行',
  binding: {
    platform: 'ios', deviceId: 'ios-real-device', appId: 'com.example.ios', deviceType: 'realDevice',
    xcodeOrgId: 'TEAM', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.wda',
  },
 } }, {
  batchExecute: () => ({ state: { status: 'INITIALIZING' } }),
});
assert.strictEqual(iosSigningConfirmed.result.outcome, 'CONFIRMED');
confirmEnvironment({
  workspaceRoot: workspace,
  binding: { platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility' },
  probe,
  userConfirmation: '恢复协调器测试的 HarmonyOS 环境',
});
const invalidBindingConfirmation = coordinatorAgent.main(['--state', statePath(selectedIos)], { returnOnly: true, stdin: '{' });
assert.strictEqual(invalidBindingConfirmation.status, 'REJECTED');
assert.strictEqual(invalidBindingConfirmation.error.code, 'COORDINATOR_INPUT_INVALID');
assertNoEmbeddedInstructions(invalidBindingConfirmation);

const environmentFile = path.join(workspace, 'environment-confirmation.json');
const validEnvironmentSource = fs.readFileSync(environmentFile, 'utf8');
fs.writeFileSync(environmentFile, '{');
const invalidDefaultEnvironment = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-invalid-default-environment',
});
assert.strictEqual(invalidDefaultEnvironment.result.outcome, 'NEED_USER_CONFIRMATION');
assert.strictEqual(content(invalidDefaultEnvironment).binding, undefined);
assert.ok(diagnostic(invalidDefaultEnvironment).resourceFacts.diagnostics.length);
assert.deepStrictEqual(content(invalidDefaultEnvironment).choices.map((choice) => choice.id), [
  'SELECT_HARMONY', 'SELECT_ANDROID', 'SELECT_IOS',
]);
fs.writeFileSync(environmentFile, validEnvironmentSource);

const frozenOffer = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
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
const frozenOfferResult = confirmRun(statePath(frozenOffer), { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: '确认使用响应中展示的环境',
 } }, {
  createExecutionRequest: (input) => {
    assert.strictEqual(input.environmentConfirmation.binding.platform, 'harmony');
    assert.strictEqual(input.environmentConfirmation.binding.deviceId, 'device-001');
    return frozenOfferRequest;
  },
  batchExecute: () => ({ state: { status: 'INITIALIZING' }, contract: { contractSha: 'contract-frozen-offer' } }),
});
assert.strictEqual(frozenOfferResult.result.outcome, 'CONFIRMED');
fs.writeFileSync(environmentFile, validEnvironmentSource);

function verifyInitializationRecovery(interruptAfter, expected) {
  const suffix = interruptAfter.replace(/[^a-z]/gi, '-').toLowerCase();
  const start = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
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
  assert.throws(() => confirmRun(statePath(start), { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: `确认恢复 ${suffix}`,
   } }, options), new RegExp(`MAVT_COORDINATOR_INTERRUPTED: ${interruptAfter}`));
  const interrupted = loadCoordinatorState(statePath(start));
  assert.strictEqual(interrupted.phase, 'INITIALIZING_RUN');
  assert.ok(interrupted.initialization.environmentFrozen);
  assert.strictEqual(Boolean(interrupted.initialization.executionRequestCreated), expected.requestRecorded);
  assert.strictEqual(Boolean(interrupted.initialization.batchInitialized), expected.batchRecorded);

  const resumed = advanceRun(statePath(start), { ...options, interruptAfter: null });
  assert.strictEqual(resumed.result.outcome, 'CONFIRMED');
  assert.strictEqual(loadCoordinatorState(statePath(start)).phase, 'BATCH_READY');
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
const handoffEnvelope = { handoffId: 'handoff-test', sequence: 1, batchId: 'batch-coordinator-facing', executionId: 'execution-014' };
const handoffSha = crypto.createHash('sha256').update(require('../lib/contract-utils').canonicalJson(handoffEnvelope)).digest('hex');
const handoffPath = path.join(path.dirname(statePath(prepared)), 'handoffs', 'execution-014', `1-${handoffSha}.json`);
writeJsonAtomic(handoffPath, handoffEnvelope);
const needsCaseAgent = advanceRun(statePath(prepared), {
  batchExecute: (input) => {
    calls.push(input.command);
    if (input.command === 'reconcile') return sequence.shift();
    if (input.command === 'bootstrap') return { state: { status: 'RUNNING' } };
    if (input.command === 'start') return {
      action: 'DELEGATE_CASE_AGENT', agentRequired: true, batchId: 'batch-coordinator-facing',
      caseKey: case014.caseKey, executionId: 'execution-014',
      handoff: { handoffId: handoffEnvelope.handoffId, loaderCommand: 'opaque-case-loader', path: handoffPath, sha256: handoffSha },
    };
    throw new Error(`unexpected command ${input.command}`);
  },
  now: '2026-09-11T02:00:05.000Z',
});
assert.strictEqual(needsCaseAgent.result.outcome, 'NEED_CASE_AGENT');
assert.strictEqual(content(needsCaseAgent).loaderCommand, 'opaque-case-loader');
assert.match(content(needsCaseAgent).delegationPrompt, /独立 Case Agent/);
assert.deepStrictEqual(calls, ['reconcile', 'bootstrap', 'reconcile', 'start']);
for (const hidden of ['handoff', 'path', 'sha256', 'brief', 'source']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(needsCaseAgent, hidden), false, `dispatch response must not expose ${hidden}`);
}

const waiting = advanceRun(statePath(prepared), {
  batchExecute: () => ({
    action: 'WAIT_EXECUTION_RESULT', batchId: 'batch-coordinator-facing', caseKey: case014.caseKey, executionId: 'execution-014',
    progress: {
      executionPhase: 'HANDOFF_CONSUMED', lastEventType: 'actionOutcomeUnknown', lastEventAt: '2026-09-11T02:00:06.000Z',
      resultArtifacts: { result: false, metrics: false, executionFinalized: false, runtimeCompleted: false },
    },
  }),
});
assert.deepStrictEqual(waiting.result.outcome, 'WAITING');
assert.strictEqual(content(waiting).reason, 'WAIT_EXECUTION_RESULT');
assert.strictEqual(waiting.result.waitFor, 'EXECUTION_RESULT');
assert.strictEqual(content(waiting).caseNo, '014');
assert.strictEqual(content(waiting).caseKey, case014.caseKey);
assert.strictEqual(content(waiting).executionId, 'execution-014');
assert.strictEqual(content(waiting).progress.executionPhase, 'HANDOFF_CONSUMED');
assert.strictEqual(content(waiting).progress.lastEventType, 'actionOutcomeUnknown');
assert.strictEqual(waiting.result.command, prepared.result.command);

const complete = advanceRun(statePath(prepared), {
  batchExecute: () => ({ action: 'BATCH_COMPLETE', state: { status: 'COMPLETED' }, publicationState: { status: 'PUBLISHED' } }),
});
assert.strictEqual(complete.result.outcome, 'COMPLETE');
assert.strictEqual(complete.data.content.runOutcome, 'COMPLETED');
assert.strictEqual(content(complete).reportPath, path.join(workspace, 'index.html'));
assert.strictEqual(loadCoordinatorState(statePath(prepared)).phase, 'COMPLETE');

const retryPublicationRun = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-report-retry-terminal',
});
confirmRun(statePath(retryPublicationRun), { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: '确认执行报告重试终态用例',
 } }, { batchExecute: () => ({ state: { status: 'INITIALIZING' } }) });
const completeWithReportRetry = advanceRun(statePath(retryPublicationRun), {
  batchExecute: () => ({
    action: 'BATCH_COMPLETE',
    state: { status: 'COMPLETED' },
    publicationState: { status: 'RETRY_REQUIRED', errorCode: 'EXECUTION_LOCKED', reason: '报告锁冲突' },
  }),
});
assert.strictEqual(completeWithReportRetry.result.outcome, 'COMPLETE');
assert.strictEqual(completeWithReportRetry.data.content.runOutcome, 'COMPLETED');
assert.strictEqual(content(completeWithReportRetry).reportStatus, 'RETRY_REQUIRED');
assert.strictEqual(content(completeWithReportRetry).reportPath, undefined);
writeJsonAtomic(path.join(workspace, 'runs', 'batch-report-retry-terminal', 'report-publication.json'), {
  schemaVersion: 1,
  batchId: 'batch-report-retry-terminal',
  status: 'PUBLISHED',
  attempts: [],
});
const completeAfterReportRecovery = advanceRun(statePath(retryPublicationRun));
assert.strictEqual(completeAfterReportRecovery.result.outcome, 'COMPLETE');
assert.strictEqual(completeAfterReportRecovery.data.content.runOutcome, 'COMPLETED');
assert.strictEqual(content(completeAfterReportRecovery).reportStatus, 'RETRY_REQUIRED');
assert.strictEqual(content(completeAfterReportRecovery).reportPath, undefined);
assert.deepStrictEqual(completeAfterReportRecovery.data, completeWithReportRetry.data);

function prepareConfirmedRun(batchId) {
  const start = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, { batchId });
  const ready = confirmRun(statePath(start), { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: `确认执行 ${batchId}`,
   } }, { batchExecute: () => ({ state: { status: 'INITIALIZING' } }) });
  assert.strictEqual(ready.result.outcome, 'CONFIRMED');
  return start;
}

const cancelledRun = prepareConfirmedRun('batch-coordinator-cancelled');
const cancelCalls = [];
const cancelled = cancelRun(statePath(cancelledRun), { operation: 'cancelRun', input: { reason: '用户取消测试'  } }, {
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
assert.strictEqual(cancelled.result.outcome, 'COMPLETE');
assert.strictEqual(cancelled.data.content.runOutcome, 'CANCELLED');
assert.strictEqual(content(cancelled).reportStatus, 'DEGRADED');
assert.strictEqual(content(cancelled).reportPath, undefined);
assert.strictEqual(content(cancelled).reportErrorCode, 'REPORT_RENDERER_INVALID');
assert.deepStrictEqual(cancelCalls, ['cancel', 'reconcile']);
assert.strictEqual(loadCoordinatorState(statePath(cancelledRun)).updatedAt, '2026-09-11T04:00:00.000Z');

const interruptedCancellationRun = prepareConfirmedRun('batch-coordinator-cancel-interrupted');
assert.throws(() => cancelRun(statePath(interruptedCancellationRun), { operation: 'cancelRun', input: { reason: '取消落盘后模拟进程中断',
 } }, {
  batchExecute: (input) => {
    if (input.command === 'cancel') return { state: { status: 'CANCELLING' } };
    throw new Error('MAVT_TEST_INTERRUPT_AFTER_CANCELLING');
  },
}), /MAVT_TEST_INTERRUPT_AFTER_CANCELLING/);
assert.strictEqual(loadCoordinatorState(statePath(interruptedCancellationRun)).phase, 'CANCELLING');
const resumedCancellation = advanceRun(statePath(interruptedCancellationRun), {
  batchExecute: (input) => {
    assert.strictEqual(input.command, 'reconcile');
    return {
      action: 'BATCH_CANCELLED', state: { status: 'CANCELLED' },
      publicationState: { status: 'PUBLISHED' },
    };
  },
});
assert.strictEqual(resumedCancellation.result.outcome, 'COMPLETE');
assert.strictEqual(resumedCancellation.data.content.runOutcome, 'CANCELLED');
assert.strictEqual(loadCoordinatorState(statePath(interruptedCancellationRun)).phase, 'COMPLETE');

const blockedRun = prepareConfirmedRun('batch-coordinator-blocked');
const blocked = advanceRun(statePath(blockedRun), {
  batchExecute: () => ({ action: 'BATCH_BLOCKED', state: { status: 'BLOCKED' }, failureCode: 'PLATFORM_UNAVAILABLE', reason: '设备不可用' }),
});
assert.strictEqual(blocked.result.outcome, 'BLOCKED');
assert.strictEqual(content(blocked).code, 'PLATFORM_UNAVAILABLE');
assert.strictEqual(content(blocked).reason, '设备不可用');
assert.strictEqual(content(blocked).reportStatus, 'DEGRADED');
assert.strictEqual(content(blocked).reportPath, undefined);
assert.deepStrictEqual(diagnostic(blocked), { code: 'PLATFORM_UNAVAILABLE', stage: 'BATCH' });
assertNoEmbeddedInstructions(blocked);
const blockedAgain = advanceRun(statePath(blockedRun), {
  batchExecute: () => { throw new Error('stable BLOCKED must not re-enter Batch'); },
});
assert.strictEqual(blockedAgain.result.outcome, 'BLOCKED');
assert.strictEqual(content(blockedAgain).code, content(blocked).code);
assert.strictEqual(content(blockedAgain).reason, content(blocked).reason);
assert.strictEqual(content(blockedAgain).reportStatus, content(blocked).reportStatus);
assert.strictEqual(content(blockedAgain).reportPath, undefined);

const stateOnlyBlockedRun = prepareConfirmedRun('batch-coordinator-state-only-blocked');
const stateOnlyBlocked = advanceRun(statePath(stateOnlyBlockedRun), {
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
assert.strictEqual(content(stateOnlyBlocked).code, 'IOS_WDA_START_TIMEOUT');
assert.strictEqual(content(stateOnlyBlocked).reason, 'WDA 启动超过等待期限');
assert.strictEqual(stateOnlyBlocked.diagnostic, undefined);
assert.deepStrictEqual(diagnostic(stateOnlyBlocked), {
  code: 'IOS_WDA_START_TIMEOUT', stage: 'WDA_BUILD',
});
assertNoEmbeddedInstructions(stateOnlyBlocked);

const waitingRuntimeRun = prepareConfirmedRun('batch-coordinator-waiting-runtime');
const waitingRuntime = advanceRun(statePath(waitingRuntimeRun), {
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
assert.strictEqual(waitingRuntime.result.outcome, 'WAITING');
assert.strictEqual(waitingRuntime.result.waitFor, 'PLATFORM_RUNTIME');
assert.strictEqual(waitingRuntime.diagnostic, undefined);
assert.strictEqual(diagnostic(waitingRuntime).code, 'DEVICE_ADAPTER_TIMEOUT');
assertNoEmbeddedInstructions(waitingRuntime);

const waitingOwnerRun = prepareConfirmedRun('batch-coordinator-waiting-owner');
const waitingOwner = advanceRun(statePath(waitingOwnerRun), {
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
assert.strictEqual(waitingOwner.result.outcome, 'WAITING');
assert.strictEqual(waitingOwner.result.waitFor, 'OWNER_BATCH_TERMINAL');
assert.strictEqual(content(waitingOwner).reason, 'PLATFORM_RUNTIME_OWNER_ACTIVE');
assert.strictEqual(waitingOwner.recovery, undefined);
assert.strictEqual(diagnostic(waitingOwner).code, 'IOS_APPIUM_SERVICE_IN_USE');
assertNoEmbeddedInstructions(waitingOwner);

const invalidConfirmRun = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  batchId: 'batch-coordinator-invalid-confirm',
});
function callCommand(response, request) {
  const child = childProcess.spawnSync('/bin/zsh', ['-c', response.result.command], { encoding: 'utf8', env: process.env, input: typeof request === 'string' ? request : JSON.stringify(request) });
  assert.strictEqual(child.stderr, '');
  const envelope = JSON.parse(child.stdout);
  assert.strictEqual(child.status, envelope.status === 'SUCCEEDED' ? 0 : 2);
  return envelope;
}
const invalidConfirm = callCommand(invalidConfirmRun, { operation: 'confirmRun', input: {} });
assert.strictEqual(invalidConfirm.status, 'REJECTED');
assert.strictEqual(invalidConfirm.error.code, 'COORDINATOR_INPUT_INVALID');
assert.ok(invalidConfirm.error.operationDocumentationRef);
const repeatedInvalidConfirm = callCommand(invalidConfirmRun, { operation: 'confirmRun', input: {} });
assert.strictEqual(repeatedInvalidConfirm.status, 'REJECTED');
assert.strictEqual(repeatedInvalidConfirm.error.code, 'AGENT_INPUT_STALLED');
const advanced = callCommand(invalidConfirmRun, { operation: 'advanceRun', input: {} });
assert.strictEqual(advanced.status, 'SUCCEEDED');
assert.strictEqual(advanced.result.command, invalidConfirmRun.result.command);
assert.strictEqual(callCommand(invalidConfirmRun, '{}\n{}').status, 'REJECTED');
const technicalResponse = coordinatorAgent.errorResponse(Object.assign(new Error('probe failed'), { code: 'ENVIRONMENT_PROBE_FAILED' }), 'confirmRun');
assert.strictEqual(technicalResponse.status, 'FAILED');
assert.strictEqual(technicalResponse.error.code, 'COORDINATOR_TECHNICAL');
assertNoEmbeddedInstructions(technicalResponse);
const technicalWithResource = coordinatorAgent.main(['--state', statePath(invalidConfirmRun)], {
  returnOnly: true, request: { operation: 'confirmRun', input: { decision: 'SELECT_PLATFORM', platform: 'ios' } },
  probeEnvironment: () => {
    throw Object.assign(new Error('probe failed'), { code: 'ENVIRONMENT_PROBE_FAILED', diagnostic: {
      code: 'ENVIRONMENT_PROBE_FAILED', stage: 'ENVIRONMENT_PROBE', resourceFacts: { connected: false },
    } });
  },
});
assert.strictEqual(technicalWithResource.status, 'FAILED');
assert.strictEqual(technicalWithResource.resources[0].type, 'coordinatorDiagnostic');
const technicalDetail = callCommand(invalidConfirmRun, { operation: 'read', input: { ref: technicalWithResource.resources[0].ref } });
assert.deepStrictEqual(technicalDetail.data.content, {
  code: 'ENVIRONMENT_PROBE_FAILED', stage: 'ENVIRONMENT_PROBE', resourceFacts: { connected: false },
});
const cancelledBeforeBatch = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014'] } }, { batchId: 'batch-coordinator-cancelled-before-init' });
const preBatchCancelled = callCommand(cancelledBeforeBatch, { operation: 'cancelRun', input: { reason: '确认前取消' } });
assert.strictEqual(preBatchCancelled.result.outcome, 'COMPLETE');
assert.strictEqual(content(preBatchCancelled).runOutcome, 'CANCELLED');
assert.strictEqual(content(preBatchCancelled).reportStatus, 'DEGRADED');
assert.strictEqual(content(preBatchCancelled).reportPath, undefined);
const sameTimeA = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  now: '2026-09-11T03:00:00.000Z',
});
const sameTimeB = prepareRun({ operation: 'prepareRun', input: { caseNos: ['014']  } }, {
  now: '2026-09-11T03:00:00.000Z',
});
assert.notStrictEqual(statePath(sameTimeA), statePath(sameTimeB));

assert.throws(
  () => prepareRun({ operation: 'prepareRun', input: { caseNos: ['999']  } }, { batchId: 'batch-missing-case' }),
  (error) => error.code === 'COORDINATOR_INPUT_INVALID' && error.issues.some((item) => item.field === 'caseNos[0]'),
);

// Every public outcome uses the contract's allowlist; neither the old transport
// bindings nor a primary resource repeated in resources may escape projection.
for (const response of [prepared, unavailable, needBinding, confirmed, multiIosSelection, iosSigningPending,
  needsCaseAgent, waiting, complete, cancelled, blocked, waitingRuntime, waitingOwner]) {
  assert.strictEqual(response.status, 'SUCCEEDED');
  const projection = PUBLIC_CONTRACT.methods[response.operation].responseProjection.outcomes[response.result.outcome];
  assert.ok(projection);
  assert.ok(Object.keys(response.result).every((field) => projection.resultFields.includes(field)));
  assert.strictEqual(response.data?.type || null, projection.primaryResourceType);
  assert.ok(response.resources.every((item) => projection.associatedResourceTypes.includes(item.type)));
  assert.ok(response.resources.every((item) => item.ref !== response.data?.ref));
  assert.strictEqual(response.statePath, undefined);
  assert.strictEqual(response.commands, undefined);
  assert.strictEqual(response.requestPath, undefined);
  if (response.data && response.data.type !== 'caseDispatch') assert.strictEqual(JSON.stringify(response.data).includes(workspace), response.data.type === 'runSummary' && Boolean(content(response).reportPath));
}

// Historical resources remain immutable and readable after the run terminates.
const { executeRunRequest } = require('../coordinator/agent-facing-service');
for (const response of [prepared, needBinding, needsCaseAgent, waiting, complete, unavailable, blocked, waitingRuntime]) {
  const file = statePath(response);
  const before = fs.readFileSync(file, 'utf8');
  const loaded = executeRunRequest(file, { operation: 'read', input: { ref: response.data.ref } });
  assert.strictEqual(loaded.status, 'SUCCEEDED');
  assert.deepStrictEqual(loaded.data, response.data);
  assert.deepStrictEqual(loaded.resources, response.resources);
  assert.deepStrictEqual(Object.keys(loaded.result).sort(), ['outcome', 'resourceRef', 'resourceType']);
  for (const linked of response.resources) {
    const detail = executeRunRequest(file, { operation: 'read', input: { ref: linked.ref } });
    assert.strictEqual(detail.data.type, 'coordinatorDiagnostic');
    assert.strictEqual(detail.data.ref, linked.ref);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
}
const terminalBefore = fs.readFileSync(statePath(blocked), 'utf8');
const noBatch = { batchExecute: () => { throw new Error('terminal calls must not reenter Batch'); } };
assert.deepStrictEqual(cancelRun(statePath(blocked), { operation: 'cancelRun', input: { reason: '再次取消' } }, noBatch).data, blocked.data);
assert.deepStrictEqual(advanceRun(statePath(blocked), noBatch).data, blocked.data);
assert.deepStrictEqual(cancelRun(statePath(complete), { operation: 'cancelRun', input: { reason: '再次取消' } }, noBatch).data, complete.data);
assert.strictEqual(callCommand(blocked, { operation: 'confirmRun', input: { decision: 'USE_CURRENT', userInstruction: '再确认' } }).error.code, 'COORDINATOR_TERMINAL');
assert.strictEqual(fs.readFileSync(statePath(blocked), 'utf8'), terminalBefore);
const foreign = callCommand(blocked, { operation: 'read', input: { ref: complete.data.ref } });
assert.strictEqual(foreign.status, 'REJECTED');
assert.strictEqual(foreign.error.code, 'RESOURCE_SCOPE_MISMATCH');
const unknownRef = blocked.data.ref.replace(/:[^:]+$/, ':not-published');
assert.strictEqual(callCommand(blocked, { operation: 'read', input: { ref: unknownRef } }).error.code, 'RESOURCE_UNKNOWN');
assert.strictEqual(callCommand(blocked, { operation: 'read', input: {} }).error.code, 'COORDINATOR_INPUT_INVALID');
assert.strictEqual(fs.readFileSync(statePath(blocked), 'utf8'), terminalBefore);

function resourceRecord(response) {
  const name = crypto.createHash('sha256').update(response.data.ref).digest('hex');
  const file = path.join(path.dirname(statePath(response)), 'coordinator-resources', 'catalog', `${name}.json`);
  return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const dispatchRecord = resourceRecord(needsCaseAgent);
const handoffOriginal = fs.readFileSync(handoffPath, 'utf8');
writeJsonAtomic(handoffPath, { ...handoffEnvelope, sequence: 2 });
assert.strictEqual(callCommand(needsCaseAgent, { operation: 'read', input: { ref: needsCaseAgent.data.ref } }).error.code, 'RESOURCE_INTEGRITY_INVALID');
fs.writeFileSync(handoffPath, handoffOriginal);
const registryOriginal = fs.readFileSync(dispatchRecord.file, 'utf8');
const alteredDispatch = { ...dispatchRecord.record, loaderCommand: 'untrusted-command' };
alteredDispatch.integrity = crypto.createHash('sha256').update(require('../lib/contract-utils').canonicalJson({
  content: { ...needsCaseAgent.data.content, loaderCommand: 'untrusted-command' }, resources: [],
})).digest('hex');
writeJsonAtomic(dispatchRecord.file, alteredDispatch);
assert.strictEqual(callCommand(needsCaseAgent, { operation: 'read', input: { ref: needsCaseAgent.data.ref } }).error.code, 'RESOURCE_INTEGRITY_INVALID');
fs.writeFileSync(dispatchRecord.file, registryOriginal);
const { record: snapshotRecord } = resourceRecord(waiting);
const snapshotPath = path.join(path.dirname(statePath(waiting)), snapshotRecord.source);
const snapshotOriginal = fs.readFileSync(snapshotPath, 'utf8');
fs.writeFileSync(snapshotPath, '{}');
const corrupt = callCommand(waiting, { operation: 'read', input: { ref: waiting.data.ref } });
assert.strictEqual(corrupt.status, 'FAILED');
assert.strictEqual(corrupt.error.code, 'RESOURCE_INTEGRITY_INVALID');
fs.unlinkSync(snapshotPath);
fs.symlinkSync(handoffPath, snapshotPath);
assert.strictEqual(callCommand(waiting, { operation: 'read', input: { ref: waiting.data.ref } }).error.code, 'RESOURCE_INTEGRITY_INVALID');
fs.unlinkSync(snapshotPath);
fs.writeFileSync(snapshotPath, snapshotOriginal);
assert.deepStrictEqual(callCommand(waiting, { operation: 'read', input: { ref: waiting.data.ref } }).data, waiting.data);

// Shell metacharacters in the bound workspace remain literal when the Agent
// executes the returned command; requests cannot replace the bound workspace.
const unusualWorkspace = path.join(temp, "workspace ' $USER `literal`");
createTestWorkspace(unusualWorkspace);
fs.cpSync(case014.caseDir, path.join(unusualWorkspace, 'cases', path.basename(case014.caseDir)), { recursive: true });
const unusualPrepared = coordinatorAgent.main(['--workspace', unusualWorkspace], {
  returnOnly: true, request: { operation: 'prepareRun', input: { caseNos: ['014'] } },
});
assert.strictEqual(unusualPrepared.status, 'SUCCEEDED');
const unusualRead = callCommand(unusualPrepared, { operation: 'read', input: { ref: unusualPrepared.data.ref } });
assert.deepStrictEqual(unusualRead.data, unusualPrepared.data);
assert.strictEqual(coordinatorAgent.main(['--workspace', workspace], {
  returnOnly: true, request: { operation: 'prepareRun', input: { caseNos: ['014'], workspace: unusualWorkspace } },
}).status, 'REJECTED');

const protocolTelemetry = require('../lib/agent-facing-telemetry');
const protocolFile = path.join(path.dirname(statePath(blocked)), 'telemetry', 'agent-facing.jsonl');
const protocolBefore = protocolTelemetry.readAgentFacingEvents(protocolFile).length;
const terminalResponse = advanceRun(statePath(blocked));
const terminalRead = executeRunRequest(statePath(blocked), { operation: 'read', input: { ref: blocked.data.ref } });
const protocolEvents = protocolTelemetry.readAgentFacingEvents(protocolFile);
assert.strictEqual(protocolEvents.length, protocolBefore + 2);
assert.ok(protocolEvents.every(protocolTelemetry.validateAgentFacingEvent));
assert.strictEqual(protocolEvents.at(-2).responseBytes, Buffer.byteLength(JSON.stringify(terminalResponse)));
assert.strictEqual(protocolEvents.at(-1).dataBytes, Buffer.byteLength(JSON.stringify(terminalRead.data)));
assert.strictEqual(protocolEvents.at(-1).readTargetType, 'runSummary');
assert.strictEqual(fs.readFileSync(statePath(blocked), 'utf8'), terminalBefore);
const protocolText = fs.readFileSync(protocolFile, 'utf8');
for (const forbidden of [workspace, 'loaderCommand', 'command', 'content', 'input', blocked.data.ref]) {
  assert.strictEqual(protocolText.includes(forbidden), false, forbidden);
}
assert.ok(protocolTelemetry.summarizeAgentFacing(protocolEvents).statusCounts.REJECTED > 0, 'CLI rejection is measured after error projection');

// Unrecognized operation names never enter the envelope or method-doc routing.
for (const operation of ['unknown-operation', '', undefined, 'constructor', 'toString', '__proto__', 'prepareRun']) {
  const request = { ...(operation === undefined ? {} : { operation }), input: {} };
  const expectedOperation = operation === 'prepareRun' ? operation : null;
  const inputError = Object.assign(new Error('invalid request'), { code: 'COORDINATOR_INPUT_INVALID' });
  const direct = coordinatorAgent.errorResponse(inputError, operation);
  const facade = coordinatorAgent.main(['--workspace', workspace], { returnOnly: true, request });
  const cli = require('child_process').spawnSync(process.execPath, [path.resolve(__dirname, '../coordinator-agent.js'), '--workspace', workspace], {
    input: JSON.stringify(request), encoding: 'utf8',
  });
  assert.strictEqual(cli.status, 2, cli.stderr);
  for (const response of [direct, facade, JSON.parse(cli.stdout)]) {
    assert.strictEqual(response.status, 'REJECTED');
    assert.strictEqual(response.operation, expectedOperation);
    assert.strictEqual(Boolean(response.error.operationDocumentationRef), operation === 'prepareRun');
    assert.ok(response.error.documentationRef);
  }
}

fs.rmSync(temp, { recursive: true, force: true });
console.log('coordinator Agent-facing facade passed');
