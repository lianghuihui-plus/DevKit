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
  understand: freezeUnderstanding,
  plan: submitPlan,
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
const SEMANTIC_REVIEW = Object.freeze({
  review: Object.freeze({
    sourceConclusion: '已根据冻结原文复核当前结论',
    recoveryConclusion: '当前结论不需要额外恢复动作',
  }),
});

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
        ...(actionType === 'swipe' ? {
          executedFrom: { x: Number(valueAfter(args, '--from-x')), y: Number(valueAfter(args, '--from-y')) },
          executedTo: { x: Number(valueAfter(args, '--to-x')), y: Number(valueAfter(args, '--to-y')) },
        } : valueAfter(args, '--x') !== null ? {
          executedPoint: { x: Number(valueAfter(args, '--x')), y: Number(valueAfter(args, '--y')) },
        } : {}),
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
      requirements: [{
        id: 'req-001', text: item.sourceText, basis: 'explicit',
        requiredInteractions: ['点击目标按钮'], expectedOutcomes: [item.sourceText],
      }],
      uncertainties: [],
    },
    checkpoints: [{ id: 'cp-001', objective: '检查目标按钮状态', requirementRefs: ['req-001'] }],
    reason: '根据冻结原文建立检查点',
  };
}

function initialize(execDir, input, options = {}) {
  let result;
  if (input.understanding) result = freezeUnderstanding(execDir, { understanding: input.understanding }, options);
  if (input.checkpoints || input.plan) {
    result = submitPlan(execDir, {
      checkpoints: input.checkpoints || input.plan.checkpoints,
      reason: input.reason || input.plan?.reason,
    }, options);
  }
  return result;
}

const stagedPlanning = setup('staged-understanding-and-plan');
const stagedInput = understandInput(stagedPlanning);
const frozen = freezeUnderstanding(stagedPlanning.execDir, { understanding: stagedInput.understanding }, { now: T0 });
assert.strictEqual(frozen.runtimeState.understandingRevision, 1);
assert.deepStrictEqual(frozen.runtimeState.readiness.missingArtifacts, ['plan']);
expectCode(() => inspectCurrent(stagedPlanning.execDir, {}, { now: T0 }), 'AGENT_TURN_NOT_EXECUTABLE');
const stagedPlan = submitPlan(stagedPlanning.execDir, {
  checkpoints: stagedInput.checkpoints,
  reason: stagedInput.reason,
}, { now: T0 });
assert.strictEqual(stagedPlan.runtimeState.planRevision, 1);
assert.strictEqual(stagedPlan.runtimeState.activeCheckpointRef, null);
assert.strictEqual(stagedPlan.runtimeState.activeCheckpoint, null);
assert.strictEqual(stagedPlan.runtimeState.continuation.mode, 'RESUME');
const stagedStatus = readAgentStatus(stagedPlanning.execDir, T0);
assert.deepStrictEqual(stagedStatus.semanticContext.plan.checkpoints[0].requiredInteractions, ['点击目标按钮']);
assert.deepStrictEqual(stagedStatus.semanticContext.plan.checkpoints[0].expectedOutcomes, [stagedPlanning.sourceText]);
assert.strictEqual(stagedStatus.semanticContext.plan.checkpoints[0].requiresAction, true);

const happy = setup('happy');
const runner = createRunner();
const understood = initialize(happy.execDir, understandInput(happy), { now: T0 });
assert.strictEqual(understood.runtimeState.understandingRevision, 1);
assert.strictEqual(understood.runtimeState.evidence, undefined);
assert.deepStrictEqual(readJson(path.join(happy.execDir, 'understanding.json')).sourceRefs.map((entry) => entry.id), ['source-case']);
assert.strictEqual(readJson(path.join(happy.execDir, 'plan.json')).revision, 1);
assert.match(readJson(path.join(happy.execDir, 'plan.json')).planSha, /^plan-/);

const blankSyntax = setup('blank-syntax-normalization');
const blankInput = understandInput(blankSyntax);
blankInput.understanding.requirements[0].requiredInteractions = ['   '];
blankInput.understanding.uncertainties = [''];
freezeUnderstanding(blankSyntax.execDir, { understanding: blankInput.understanding }, { now: T0 });
assert.deepStrictEqual(readJson(path.join(blankSyntax.execDir, 'understanding.json')).requirements[0].requiredInteractions, []);
assert.deepStrictEqual(readJson(path.join(blankSyntax.execDir, 'understanding.json')).uncertainties, []);

const repeatedUnderstanding = initialize(happy.execDir, understandInput(happy), { now: T0 });
assert.strictEqual(repeatedUnderstanding.idempotent, true);
assert.strictEqual(readJson(path.join(happy.execDir, 'plan.json')).revision, 1);

const inspected = inspectCurrent(happy.execDir, { intent: '观察起点' }, { runner, now: T0 });
assert.deepStrictEqual([inspected.observationView.screenshot.width, inspected.observationView.screenshot.height], [100, 200]);
assert.strictEqual(inspected.observationView.elements[0].text, '目标按钮');
assert.strictEqual(inspected.runtimeState.signals.startEstablished, false);
const started = markStart(happy.execDir, { reason: '当前页面满足用例起点' }, { now: T0 });
assert.strictEqual(started.runtimeState.phase, 'EXECUTE');
assert.strictEqual(started.runtimeState.signals.startEstablished, true);

