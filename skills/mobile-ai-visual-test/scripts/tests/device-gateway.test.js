#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentRequest } = require('../agent/core');
const { actionAdapterArgs, assertResultBinding, observationAdapterArgs, parseAdapterOutput, resolveTargetBinding } = require('../agent/device-gateway');
const { executeDeviceOperation } = require('../agent/operations');
const { readAgentStatus } = require('../agent/status');
const { bootstrapBatch, initializeBatch, startCurrentCase } = require('../batch/core');
const { changePhase, confirmStartObservation, timelineEvents } = require('../execution/core');
const { createCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { withAuthorizationSha } = require('../lib/plan-authorization');
const { withPlanSha } = require('../lib/plan-contract');
const { commitAgentTurn } = require('../agent/turn');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const T0 = '2026-08-13T10:00:00.000Z';
const BINDING = Object.freeze({ platform: 'harmony', deviceId: 'gateway-device', appId: 'com.example.gateway', entry: 'EntryAbility' });

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

function observationResult(args, overrides = {}) {
  const out = valueAfter(args, '--out');
  const label = valueAfter(args, '--label');
  const screenshot = `screenshots/${label}.png`;
  const layout = `layouts/${label}.json`;
  fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(out, 'layouts'), { recursive: true });
  fs.writeFileSync(path.join(out, screenshot), overrides.png || PNG);
  fs.writeFileSync(path.join(out, layout), '{}\n');
  return {
    schemaVersion: 1, type: 'observation', platform: 'harmony',
    artifacts: { screenshot, layout, logs: [] },
    device: { id: BINDING.deviceId },
    app: { appId: BINDING.appId, foregroundApp: BINDING.appId, inTargetApp: true },
    ...overrides.result,
  };
}

function runnerFactory(handler) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return handler(command, args, options, calls.length);
  };
  runner.calls = calls;
  return runner;
}

function okObservationRunner(overrides = {}) {
  return runnerFactory((command, args) => ({ status: 0, stdout: JSON.stringify(observationResult(args, overrides)), stderr: '' }));
}

function okActionRunner(overrides = {}) {
  return runnerFactory((command, args) => {
    const action = valueAfter(args, '--type');
    const coordinateResult = action === 'swipe' ? {
      executedFrom: { x: Number(valueAfter(args, '--from-x')), y: Number(valueAfter(args, '--from-y')) },
      executedTo: { x: Number(valueAfter(args, '--to-x')), y: Number(valueAfter(args, '--to-y')) },
    } : valueAfter(args, '--x') !== null ? {
      executedPoint: { x: Number(valueAfter(args, '--x')), y: Number(valueAfter(args, '--y')) },
    } : {};
    return {
      status: 0,
      stdout: JSON.stringify({
      schemaVersion: 1, type: 'actionResult', platform: 'harmony', action: valueAfter(args, '--type'), ok: true,
        device: { id: BINDING.deviceId }, app: { appId: BINDING.appId }, ...coordinateResult, ...overrides,
      }),
      stderr: '',
    };
  });
}

function understanding(sourceText) {
  return {
    schemaVersion: 1, revision: 1, summary: '理解设备网关用例',
    startConditions: [{ id: 'start-001', text: '确认当前页面', basis: 'implied', sourceRefs: ['src-001'] }],
    requirements: [{
      id: 'req-001', text: sourceText, basis: 'explicit', sourceRefs: ['src-001'],
      requiredInteractions: [], expectedOutcomes: [sourceText],
    }],
    sourceRefs: [{ id: 'src-001', sourceSha: sourceSha(sourceText), lineStart: 1, lineEnd: 1, quote: sourceText }],
    uncertainties: [],
  };
}

function authorization(started, phase) {
  const executionId = started.execution.executionId;
  return withAuthorizationSha(phase === 'case-prepare' ? {
    schemaVersion: 1, source: 'agent-plan', executionId, phase,
    understandingRevision: 1, startConditionId: 'start-001', purpose: '确认当前页面',
    requirementRefs: [], sourceRefs: [], sideEffect: false,
  } : {
    schemaVersion: 1, source: 'agent-plan', executionId, phase,
    understandingRevision: 1, planRevision: 1, checkpointId: 'cp-001', purpose: '执行当前检查点',
    requirementRefs: ['req-001'], sourceRefs: [], sideEffect: false,
  });
}

process.env.MAVT_SELF_TEST = '1';
const repo = path.resolve(__dirname, '../..');

