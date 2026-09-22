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
const { createTestExecutionRequest, createTestWorkspace } = require('./support/workspace-fixture');
const { simpleCaseFlow } = require('./support/case-flow');

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
    operation: 'plan', input: {
      caseFlow: simpleCaseFlow(`验证 ${target.source} 的空数据首次启动状态`, '首次启动页面可见', {
        actionText: '建立空数据状态并观察首次启动页面',
      }),
    },
  }, { now: T0 });
  assert.strictEqual(plan.result.outcome, 'CASE_FLOW_RECORDED', JSON.stringify(plan));
  return { started, execDir };
}

const allowed = makeCase('允许清理');
const allowedRun = start('batch-preparation-allowed', allowed);
const executionPath = path.join(allowedRun.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
assert.deepStrictEqual(execution.preparationPolicy.allowedEffects, ['CLEAR_APP_DATA']);
let preparationCalls = 0;
const prepared = run(allowedRun.execDir, {
  operation: 'recover', input: { mode: 'prepare', reason: '用例前置条件要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY' },
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
assert.strictEqual(prepared.status, 'SUCCEEDED');
assert.strictEqual(prepared.result.preparationState, 'SATISFIED');
assert.strictEqual(JSON.parse(fs.readFileSync(executionPath, 'utf8')).warmSessionId, 'warm-0002');
assert.strictEqual(preparationCalls, 1);
const preparedEvents = fs.readFileSync(path.join(allowedRun.execDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const preparationEvent = preparedEvents.find((event) => event.type === 'appPreparationCompleted');
assert.strictEqual(preparationEvent.caseFlowRevision, 1);

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
  operation: 'recover', input: { mode: 'prepare', reason: '用例前置条件要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY' },
}, {
  now: T0,
  invokeAppPreparation: () => { deniedCalls += 1; },
});
assert.strictEqual(deniedResponse.status, 'FAILED');
assert.strictEqual(deniedResponse.error.code, 'APP_INITIAL_STATE_UNAVAILABLE');
assert.strictEqual(deniedResponse.diagnostic, undefined);
assert.strictEqual(deniedResponse.facts, undefined, 'preparation diagnostics are only available through read');
const deniedFactDescriptor = deniedResponse.resources.find((resource) => resource.type === 'technicalFact');
assert.ok(deniedFactDescriptor?.ref, 'a preparation error must provide its persisted diagnostic resource');
const deniedFact = run(deniedRun.execDir, { operation: 'read', input: { ref: deniedFactDescriptor.ref } });
assert.strictEqual(deniedFact.status, 'SUCCEEDED');
assert.strictEqual(deniedFact.data.content.code, 'APP_INITIAL_STATE_UNAVAILABLE');
assert.strictEqual(deniedFact.data.content.internalCode, 'APP_PREPARATION_SCOPE_MISMATCH');
assert.match(deniedFact.data.content.message, /outside the frozen execution scope/);
assert.strictEqual(deniedCalls, 0);
assert.strictEqual(deniedResponse.technicalContext, undefined);
assert.strictEqual(deniedResponse.nextCall, undefined);
assert.match(deniedResponse.error.documentationRef, /error-app-initial-state-unavailable$/);

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
  operation: 'recover', input: { mode: 'prepare', reason: '用例要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY' },
}, { now: T0, runner: observeRunner, invokeAppPreparation: invokeRetryablePreparation });
assert.strictEqual(firstFailure.status, 'FAILED');
assert.strictEqual(firstFailure.nextCall, undefined);
assert.strictEqual(firstFailure.technicalContext, undefined);
assert.match(firstFailure.error.documentationRef, /error-app-initial-state-unavailable$/);

const retryPreparationRequest = {
  operation: 'recover', input: { mode: 'prepare', reason: '重新建立用例要求的 App 初始状态', targetState: 'APP_LOCAL_STATE_EMPTY' },
};
const secondFailure = run(retryableRun.execDir, retryPreparationRequest, {
  now: T0, runner: observeRunner, invokeAppPreparation: invokeRetryablePreparation,
});
assert.strictEqual(secondFailure.status, 'FAILED');
assert.strictEqual(secondFailure.nextCall, undefined);
assert.match(secondFailure.error.documentationRef, /error-app-initial-state-unavailable$/);

const externalRecovery = run(retryableRun.execDir, {
  operation: 'recover', input: { mode: 'external', reason: '登记当前 execution 范围内的技术处置',
    externalAction: { summary: '已恢复当前 execution 的设备安装态查询能力', tool: 'platform-native-tool' },
  },
}, { now: T0, runner: observeRunner, invokeAppPreparation: invokeRetryablePreparation });
assert.strictEqual(externalRecovery.result.outcome, 'EXTERNAL_ACTION_RECORDED', JSON.stringify(externalRecovery));
assert.strictEqual(externalRecovery.nextCall, undefined);

const recoveredPreparation = run(retryableRun.execDir, retryPreparationRequest, {
  now: T0,
  runner: observeRunner,
  invokeAppPreparation: invokeRetryablePreparation,
  restartApp: () => ({ coldStartVerified: true, startupDisplayVerified: true }),
});
assert.strictEqual(recoveredPreparation.status, 'SUCCEEDED');
assert.strictEqual(recoveredPreparation.result.preparationState, 'SATISFIED');
assert.strictEqual(retryableCalls, 3);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(retryableRun.execDir, 'execution.json'), 'utf8')).preparationFailed, false);

const restarted = run(retryableRun.execDir, {
  operation: 'recover', input: { mode: 'restart', reason: '重新启动当前目标 App', sceneRef: recoveredPreparation.data.ref },
}, { now: T0, runner: observeRunner,
  restartApp: () => ({ coldStartVerified: true, startupDisplayVerified: true }),
});
assert.strictEqual(restarted.status, 'SUCCEEDED');
assert.strictEqual(restarted.data.type, 'scene');
assert.strictEqual(Object.hasOwn(restarted.result, 'preparationState'), false,
  'restart must not turn recovery status into an App preparation result');

fs.rmSync(temp, { recursive: true, force: true });
console.log('app preparation passed');