const targetRef = inspected.observationView.elements[0].ref;
const stepped = executeStep(happy.execDir, {
  intent: '点击目标按钮', expectedOutcome: '目标状态可观察',
  action: { type: 'tap', targetRef },
}, { runner, now: T0 });
const targetActionCall = runner.calls.find((entry) => entry.kind === 'ACTION');
const targetObservationCall = runner.calls.find((entry) => entry.kind === 'OBSERVE'
  && valueAfter(entry.args, '--label') === stepped.observation.operationId);
assert.strictEqual(stepped.runtimeState.activeCheckpointRef, 'cp-001');
assert.strictEqual(timelineEvents(happy.execDir).find((event) => event.type === 'actionResult').authorization.checkpointId, 'cp-001');
assert.strictEqual(valueAfter(targetActionCall.args, '--x'), '30');
assert.strictEqual(valueAfter(targetActionCall.args, '--y'), '40');
assert.strictEqual(stepped.action.coordinateAudit.consistency, 'MATCHED');
assert.deepStrictEqual(stepped.action.coordinateAudit.executed.point, { x: 30, y: 40 });
assert.strictEqual(fs.existsSync(path.join(happy.execDir, stepped.action.coordinateAudit.overlayRef)), true);
assert.strictEqual(stepped.observationView.actionEffect.status, 'NO_VISIBLE_CHANGE');
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
expectCode(() => resolveSemanticAction(happy.execDir, {
  type: 'swipe', normalizedFrom: { x: 0.8, y: 0.5 }, normalizedTo: [0.2, 0.5],
}), 'AGENT_FACADE_INVALID');
const normalizedSwipe = resolveSemanticAction(happy.execDir, {
  type: 'swipe', normalizedFrom: [0.8, 0.5], normalizedTo: [0.2, 0.5], normalizedBounds: [0.1, 0.2, 0.9, 0.8], velocity: 800,
}).action;
assert.deepStrictEqual([normalizedSwipe.fromX, normalizedSwipe.fromY, normalizedSwipe.toX, normalizedSwipe.toY], [80, 100, 20, 100]);
assert.deepStrictEqual(normalizedSwipe.targetBounds, [10, 40, 90, 160]);
expectCode(() => inspectCurrent(happy.execDir, { stage: 'BUSINESS' }, { runner, now: T0 }), 'AGENT_FACADE_INVALID');

runner.failNextObservation = true;
const actionsBeforeRecovery = runner.calls.filter((entry) => entry.kind === 'ACTION').length;
expectCode(() => executeStep(happy.execDir, {
  checkpointRef: 'cp-001', intent: '再次点击并验证恢复',
  action: { type: 'tap', targetRef: stepped.observationView.elements[0].ref },
}, { runner, now: T0 }), 'DEVICE_ADAPTER_FAILED');
const recovery = readAgentStatus(happy.execDir, T0).stepRecoveries[0];
assert.strictEqual(recovery.recoveryMode, 'RESUME_SEMANTIC_STEP');
const resumed = executeStep(happy.execDir, {}, { resumeStepId: recovery.stepId, runner, now: T0 });
assert.ok(resumed.observationView.conflicts.some((entry) => entry.code === 'REPEATED_VISUAL_ACTION_NO_EFFECT') === false);
assert.strictEqual(resumed.runtimeState.stepRecoveries.length, 0);
assert.strictEqual(runner.calls.filter((entry) => entry.kind === 'ACTION').length, actionsBeforeRecovery + 1);

expectCode(() => conclude(happy.execDir, {
  verdict: 'FAIL', summary: '目标状态不符合要求',
  findings: [{ requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '当前现场不匹配' }],
}, { now: T0 }), 'KNOWLEDGE_QUERY_REQUIRED');
expectCode(() => conclude(happy.execDir, {
  verdict: 'PASS', summary: '未显式选择证据时不能通过',
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '不能由框架自动选择最后现场' }],
}, { now: T0 }), 'RESULT_EVIDENCE_INVALID');
const completed = conclude(happy.execDir, {
  verdict: 'PASS', summary: '目标状态符合要求',
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态', evidenceRefs: [resumed.observation.ref] }],
}, { now: T0 });
assert.strictEqual(completed.runtimeState.finalized, true);
assert.strictEqual(completed.agentResult.finalized, true);
const completedReview = timelineEvents(happy.execDir).find((event) => event.type === 'verdictReview');
assert.strictEqual(completedReview.sourceRecheck.conclusion, SEMANTIC_REVIEW.review.sourceConclusion);
assert.strictEqual(completedReview.recoveryAttempt.explanation, SEMANTIC_REVIEW.review.recoveryConclusion);
const result = readJson(path.join(happy.execDir, 'result.json'));
assert.strictEqual(result.requirementFindings[0].requirementRef, undefined);
assert.deepStrictEqual(Object.keys(result.requirementFindings[0]).sort(), [
  'evidenceRefs', 'incidentRefs', 'knowledgeRefs', 'reason', 'requirementId', 'status',
]);
const repeatedConclusion = conclude(happy.execDir, {
  verdict: 'PASS', summary: '目标状态符合要求',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态', evidenceRefs: [resumed.observation.ref] }],
}, { now: T0 });
assert.strictEqual(repeatedConclusion.idempotent, true);

