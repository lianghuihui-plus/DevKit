#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createAgentRequest } = require('../agent/core');
const {
  conclude,
  executeStep,
  inspectCurrent,
  investigate,
  markStart,
  resolveSemanticAction,
  resolvePostActionSettleMs,
  understand,
} = require('../agent/facade-core');
const { readAgentStatus } = require('../agent/status');
const { activeCheckpoint, controlRequestPath, requestRecovery } = require('../agent/control-request');
const { recoverInternalTransactions } = require('../batch/internal-recovery');
const { bootstrapBatch, initializeBatch, recoverApp, startCurrentCase } = require('../batch/core');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { sealTimeLimit, timelineEvents } = require('../execution/core');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

const T0 = '2026-08-13T10:00:00.000Z';
const BINDING = Object.freeze({ platform: 'harmony', deviceId: 'facade-device', appId: 'com.example.facade', entry: 'EntryAbility' });

const revisedCheckpointPlan = { revision: 2, checkpoints: [{ id: 'cp-001' }, { id: 'cp-002' }] };
const priorCheckpointActivity = [{ warmSessionGeneration: 1, authorization: { checkpointId: 'cp-002', planRevision: 1 } }];
assert.strictEqual(activeCheckpoint(revisedCheckpointPlan, priorCheckpointActivity, 1), 'cp-002');
assert.strictEqual(activeCheckpoint(revisedCheckpointPlan, priorCheckpointActivity, 2), 'cp-001');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const value = Buffer.alloc(data.length + 12);
  value.writeUInt32BE(data.length, 0);
  name.copy(value, 4);
  data.copy(value, 8);
  value.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return value;
}

function createPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y += 1) rows[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

function createRunner() {
  const calls = [];
  const runner = (command, args, options = {}) => {
    const kind = command.endsWith('/action.sh') ? 'ACTION' : 'OBSERVE';
    calls.push({ kind, args: [...args], options: { ...options } });
    if (kind === 'ACTION') {
      const actionType = valueAfter(args, '--type');
      const baseResult = {
        schemaVersion: 1,
        type: 'actionResult',
        platform: 'harmony',
        action: actionType,
        ok: true,
        device: { id: BINDING.deviceId },
        app: { appId: BINDING.appId },
      };
      return { status: 0, stderr: '', stdout: JSON.stringify(runner.actionResultFactory
        ? { ...baseResult, ...runner.actionResultFactory({ actionType, args }) }
        : baseResult) };
    }
    if (runner.failNextObservation) {
      runner.failNextObservation = false;
      return { status: 2, stderr: 'fixture observation failed', stdout: 'not-json' };
    }
    const out = valueAfter(args, '--out');
    const label = valueAfter(args, '--label');
    const screenshot = `screenshots/${label}.png`;
    const layout = `layouts/${label}.json`;
    fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(out, 'layouts'), { recursive: true });
    fs.writeFileSync(path.join(out, screenshot), createPng(100, 200));
    const defaultLayout = {
      attributes: { type: 'Root', bounds: '[0,0][100,200]', visible: 'true' },
      children: [{
        attributes: {
          text: '目标按钮', type: 'Button', bounds: '[10,20][50,60]', clickable: 'true', enabled: 'true', visible: 'true',
        },
        children: [],
      }],
    };
    runner.observationCount += 1;
    writeJsonAtomic(path.join(out, layout), runner.layoutFactory
      ? runner.layoutFactory({ label, observationCount: runner.observationCount, defaultLayout })
      : defaultLayout);
    const baseObservation = {
      schemaVersion: 1,
      type: 'observation',
      platform: 'harmony',
      artifacts: { screenshot, layout, logs: [] },
      device: { id: BINDING.deviceId },
      app: { appId: BINDING.appId, foregroundApp: BINDING.appId, inTargetApp: true },
    };
    return { status: 0, stderr: '', stdout: JSON.stringify(runner.observationResultFactory
      ? { ...baseObservation, ...runner.observationResultFactory({ label, observationCount: runner.observationCount }) }
      : baseObservation) };
  };
  runner.calls = calls;
  runner.failNextObservation = false;
  runner.observationCount = 0;
  runner.layoutFactory = null;
  runner.actionResultFactory = null;
  runner.observationResultFactory = null;
  return runner;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const repo = path.resolve(__dirname, '../..');
const contract = JSON.parse(childProcess.execFileSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony',
], { cwd: repo, encoding: 'utf8' }));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-facade-'));
process.env.MAVT_SELF_TEST = '1';

assert.strictEqual(resolvePostActionSettleMs({ type: 'tap' }, {}), 500);
assert.strictEqual(resolvePostActionSettleMs({ type: 'inputText' }, { MAVT_POST_ACTION_SETTLE_MS: '250' }), 250);
assert.strictEqual(resolvePostActionSettleMs({ type: 'swipe' }, { MAVT_POST_ACTION_SETTLE_MS: '9000' }), 5000);
assert.strictEqual(resolvePostActionSettleMs({ type: 'tap' }, { MAVT_POST_ACTION_SETTLE_MS: 'invalid' }), 500);
assert.strictEqual(resolvePostActionSettleMs({ type: 'wait' }, { MAVT_POST_ACTION_SETTLE_MS: '500' }), 0);

