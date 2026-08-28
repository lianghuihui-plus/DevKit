#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bootstrapBatch, commitCurrentCase, initializeBatch, loadBatch, reconcileBatch, recoverApp, startCurrentCase,
} = require('../batch/core');
const { createAgentRequest, createAgentResult } = require('../agent/core');
const { requestRecovery } = require('../agent/control-request');
const { executeKnowledgeQuery } = require('../agent/query-knowledge');
const { recordSimulatedOperation } = require('./simulated-operation');
const { commitAgentTurn } = require('../agent/turn');
const { changePhase, confirmStartObservation, finalizeExecution, timelineEvents } = require('../execution/core');
const { createCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { evaluateTrace, loadEvalScenarios, traceFromExecution } = require('../lib/agent-eval');
const { readExecutionReport } = require('../lib/execution-reader');
const { sha256File } = require('../lib/execution-evidence');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { withAuthorizationSha } = require('../lib/plan-authorization');
const { withPlanSha } = require('../lib/plan-contract');
const { collectIndexCases, renderIndexForRoot, writeCaseReports } = require('../report/report-service');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const T0 = '2026-08-13T10:00:00.000Z';
const T30 = '2026-08-13T10:30:00.000Z';
const BINDING = Object.freeze({ platform: 'harmony', deviceId: 'integration-device', appId: 'com.example.integration', entry: 'EntryAbility' });

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function adapter() {
  const calls = [];
  return {
    calls,
    restartApp(request) { calls.push(request); return { ok: true, coldStartVerified: true, startupDisplayVerified: true }; },
    probeSession() { return { ok: true, binding: { ...BINDING } }; },
  };
}

function makeCase(root, name, sourceText) {
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText, importPath: `/integration/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  return { name, caseKey, caseDir, caseJson, sourceText };
}

function understanding(item) {
  return {
    schemaVersion: 1, revision: 1, summary: `理解 ${item.name}`,
    startConditions: [{ id: 'start-001', text: '通过当前现场建立起点', basis: 'implied', sourceRefs: ['src-001'] }],
    requirements: [{ id: 'req-001', text: item.sourceText, basis: 'explicit', sourceRefs: ['src-001'] }],
    sourceRefs: [{ id: 'src-001', sourceSha: sourceSha(item.sourceText), lineStart: 1, lineEnd: 1, quote: item.sourceText }],
    uncertainties: [], requirementDispositions: [],
  };
}

function plan(revision = 1, reason = '建立当前检查点') {
  return withPlanSha({
    schemaVersion: 1, revision, reason,
    checkpoints: [{ id: 'cp-001', goal: '验证当前明确要求', requirementRefs: ['req-001'], requiredAction: false }],
  });
}

function prepareAuth(started) {
  return withAuthorizationSha({ schemaVersion: 1, source: 'agent-plan', executionId: started.execution.executionId, phase: 'case-prepare', understandingRevision: 1, startConditionId: 'start-001', purpose: '建立本用例起点', requirementRefs: [], sourceRefs: [], sideEffect: false });
}

function businessAuth(started, overrides = {}) {
  return withAuthorizationSha({ schemaVersion: 1, source: 'agent-plan', executionId: started.execution.executionId, phase: 'case-business', understandingRevision: 1, planRevision: overrides.planRevision || 1, checkpointId: 'cp-001', purpose: '验证当前要求', requirementRefs: ['req-001'], sourceRefs: [], sideEffect: false, ...overrides });
}

function reviewBinding(started) {
  const currentUnderstanding = readJson(path.join(started.execDir, 'understanding.json'));
  const currentPlan = readJson(path.join(started.execDir, 'plan.json'));
  return {
    understandingRevision: currentUnderstanding.revision,
    planRevision: currentPlan.revision,
    planSha: currentPlan.planSha,
    requirementRefs: currentUnderstanding.requirements.map((entry) => entry.id),
  };
}

function evidence(execDir, operationId) {
  const ref = `screenshots/${operationId}.png`;
  fs.writeFileSync(path.join(execDir, ref), PNG);
  return { ref, sha256: sha256File(path.join(execDir, ref)), usable: true };
}

function observe(started, operationId, authorization, options = {}) {
  return recordSimulatedOperation(started.execDir, { operationId, authorization }, evidence(started.execDir, operationId), { now: options.now || T0, interruptAfter: options.interruptAfter });
}

function startCase(batch, index, options = {}) {
  const started = startCurrentCase({ workspaceRoot: batch.root, batchId: batch.batchId, implementationSha: batch.contract.implementationSha, executionId: `execution-integration-${index + 1}`, now: T0 });
  createAgentRequest({ workspaceRoot: batch.root, execDir: started.execDir, skillContract: batch.contract });
  const turn = { schemaVersion: 1, turnId: `turn-initial-${index + 1}`, understanding: understanding(batch.cases[index]), plan: plan(), facts: [] };
  if (options.interruptTurn) assert.throws(() => commitAgentTurn(started.execDir, turn, { now: T0, interruptAfter: 'understanding' }), /MAVT_AGENT_TURN_INTERRUPTED/);
  commitAgentTurn(started.execDir, turn, { now: T0 });
  changePhase(started.execDir, 'ESTABLISH_START', '根据暖状态观察并建立起点', { implementationSha: batch.contract.implementationSha, now: T0 });
  const startRef = observe(started, `prepare-${index + 1}`, prepareAuth(started)).fact.ref;
  confirmStartObservation(started.execDir, startRef, '测试确认当前现场满足起点', { now: T0 });
  changePhase(started.execDir, 'EXECUTE', '起点已由当前 observation 确认', { implementationSha: batch.contract.implementationSha, now: T0 });
  return { ...started, sourceItem: batch.cases[index] };
}

function finalize(started, batch, value, options = {}) {
  return finalizeExecution(started.execDir, value, { implementationSha: batch.contract.implementationSha, now: options.now || T0, interruptAfter: options.interruptAfter });
}

function publish(batch, started, options = {}) {
  if (!fs.existsSync(path.join(started.execDir, 'agent', 'result.json'))) createAgentResult({ execDir: started.execDir });
  return commitCurrentCase({ workspaceRoot: batch.root, batchId: batch.batchId, implementationSha: batch.contract.implementationSha, now: options.now || T0, interruptAfter: options.interruptAfter });
}

function reportAndEval(batch, started, scenarioId) {
  const report = readExecutionReport(started.execDir);
  writeCaseReports(started.sourceItem.caseDir, started.sourceItem.caseJson, {}, [], report, { platform: 'harmony', skipRootOverview: true });
  const scenario = batch.scenarios.find((item) => item.id === scenarioId);
  const evaluated = evaluateTrace(scenario, traceFromExecution(report));
  assert.strictEqual(evaluated.passed, true, `${scenarioId}: ${JSON.stringify(evaluated)}`);
  return report;
}

process.env.MAVT_SELF_TEST = '1';
const repo = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-integration-'));
const workspacePath = path.join(temp, 'workspace');
createTestWorkspace(workspacePath);
const root = fs.realpathSync(workspacePath);
fs.mkdirSync(path.join(root, 'knowledge'));
fs.mkdirSync(path.join(root, 'runs'));
const cases = [
  makeCase(root, 'direct', '确认课程页显示开始学习按钮'),
  makeCase(root, 'knowledge', '登录后确认首页显示用户头像'),
  makeCase(root, 'defect', '提交表单后应展示成功提示'),
  makeCase(root, 'timeout', '探索设置并确认目标选项'),
];
fs.writeFileSync(path.join(root, 'knowledge', 'known.md'), `# K-login-001 登录后首页刷新延迟

## 适用范围
- App: 测试应用
- Platform: harmony
- Version: 3.2.x
- Page: 首页

## 可观察现象
登录后首页可能短暂显示游客入口，随后刷新头像。

## 结论与处理建议
重新观察后头像出现属于正常刷新延迟。

## 追溯信息
登录专项记录。
`);
const contract = JSON.parse(childProcess.execFileSync(process.execPath, ['scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony'], { cwd: repo, env: { ...process.env, MAVT_SELF_TEST: '1' }, encoding: 'utf8' }));
const batchId = 'batch-agent-integration';
const device = adapter();
createTestExecutionRequest(root, batchId, BINDING, cases, { mode: 'BATCH', now: T0 });
initializeBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, now: T0 });
bootstrapBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter: device, now: T0 });
const batch = { root, batchId, contract, device, cases, scenarios: loadEvalScenarios(path.join(__dirname, 'evals')) };

// Direct page: interrupted turn and operation recover without adding a needless business action.
const direct = startCase(batch, 0, { interruptTurn: true });
assert.throws(() => observe(direct, 'direct-business', businessAuth(direct), { interruptAfter: 'begin' }), /MAVT_AGENT_OPERATION_INTERRUPTED/);
const directEvidence = observe(direct, 'direct-business', businessAuth(direct)).fact.ref;
changePhase(direct.execDir, 'CONCLUDE', '直接证据充分', { implementationSha: contract.implementationSha, now: T0 });
finalize(direct, batch, { verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '开始学习按钮可见', requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: [directEvidence], knowledgeRefs: [] }], uncertainties: [], technicalFailureCode: null });
publish(batch, direct);
reportAndEval(batch, direct, 'target-page-direct');

// Knowledge-supported result: finalization resumes from a frozen draft.
const knownCase = startCase(batch, 1);
const knownEvidence = observe(knownCase, 'known-business', businessAuth(knownCase)).fact.ref;
changePhase(knownCase.execDir, 'INVESTIGATE', '当前现象需要知识调查', { implementationSha: contract.implementationSha, now: T0 });
const query = executeKnowledgeQuery({ execDir: knownCase.execDir, queryId: 'query-login', query: { platform: 'harmony', version: '3.2.5', page: '首页', symptom: '游客入口', keywords: ['头像'] }, now: T0 });
const candidate = query.candidates[0];
commitAgentTurn(knownCase.execDir, { schemaVersion: 1, turnId: 'turn-known-assessment', facts: [{ factId: 'assessment-login', type: 'knowledgeAssessment', queryId: 'query-login', knowledgeRef: 'assessment-login', entryId: candidate.entryId, sourceNamespace: candidate.sourceNamespace, relativePath: candidate.relativePath, contentSha: candidate.contentSha, assessment: 'APPLICABLE', reason: '平台、版本、页面和当前现象均一致' }] }, { now: T0 });
changePhase(knownCase.execDir, 'CONCLUDE', '当前证据与适用知识支持结论', { implementationSha: contract.implementationSha, now: T0 });
const knowledgeResult = { verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'KNOWLEDGE_SUPPORTED', summary: '当前现象属于已知刷新延迟', requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: [knownEvidence], knowledgeRefs: ['assessment-login'] }], uncertainties: [], technicalFailureCode: null };
assert.throws(() => finalize(knownCase, batch, knowledgeResult, { interruptAfter: 'draft' }), /MAVT_FINALIZE_INTERRUPTED/);
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter: device, now: T0 }).action, 'RESUME_FINALIZE');
  finalize(knownCase, batch, knowledgeResult);
const knownSnapshot = path.join(knownCase.execDir, candidate.snapshotRef);
const knownSnapshotContent = fs.readFileSync(knownSnapshot, 'utf8');
fs.writeFileSync(knownSnapshot, `${knownSnapshotContent}\n篡改`);
expectCode(() => publish(batch, knownCase), 'KNOWLEDGE_SNAPSHOT_CHANGED');
assert.strictEqual(readJson(path.join(knownCase.execDir, 'agent', 'runtime.json')).status, 'BOUND');
fs.writeFileSync(knownSnapshot, knownSnapshotContent);
  publish(batch, knownCase);
reportAndEval(batch, knownCase, 'knowledge-applicable');
const publishedPlanPath = path.join(knownCase.execDir, 'plan.json');
const publishedPlan = fs.readFileSync(publishedPlanPath, 'utf8');
fs.writeFileSync(publishedPlanPath, publishedPlan.replace('建立当前检查点', '发布后被修改'));
assert.match(readExecutionReport(knownCase.execDir).completionError, /EXECUTION_ARTIFACT_CHANGED/);
fs.writeFileSync(publishedPlanPath, publishedPlan);
fs.writeFileSync(knownSnapshot, `${knownSnapshotContent}\n发布后篡改`);
assert.match(readExecutionReport(knownCase.execDir).completionError, /KNOWLEDGE_SNAPSHOT_CHANGED/);
fs.writeFileSync(knownSnapshot, knownSnapshotContent);

// Real defect: illegal action is rejected before device operation; recovery rebinds the same case request generation.
const defect = startCase(batch, 2);
expectCode(() => recordSimulatedOperation(defect.execDir, { operationId: 'invalid-tap', authorization: businessAuth(defect), action: { type: 'tap', x: 10, target: '缺少 y' } }, { ok: true }), 'ACTION_CONTRACT_INVALID');
recordSimulatedOperation(defect.execDir, {
  operationId: 'corrected-tap', authorization: businessAuth(defect), basisObservationRef: 'screenshots/prepare-3.png',
  action: { type: 'tap', x: 10, y: 10, target: '提交按钮', coordinateSource: 'visual', targetBounds: [0, 0, 20, 20], coordinateEvidence: '当前截图按钮区域', coordinateArtifactRef: 'screenshots/prepare-3.png' },
}, { ok: true }, { now: T0 });
const defectEvidence = observe(defect, 'defect-business', businessAuth(defect)).fact.ref;
const controlRequest = requestRecovery(defect.execDir, { reason: '系统终止目标 App 进程', triggerType: 'SYSTEM_KILLED' }, { now: T0 }).controlRequest;
const recoveryAction = reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter: device, now: T0 });
assert.strictEqual(recoveryAction.action, 'RECOVER_APP');
assert.deepStrictEqual(recoveryAction.recoveryRequest, controlRequest);
recoverApp({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter: device, now: T0, request: controlRequest });
assert.strictEqual(fs.existsSync(path.join(defect.execDir, 'agent', 'control-request.json')), false);
const reboundRequest = readJson(path.join(defect.execDir, 'agent', 'request.json'));
assert.strictEqual(reboundRequest.warmSessionGeneration, 2);
assert.strictEqual(fs.existsSync(path.join(defect.execDir, 'agent', 'request-generation-1.json')), true);
const recoveredStartRef = observe(defect, 'prepare-after-recovery', prepareAuth(defect)).fact.ref;
confirmStartObservation(defect.execDir, recoveredStartRef, '恢复后重新确认用例起点', { now: T0 });
const postRecoveryEvidence = observe(defect, 'defect-after-recovery', businessAuth(defect)).fact.ref;
changePhase(defect.execDir, 'INVESTIGATE', '明确失败前完成恢复与知识调查', { implementationSha: contract.implementationSha, now: T0 });
executeKnowledgeQuery({ execDir: defect.execDir, queryId: 'query-defect', query: { symptom: '提交后错误提示', keywords: ['成功提示'] }, now: T0 });
changePhase(defect.execDir, 'CONCLUDE', '恢复后缺陷仍稳定存在', { implementationSha: contract.implementationSha, now: T0 });
commitAgentTurn(defect.execDir, { schemaVersion: 1, turnId: 'turn-defect-review', facts: [{ factId: 'review-defect', type: 'verdictReview', ...reviewBinding(defect), queryRefs: ['query-defect'], requestedVerdict: 'FAIL', sourceRecheck: { sourceRefs: ['src-001'], conclusion: '原文明示提交后应展示成功提示' }, currentObservationRefs: [postRecoveryEvidence], recoveryAttempt: { performed: true, explanation: '系统退出后已受控恢复并重新观察，错误提示仍存在', evidenceRefs: [postRecoveryEvidence] }, remainingUncertainties: [], reason: '零命中知识无法解释当前稳定错误提示' }] }, { now: T0 });
finalize(defect, batch, { verdict: 'FAIL', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '提交后未展示成功提示', requirementFindings: [{ requirementId: 'req-001', status: 'NOT_SATISFIED', evidenceRefs: [postRecoveryEvidence], knowledgeRefs: [] }], uncertainties: [], technicalFailureCode: null });
assert.throws(() => publish(batch, defect, { interruptAfter: 'completion' }), /MAVT_BATCH_COMMIT_INTERRUPTED/);
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter: device, now: T0 }).action, 'COMMIT_CASE');
publish(batch, defect);
reportAndEval(batch, defect, 'real-defect');

// Time limit stops new device operations but still permits investigation and conclusion.
const timeout = startCase(batch, 3);
const timeoutEvidence = observe(timeout, 'timeout-business', businessAuth(timeout)).fact.ref;
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter: device, now: T30 }).action, 'CONCLUDE_TIME_LIMIT');
expectCode(() => observe(timeout, 'after-time-limit', businessAuth(timeout), { now: T30 }), 'CASE_TIME_LIMIT_REACHED');
assert.strictEqual(fs.existsSync(path.join(timeout.execDir, 'agent', 'operation-after-time-limit.draft.json')), false);
changePhase(timeout.execDir, 'INVESTIGATE', '达到时限后使用已有事实调查', { implementationSha: contract.implementationSha, now: T30 });
executeKnowledgeQuery({ execDir: timeout.execDir, queryId: 'query-timeout', query: { symptom: '目标选项无法确认', keywords: ['设置'] }, now: T30 });
changePhase(timeout.execDir, 'CONCLUDE', '时限内证据不足，停止新操作并形成结论', { implementationSha: contract.implementationSha, now: T30 });
commitAgentTurn(timeout.execDir, { schemaVersion: 1, turnId: 'turn-timeout-review', facts: [{ factId: 'review-timeout', type: 'verdictReview', ...reviewBinding(timeout), queryRefs: ['query-timeout'], requestedVerdict: 'INCONCLUSIVE', sourceRecheck: { sourceRefs: ['src-001'], conclusion: '原文目标明确，但现有现场不足以确认' }, currentObservationRefs: [timeoutEvidence], recoveryAttempt: { performed: false, explanation: '未发现技术退出或可恢复异常，时限后不再新增设备操作', evidenceRefs: [] }, remainingUncertainties: ['时限内未取得目标选项的充分证据'], reason: '已有证据和知识均不足以形成 PASS 或 FAIL' }] }, { now: T30 });
finalize(timeout, batch, { verdict: 'INCONCLUSIVE', executionStatus: 'STOPPED_BY_BUDGET', verdictBasis: 'INSUFFICIENT_EVIDENCE', summary: '时限内无法确认目标选项', requirementFindings: [{ requirementId: 'req-001', status: 'UNRESOLVED', evidenceRefs: [timeoutEvidence], knowledgeRefs: [] }], uncertainties: ['时限内未取得目标选项的充分证据'], technicalFailureCode: null }, { now: T30 });
publish(batch, timeout, { now: T30 });
reportAndEval(batch, timeout, 'time-limit-stop');

const finalState = loadBatch(root, batchId, contract.implementationSha).state;
assert.strictEqual(finalState.status, 'COMPLETED');
assert.strictEqual(finalState.warmSession.appStartCount, 2);
assert.strictEqual(finalState.warmSession.recoveryCount, 1);
assert.strictEqual(new Set(finalState.cases.map((item) => item.sessionId)).size, 4);
for (const item of cases) assert.ok(fs.existsSync(path.join(item.caseDir, 'platforms', 'harmony', 'CONTEXT.html')));
const indexPath = renderIndexForRoot(root);
const indexHtml = fs.readFileSync(indexPath, 'utf8');
assert.ok(indexHtml.includes('知识支持'));
assert.ok(indexHtml.includes('时限停止'));
const indexed = collectIndexCases(root);
assert.strictEqual(indexed.length, 4);
assert.ok(indexed.some((item) => item.status === 'FAIL'));
assert.ok(indexed.some((item) => item.status === 'UNKNOWN'));
assert.strictEqual(device.calls.filter((request) => request.scope === 'batch-bootstrap').length, 1);
assert.strictEqual(device.calls.filter((request) => request.scope === 'batch-recovery').length, 1);
assert.strictEqual(timelineEvents(defect.execDir).some((event) => event.operationId === 'invalid-tap'), false);

// Retired execution schemas are rejected instead of entering a compatibility path.
const historicalDir = path.join(temp, 'historical-execution');
fs.mkdirSync(historicalDir);
writeJsonAtomic(path.join(historicalDir, 'execution.json'), { schemaVersion: 2, executionId: 'execution-historical' });
writeJsonAtomic(path.join(historicalDir, 'result.json'), { executionId: 'execution-historical', status: 'PASS', reason: '历史结果' });
expectCode(() => readExecutionReport(historicalDir), 'EXECUTION_SCHEMA_UNSUPPORTED');

fs.rmSync(temp, { recursive: true, force: true });
delete process.env.MAVT_SELF_TEST;
console.log('agent-integration passed');