const repeatedVisual = setup('repeated-visual-no-effect');
const repeatedVisualRunner = createRunner();
initialize(repeatedVisual.execDir, understandInput(repeatedVisual), { now: T0 });
inspectCurrent(repeatedVisual.execDir, { intent: '观察视觉目标现场' }, { runner: repeatedVisualRunner, now: T0 });
markStart(repeatedVisual.execDir, { reason: '当前页面满足起点' }, { now: T0 });
const visualAction = { type: 'tap', normalizedPoint: [0.5, 0.5], normalizedBounds: [0.4, 0.4, 0.6, 0.6], target: '视觉目标' };
const firstVisual = executeStep(repeatedVisual.execDir, {
  intent: '首次点击视觉目标', action: visualAction,
}, { runner: repeatedVisualRunner, now: T0 });
assert.strictEqual(firstVisual.observationView.actionEffect.status, 'NO_VISIBLE_CHANGE');
const secondVisual = executeStep(repeatedVisual.execDir, {
  intent: '复核并再次点击相同视觉目标', action: visualAction,
}, { runner: repeatedVisualRunner, now: T0 });
assert.strictEqual(secondVisual.accepted, true);
assert.ok(secondVisual.observationView.conflicts.some((entry) => entry.code === 'REPEATED_VISUAL_ACTION_NO_EFFECT' && entry.severity === 'WARN'));

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
initialize(evidenceConflict.execDir, understandInput(evidenceConflict), { now: T0 });
const conflictStart = inspectCurrent(evidenceConflict.execDir, { intent: '观察安全输入现场' }, { runner: conflictRunner, now: T0 });
markStart(evidenceConflict.execDir, { reason: '当前页面满足起点' }, { now: T0 });
const conflictTarget = conflictStart.observationView.elements.find((entry) => entry.text === '目标按钮');
const conflictStep = executeStep(evidenceConflict.execDir, {
  intent: '点击与输入无关的目标按钮',
  action: { type: 'tap', targetRef: conflictTarget.ref },
}, { runner: conflictRunner, now: T0 });
assert.ok(conflictStep.observationView.conflicts.some((entry) => entry.code === 'UNEXPECTED_SECURE_INPUT_MUTATION'));
expectCode(() => conclude(evidenceConflict.execDir, {
  verdict: 'PASS', summary: '目标状态符合要求',
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态', evidenceRefs: [conflictStep.observation.ref] }],
}, { now: T0 }), 'EVIDENCE_CONFLICT_UNRESOLVED');
const conflictInvestigation = investigate(evidenceConflict.execDir, {
  query: { platform: 'harmony', page: '证据冲突测试页', symptom: '安全字段被非输入动作改变', keywords: ['不存在的证据冲突知识条目'] },
  reason: '确定性结论被现场证据冲突阻止后完成调查',
}, { now: T0 });
assert.strictEqual(conflictInvestigation.candidateCount, 0);
const conflictConclusion = conclude(evidenceConflict.execDir, {
  verdict: 'INCONCLUSIVE', summary: '关键现场证据冲突尚未恢复，无法可靠判断',
  ...SEMANTIC_REVIEW,
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
initialize(repairedConflict.execDir, understandInput(repairedConflict), { now: T0 });
const repairStart = inspectCurrent(repairedConflict.execDir, { intent: '观察待修复现场' }, { runner: repairRunner, now: T0 });
markStart(repairedConflict.execDir, { reason: '当前页面满足起点' }, { now: T0 });
const pollutedStep = executeStep(repairedConflict.execDir, {
  intent: '执行无关点击并模拟输入污染',
  action: { type: 'tap', targetRef: repairStart.observationView.elements.find((entry) => entry.text === '目标按钮').ref },
}, { runner: repairRunner, now: T0 });
const repairedStep = executeStep(repairedConflict.execDir, {
  intent: '使用整串输入恢复安全字段',
  action: { type: 'inputText', targetRef: pollutedStep.observationView.elements.find((entry) => entry.secure).ref, text: '123456' },
}, { runner: repairRunner, now: T0 });
assert.deepStrictEqual(repairedStep.observationView.stateChanges.map((entry) => [entry.before, entry.after, entry.unexpected]), [[7, 6, false]]);
const repairedConclusion = conclude(repairedConflict.execDir, {
  verdict: 'PASS', summary: '安全字段已经通过整串输入恢复并核验',
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场证据可靠', evidenceRefs: [repairedStep.observation.ref] }],
}, { now: T0 });
assert.strictEqual(repairedConclusion.runtimeState.finalized, true);

const control = setup('control-request');
initialize(control.execDir, understandInput(control), { now: T0 });
const controlObservation = inspectCurrent(control.execDir, { intent: '观察恢复前现场' }, { runner, now: T0 });
markStart(control.execDir, { reason: '恢复请求测试起点' }, { now: T0 });
const requested = requestRecovery(control.execDir, { reason: '目标 App 意外退出', triggerType: 'UNKNOWN_EXIT' }, { now: T0 });
assert.deepStrictEqual(requested.controlRequest.evidenceRefs, [controlObservation.observation.ref]);
assert.strictEqual(requested.controlRequest.checkpointId, 'cp-001');
assert.strictEqual(requested.controlRequest.incidentCategory, 'TECHNICAL');
assert.strictEqual(readAgentStatus(control.execDir, T0).controlRequestPending, true);
expectCode(() => inspectCurrent(control.execDir, {}, { runner, now: T0 }), 'AGENT_CONTROL_REQUEST_PENDING');

const invalidIncidentCategory = setup('invalid-incident-category');
initialize(invalidIncidentCategory.execDir, understandInput(invalidIncidentCategory), { now: T0 });
inspectCurrent(invalidIncidentCategory.execDir, { intent: '观察非法事故分类测试现场' }, { runner, now: T0 });
expectCode(() => requestRecovery(invalidIncidentCategory.execDir, {
  reason: '目标 App 离开前台',
  triggerType: 'UNKNOWN_EXIT',
  incidentCategory: 'TARGET_APP_LEFT_FOREGROUND',
}, { now: T0 }), 'AGENT_CONTROL_REQUEST_INVALID');
assert.strictEqual(fs.existsSync(controlRequestPath(invalidIncidentCategory.execDir)), false);

const firstObservationFailure = setup('first-observation-recovery');
initialize(firstObservationFailure.execDir, understandInput(firstObservationFailure), { now: T0 });
runner.failNextObservation = true;
expectCode(() => inspectCurrent(firstObservationFailure.execDir, {}, { runner, now: T0 }), 'DEVICE_ADAPTER_FAILED');
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
initialize(unavailableObservationRecovery.execDir, understandInput(unavailableObservationRecovery), { now: T0 });
const unavailableStart = inspectCurrent(unavailableObservationRecovery.execDir, {
  intent: '观察事故恢复测试起点',
}, { runner: unavailableRunner, now: T0 });
markStart(unavailableObservationRecovery.execDir, { reason: '当前页面满足事故恢复测试起点' }, { now: T0 });
unavailableRunner.observationResultFactory = () => ({
  usable: false,
  app: { appId: BINDING.appId, foregroundApp: 'com.example.other', inTargetApp: false },
});
const unavailableStep = executeStep(unavailableObservationRecovery.execDir, {
  intent: '点击后模拟目标 App 离开前台',
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
assert.throws(() => initialize(facadeTurnRecovery.execDir, understandInput(facadeTurnRecovery), {
  now: T0, interruptAfter: 'understanding',
}), /MAVT_AGENT_TURN_INTERRUPTED/);
expectCode(() => initialize(facadeTurnRecovery.execDir, understandInput(facadeTurnRecovery), { now: T0 }), 'FRAMEWORK_RECOVERY_PENDING');
recoverInternalTransactions(facadeTurnRecovery.execDir, { now: T0 });
initialize(facadeTurnRecovery.execDir, understandInput(facadeTurnRecovery), { now: T0 });
assert.strictEqual(readJson(path.join(facadeTurnRecovery.execDir, 'plan.json')).revision, 1);

const deadline = setup('deadline-step-recovery');
initialize(deadline.execDir, understandInput(deadline), { now: T0 });
const deadlineObservation = inspectCurrent(deadline.execDir, { intent: '观察时限测试起点' }, { runner, now: T0 });
markStart(deadline.execDir, { reason: '时限测试起点' }, { now: T0 });
runner.failNextObservation = true;
expectCode(() => executeStep(deadline.execDir, {
  intent: '执行后模拟观察中断', action: { type: 'tap', targetRef: deadlineObservation.observationView.elements[0].ref },
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
assert.strictEqual(deadlineQuery.candidateCount, 0);
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
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'UNRESOLVED', reason: '最新状态变化后的页面状态不可得' }],
}, { now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(deadlineConclusion.result.executionStatus, 'STOPPED_BY_BUDGET');
assert.deepStrictEqual(deadlineConclusion.result.uncertainties, ['最新状态变更后未取得可用观察']);
const deadlineReview = timelineEvents(deadline.execDir).find((event) => event.type === 'verdictReview');
assert.deepStrictEqual(deadlineReview.currentObservationRefs, []);
assert.strictEqual(deadlineReview.observationUnavailable, true);

const blocked = setup('blocked-before-observation');
initialize(blocked.execDir, understandInput(blocked), { now: T0 });
const blockedResult = conclude(blocked.execDir, {
  verdict: 'BLOCKED', summary: '设备连接不可用', technicalFailureCode: 'AUTOMATION_CONNECTION_LOST',
  findings: [{ requirementRef: 'req-001', status: 'BLOCKED', reason: '设备连接在首次观察前中断' }],
}, { now: T0 });
assert.strictEqual(blockedResult.runtimeState.finalized, true);
assert.strictEqual(readJson(path.join(blocked.execDir, 'result.json')).executionStatus, 'TECHNICALLY_BLOCKED');
assert.strictEqual(timelineEvents(blocked.execDir).some((event) => event.type === 'verdictReview'), false);

const revised = setup('understanding-revision-reason');
initialize(revised.execDir, understandInput(revised), { now: T0 });
const revisedInput = understandInput(revised);
revisedInput.understanding.summary = '根据现场修订后的用例理解';
revisedInput.reason = '现场显示目标状态需要重新描述';
freezeUnderstanding(revised.execDir, { understanding: revisedInput.understanding, reason: revisedInput.reason }, { now: T0 });
const persistedRevision = readJson(path.join(revised.execDir, 'understanding.json'));
assert.strictEqual(persistedRevision.revision, 2);
assert.strictEqual(persistedRevision.reason, revisedInput.reason);
assert.deepStrictEqual(readAgentStatus(revised.execDir, T0).readiness.missingArtifacts, ['plan']);
expectCode(() => inspectCurrent(revised.execDir, {}, { now: T0 }), 'PLAN_REVISION_STALE');
submitPlan(revised.execDir, { checkpoints: revisedInput.checkpoints, reason: '理解修订后重新建立计划' }, { now: T0 });
assert.strictEqual(readJson(path.join(revised.execDir, 'plan.json')).revision, 2);
const reusedRequirement = understandInput(revised);
reusedRequirement.understanding.requirements[0].expectedOutcomes = ['已改变的要求语义'];
expectCode(() => freezeUnderstanding(revised.execDir, {
  understanding: reusedRequirement.understanding, reason: '尝试复用原 requirement id',
}, { now: T0 }), 'UNDERSTANDING_REQUIREMENT_ID_REUSED');

const noStartPass = setup('pass-before-mark-start');
const noStartInput = understandInput(noStartPass);
noStartInput.understanding.requirements[0].requiredInteractions = [];
initialize(noStartPass.execDir, noStartInput, { now: T0 });
  const noStartObservation = inspectCurrent(noStartPass.execDir, { intent: '只观察但不确认起点' }, { runner, now: T0 });
expectCode(() => conclude(noStartPass.execDir, {
  verdict: 'PASS', summary: '不能在未确认起点时通过',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前现场看似满足', evidenceRefs: [noStartObservation.observation.ref] }],
}, { now: T0 }), 'START_NOT_ESTABLISHED');

const atomicConclusion = setup('atomic-conclusion-validation');
const atomicRunner = createRunner();
initialize(atomicConclusion.execDir, understandInput(atomicConclusion), { now: T0 });
const atomicStart = inspectCurrent(atomicConclusion.execDir, { intent: '观察原子结论起点' }, { runner: atomicRunner, now: T0 });
markStart(atomicConclusion.execDir, { reason: '当前页面满足原子结论起点' }, { now: T0 });
  const atomicStep = executeStep(atomicConclusion.execDir, {
  intent: '执行原子结论测试动作', action: { type: 'tap', targetRef: atomicStart.observationView.elements[0].ref },
}, { runner: atomicRunner, now: T0 });
const atomicTimelineBefore = fs.readFileSync(path.join(atomicConclusion.execDir, 'timeline.jsonl'), 'utf8');
const atomicPhaseBefore = readJson(path.join(atomicConclusion.execDir, 'execution.json')).phase;
expectCode(() => conclude(atomicConclusion.execDir, {
  verdict: 'PASS', summary: '无效复核结构不得污染时间线',
  review: { sourceConclusion: ' ', recoveryConclusion: '当前结论不需要额外恢复动作' },
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '最新现场展示目标状态', evidenceRefs: [atomicStep.observation.ref] }],
}, { now: T0 }), 'AGENT_FACADE_INVALID');
assert.strictEqual(fs.readFileSync(path.join(atomicConclusion.execDir, 'timeline.jsonl'), 'utf8'), atomicTimelineBefore);
assert.strictEqual(readJson(path.join(atomicConclusion.execDir, 'execution.json')).phase, atomicPhaseBefore);
assert.strictEqual(timelineEvents(atomicConclusion.execDir).some((event) => event.type === 'checkpointFinding'), false);

const observationOnly = setup('observation-only-pass');
const observationOnlyInput = understandInput(observationOnly);
observationOnlyInput.understanding.requirements[0].requiredInteractions = [];
initialize(observationOnly.execDir, observationOnlyInput, { now: T0 });
  const observationOnlyScene = inspectCurrent(observationOnly.execDir, { intent: '观察型检查点取得现场' }, { runner, now: T0 });
markStart(observationOnly.execDir, { reason: '当前观察同时满足起点和观察型检查点' }, { now: T0 });
const observationOnlyResult = conclude(observationOnly.execDir, {
  verdict: 'PASS', summary: '观察型检查点直接通过',
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '起点观察已展示目标状态', evidenceRefs: [observationOnlyScene.observation.ref] }],
}, { now: T0 });
assert.strictEqual(observationOnlyResult.runtimeState.finalized, true);
assert.strictEqual(timelineEvents(observationOnly.execDir).filter((event) => event.type === 'observation').length, 1);

const actionRequired = setup('required-action-incomplete');
initialize(actionRequired.execDir, understandInput(actionRequired), { now: T0 });
inspectCurrent(actionRequired.execDir, { intent: '建立需要操作的检查点起点' }, { runner, now: T0 });
markStart(actionRequired.execDir, { reason: '当前现场满足操作前起点' }, { now: T0 });
expectCode(() => conclude(actionRequired.execDir, {
  verdict: 'PASS', summary: '缺少要求的操作时不能通过',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '只有起点观察', evidenceRefs: [readAgentStatus(actionRequired.execDir, T0).currentObservationRef] }],
}, { now: T0 }), 'CHECKPOINT_EXECUTION_INCOMPLETE');