// Platform argument construction is internal and uses only the frozen binding.
const harmonyArgs = actionAdapterArgs(BINDING, { type: 'tap', x: 10, y: 20 });
assert.deepStrictEqual(harmonyArgs.slice(0, 8), ['--platform', 'harmony', '--device', 'gateway-device', '--app', 'com.example.gateway', '--entry', 'EntryAbility']);
assert.deepStrictEqual(harmonyArgs.slice(-6), ['--type', 'tap', '--x', '10', '--y', '20']);
const androidArgs = actionAdapterArgs({ platform: 'android', deviceId: 'emulator-5554', appId: 'com.example.android', entry: 'MainActivity' }, { type: 'inputText', text: 'hello', mode: 'replace' });
assert.ok(androidArgs.includes('emulator-5554'));
assert.deepStrictEqual(androidArgs.slice(-6), ['--type', 'inputText', '--text', 'hello', '--mode', 'replace']);
const androidVisualArgs = actionAdapterArgs({ platform: 'android', deviceId: 'emulator-5554', appId: 'com.example.android', entry: 'MainActivity' }, { type: 'tap', x: 200, y: 400, coordinateSource: 'visual' });
assert.deepStrictEqual(androidVisualArgs.slice(-6), ['--type', 'tap', '--x', '200', '--y', '400']);
assert.strictEqual(androidVisualArgs.includes('--coordinate-source'), false);
const harmonyVisualArgs = actionAdapterArgs(BINDING, { type: 'tap', x: 200, y: 400, coordinateSource: 'visual' });
assert.strictEqual(harmonyVisualArgs.includes('--coordinate-source'), false);
const iosArgs = observationAdapterArgs({ platform: 'ios', deviceId: 'ios-udid', appId: 'com.example.ios', deviceType: 'simulator', appiumServer: 'http://127.0.0.1:4723' }, '/tmp/execution', 'observe-001');
assert.ok(iosArgs.includes('--device-type'));
assert.ok(iosArgs.includes('--appium-server'));
assert.deepStrictEqual(iosArgs.slice(-4), ['--out', '/tmp/execution', '--label', 'observe-001']);
const iosVisualArgs = actionAdapterArgs({ platform: 'ios', deviceId: 'ios-udid', appId: 'com.example.ios', deviceType: 'simulator' }, { type: 'tap', x: 200, y: 400, coordinateSource: 'visual' });
assert.deepStrictEqual(iosVisualArgs.slice(-8), ['--type', 'tap', '--x', '200', '--y', '400', '--coordinate-source', 'visual']);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-device-gateway-'));
const workspacePath = path.join(temp, 'workspace');
createTestWorkspace(workspacePath);
const root = fs.realpathSync(workspacePath);
fs.mkdirSync(path.join(root, 'runs'));
const sourceText = '确认当前页面并等待内容稳定';
const caseKey = `ck-${crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 12)}`;
const caseJson = createCaseContract({ caseKey, title: '设备网关', sourceText, importPath: '/gateway/source.md' });
const caseDir = path.join(root, 'cases', `gateway__${caseKey}`);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
const contract = JSON.parse(childProcess.execFileSync(process.execPath, ['scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony'], { cwd: repo, encoding: 'utf8' }));
createTestExecutionRequest(root, 'batch-gateway', BINDING, [{ caseKey, caseDir }], { mode: 'SINGLE', now: T0 });
initializeBatch({ workspaceRoot: root, batchId: 'batch-gateway', implementationSha: contract.implementationSha, now: T0 });
bootstrapBatch({ workspaceRoot: root, batchId: 'batch-gateway', implementationSha: contract.implementationSha, adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) }, now: T0 });
const started = startCurrentCase({ workspaceRoot: root, batchId: 'batch-gateway', implementationSha: contract.implementationSha, executionId: 'execution-gateway', now: T0 });
createAgentRequest({ workspaceRoot: root, execDir: started.execDir, skillContract: contract });
commitAgentTurn(started.execDir, {
  schemaVersion: 1, turnId: 'turn-gateway', understanding: understanding(sourceText),
  plan: withPlanSha({ schemaVersion: 1, revision: 1, reason: '建立设备检查点', checkpoints: [{ id: 'cp-001', objective: '验证当前页面', requirementRefs: ['req-001'] }] }),
  facts: [],
}, { now: T0 });
changePhase(started.execDir, 'ESTABLISH_START', '准备观察起点', { implementationSha: contract.implementationSha, now: T0 });