function setup(name) {
  const root = path.join(temp, name);
  createTestWorkspace(root);
  fs.mkdirSync(path.join(root, 'runs'));
  const sourceText = `验证 ${name} 的目标按钮状态`;
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText, importPath: `/facade/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  const batchId = `batch-${name}`;
  createTestExecutionRequest(root, batchId, BINDING, [{ caseKey, caseDir }], { mode: 'SINGLE', now: T0 });
  initializeBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, now: T0 });
  bootstrapBatch({
    workspaceRoot: root,
    batchId,
    implementationSha: contract.implementationSha,
    adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
    now: T0,
  });
  const started = startCurrentCase({
    workspaceRoot: root, batchId, implementationSha: contract.implementationSha, executionId: `execution-${name}`, now: T0,
  });
  createAgentRequest({ workspaceRoot: root, execDir: started.execDir, skillContract: contract });
  return { root, sourceText, ...started };
}

function understandInput(item) {
  return {
    understanding: {
      summary: '验证原文中的目标状态',
      startConditions: [{ id: 'start-001', text: '目标页面可用', basis: 'implied' }],
      requirements: [{ id: 'req-001', text: item.sourceText, basis: 'explicit' }],
      uncertainties: [],
    },
    checkpoints: [{ id: 'cp-001', goal: '检查目标按钮状态', requirementRefs: ['req-001'], requiredAction: true }],
    reason: '根据冻结原文建立检查点',
  };
}

const happy = setup('happy');
const runner = createRunner();
const understood = understand(happy.execDir, understandInput(happy), { now: T0 });
assert.strictEqual(understood.runtimeState.understandingRevision, 1);
assert.strictEqual(understood.runtimeState.evidence, undefined);
assert.deepStrictEqual(readJson(path.join(happy.execDir, 'understanding.json')).sourceRefs.map((entry) => entry.id), ['source-case']);
assert.strictEqual(readJson(path.join(happy.execDir, 'plan.json')).revision, 1);
assert.match(readJson(path.join(happy.execDir, 'plan.json')).planSha, /^plan-/);
const repeatedUnderstanding = understand(happy.execDir, understandInput(happy), { now: T0 });
assert.strictEqual(repeatedUnderstanding.idempotent, true);
assert.strictEqual(readJson(path.join(happy.execDir, 'plan.json')).revision, 1);

const inspected = inspectCurrent(happy.execDir, { stage: 'PREPARE', intent: '观察起点' }, { runner, now: T0 });
assert.deepStrictEqual([inspected.observationView.screenshot.width, inspected.observationView.screenshot.height], [100, 200]);
assert.strictEqual(inspected.observationView.elements[0].text, '目标按钮');
assert.strictEqual(inspected.runtimeState.signals.startEstablished, false);
const started = markStart(happy.execDir, { reason: '当前页面满足用例起点' }, { now: T0 });
assert.strictEqual(started.runtimeState.phase, 'EXECUTE');
assert.strictEqual(started.runtimeState.signals.startEstablished, true);

const targetRef = inspected.observationView.elements[0].ref;
const stepped = executeStep(happy.execDir, {
  stage: 'BUSINESS', intent: '点击目标按钮', expectedOutcome: '目标状态可观察',
  action: { type: 'tap', targetRef },
}, { runner, now: T0 });
const targetActionCall = runner.calls.find((entry) => entry.kind === 'ACTION');
const targetObservationCall = runner.calls.find((entry) => entry.kind === 'OBSERVE'
  && valueAfter(entry.args, '--label') === stepped.observation.operationId);
assert.strictEqual(stepped.runtimeState.activeCheckpointRef, 'cp-001');
assert.strictEqual(timelineEvents(happy.execDir).find((event) => event.type === 'actionResult').authorization.checkpointId, 'cp-001');
assert.strictEqual(valueAfter(targetActionCall.args, '--x'), '30');
assert.strictEqual(valueAfter(targetActionCall.args, '--y'), '40');
assert.strictEqual(targetObservationCall.options.preAdapterDelayMs, 500);
const completedStep = readJson(path.join(happy.execDir, 'agent', 'steps', `${stepped.stepId}.json`));
assert.strictEqual(completedStep.postActionSettleMs, 500);
const completedObservation = readJson(path.join(happy.execDir, 'agent', `operation-${stepped.observation.operationId}.json`));
assert.strictEqual(completedObservation.timing.postActionSettleMs, 500);
assert.strictEqual(stepped.runtimeState.postActionObservationRequired, null);
assert.strictEqual(timelineEvents(happy.execDir).filter((event) => event.type === 'actionResult').length, 1);
assert.strictEqual(timelineEvents(happy.execDir).filter((event) => event.type === 'observation').length, 2);

const normalizedTap = resolveSemanticAction(happy.execDir, { type: 'tap', normalizedPoint: [0.5, 0.25] }).action;
assert.deepStrictEqual([normalizedTap.x, normalizedTap.y], [50, 50]);
const normalizedSwipe = resolveSemanticAction(happy.execDir, {
  type: 'swipe', normalizedFrom: [0.8, 0.5], normalizedTo: [0.2, 0.5], normalizedBounds: [0.1, 0.2, 0.9, 0.8], velocity: 800,
}).action;
assert.deepStrictEqual([normalizedSwipe.fromX, normalizedSwipe.fromY, normalizedSwipe.toX, normalizedSwipe.toY], [80, 100, 20, 100]);
assert.deepStrictEqual(normalizedSwipe.targetBounds, [10, 40, 90, 160]);

runner.failNextObservation = true;
const actionsBeforeRecovery = runner.calls.filter((entry) => entry.kind === 'ACTION').length;
expectCode(() => executeStep(happy.execDir, {
  stage: 'BUSINESS', checkpointRef: 'cp-001', intent: '再次点击并验证恢复',
  action: { type: 'tap', targetRef: stepped.observationView.elements[0].ref },
}, { runner, now: T0 }), 'DEVICE_ADAPTER_FAILED');
const recovery = readAgentStatus(happy.execDir, T0).stepRecoveries[0];
assert.strictEqual(recovery.recoveryMode, 'RESUME_SEMANTIC_STEP');
const resumed = executeStep(happy.execDir, {}, { resumeStepId: recovery.stepId, runner, now: T0 });
assert.strictEqual(resumed.runtimeState.stepRecoveries.length, 0);
assert.strictEqual(runner.calls.filter((entry) => entry.kind === 'ACTION').length, actionsBeforeRecovery + 1);

expectCode(() => conclude(happy.execDir, {
  verdict: 'FAIL', summary: '目标状态不符合要求',
  findings: [{ requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '当前现场不匹配' }],
}, { now: T0 }), 'KNOWLEDGE_QUERY_REQUIRED');
const completed = conclude(happy.execDir, {
  verdict: 'PASS', summary: '目标状态符合要求',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态' }],
}, { now: T0 });
assert.strictEqual(completed.runtimeState.finalized, true);
assert.strictEqual(completed.agentResult.finalized, true);
const result = readJson(path.join(happy.execDir, 'result.json'));
assert.strictEqual(result.requirementFindings[0].requirementRef, undefined);
assert.deepStrictEqual(Object.keys(result.requirementFindings[0]).sort(), [
  'evidenceRefs', 'incidentRefs', 'knowledgeRefs', 'reason', 'requirementId', 'status',
]);
const repeatedConclusion = conclude(happy.execDir, {
  verdict: 'PASS', summary: '目标状态符合要求',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态' }],
}, { now: T0 });
assert.strictEqual(repeatedConclusion.idempotent, true);

const evidenceConflict = setup('evidence-conflict');
const conflictRunner = createRunner();
conflictRunner.layoutFactory = ({ observationCount, defaultLayout }) => ({
  ...defaultLayout,
  children: [
    ...defaultLayout.children,
    {
      attributes: {
        type: 'SecureTextField', hint: '密码', value: observationCount === 1 ? '••••••' : '•••••••',
        bounds: '[10,80][80,110]', enabled: 'true', visible: 'true', secure: 'true',
      },
      children: [],
    },
  ],
});
understand(evidenceConflict.execDir, understandInput(evidenceConflict), { now: T0 });
const conflictStart = inspectCurrent(evidenceConflict.execDir, { stage: 'PREPARE', intent: '观察安全输入现场' }, { runner: conflictRunner, now: T0 });
markStart(evidenceConflict.execDir, { reason: '当前页面满足起点' }, { now: T0 });
const conflictTarget = conflictStart.observationView.elements.find((entry) => entry.text === '目标按钮');
const conflictStep = executeStep(evidenceConflict.execDir, {
  stage: 'BUSINESS', intent: '点击与输入无关的目标按钮',
  action: { type: 'tap', targetRef: conflictTarget.ref },
}, { runner: conflictRunner, now: T0 });
assert.ok(conflictStep.observationView.conflicts.some((entry) => entry.code === 'UNEXPECTED_SECURE_INPUT_MUTATION'));
expectCode(() => conclude(evidenceConflict.execDir, {
  verdict: 'PASS', summary: '目标状态符合要求',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态' }],
}, { now: T0 }), 'EVIDENCE_CONFLICT_UNRESOLVED');
const conflictInvestigation = investigate(evidenceConflict.execDir, {
  query: { platform: 'harmony', page: '证据冲突测试页', symptom: '安全字段被非输入动作改变', keywords: ['不存在的证据冲突知识条目'] },
  reason: '确定性结论被现场证据冲突阻止后完成调查',
}, { now: T0 });
assert.strictEqual(conflictInvestigation.matchCount, 0);
const conflictConclusion = conclude(evidenceConflict.execDir, {
  verdict: 'INCONCLUSIVE', summary: '关键现场证据冲突尚未恢复，无法可靠判断',
  uncertainties: ['非输入动作改变了安全输入字段，当前证据受到污染'],
  findings: [{ requirementRef: 'req-001', status: 'UNRESOLVED', reason: '现场证据冲突未闭合' }],
}, { now: T0 });
assert.strictEqual(conflictConclusion.runtimeState.finalized, true);

const repairedConflict = setup('evidence-conflict-repaired');
const repairRunner = createRunner();
repairRunner.layoutFactory = ({ observationCount, defaultLayout }) => ({
  ...defaultLayout,
  children: [
    ...defaultLayout.children,
    {
      attributes: {
        type: 'SecureTextField', hint: '密码', value: observationCount === 2 ? '•••••••' : '••••••',
        bounds: '[10,80][80,110]', enabled: 'true', visible: 'true', secure: 'true',
      },
      children: [],
    },
  ],
});
repairRunner.actionResultFactory = ({ actionType }) => actionType === 'inputText'
  ? { inputEffect: { status: 'MASKED', expectedLength: 6, observedLength: 6 } }
  : {};
understand(repairedConflict.execDir, understandInput(repairedConflict), { now: T0 });
const repairStart = inspectCurrent(repairedConflict.execDir, { stage: 'PREPARE', intent: '观察待修复现场' }, { runner: repairRunner, now: T0 });
markStart(repairedConflict.execDir, { reason: '当前页面满足起点' }, { now: T0 });
const pollutedStep = executeStep(repairedConflict.execDir, {
  stage: 'BUSINESS', intent: '执行无关点击并模拟输入污染',
  action: { type: 'tap', targetRef: repairStart.observationView.elements.find((entry) => entry.text === '目标按钮').ref },
}, { runner: repairRunner, now: T0 });
const repairedStep = executeStep(repairedConflict.execDir, {
  stage: 'BUSINESS', intent: '使用整串输入恢复安全字段',
  action: { type: 'inputText', targetRef: pollutedStep.observationView.elements.find((entry) => entry.secure).ref, text: '123456' },
}, { runner: repairRunner, now: T0 });
assert.deepStrictEqual(repairedStep.observationView.stateChanges.map((entry) => [entry.before, entry.after, entry.unexpected]), [[7, 6, false]]);
const repairedConclusion = conclude(repairedConflict.execDir, {
  verdict: 'PASS', summary: '安全字段已经通过整串输入恢复并核验',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场证据可靠' }],
}, { now: T0 });
assert.strictEqual(repairedConclusion.runtimeState.finalized, true);

const control = setup('control-request');
understand(control.execDir, understandInput(control), { now: T0 });
const controlObservation = inspectCurrent(control.execDir, { stage: 'PREPARE', intent: '观察恢复前现场' }, { runner, now: T0 });
markStart(control.execDir, { reason: '恢复请求测试起点' }, { now: T0 });
const requested = requestRecovery(control.execDir, { reason: '目标 App 意外退出', triggerType: 'UNKNOWN_EXIT' }, { now: T0 });
assert.deepStrictEqual(requested.controlRequest.evidenceRefs, [controlObservation.observation.ref]);
assert.strictEqual(requested.controlRequest.checkpointId, 'cp-001');
assert.strictEqual(requested.controlRequest.incidentCategory, 'TECHNICAL');
assert.strictEqual(readAgentStatus(control.execDir, T0).controlRequestPending, true);
expectCode(() => inspectCurrent(control.execDir, { stage: 'BUSINESS' }, { runner, now: T0 }), 'AGENT_CONTROL_REQUEST_PENDING');

const invalidIncidentCategory = setup('invalid-incident-category');
understand(invalidIncidentCategory.execDir, understandInput(invalidIncidentCategory), { now: T0 });
inspectCurrent(invalidIncidentCategory.execDir, { stage: 'PREPARE', intent: '观察非法事故分类测试现场' }, { runner, now: T0 });
expectCode(() => requestRecovery(invalidIncidentCategory.execDir, {
  reason: '目标 App 离开前台',
  triggerType: 'UNKNOWN_EXIT',
  incidentCategory: 'TARGET_APP_LEFT_FOREGROUND',
}, { now: T0 }), 'AGENT_CONTROL_REQUEST_INVALID');
assert.strictEqual(fs.existsSync(controlRequestPath(invalidIncidentCategory.execDir)), false);

const firstObservationFailure = setup('first-observation-recovery');
understand(firstObservationFailure.execDir, understandInput(firstObservationFailure), { now: T0 });
runner.failNextObservation = true;
expectCode(() => inspectCurrent(firstObservationFailure.execDir, { stage: 'PREPARE' }, { runner, now: T0 }), 'DEVICE_ADAPTER_FAILED');
const firstFailureRequest = requestRecovery(firstObservationFailure.execDir, {
  reason: '首次观察时自动化会话失效', triggerType: 'AUTOMATION_SESSION_LOST',
}, { now: T0 }).controlRequest;
assert.deepStrictEqual(firstFailureRequest.evidenceRefs, []);
assert.ok(firstFailureRequest.failedOperationId);
const firstFailureRecovery = recoverApp({
  workspaceRoot: firstObservationFailure.root,
  batchId: firstObservationFailure.execution.batchId,
  implementationSha: contract.implementationSha,
  adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
  request: firstFailureRequest,
  now: T0,
});
assert.strictEqual(firstFailureRecovery.recovery.failedOperationId, firstFailureRequest.failedOperationId);
const firstFailureRecoveryEvent = timelineEvents(firstObservationFailure.execDir)
  .find((event) => event.type === 'recoveryCompleted');
assert.strictEqual(firstFailureRecoveryEvent.failedOperationId, firstFailureRequest.failedOperationId);
assert.match(firstFailureRecoveryEvent.requestSha, /^recovery-request-/);
expectCode(() => requestRecovery(firstObservationFailure.execDir, {
  reason: '新暖会话不得复用恢复前的失败操作', triggerType: 'AUTOMATION_SESSION_LOST',
}, { now: T0 }), 'RECOVERY_EVIDENCE_REQUIRED');

const unavailableObservationRecovery = setup('unavailable-observation-recovery');
const unavailableRunner = createRunner();
understand(unavailableObservationRecovery.execDir, understandInput(unavailableObservationRecovery), { now: T0 });
const unavailableStart = inspectCurrent(unavailableObservationRecovery.execDir, {
  stage: 'PREPARE', intent: '观察事故恢复测试起点',
}, { runner: unavailableRunner, now: T0 });
markStart(unavailableObservationRecovery.execDir, { reason: '当前页面满足事故恢复测试起点' }, { now: T0 });
unavailableRunner.observationResultFactory = () => ({
  usable: false,
  app: { appId: BINDING.appId, foregroundApp: 'com.example.other', inTargetApp: false },
});
const unavailableStep = executeStep(unavailableObservationRecovery.execDir, {
  stage: 'BUSINESS', intent: '点击后模拟目标 App 离开前台',
  action: { type: 'tap', targetRef: unavailableStart.observationView.elements[0].ref },
}, { runner: unavailableRunner, now: T0 });
assert.strictEqual(unavailableStep.observation.usable, false);
assert.strictEqual(unavailableStep.runtimeState.currentObservationRef, null);
expectCode(() => requestRecovery(unavailableObservationRecovery.execDir, {
  reason: '没有当前可用现场时不能主动决定重启', triggerType: 'AGENT_DECIDED_RESTART',
}, { now: T0 }), 'RECOVERY_EVIDENCE_REQUIRED');
const unavailableRecoveryRequest = requestRecovery(unavailableObservationRecovery.execDir, {
  reason: '目标 App 已离开前台', triggerType: 'UNKNOWN_EXIT',
}, { now: T0 }).controlRequest;
assert.deepStrictEqual(unavailableRecoveryRequest.evidenceRefs, [unavailableStep.observation.ref]);
assert.strictEqual(unavailableRecoveryRequest.failedOperationId, undefined);
const unavailableRecovered = recoverApp({
  workspaceRoot: unavailableObservationRecovery.root,
  batchId: unavailableObservationRecovery.execution.batchId,
  implementationSha: contract.implementationSha,
  adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
  request: unavailableRecoveryRequest,
  now: T0,
});
assert.strictEqual(unavailableRecovered.recovery.status, 'SUCCEEDED');
const unavailableIncident = timelineEvents(unavailableObservationRecovery.execDir)
  .find((event) => event.type === 'runtimeIncident');
assert.deepStrictEqual(unavailableIncident.evidenceRefs, [unavailableStep.observation.ref]);

const facadeTurnRecovery = setup('facade-turn-recovery');
assert.throws(() => understand(facadeTurnRecovery.execDir, understandInput(facadeTurnRecovery), {
  now: T0, interruptAfter: 'understanding',
}), /MAVT_AGENT_TURN_INTERRUPTED/);
expectCode(() => understand(facadeTurnRecovery.execDir, understandInput(facadeTurnRecovery), { now: T0 }), 'FRAMEWORK_RECOVERY_PENDING');
recoverInternalTransactions(facadeTurnRecovery.execDir, { now: T0 });
assert.strictEqual(readJson(path.join(facadeTurnRecovery.execDir, 'plan.json')).revision, 1);

const deadline = setup('deadline-step-recovery');
understand(deadline.execDir, understandInput(deadline), { now: T0 });
const deadlineObservation = inspectCurrent(deadline.execDir, { stage: 'PREPARE', intent: '观察时限测试起点' }, { runner, now: T0 });
markStart(deadline.execDir, { reason: '时限测试起点' }, { now: T0 });
runner.failNextObservation = true;
expectCode(() => executeStep(deadline.execDir, {
  stage: 'BUSINESS', intent: '执行后模拟观察中断', action: { type: 'tap', targetRef: deadlineObservation.observationView.elements[0].ref },
}, { runner, now: T0 }), 'DEVICE_ADAPTER_FAILED');
const deadlineActions = runner.calls.filter((entry) => entry.kind === 'ACTION').length;
recoverInternalTransactions(deadline.execDir, { runner, now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(readAgentStatus(deadline.execDir, '2026-08-13T10:30:00.000Z').stepRecoveries.length, 0);
assert.strictEqual(runner.calls.filter((entry) => entry.kind === 'ACTION').length, deadlineActions);
sealTimeLimit(deadline.execDir, { implementationSha: contract.implementationSha, now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(readAgentStatus(deadline.execDir, '2026-08-13T10:30:00.000Z').signals.mayConclude, false);

const deadlineTimelineBeforeRejectedConclusion = fs.readFileSync(path.join(deadline.execDir, 'timeline.jsonl'), 'utf8');
expectCode(() => conclude(deadline.execDir, {
  verdict: 'BLOCKED', summary: '超时后的观察缺口不能收口为技术阻塞', technicalFailureCode: 'OBSERVATION_UNAVAILABLE',
  findings: [{ requirementRef: 'req-001', status: 'BLOCKED', reason: '动作后没有取得可用观察' }],
}, { now: '2026-08-13T10:30:00.000Z' }), 'RESULT_SEMANTICS_INVALID');
assert.strictEqual(fs.readFileSync(path.join(deadline.execDir, 'timeline.jsonl'), 'utf8'), deadlineTimelineBeforeRejectedConclusion);
const deadlineQuery = investigate(deadline.execDir, {
  query: { platform: 'harmony', page: '目标页面', symptom: '动作后无法取得可用观察', keywords: ['动作后观察'] },
  reason: '超时证据不足结论前完成知识调查',
}, { now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(deadlineQuery.matchCount, 0);
const deadlineStatus = readAgentStatus(deadline.execDir, '2026-08-13T10:30:00.000Z');
assert.strictEqual(deadlineStatus.signals.mayConclude, true);
assert.deepStrictEqual(deadlineStatus.conclusionConstraint, {
  mode: 'TIME_LIMIT_OBSERVATION_GAP',
  allowedVerdicts: ['INCONCLUSIVE'],
  findingStatus: 'UNRESOLVED',
  knowledgeRequired: true,
});
const deadlineConclusion = conclude(deadline.execDir, {
  verdict: 'INCONCLUSIVE', summary: '达到时限后仍未取得动作后的可用观察',
  findings: [{ requirementRef: 'req-001', status: 'UNRESOLVED', reason: '最新状态变化后的页面状态不可得' }],
}, { now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(deadlineConclusion.result.executionStatus, 'STOPPED_BY_BUDGET');
assert.deepStrictEqual(deadlineConclusion.result.uncertainties, ['最新状态变更后未取得可用观察']);
const deadlineReview = timelineEvents(deadline.execDir).find((event) => event.type === 'verdictReview');
assert.deepStrictEqual(deadlineReview.currentObservationRefs, []);
assert.strictEqual(deadlineReview.observationUnavailable, true);

const blocked = setup('blocked-before-observation');
understand(blocked.execDir, understandInput(blocked), { now: T0 });
const blockedResult = conclude(blocked.execDir, {
  verdict: 'BLOCKED', summary: '设备连接不可用', technicalFailureCode: 'AUTOMATION_CONNECTION_LOST',
  findings: [{ requirementRef: 'req-001', status: 'BLOCKED', reason: '设备连接在首次观察前中断' }],
}, { now: T0 });
assert.strictEqual(blockedResult.runtimeState.finalized, true);
assert.strictEqual(readJson(path.join(blocked.execDir, 'result.json')).executionStatus, 'TECHNICALLY_BLOCKED');
assert.strictEqual(timelineEvents(blocked.execDir).some((event) => event.type === 'verdictReview'), false);

const revised = setup('understanding-revision-reason');
understand(revised.execDir, understandInput(revised), { now: T0 });
const revisedInput = understandInput(revised);
revisedInput.understanding.summary = '根据现场修订后的用例理解';
revisedInput.reason = '现场显示目标状态需要重新描述';
understand(revised.execDir, revisedInput, { now: T0 });
const persistedRevision = readJson(path.join(revised.execDir, 'understanding.json'));
assert.strictEqual(persistedRevision.revision, 2);
assert.strictEqual(persistedRevision.reason, revisedInput.reason);
assert.strictEqual('revisionReason' in persistedRevision, false);

const noStartPass = setup('pass-before-mark-start');
const noStartInput = understandInput(noStartPass);
noStartInput.checkpoints[0].requiredAction = false;
understand(noStartPass.execDir, noStartInput, { now: T0 });
inspectCurrent(noStartPass.execDir, { stage: 'PREPARE', intent: '只观察但不确认起点' }, { runner, now: T0 });
expectCode(() => conclude(noStartPass.execDir, {
  verdict: 'PASS', summary: '不能在未确认起点时通过',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前现场看似满足' }],
}, { now: T0 }), 'START_NOT_ESTABLISHED');

const atomicConclusion = setup('atomic-conclusion-validation');
const atomicRunner = createRunner();
understand(atomicConclusion.execDir, understandInput(atomicConclusion), { now: T0 });
const atomicStart = inspectCurrent(atomicConclusion.execDir, { stage: 'PREPARE', intent: '观察原子结论起点' }, { runner: atomicRunner, now: T0 });
markStart(atomicConclusion.execDir, { reason: '当前页面满足原子结论起点' }, { now: T0 });
executeStep(atomicConclusion.execDir, {
  stage: 'BUSINESS', intent: '执行原子结论测试动作', action: { type: 'tap', targetRef: atomicStart.observationView.elements[0].ref },
}, { runner: atomicRunner, now: T0 });
const atomicTimelineBefore = fs.readFileSync(path.join(atomicConclusion.execDir, 'timeline.jsonl'), 'utf8');
const atomicPhaseBefore = readJson(path.join(atomicConclusion.execDir, 'execution.json')).phase;
expectCode(() => conclude(atomicConclusion.execDir, {
  verdict: 'PASS', summary: '无效复核结构不得污染时间线', sourceRecheck: ' ',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态' }],
}, { now: T0 }), 'EXECUTION_EVENT_INVALID');
assert.strictEqual(fs.readFileSync(path.join(atomicConclusion.execDir, 'timeline.jsonl'), 'utf8'), atomicTimelineBefore);
assert.strictEqual(readJson(path.join(atomicConclusion.execDir, 'execution.json')).phase, atomicPhaseBefore);
assert.strictEqual(timelineEvents(atomicConclusion.execDir).some((event) => event.type === 'checkpointFinding'), false);

const observationOnly = setup('observation-only-pass');
const observationOnlyInput = understandInput(observationOnly);
observationOnlyInput.checkpoints[0].requiredAction = false;
understand(observationOnly.execDir, observationOnlyInput, { now: T0 });
inspectCurrent(observationOnly.execDir, { stage: 'PREPARE', intent: '观察型检查点取得现场' }, { runner, now: T0 });
markStart(observationOnly.execDir, { reason: '当前观察同时满足起点和观察型检查点' }, { now: T0 });
const observationOnlyResult = conclude(observationOnly.execDir, {
  verdict: 'PASS', summary: '观察型检查点直接通过',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '起点观察已展示目标状态' }],
}, { now: T0 });
assert.strictEqual(observationOnlyResult.runtimeState.finalized, true);
assert.strictEqual(timelineEvents(observationOnly.execDir).filter((event) => event.type === 'observation').length, 1);

const actionRequired = setup('required-action-incomplete');
understand(actionRequired.execDir, understandInput(actionRequired), { now: T0 });
inspectCurrent(actionRequired.execDir, { stage: 'PREPARE', intent: '建立需要操作的检查点起点' }, { runner, now: T0 });
markStart(actionRequired.execDir, { reason: '当前现场满足操作前起点' }, { now: T0 });
expectCode(() => conclude(actionRequired.execDir, {
  verdict: 'PASS', summary: '缺少要求的操作时不能通过',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '只有起点观察' }],
}, { now: T0 }), 'CHECKPOINT_EXECUTION_INCOMPLETE');

const carriedCheckpoint = setup('checkpoint-evidence-carry-forward');
understand(carriedCheckpoint.execDir, understandInput(carriedCheckpoint), { now: T0 });
const carriedStart = inspectCurrent(carriedCheckpoint.execDir, { stage: 'PREPARE', intent: '建立计划修订测试起点' }, { runner, now: T0 });
markStart(carriedCheckpoint.execDir, { reason: '当前现场满足计划修订测试起点' }, { now: T0 });
executeStep(carriedCheckpoint.execDir, {
  stage: 'BUSINESS', checkpointRef: 'cp-001', intent: '完成原计划中的目标操作',
  action: { type: 'tap', targetRef: carriedStart.observationView.elements[0].ref },
}, { runner, now: T0 });
understand(carriedCheckpoint.execDir, {
  checkpoints: [{ id: 'cp-001', goal: '按现场信息调整后的检查目标', requirementRefs: ['req-001'], requiredAction: true }],
  reason: '保留稳定检查点身份并修订计划描述',
}, { now: T0 });
const carriedResult = conclude(carriedCheckpoint.execDir, {
  verdict: 'PASS', summary: '计划修订前的有效操作继续支撑稳定检查点',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前现场满足修订后的检查目标' }],
}, { now: T0 });
assert.strictEqual(carriedResult.runtimeState.finalized, true);
assert.strictEqual(readJson(path.join(carriedCheckpoint.execDir, 'plan.json')).revision, 2);

const replacedCheckpoint = setup('checkpoint-evidence-not-carried-to-new-id');
understand(replacedCheckpoint.execDir, understandInput(replacedCheckpoint), { now: T0 });
const replacedStart = inspectCurrent(replacedCheckpoint.execDir, { stage: 'PREPARE', intent: '建立检查点替换测试起点' }, { runner, now: T0 });
markStart(replacedCheckpoint.execDir, { reason: '当前现场满足检查点替换测试起点' }, { now: T0 });
executeStep(replacedCheckpoint.execDir, {
  stage: 'BUSINESS', checkpointRef: 'cp-001', intent: '完成旧检查点操作',
  action: { type: 'tap', targetRef: replacedStart.observationView.elements[0].ref },
}, { runner, now: T0 });
understand(replacedCheckpoint.execDir, {
  checkpoints: [{ id: 'cp-002', goal: '语义变化后的新检查点', requirementRefs: ['req-001'], requiredAction: true }],
  reason: '检查点语义变化后使用新身份',
}, { now: T0 });
expectCode(() => conclude(replacedCheckpoint.execDir, {
  verdict: 'PASS', summary: '新检查点不能继承旧检查点操作',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前现场满足要求' }],
}, { now: T0 }), 'CHECKPOINT_EXECUTION_INCOMPLETE');

const staleFailure = setup('stale-failure-observation');
const staleInput = understandInput(staleFailure);
staleInput.checkpoints[0].requiredAction = false;
understand(staleFailure.execDir, staleInput, { now: T0 });
inspectCurrent(staleFailure.execDir, { stage: 'PREPARE', intent: '建立失败复核起点' }, { runner, now: T0 });
markStart(staleFailure.execDir, { reason: '当前现场满足失败复核起点' }, { now: T0 });
const oldObservation = inspectCurrent(staleFailure.execDir, { stage: 'BUSINESS', intent: '记录旧现场' }, { runner, now: T0 }).observation;
inspectCurrent(staleFailure.execDir, { stage: 'BUSINESS', intent: '记录最新现场' }, { runner, now: T0 });
investigate(staleFailure.execDir, {
  query: { platform: 'harmony', page: '目标页面', symptom: '目标状态不符合预期', keywords: ['目标状态'] },
  reason: '失败结论前查询知识库',
}, { now: T0 });
expectCode(() => conclude(staleFailure.execDir, {
  verdict: 'FAIL', summary: '旧现场不能支撑当前失败结论',
  findings: [{
    requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '引用的是旧现场', evidenceRefs: [oldObservation.ref],
  }],
}, { now: T0 }), 'CURRENT_OBSERVATION_REQUIRED');

const matchedKnowledge = setup('matched-knowledge-review');
const matchedInput = understandInput(matchedKnowledge);
matchedInput.checkpoints[0].requiredAction = false;
understand(matchedKnowledge.execDir, matchedInput, { now: T0 });
inspectCurrent(matchedKnowledge.execDir, { stage: 'PREPARE', intent: '建立知识调查测试起点' }, { runner, now: T0 });
markStart(matchedKnowledge.execDir, { reason: '当前现场满足知识调查测试起点' }, { now: T0 });
fs.mkdirSync(path.join(matchedKnowledge.root, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(matchedKnowledge.root, 'knowledge', 'known-normal.md'), [
  '# K-known-normal 当前现象可能属于正常状态', '',
  '## 适用范围', '- Platform: harmony', '- Page: 目标页面', '',
  '## 可观察现象', '目标状态暂未展示。', '',
  '## 结论与处理建议', '结合当前现场判断是否适用。', '',
  '## 追溯信息', '知识调查闭环测试。', '',
].join('\n'));
const matchedQuery = investigate(matchedKnowledge.execDir, {
  query: { platform: 'harmony', page: '目标页面', symptom: '目标状态暂未展示', keywords: ['目标状态'] },
  reason: '失败结论前调查已知现象',
}, { now: T0 });
assert.strictEqual(matchedQuery.matchCount, 1);
expectCode(() => conclude(matchedKnowledge.execDir, {
  verdict: 'FAIL', summary: '未完成知识候选判断时不能失败',
  findings: [{ requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '当前现场未展示目标状态' }],
}, { now: T0 }), 'KNOWLEDGE_REVIEW_REQUIRED');
investigate(matchedKnowledge.execDir, {
  queryId: matchedQuery.queryId,
  conclusion: 'NO_APPLICABLE',
  reason: '候选描述不足以解释当前稳定现场',
  assessments: [{ entryId: matchedQuery.candidates[0].entryId, assessment: 'NOT_APPLICABLE', reason: '候选适用现象与当前稳定现场不一致' }],
}, { now: T0 });
const matchedFailure = conclude(matchedKnowledge.execDir, {
  verdict: 'FAIL', summary: '知识调查完成后当前证据仍明确不满足要求',
  findings: [{ requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '当前稳定现场未展示目标状态' }],
}, { now: T0 });
assert.strictEqual(matchedFailure.runtimeState.finalized, true);
assert.strictEqual(timelineEvents(matchedKnowledge.execDir).filter((event) => event.type === 'knowledgeReview').length, 1);

const sourceColdStart = setup('source-cold-start');
understand(sourceColdStart.execDir, understandInput(sourceColdStart), { now: T0 });
const sourceColdRequest = requestRecovery(sourceColdStart.execDir, {
  reason: '冻结原文明示必须冷启动', triggerType: 'SOURCE_REQUIRED_COLD_START',
}, { now: T0 }).controlRequest;
assert.deepStrictEqual(sourceColdRequest.sourceRefs, ['source-case']);
assert.strictEqual(sourceColdRequest.incidentId, undefined);
assert.deepStrictEqual(sourceColdRequest.evidenceRefs, []);
const generationBeforeRecovery = readJson(path.join(sourceColdStart.execDir, 'execution.json')).warmSessionGeneration;
const sourceColdRecovered = recoverApp({
  workspaceRoot: sourceColdStart.root,
  batchId: sourceColdStart.execution.batchId,
  implementationSha: contract.implementationSha,
  adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
  request: sourceColdRequest,
  now: T0,
});
assert.strictEqual(sourceColdRecovered.recovery.status, 'SUCCEEDED');
assert.strictEqual(sourceColdRecovered.recovery.warmSessionGeneration, generationBeforeRecovery + 1);
assert.strictEqual(timelineEvents(sourceColdStart.execDir).some((event) => event.type === 'runtimeIncident'), false);

const cliConclusion = setup('cli-conclusion-attempt');
const cliInput = understandInput(cliConclusion);
cliInput.checkpoints[0].requiredAction = false;
understand(cliConclusion.execDir, cliInput, { now: T0 });
inspectCurrent(cliConclusion.execDir, { stage: 'PREPARE', intent: '建立 CLI 结论起点' }, { runner, now: T0 });
markStart(cliConclusion.execDir, { reason: '当前现场满足 CLI 结论起点' }, { now: T0 });
childProcess.execFileSync(process.execPath, [
  'scripts/agent/conclude.js', '--exec-dir', cliConclusion.execDir, '--request-json', JSON.stringify({
    verdict: 'PASS', summary: 'CLI 结论计入协议指标',
    findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前观察满足要求' }],
  }),
], { cwd: repo, encoding: 'utf8', env: process.env });
const cliMetrics = readJson(path.join(cliConclusion.execDir, 'metrics.json'));
assert.strictEqual(cliMetrics.timing.protocolAttempts, 1);
assert.strictEqual(fs.readFileSync(path.join(cliConclusion.execDir, 'agent', 'attempts.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cliConclusion.execDir, 'agent', 'attempts.jsonl'), 'utf8')).entrypoint, 'conclude');
assert.strictEqual(fs.existsSync(path.join(cliConclusion.execDir, 'agent', 'attempt.current.json')), false);

console.log('agent-facade passed');