const carriedCheckpoint = setup('checkpoint-evidence-carry-forward');
initialize(carriedCheckpoint.execDir, understandInput(carriedCheckpoint), { now: T0 });
const carriedStart = inspectCurrent(carriedCheckpoint.execDir, { intent: '建立计划修订测试起点' }, { runner, now: T0 });
markStart(carriedCheckpoint.execDir, { reason: '当前现场满足计划修订测试起点' }, { now: T0 });
  const carriedStep = executeStep(carriedCheckpoint.execDir, {
  checkpointRef: 'cp-001', intent: '完成原计划中的目标操作',
  action: { type: 'tap', targetRef: carriedStart.observationView.elements[0].ref },
}, { runner, now: T0 });
expectCode(() => initialize(carriedCheckpoint.execDir, {
  checkpoints: [{ id: 'cp-001', objective: '按现场信息调整后的检查目标', requirementRefs: ['req-001'] }],
  reason: '保留稳定检查点身份并修订计划描述',
}, { now: T0 }), 'PLAN_CHECKPOINT_ID_REUSED');
const carriedResult = conclude(carriedCheckpoint.execDir, {
  verdict: 'PASS', summary: '计划修订前的有效操作继续支撑稳定检查点',
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前现场满足修订后的检查目标', evidenceRefs: [carriedStep.observation.ref] }],
}, { now: T0 });
assert.strictEqual(carriedResult.runtimeState.finalized, true);
assert.strictEqual(readJson(path.join(carriedCheckpoint.execDir, 'plan.json')).revision, 1);

