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
const { requestRecovery } = require('../agent/control-request');
const { recoverInternalTransactions } = require('../batch/internal-recovery');
const { bootstrapBatch, initializeBatch, recoverApp, startCurrentCase } = require('../batch/core');
const { createCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { sealTimeLimit, timelineEvents } = require('../execution/core');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

const T0 = '2026-08-13T10:00:00.000Z';
const BINDING = Object.freeze({ platform: 'harmony', deviceId: 'facade-device', appId: 'com.example.facade', entry: 'EntryAbility' });

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
      return { status: 0, stderr: '', stdout: JSON.stringify({
        schemaVersion: 1,
        type: 'actionResult',
        platform: 'harmony',
        action: valueAfter(args, '--type'),
        ok: true,
        device: { id: BINDING.deviceId },
        app: { appId: BINDING.appId },
      }) };
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
    writeJsonAtomic(path.join(out, layout), {
      attributes: { type: 'Root', bounds: '[0,0][100,200]', visible: 'true' },
      children: [{
        attributes: {
          text: '目标按钮', type: 'Button', bounds: '[10,20][50,60]', clickable: 'true', enabled: 'true', visible: 'true',
        },
        children: [],
      }],
    });
    return { status: 0, stderr: '', stdout: JSON.stringify({
      schemaVersion: 1,
      type: 'observation',
      platform: 'harmony',
      artifacts: { screenshot, layout, logs: [] },
      device: { id: BINDING.deviceId },
      app: { appId: BINDING.appId, foregroundApp: BINDING.appId, inTargetApp: true },
    }) };
  };
  runner.calls = calls;
  runner.failNextObservation = false;
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
      sourceRefs: [{ id: 'src-001', sourceSha: sourceSha(item.sourceText), lineStart: 1, lineEnd: 1, quote: item.sourceText }],
      startConditions: [{ id: 'start-001', text: '目标页面可用', basis: 'implied', sourceRefs: ['src-001'] }],
      requirements: [{ id: 'req-001', text: item.sourceText, basis: 'explicit', sourceRefs: ['src-001'] }],
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
}, { runner, now: T0 }), 'DEVICE_ADAPTER_OUTPUT_INVALID');
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

const control = setup('control-request');
understand(control.execDir, understandInput(control), { now: T0 });
const controlObservation = inspectCurrent(control.execDir, { stage: 'PREPARE', intent: '观察恢复前现场' }, { runner, now: T0 });
markStart(control.execDir, { reason: '恢复请求测试起点' }, { now: T0 });
const requested = requestRecovery(control.execDir, { reason: '目标 App 意外退出', triggerType: 'UNKNOWN_EXIT' }, { now: T0 });
assert.deepStrictEqual(requested.controlRequest.evidenceRefs, [controlObservation.observation.ref]);
assert.strictEqual(requested.controlRequest.checkpointId, 'cp-001');
assert.strictEqual(readAgentStatus(control.execDir, T0).controlRequestPending, true);
expectCode(() => inspectCurrent(control.execDir, { stage: 'BUSINESS' }, { runner, now: T0 }), 'AGENT_CONTROL_REQUEST_PENDING');

const firstObservationFailure = setup('first-observation-recovery');
understand(firstObservationFailure.execDir, understandInput(firstObservationFailure), { now: T0 });
runner.failNextObservation = true;
expectCode(() => inspectCurrent(firstObservationFailure.execDir, { stage: 'PREPARE' }, { runner, now: T0 }), 'DEVICE_ADAPTER_OUTPUT_INVALID');
const firstFailureRequest = requestRecovery(firstObservationFailure.execDir, {
  reason: '首次观察时自动化会话失效', triggerType: 'AUTOMATION_SESSION_LOST',
}, { now: T0 }).controlRequest;
assert.deepStrictEqual(firstFailureRequest.evidenceRefs, []);
assert.ok(firstFailureRequest.failedOperationId);

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
}, { runner, now: T0 }), 'DEVICE_ADAPTER_OUTPUT_INVALID');
const deadlineActions = runner.calls.filter((entry) => entry.kind === 'ACTION').length;
recoverInternalTransactions(deadline.execDir, { runner, now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(readAgentStatus(deadline.execDir, '2026-08-13T10:30:00.000Z').stepRecoveries.length, 0);
assert.strictEqual(runner.calls.filter((entry) => entry.kind === 'ACTION').length, deadlineActions);
sealTimeLimit(deadline.execDir, { implementationSha: contract.implementationSha, now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(readAgentStatus(deadline.execDir, '2026-08-13T10:30:00.000Z').signals.mayConclude, true);

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

const sourceColdStart = setup('source-cold-start');
understand(sourceColdStart.execDir, understandInput(sourceColdStart), { now: T0 });
const sourceColdRequest = requestRecovery(sourceColdStart.execDir, {
  reason: '冻结原文明示必须冷启动', triggerType: 'SOURCE_REQUIRED_COLD_START',
}, { now: T0 }).controlRequest;
assert.deepStrictEqual(sourceColdRequest.sourceRefs, ['src-001']);
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
assert.strictEqual(fs.existsSync(path.join(cliConclusion.execDir, 'agent', 'attempt.current.json')), false);

console.log('agent-facade passed');