assert.deepStrictEqual(resolveTargetBinding(started.execDir, started.execution), BINDING);
assert.strictEqual(assertResultBinding({ schemaVersion: 1, type: 'actionResult', platform: 'harmony', device: { id: BINDING.deviceId }, app: { appId: BINDING.appId } }, BINDING, 'ACTION').type, 'actionResult');
expectCode(() => assertResultBinding({ schemaVersion: 1, type: 'actionResult', platform: 'harmony', device: { id: 'other-device' }, app: { appId: BINDING.appId } }, BINDING, 'ACTION'), 'DEVICE_RESULT_BINDING_MISMATCH');
expectCode(() => assertResultBinding({ schemaVersion: 1, type: 'actionResult', platform: 'harmony', device: { id: BINDING.deviceId }, app: { appId: 'other.app' } }, BINDING, 'ACTION'), 'DEVICE_RESULT_BINDING_MISMATCH');
const currentExecution = readJson(path.join(started.execDir, 'execution.json'));
const drifted = { ...currentExecution, targetBinding: { ...BINDING, deviceId: 'other-device' } };
expectCode(() => resolveTargetBinding(started.execDir, drifted), 'DEVICE_BINDING_CHANGED');
const executionPath = path.join(started.execDir, 'execution.json');
writeJsonAtomic(executionPath, drifted);
const rejectedBeforeAdapter = okActionRunner();
expectCode(() => executeDeviceOperation(started.execDir, {
  operationId: 'action-binding-rejected',
  authorization: authorization(started, 'case-prepare'),
  action: { type: 'wait', ms: 0, reason: '不得触碰错误绑定' },
}, { runner: rejectedBeforeAdapter, now: T0 }), 'DEVICE_BINDING_CHANGED');
assert.strictEqual(rejectedBeforeAdapter.calls.length, 0);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'agent', 'operation-action-binding-rejected.draft.json')), false);
writeJsonAtomic(executionPath, currentExecution);

// Observation invokes the adapter, validates the PNG, and freezes evidence SHA.
const prepareRunner = okObservationRunner();
const prepare = executeDeviceOperation(started.execDir, { operationId: 'observe-prepare', authorization: authorization(started, 'case-prepare') }, { runner: prepareRunner, now: T0 });
assert.strictEqual(prepare.fact.usable, true);
assert.match(prepare.fact.sha256, /^[0-9a-f]{64}$/);
assert.strictEqual(prepareRunner.calls.length, 1);
assert.strictEqual(executeDeviceOperation(started.execDir, { operationId: 'observe-prepare', authorization: authorization(started, 'case-prepare') }, { runner: prepareRunner, now: T0 }).idempotent, true);
assert.strictEqual(prepareRunner.calls.length, 1);
const unsignedAuthorization = { ...authorization(started, 'case-prepare') };
delete unsignedAuthorization.authorizationSha;
const autoSigned = executeDeviceOperation(started.execDir, { operationId: 'observe-auto-authorization-sha', authorization: unsignedAuthorization }, { runner: okObservationRunner(), now: T0 });
assert.match(autoSigned.fact.authorization.authorizationSha, /^plan-authorization-[0-9a-f]{24}$/);
confirmStartObservation(started.execDir, autoSigned.fact.ref, '测试确认当前现场满足起点', { now: T0 });
changePhase(started.execDir, 'EXECUTE', '起点已确认', { implementationSha: contract.implementationSha, now: T0 });

// Result-frozen interruptions recommit without touching the device again.
const actionRunner = okActionRunner();
const waitRequest = { operationId: 'action-result-frozen', authorization: authorization(started, 'case-business'), action: { type: 'wait', ms: 0, reason: '等待稳定' } };
assert.throws(() => executeDeviceOperation(started.execDir, waitRequest, { runner: actionRunner, now: T0, interruptAfter: 'result' }), /MAVT_AGENT_OPERATION_INTERRUPTED/);
assert.strictEqual(actionRunner.calls.length, 1);
const frozenResultStatus = readAgentStatus(started.execDir, T0);
assert.deepStrictEqual(frozenResultStatus.operationRecoveries.map((item) => [item.operationId, item.recoveryMode]), [
  ['action-result-frozen', 'COMMIT_FROZEN_RESULT'],
]);
assert.deepStrictEqual([frozenResultStatus.signals.mayOperate, frozenResultStatus.signals.mayConclude], [false, false]);
expectCode(() => changePhase(started.execDir, 'CONCLUDE', '不得越过待恢复操作', { implementationSha: contract.implementationSha, now: T0 }), 'EXECUTION_OPERATION_RECOVERY_REQUIRED');
expectCode(() => executeDeviceOperation(started.execDir, {
  operationId: 'action-before-recovery', authorization: authorization(started, 'case-business'),
  action: { type: 'wait', ms: 0, reason: '不得越过待恢复操作' },
}, { runner: okActionRunner(), now: T0 }), 'EXECUTION_OPERATION_RECOVERY_REQUIRED');
assert.strictEqual(executeDeviceOperation(started.execDir, waitRequest, { runner: actionRunner, now: T0 }).recovered, true);
assert.strictEqual(actionRunner.calls.length, 1);