const replacedCheckpoint = setup('checkpoint-evidence-not-carried-to-new-id');
initialize(replacedCheckpoint.execDir, understandInput(replacedCheckpoint), { now: T0 });
const replacedStart = inspectCurrent(replacedCheckpoint.execDir, { intent: '建立检查点替换测试起点' }, { runner, now: T0 });
markStart(replacedCheckpoint.execDir, { reason: '当前现场满足检查点替换测试起点' }, { now: T0 });
executeStep(replacedCheckpoint.execDir, {
  checkpointRef: 'cp-001', intent: '完成旧检查点操作',
  action: { type: 'tap', targetRef: replacedStart.observationView.elements[0].ref },
}, { runner, now: T0 });
initialize(replacedCheckpoint.execDir, {
  checkpoints: [{ id: 'cp-002', objective: '语义变化后的新检查点', requirementRefs: ['req-001'] }],
  reason: '检查点语义变化后使用新身份',
}, { now: T0 });
expectCode(() => conclude(replacedCheckpoint.execDir, {
  verdict: 'PASS', summary: '新检查点不能继承旧检查点操作',
  findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前现场满足要求' }],
}, { now: T0 }), 'CHECKPOINT_EXECUTION_INCOMPLETE');

const staleFailure = setup('stale-failure-observation');
const staleInput = understandInput(staleFailure);
staleInput.understanding.requirements[0].requiredInteractions = [];
initialize(staleFailure.execDir, staleInput, { now: T0 });
inspectCurrent(staleFailure.execDir, { intent: '建立失败复核起点' }, { runner, now: T0 });
markStart(staleFailure.execDir, { reason: '当前现场满足失败复核起点' }, { now: T0 });
const oldObservation = inspectCurrent(staleFailure.execDir, { intent: '记录旧现场' }, { runner, now: T0 }).observation;
inspectCurrent(staleFailure.execDir, { intent: '记录最新现场' }, { runner, now: T0 });
investigate(staleFailure.execDir, {
  query: { platform: 'harmony', page: '目标页面', symptom: '目标状态不符合预期', keywords: ['目标状态'] },
  reason: '失败结论前查询知识库',
}, { now: T0 });
const historicalFailure = conclude(staleFailure.execDir, {
  verdict: 'FAIL', summary: '对应检查点的历史现场继续支撑失败结论',
  ...SEMANTIC_REVIEW,
  findings: [{
    requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '引用检查点执行时取得的负向现场', evidenceRefs: [oldObservation.ref],
  }],
}, { now: T0 });
assert.strictEqual(historicalFailure.runtimeState.finalized, true);

