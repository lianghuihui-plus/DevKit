#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcileWithFinalization } = require('../batch');
const { bootstrapBatch, commitCurrentCase, initializeBatch, reconcileBatch, startCurrentCase } = require('../batch/core');
const { establishInitialState } = require('../case-runtime/lifecycle');
const { run } = require('../case-runtime/runtime-client');
const runtimeCore = require('../case-runtime/runtime-core');
const { validateRuntimeRequest } = require('../case-runtime/contract');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-app-preparation-'));
const root = path.join(temp, 'workspace');
createTestWorkspace(root);
const binding = { platform: 'harmony', deviceId: 'preparation-device', appId: 'com.example.preparation', entry: 'EntryAbility' };
const T0 = '2026-09-08T10:00:00.000Z';
assert.throws(() => validateRuntimeRequest({
  operation: 'prepare',
  caseContext: {
    summary: '非法准备请求', preconditions: [], expectations: ['首次页可见'], initialPlan: ['准备'], uncertainties: [],
  },
  preparation: { targetState: 'APP_LOCAL_STATE_EMPTY' },
  artifactPath: '/tmp/forbidden.ipa',
}), (error) => error?.code === 'CASE_RUNTIME_REQUEST_INVALID');

function makeCase(name) {
  const source = `验证 ${name} 的首次启动状态`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText: source, importPath: `/fixture/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  return { caseKey, caseDir };
}

function observeRunner(command, args, options) {
  assert.strictEqual(options.kind, 'OBSERVE');
  const out = args[args.indexOf('--out') + 1];
  const label = args[args.indexOf('--label') + 1];
  const screenshot = `screenshots/${label}.png`;
  fs.writeFileSync(path.join(out, screenshot), PNG);
  return { status: 0, stderr: '', stdout: JSON.stringify({
    schemaVersion: 1,
    type: 'observation',
    platform: binding.platform,
    time: '2026-09-08T10:00:02.000Z',
    device: { id: binding.deviceId },
    app: { appId: binding.appId, inTargetApp: true },
    artifacts: { screenshot, layout: null, logs: [] },
  }) };
}

function bootstrap(batchId, target) {
  createTestExecutionRequest(root, batchId, binding, [target], { now: T0 });
  initializeBatch({ workspaceRoot: root, batchId, now: T0 });
  bootstrapBatch({
    workspaceRoot: root,
    batchId,
    adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
    now: T0,
  });
  const response = startCurrentCase({ workspaceRoot: root, batchId, now: T0 });
  return { ...response, execDir: fs.realpathSync(path.join(target.caseDir, 'platforms', binding.platform, 'executions', response.executionId)) };
}

const allowed = makeCase('允许清理');
const allowedBatch = 'batch-preparation-allowed';
let preparationCalls = 0;
createTestExecutionRequest(root, allowedBatch, binding, [{
  ...allowed,
  initialStateRequirement: {
    schemaVersion: 1,
    targetState: 'FRESH_INSTALL',
    rationale: '用例原文要求卸载并重新安装',
  },
}], { now: T0 });
initializeBatch({ workspaceRoot: root, batchId: allowedBatch, now: T0 });
bootstrapBatch({ workspaceRoot: root, batchId: allowedBatch, adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) }, now: T0 });
const started = startCurrentCase({
  workspaceRoot: root,
  batchId: allowedBatch,
  now: T0,
  runtimeOptions: {
    now: T0,
    runner: observeRunner,
    invokeAppPreparation: (execDir, request) => {
      preparationCalls += 1;
      assert.strictEqual(request.strategy, 'CLEAR_APP_DATA');
      return {
        schemaVersion: 1,
        type: 'appPreparationResult',
        platform: binding.platform,
        strategy: request.strategy,
        ok: true,
        status: 'SUCCEEDED',
        device: { id: binding.deviceId },
        app: { appId: binding.appId },
      };
    },
    restartApp: () => ({ coldStartVerified: true, startupDisplayVerified: true }),
  },
});
const startedExecDir = fs.realpathSync(path.join(allowed.caseDir, 'platforms', binding.platform, 'executions', started.executionId));
const prepared = {
  ...establishInitialState({ executionDir: startedExecDir }),
  preparation: runtimeCore.runtimeStatus(startedExecDir).preparation,
};
assert.strictEqual(started.agentRequired, true);
assert.strictEqual(prepared.status, 'READY');
assert.strictEqual(prepared.preparation.status, 'SATISFIED');
assert.strictEqual(prepared.preparation.sessionId, 'warm-0002');
assert.deepStrictEqual(prepared.scene.warmSessionRef, { sessionId: 'warm-0002', epoch: 2, generation: 1 });
assert.strictEqual(preparationCalls, 1);
assert.strictEqual(JSON.stringify(prepared).includes('CLEAR_APP_DATA'), false);
assert.strictEqual(JSON.stringify(prepared).includes('artifact'), false);
const execution = JSON.parse(fs.readFileSync(path.join(startedExecDir, 'execution.json'), 'utf8'));
assert.strictEqual(execution.warmSessionId, 'warm-0002');
assert.strictEqual(execution.warmSessionEpoch, 2);
assert.deepStrictEqual(execution.preparationPolicy, {
  schemaVersion: 1,
  allowedEffects: ['CLEAR_APP_DATA'],
  targetAppOnly: true,
});
const batchState = JSON.parse(fs.readFileSync(path.join(root, 'runs', allowedBatch, 'batch.json'), 'utf8'));
assert.strictEqual(batchState.warmSession.sessionId, 'warm-0002');
assert.strictEqual(batchState.warmSession.status, 'READY');
const operation = JSON.parse(fs.readFileSync(path.join(startedExecDir, 'operations', 'preparation-0001.json'), 'utf8'));
assert.strictEqual(operation.strategy, 'CLEAR_APP_DATA');

const visualInspection = run(startedExecDir, {
  operation: 'inspectVisual',
  basedOnSceneId: prepared.scene.sceneId,
  decision: {
    purpose: '检查准备后的首次启动截图',
    expectationRefs: ['E1'],
    observation: '首次启动页面可见',
  },
}, { now: T0 });
assert.strictEqual(visualInspection.status, 'VISUAL_INSPECTED');

const finished = run(startedExecDir, {
  operation: 'finish',
  basedOnSceneId: prepared.scene.sceneId,
  decision: {
    observation: '首次启动页面可见',
    conclusion: '首次启动状态符合预期',
    purpose: '提交结论',
    expectedOutcome: '结果绑定准备后的 Scene',
    expectationRefs: ['E1'],
  },
  result: {
    verdict: 'PASS',
    summary: '首次启动页面符合预期',
    checks: [{ expectationRef: 'E1', status: 'PASS', actual: '首次启动页面可见', sceneRefs: [prepared.scene.sceneId] }],
    uncertainties: [],
  },
}, { now: T0 });
assert.strictEqual(finished.status, 'COMPLETED');
const autoFinalized = reconcileWithFinalization(
  { workspaceRoot: root, batchId: allowedBatch, now: T0 },
  { adapter: {} },
);
assert.strictEqual(autoFinalized.action, 'BATCH_COMPLETE');
assert.deepStrictEqual(autoFinalized.progress, [
  'COMMIT_CASE',
  'CASE_COMMITTED',
  'SETTLE_EXECUTIONS',
  'RELEASE_PLATFORM',
  'PUBLISH_REPORTS',
  'BATCH_COMPLETE',
]);
assert.strictEqual(autoFinalized.state.status, 'COMPLETED');
assert.strictEqual(autoFinalized.publicationState.status, 'PUBLISHED');

const unavailable = makeCase('自动准备失败');
const unavailableBatch = 'batch-preparation-unavailable';
createTestExecutionRequest(root, unavailableBatch, binding, [{
  ...unavailable,
  initialStateRequirement: {
    schemaVersion: 1,
    targetState: 'APP_LOCAL_STATE_EMPTY',
    rationale: '用例必须从空本地状态开始',
  },
  preparationPolicy: {
    schemaVersion: 1,
    allowedEffects: ['CLEAR_APP_DATA'],
    targetAppOnly: true,
  },
}], { now: T0 });
initializeBatch({ workspaceRoot: root, batchId: unavailableBatch, now: T0 });
const unavailableAdapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId: unavailableBatch, adapter: unavailableAdapter, now: T0 });
const unavailableStarted = startCurrentCase({
  workspaceRoot: root,
  batchId: unavailableBatch,
  now: T0,
  runtimeOptions: {
    invokeAppPreparation: () => ({ ok: false, status: 'FAILED', strategy: 'CLEAR_APP_DATA', failureCode: 'DEVICE_REJECTED', reason: 'fixture failure' }),
  },
});
assert.strictEqual(unavailableStarted.agentRequired, false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(unavailableStarted, 'handoff'), false);
const unavailableExecDir = fs.realpathSync(path.join(unavailable.caseDir, 'platforms', binding.platform, 'executions', unavailableStarted.executionId));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(unavailableExecDir, 'execution.json'), 'utf8')).finalized, true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(unavailableExecDir, 'result.json'), 'utf8')).verdict, 'BLOCKED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId: unavailableBatch, adapter: unavailableAdapter }).action, 'COMMIT_CASE');

const implicit = makeCase('执行授权包含状态准备');
const implicitRequest = createTestExecutionRequest(root, 'batch-preparation-implicit-authorization', binding, [{
  ...implicit,
  initialStateRequirement: { schemaVersion: 1, targetState: 'APP_LOCAL_STATE_EMPTY', rationale: '验证执行授权自动包含状态准备' },
}], { now: T0 });
assert.deepStrictEqual(implicitRequest.targets[0].preparationPolicy, {
  schemaVersion: 1,
  allowedEffects: ['CLEAR_APP_DATA'],
  targetAppOnly: true,
});

const outOfScope = makeCase('冻结范围外清理');
const deniedStarted = bootstrap('batch-preparation-denied', outOfScope);
let deniedCalls = 0;
const deniedResponse = runtimeCore.execute(deniedStarted.execDir, {
  operation: 'prepare',
  preparation: { targetState: 'APP_LOCAL_STATE_EMPTY' },
}, {
  invokeAppPreparation: () => { deniedCalls += 1; },
  now: T0,
});
assert.strictEqual(deniedResponse.status, 'TECHNICAL');
assert.strictEqual(deniedResponse.code, 'APP_INITIAL_STATE_UNAVAILABLE');
assert.match(deniedResponse.technicalFactRef, /^technical-fact-/);
assert.strictEqual(deniedCalls, 0);
const deniedStatus = run(deniedStarted.execDir, { operation: 'status' });
assert.deepStrictEqual(deniedStatus.preparation, {
  targetState: 'APP_LOCAL_STATE_EMPTY',
  status: 'FAILED',
  code: 'APP_INITIAL_STATE_UNAVAILABLE',
  technicalFactRef: deniedResponse.technicalFactRef,
});
const deniedBatchState = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'batch-preparation-denied', 'batch.json'), 'utf8'));
assert.strictEqual(deniedBatchState.warmSession.status, 'READY');
const deniedFinished = run(deniedStarted.execDir, {
  operation: 'finish',
  decision: {
    observation: 'Runtime 拒绝执行冻结范围外的状态准备',
    conclusion: '验证点受到技术条件阻塞',
    purpose: '保存阻塞结论',
    expectedOutcome: '阻塞结论引用准备失败技术事实',
    expectationRefs: ['E1'],
  },
  result: {
    verdict: 'BLOCKED',
    summary: 'App 初始状态无法建立',
    checks: [{
      expectationRef: 'E1',
      status: 'BLOCKED',
      actual: '执行请求未声明需要重置 App 状态',
      technicalRefs: [deniedResponse.technicalFactRef],
    }],
    uncertainties: [],
  },
}, { now: T0 });
assert.strictEqual(deniedFinished.status, 'COMPLETED');
commitCurrentCase({ workspaceRoot: root, batchId: 'batch-preparation-denied', now: T0 });

const interrupted = makeCase('清理中断');
const interruptedBatch = 'batch-preparation-interrupted';
createTestExecutionRequest(root, interruptedBatch, binding, [{
  ...interrupted,
}], { now: T0 });
initializeBatch({ workspaceRoot: root, batchId: interruptedBatch, now: T0 });
bootstrapBatch({ workspaceRoot: root, batchId: interruptedBatch, adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) }, now: T0 });
const interruptedStarted = startCurrentCase({ workspaceRoot: root, batchId: interruptedBatch, now: T0 });
const interruptedExecDir = fs.realpathSync(path.join(interrupted.caseDir, 'platforms', binding.platform, 'executions', interruptedStarted.executionId));
let replayed = 0;
const interruptedExecution = JSON.parse(fs.readFileSync(path.join(interruptedExecDir, 'execution.json'), 'utf8'));
replayed += 1;
writeJsonAtomic(path.join(interruptedExecDir, 'transactions', 'preparation.draft.json'), {
  schemaVersion: 1,
  operationId: 'preparation-0001',
  batchId: interruptedBatch,
  targetState: 'APP_LOCAL_STATE_EMPTY',
  strategy: 'CLEAR_APP_DATA',
  requiredEffects: ['CLEAR_APP_DATA'],
  provisioning: interruptedExecution.appProvisioning,
  status: 'STRATEGY_DISPATCHED',
  previousSessionId: interruptedExecution.warmSessionId,
  previousEpoch: interruptedExecution.warmSessionEpoch,
  nextSessionId: 'warm-0002',
  nextEpoch: 2,
  authorizationSha: interruptedExecution.preparationPolicySha,
  createdAt: T0,
});
const reconciled = run(interruptedExecDir, { operation: 'observe' }, {
  invokeAppPreparation: () => { replayed += 1; },
  now: T0,
});
assert.strictEqual(reconciled.status, 'RECOVERY_APPLIED');
assert.strictEqual(reconciled.recoveredTransactions[0].status, 'UNKNOWN');
assert.strictEqual(reconciled.recoveredTransactions[0].code, 'APP_INITIAL_STATE_UNAVAILABLE');
assert.match(reconciled.recoveredTransactions[0].technicalFactRef, /^technical-fact-/);
assert.strictEqual(replayed, 1);
const interruptedState = JSON.parse(fs.readFileSync(path.join(root, 'runs', interruptedBatch, 'batch.json'), 'utf8'));
assert.strictEqual(interruptedState.warmSession.sessionId, 'warm-0002');
assert.strictEqual(interruptedState.warmSession.status, 'DEGRADED');

fs.rmSync(temp, { recursive: true, force: true });
console.log('app preparation passed');