// A completed timeline is enough to rebuild a missing frozen operation record.
const timelineRunner = okActionRunner();
const timelineRequest = { operationId: 'action-timeline-frozen', authorization: authorization(started, 'case-business'), action: { type: 'wait', ms: 0, reason: '验证事务收口' } };
assert.throws(() => executeDeviceOperation(started.execDir, timelineRequest, { runner: timelineRunner, now: T0, interruptAfter: 'timeline' }), /MAVT_AGENT_OPERATION_INTERRUPTED/);
assert.strictEqual(timelineRunner.calls.length, 1);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'agent', 'operation-action-timeline-frozen.json')), false);
const timelineRecoveryStatus = readAgentStatus(started.execDir, T0);
assert.deepStrictEqual(timelineRecoveryStatus.operationRecoveries.map((item) => [item.operationId, item.recoveryMode]), [
  ['action-timeline-frozen', 'REBUILD_FROZEN_RECORD'],
]);
assert.strictEqual(timelineRecoveryStatus.signals.mayOperate, false);
assert.strictEqual(executeDeviceOperation(started.execDir, timelineRequest, { runner: timelineRunner, now: T0 }).recovered, true);
assert.strictEqual(timelineRunner.calls.length, 1);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'agent', 'operation-action-timeline-frozen.draft.json')), false);
assert.deepStrictEqual(readAgentStatus(started.execDir, T0).operationRecoveries, []);
assert.strictEqual(timelineEvents(started.execDir).filter((event) => event.type === 'operationCompleted' && event.operationId === timelineRequest.operationId).length, 1);

// An interruption after dispatch but before result freeze never replays an action.
const uncertainRunner = okActionRunner();
const uncertainRequest = { operationId: 'action-uncertain', authorization: authorization(started, 'case-business'), basisObservationRef: prepare.fact.ref, action: { type: 'tap', x: 10, y: 10, target: '不确定动作目标', coordinateSource: 'visual', targetBounds: [0, 0, 20, 20], coordinateEvidence: '当前截图目标区域', coordinateArtifactRef: prepare.fact.artifacts.screenshot } };
assert.throws(() => executeDeviceOperation(started.execDir, uncertainRequest, { runner: uncertainRunner, now: T0, interruptAfter: 'adapter' }), /MAVT_AGENT_OPERATION_INTERRUPTED/);
assert.strictEqual(uncertainRunner.calls.length, 1);
expectCode(() => executeDeviceOperation(started.execDir, uncertainRequest, { runner: uncertainRunner, now: T0 }), 'DEVICE_ACTION_OUTCOME_UNCERTAIN');
assert.strictEqual(uncertainRunner.calls.length, 1);
expectCode(() => executeDeviceOperation(started.execDir, { operationId: 'action-after-uncertain', authorization: authorization(started, 'case-business'), basisObservationRef: prepare.fact.ref, action: { type: 'tap', x: 20, y: 20, target: '不应直接操作', coordinateSource: 'visual', targetBounds: [10, 10, 30, 30], coordinateEvidence: '旧截图目标区域', coordinateArtifactRef: prepare.fact.artifacts.screenshot } }, { runner: okActionRunner(), now: T0 }), 'POST_ACTION_OBSERVATION_REQUIRED');
expectCode(() => executeDeviceOperation(started.execDir, uncertainRequest, { runner: uncertainRunner, now: T0 }), 'DEVICE_ACTION_OUTCOME_UNCERTAIN');
assert.strictEqual(uncertainRunner.calls.length, 1);

// Observation may be safely reacquired after the same interruption window.
const observeRetryRunner = okObservationRunner();
const observeRetryRequest = { operationId: 'observe-retry', authorization: authorization(started, 'case-business') };
assert.throws(() => executeDeviceOperation(started.execDir, observeRetryRequest, { runner: observeRetryRunner, now: T0, interruptAfter: 'adapter' }), /MAVT_AGENT_OPERATION_INTERRUPTED/);
assert.strictEqual(executeDeviceOperation(started.execDir, observeRetryRequest, { runner: observeRetryRunner, now: T0 }).accepted, true);
assert.strictEqual(observeRetryRunner.calls.length, 2);
const retryObservation = timelineEvents(started.execDir).find((entry) => entry.type === 'observation' && entry.operationId === 'observe-retry');
assert.strictEqual(executeDeviceOperation(started.execDir, { operationId: 'action-after-observation', authorization: authorization(started, 'case-business'), basisObservationRef: retryObservation.ref, action: { type: 'tap', x: 20, y: 20, target: '观察后允许操作', coordinateSource: 'visual', targetBounds: [10, 10, 30, 30], coordinateEvidence: '最新截图目标区域', coordinateArtifactRef: retryObservation.artifacts.screenshot } }, { runner: okActionRunner(), now: T0 }).accepted, true);