const evidenceOwnership = setup('checkpoint-evidence-ownership');
const ownershipInput = understandInput(evidenceOwnership);
ownershipInput.understanding.requirements = [
  {
    id: 'req-first', text: '完成第一个业务检查', basis: 'explicit',
    requiredInteractions: ['点击第一个目标'], expectedOutcomes: ['第一个目标结果可见'],
  },
  {
    id: 'req-second', text: '完成第二个业务检查', basis: 'explicit',
    requiredInteractions: ['点击第二个目标'], expectedOutcomes: ['第二个目标结果可见'],
  },
];
ownershipInput.checkpoints = [
  { id: 'cp-first', objective: '完成第一个业务检查', requirementRefs: ['req-first'] },
  { id: 'cp-second', objective: '完成第二个业务检查', requirementRefs: ['req-second'] },
];
initialize(evidenceOwnership.execDir, ownershipInput, { now: T0 });
const ownershipStart = inspectCurrent(evidenceOwnership.execDir, { intent: '建立多检查点起点' }, { runner, now: T0 });
markStart(evidenceOwnership.execDir, { reason: '当前现场满足多检查点起点' }, { now: T0 });
const firstCheckpointStep = executeStep(evidenceOwnership.execDir, {
  checkpointRef: 'cp-first', intent: '执行第一个检查点',
  action: { type: 'tap', targetRef: ownershipStart.observationView.elements[0].ref },
}, { runner, now: T0 });
const secondCheckpointStep = executeStep(evidenceOwnership.execDir, {
  checkpointRef: 'cp-second', intent: '执行第二个检查点',
  action: { type: 'tap', targetRef: firstCheckpointStep.observationView.elements[0].ref },
}, { runner, now: T0 });
expectCode(() => conclude(evidenceOwnership.execDir, {
  verdict: 'PASS', summary: '不能用第二个检查点现场替代第一个检查点证据',
  ...SEMANTIC_REVIEW,
  findings: [
    { requirementRef: 'req-first', status: 'SATISFIED', reason: '错误引用第二个检查点现场', evidenceRefs: [secondCheckpointStep.observation.ref] },
    { requirementRef: 'req-second', status: 'SATISFIED', reason: '第二个检查点现场满足要求', evidenceRefs: [secondCheckpointStep.observation.ref] },
  ],
}, { now: T0 }), 'RESULT_EVIDENCE_CHECKPOINT_MISMATCH');
const ownershipResult = conclude(evidenceOwnership.execDir, {
  verdict: 'PASS', summary: '每项要求均绑定对应检查点证据',
  ...SEMANTIC_REVIEW,
  findings: [
    { requirementRef: 'req-first', status: 'SATISFIED', reason: '第一个检查点现场满足要求', evidenceRefs: [firstCheckpointStep.observation.ref] },
    { requirementRef: 'req-second', status: 'SATISFIED', reason: '第二个检查点现场满足要求', evidenceRefs: [secondCheckpointStep.observation.ref] },
  ],
}, { now: T0 });
assert.strictEqual(ownershipResult.runtimeState.finalized, true);

