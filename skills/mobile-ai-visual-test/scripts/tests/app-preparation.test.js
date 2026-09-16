#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrapBatch, initializeBatch, startCurrentCase } = require('../batch/core');
const { run } = require('../case-runtime/agent-facing-client');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { preparationPolicySha, validatePreparationPolicy } = require('../lib/app-provisioning');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-app-preparation-'));
const root = path.join(temp, 'workspace');
const binding = { platform: 'harmony', deviceId: 'preparation-device', appId: 'com.example.preparation', entry: 'EntryAbility' };
const T0 = '2026-09-08T10:00:00.000Z';
createTestWorkspace(root);

function makeCase(name) {
  const source = `验证 ${name} 的首次启动状态`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText: source, importPath: `/fixture/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  return { caseKey, caseDir, source };
}

function observeRunner(command, args, options) {
  assert.strictEqual(options.kind, 'OBSERVE');
  const out = args[args.indexOf('--out') + 1];
  const label = args[args.indexOf('--label') + 1];
  const screenshot = `screenshots/${label}.png`;
  fs.writeFileSync(path.join(out, screenshot), PNG);
  return { status: 0, stderr: '', stdout: JSON.stringify({
    schemaVersion: 1, type: 'observation', platform: binding.platform, time: T0,
    device: { id: binding.deviceId }, app: { appId: binding.appId, inTargetApp: true },
    artifacts: { screenshot, layout: null, logs: [] },
  }) };
}

function start(batchId, target) {
  createTestExecutionRequest(root, batchId, binding, [target], { now: T0 });
  initializeBatch({ workspaceRoot: root, batchId, now: T0 });
  bootstrapBatch({
    workspaceRoot: root, batchId,
    adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
    now: T0,
  });
  const started = startCurrentCase({ workspaceRoot: root, batchId, now: T0, runtimeOptions: { runner: observeRunner } });
  const execDir = fs.realpathSync(path.join(target.caseDir, 'platforms', binding.platform, 'executions', started.executionId));
  const plan = run(execDir, {
    capability: 'plan', caseModel: {
      baseRevision: null,
      understanding: `验证 ${target.source} 的空数据首次启动状态`,
      preconditions: ['目标 App 本地数据为空'], verificationPoints: [{ text: '首次启动页面可见' }],
      items: ['建立空数据状态', '观察首次启动页面'], uncertainties: [],
    },
  }, { now: T0 });
  assert.strictEqual(plan.status, 'CASE_MODEL_RECORDED');
  return { started, execDir };
}

const allowed = makeCase('允许清理');
const allowedRun = start('batch-preparation-allowed', allowed);
const executionPath = path.join(allowedRun.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
assert.deepStrictEqual(execution.preparationPolicy.allowedEffects, ['CLEAR_APP_DATA']);
let preparationCalls = 0;
const prepared = run(allowedRun.execDir, {
  capability: 'recover', reason: '用例前置条件要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY',
}, {
  now: T0,
  runner: observeRunner,
  invokeAppPreparation: (execDir, request) => {
    preparationCalls += 1;
    assert.strictEqual(request.strategy, 'CLEAR_APP_DATA');
    return { schemaVersion: 1, type: 'appPreparationResult', platform: 'harmony', strategy: request.strategy, ok: true, status: 'SUCCEEDED', device: { id: binding.deviceId }, app: { appId: binding.appId } };
  },
  restartApp: () => ({ coldStartVerified: true, startupDisplayVerified: true }),
});
assert.strictEqual(allowedRun.started.agentRequired, true);
assert.strictEqual(prepared.status, 'SCENE');
assert.strictEqual(prepared.preparation.status, 'SATISFIED');
assert.strictEqual(prepared.preparation.sessionId, 'warm-0002');
assert.strictEqual(preparationCalls, 1);
const preparedEvents = fs.readFileSync(path.join(allowedRun.execDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const preparationEvent = preparedEvents.find((event) => event.type === 'appPreparationCompleted');
assert.strictEqual(preparationEvent.caseModelRevision, 1);

const denied = makeCase('未授权清理');
const deniedRun = start('batch-preparation-denied', denied);
const deniedExecutionPath = path.join(deniedRun.execDir, 'execution.json');
const deniedExecution = JSON.parse(fs.readFileSync(deniedExecutionPath, 'utf8'));
const deniedPolicy = validatePreparationPolicy();
writeJsonAtomic(deniedExecutionPath, {
  ...deniedExecution,
  preparationPolicy: deniedPolicy,
  preparationPolicySha: preparationPolicySha(deniedPolicy),
});
let deniedCalls = 0;
const deniedResponse = run(deniedRun.execDir, {
  capability: 'recover', reason: '用例前置条件要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY',
}, {
  now: T0,
  invokeAppPreparation: () => { deniedCalls += 1; },
});
assert.strictEqual(deniedResponse.status, 'TECHNICAL');
assert.strictEqual(deniedResponse.code, 'APP_INITIAL_STATE_UNAVAILABLE');
assert.strictEqual(deniedResponse.diagnostic, undefined);
assert.strictEqual(deniedResponse.facts.technical.code, 'APP_PREPARATION_SCOPE_MISMATCH');
assert.match(deniedResponse.message, /outside the frozen execution scope/);
assert.match(deniedResponse.technicalFactRef, /^technical-fact-/);
assert.strictEqual(deniedCalls, 0);
assert.strictEqual(deniedResponse.technicalContext, undefined);
assert.strictEqual(deniedResponse.nextCall, undefined);
assert.match(deniedResponse.documentationRef, /error-app-initial-state-unavailable$/);

const retryable = makeCase('准备失败后恢复');
const retryableRun = start('batch-preparation-retryable', retryable);
let retryableCalls = 0;
const invokeRetryablePreparation = (_execDir, request) => {
  retryableCalls += 1;
  if (retryableCalls <= 2) {
    const error = new Error('native installation verification temporarily unavailable');
    error.code = 'DEVICE_ADAPTER_FAILED';
    throw error;
  }
  return {
    schemaVersion: 1,
    type: 'appPreparationResult',
    platform: 'harmony',
    strategy: request.strategy,
    ok: true,
    status: 'SUCCEEDED',
    device: { id: binding.deviceId },
    app: { appId: binding.appId },
  };
};
const firstFailure = run(retryableRun.execDir, {
  capability: 'recover', reason: '用例要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY',
}, { now: T0, runner: observeRunner, invokeAppPreparation: invokeRetryablePreparation });
assert.strictEqual(firstFailure.status, 'TECHNICAL');
assert.strictEqual(firstFailure.nextCall, undefined);
assert.strictEqual(firstFailure.technicalContext, undefined);
assert.match(firstFailure.documentationRef, /error-app-initial-state-unavailable$/);

const retryPreparationRequest = {
  capability: 'recover', reason: '重新建立用例要求的 App 初始状态', targetState: 'APP_LOCAL_STATE_EMPTY',
};
const secondFailure = run(retryableRun.execDir, retryPreparationRequest, {
  now: T0, runner: observeRunner, invokeAppPreparation: invokeRetryablePreparation,
});
assert.strictEqual(secondFailure.status, 'TECHNICAL');
assert.strictEqual(secondFailure.nextCall, undefined);
assert.match(secondFailure.documentationRef, /error-app-initial-state-unavailable$/);

const externalRecovery = run(retryableRun.execDir, {
  capability: 'recover', reason: '登记当前 execution 范围内的技术处置',
  externalAction: { summary: '已恢复当前 execution 的设备安装态查询能力', tool: 'platform-native-tool' },
}, { now: T0, runner: observeRunner, invokeAppPreparation: invokeRetryablePreparation });
assert.strictEqual(externalRecovery.status, 'EXTERNAL_ACTION_RECORDED', JSON.stringify(externalRecovery));
assert.strictEqual(externalRecovery.nextCall, undefined);

const recoveredPreparation = run(retryableRun.execDir, retryPreparationRequest, {
  now: T0,
  runner: observeRunner,
  invokeAppPreparation: invokeRetryablePreparation,
  restartApp: () => ({ coldStartVerified: true, startupDisplayVerified: true }),
});
assert.strictEqual(recoveredPreparation.status, 'SCENE');
assert.strictEqual(recoveredPreparation.preparation.status, 'SATISFIED');
assert.strictEqual(retryableCalls, 3);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(retryableRun.execDir, 'execution.json'), 'utf8')).preparationFailed, false);

fs.rmSync(temp, { recursive: true, force: true });
console.log('app preparation passed');