// An observation is usable only when the adapter positively confirms the target App is foreground.
const unconfirmedTarget = okObservationRunner({ result: { app: { appId: BINDING.appId, foregroundApp: null, inTargetApp: null } } });
const unconfirmed = executeDeviceOperation(started.execDir, { operationId: 'observe-target-unconfirmed', authorization: authorization(started, 'case-business') }, { runner: unconfirmedTarget, now: T0 });
assert.strictEqual(unconfirmed.fact.usable, false);

// Invalid adapter output and invalid screenshots are closed terminally.
const malformed = runnerFactory(() => ({ status: 0, stdout: 'not-json', stderr: '' }));
expectCode(() => executeDeviceOperation(started.execDir, { operationId: 'observe-malformed', authorization: authorization(started, 'case-business') }, { runner: malformed, now: T0 }), 'DEVICE_ADAPTER_OUTPUT_INVALID');
expectCode(() => executeDeviceOperation(started.execDir, { operationId: 'observe-malformed', authorization: authorization(started, 'case-business') }, { runner: malformed, now: T0 }), 'DEVICE_ADAPTER_OUTPUT_INVALID');
assert.strictEqual(malformed.calls.length, 1);
expectCode(() => parseAdapterOutput({ status: 2, stdout: '', stderr: 'focused field unavailable' }, 'ACTION'), 'DEVICE_ADAPTER_FAILED');
try {
  parseAdapterOutput({ status: 2, stdout: '', stderr: 'focused field unavailable' }, 'ACTION');
} catch (error) {
  assert.strictEqual(error.adapterDiagnostics.stderr, 'focused field unavailable');
}
const invalidPng = okObservationRunner({ png: Buffer.from('not a png') });
expectCode(() => executeDeviceOperation(started.execDir, { operationId: 'observe-invalid-png', authorization: authorization(started, 'case-business') }, { runner: invalidPng, now: T0 }), 'OBSERVATION_SCREENSHOT_INVALID');
const wrongTarget = okObservationRunner({ result: { device: { id: 'other-device' } } });
expectCode(() => executeDeviceOperation(started.execDir, { operationId: 'observe-wrong-target', authorization: authorization(started, 'case-business') }, { runner: wrongTarget, now: T0 }), 'DEVICE_RESULT_BINDING_MISMATCH');

// An action that cannot leave enough time for its post-action observation is rejected before dispatch.
const insufficientRunner = okActionRunner();
const insufficientRequest = {
  operationId: 'action-insufficient-budget', authorization: authorization(started, 'case-business'),
  action: { type: 'wait', ms: 3000, reason: '验证预算准入' },
};
expectCode(() => executeDeviceOperation(started.execDir, insufficientRequest, {
  runner: insufficientRunner, now: '2026-08-13T10:29:57.500Z', postActionSettleMs: 0,
}), 'CASE_TIME_LIMIT_INSUFFICIENT');
assert.strictEqual(insufficientRunner.calls.length, 0);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'agent', 'operation-action-insufficient-budget.draft.json')), false);

// A failed wait cannot leave device state uncertain because wait has no device side effect.
const failedWaitRunner = runnerFactory(() => ({
  status: null, stdout: '', stderr: '', error: new Error('wait process timed out'),
}));
expectCode(() => executeDeviceOperation(started.execDir, {
  operationId: 'action-wait-failed', authorization: authorization(started, 'case-business'),
  action: { type: 'wait', ms: 0, reason: '验证无副作用失败分类' },
}, { runner: failedWaitRunner, now: T0 }), 'DEVICE_ADAPTER_FAILED');
const failedWaitCompletion = timelineEvents(started.execDir)
  .find((event) => event.type === 'operationCompleted' && event.operationId === 'action-wait-failed');
assert.strictEqual(failedWaitCompletion.failureCode, 'DEVICE_ADAPTER_FAILED');
assert.strictEqual(failedWaitCompletion.stateChanging, false);

// Low-level action execution is not exposed as a formal CLI.
assert.strictEqual(fs.existsSync(path.join(repo, 'scripts/agent/action.js')), false);

console.log('device-gateway passed');