const ambiguous = setup('ambiguous-non-empty-input');
freezeUnderstanding(ambiguous.execDir, {
  understanding: {
    summary: '原文非空，但不足以提取可执行验证要求',
    startConditions: [], requirements: [], uncertainties: ['缺少明确的业务目标和可观察预期'],
  },
}, { now: T0 });
submitPlan(ambiguous.execDir, { checkpoints: [], reason: '没有可执行 requirement，因此计划为空' }, { now: T0 });
const ambiguousStatus = readAgentStatus(ambiguous.execDir, T0);
assert.deepStrictEqual({
  mayOperate: ambiguousStatus.signals.mayOperate,
  mayObserve: ambiguousStatus.signals.mayObserve,
  mayAct: ambiguousStatus.signals.mayAct,
}, { mayOperate: false, mayObserve: false, mayAct: false });
expectCode(() => inspectCurrent(ambiguous.execDir, {}, { runner, now: T0 }), 'NO_EXECUTABLE_REQUIREMENTS');
expectCode(() => executeStep(ambiguous.execDir, {
  intent: '空要求不得操作设备', action: { type: 'wait', ms: 100 },
}, { runner, now: T0 }), 'NO_EXECUTABLE_REQUIREMENTS');
expectCode(() => markStart(ambiguous.execDir, {}, { now: T0 }), 'NO_EXECUTABLE_REQUIREMENTS');
expectCode(() => requestRecovery(ambiguous.execDir, {
  reason: '空要求不得请求恢复', triggerType: 'AGENT_DECIDED_RESTART',
}, { now: T0 }), 'NO_EXECUTABLE_REQUIREMENTS');
const ambiguousQuery = investigate(ambiguous.execDir, {
  query: { symptom: '原始用例缺少明确业务目标', keywords: ['用例目标'] },
  reason: '收口前查询本地知识是否能补充场景信息',
}, { now: T0 });
assert.strictEqual(ambiguousQuery.candidateCount, 0);
assert.strictEqual(readJson(path.join(ambiguous.execDir, 'execution.json')).phase, 'INVESTIGATE');
const ambiguousResult = conclude(ambiguous.execDir, {
  verdict: 'INCONCLUSIVE', summary: '现有输入不足以形成可执行验证要求', findings: [],
  ...SEMANTIC_REVIEW,
  uncertainties: ['缺少明确的业务目标和可观察预期'],
}, { now: T0 });
assert.strictEqual(ambiguousResult.result.verdict, 'INCONCLUSIVE');
assert.deepStrictEqual(ambiguousResult.result.requirementFindings, []);
assert.strictEqual(timelineEvents(ambiguous.execDir).some((event) => event.type === 'observation'), false);

const matchedKnowledge = setup('matched-knowledge-review');
const matchedInput = understandInput(matchedKnowledge);
matchedInput.understanding.requirements[0].requiredInteractions = [];
initialize(matchedKnowledge.execDir, matchedInput, { now: T0 });
  const matchedKnowledgeScene = inspectCurrent(matchedKnowledge.execDir, { intent: '建立知识调查测试起点' }, { runner, now: T0 });
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
assert.strictEqual(matchedQuery.candidateCount, 1);
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
  ...SEMANTIC_REVIEW,
  findings: [{ requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '当前稳定现场未展示目标状态', evidenceRefs: [matchedKnowledgeScene.observation.ref] }],
}, { now: T0 });
assert.strictEqual(matchedFailure.runtimeState.finalized, true);
assert.strictEqual(timelineEvents(matchedKnowledge.execDir).filter((event) => event.type === 'knowledgeReview').length, 1);

const staleKnowledgeScene = setup('stale-knowledge-after-state-change');
initialize(staleKnowledgeScene.execDir, understandInput(staleKnowledgeScene), { now: T0 });
const staleKnowledgeStart = inspectCurrent(staleKnowledgeScene.execDir, {
  intent: '建立知识上下文时效测试起点',
}, { runner, now: T0 });
markStart(staleKnowledgeScene.execDir, { reason: '当前页面满足知识上下文时效测试起点' }, { now: T0 });
const sceneQuery = investigate(staleKnowledgeScene.execDir, {
  query: { platform: 'harmony', page: '目标页面', symptom: '状态变化前的异常', keywords: ['不存在的状态变化知识'] },
  reason: '冻结状态变化前的知识调查上下文',
}, { now: T0 });
executeStep(staleKnowledgeScene.execDir, {
  intent: '改变知识调查后的当前现场',
  action: { type: 'tap', targetRef: staleKnowledgeStart.observationView.elements[0].ref },
}, { runner, now: T0 });
expectCode(() => conclude(staleKnowledgeScene.execDir, {
  verdict: 'FAIL', summary: '旧知识调查不能支撑变化后的现场', queryRefs: [sceneQuery.queryId],
  findings: [{ requirementRef: 'req-001', status: 'NOT_SATISFIED', reason: '当前现场不满足要求' }],
}, { now: T0 }), 'KNOWLEDGE_CONTEXT_STALE');

const staleKnowledgeUnderstanding = setup('stale-knowledge-after-understanding-revision');
const staleUnderstandingInput = understandInput(staleKnowledgeUnderstanding);
staleUnderstandingInput.understanding.requirements[0].requiredInteractions = [];
initialize(staleKnowledgeUnderstanding.execDir, staleUnderstandingInput, { now: T0 });
inspectCurrent(staleKnowledgeUnderstanding.execDir, {
  intent: '建立理解修订知识测试起点',
}, { runner, now: T0 });
markStart(staleKnowledgeUnderstanding.execDir, { reason: '当前页面满足理解修订知识测试起点' }, { now: T0 });
const understandingQuery = investigate(staleKnowledgeUnderstanding.execDir, {
  query: { symptom: '理解修订前的异常', keywords: ['不存在的理解修订知识'] },
  reason: '冻结理解修订前的知识调查上下文',
}, { now: T0 });
const revisedKnowledgeInput = understandInput(staleKnowledgeUnderstanding);
revisedKnowledgeInput.understanding.requirements[0].requiredInteractions = [];
revisedKnowledgeInput.understanding.summary = '修订后的完整用例理解';
freezeUnderstanding(staleKnowledgeUnderstanding.execDir, {
  understanding: revisedKnowledgeInput.understanding,
  reason: '修正用例整体理解',
}, { now: T0 });
submitPlan(staleKnowledgeUnderstanding.execDir, {
  checkpoints: revisedKnowledgeInput.checkpoints,
  reason: '理解修订后重新建立计划',
}, { now: T0 });
expectCode(() => conclude(staleKnowledgeUnderstanding.execDir, {
  verdict: 'INCONCLUSIVE', summary: '旧知识调查不能支撑修订后的理解', queryRefs: [understandingQuery.queryId],
  uncertainties: ['修订后尚未重新调查'],
  findings: [{ requirementRef: 'req-001', status: 'UNRESOLVED', reason: '修订后证据与知识尚未重新建立' }],
}, { now: T0 }), 'KNOWLEDGE_CONTEXT_STALE');

const sourceColdStart = setup('source-cold-start');
const sourceColdInput = understandInput(sourceColdStart);
sourceColdInput.understanding.startConditions = [{ id: 'start-cold', text: '原文要求冷启动 App', basis: 'explicit' }];
sourceColdInput.understanding.requirements[0].basis = 'assumed';
initialize(sourceColdStart.execDir, sourceColdInput, { now: T0 });
assert.deepStrictEqual(readJson(path.join(sourceColdStart.execDir, 'understanding.json')).requirements[0].sourceRefs, []);
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
cliInput.understanding.requirements[0].requiredInteractions = [];
initialize(cliConclusion.execDir, cliInput, { now: T0 });
  const cliScene = inspectCurrent(cliConclusion.execDir, { intent: '建立 CLI 结论起点' }, { runner, now: T0 });
markStart(cliConclusion.execDir, { reason: '当前现场满足 CLI 结论起点' }, { now: T0 });
childProcess.execFileSync(process.execPath, [
  'scripts/agent/conclude.js', '--exec-dir', cliConclusion.execDir, '--request-json', JSON.stringify({
    verdict: 'PASS', summary: 'CLI 结论计入协议指标',
    ...SEMANTIC_REVIEW,
    findings: [{ requirementRef: 'req-001', status: 'SATISFIED', reason: '当前观察满足要求', evidenceRefs: [cliScene.observation.ref] }],
  }),
], { cwd: repo, encoding: 'utf8', env: process.env });
const cliMetrics = readJson(path.join(cliConclusion.execDir, 'metrics.json'));
assert.strictEqual(cliMetrics.timing.protocolAttempts, 1);
assert.strictEqual(fs.readFileSync(path.join(cliConclusion.execDir, 'agent', 'attempts.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cliConclusion.execDir, 'agent', 'attempts.jsonl'), 'utf8')).entrypoint, 'conclude');
assert.strictEqual(fs.existsSync(path.join(cliConclusion.execDir, 'agent', 'attempt.current.json')), false);

console.log('agent-facade passed');
