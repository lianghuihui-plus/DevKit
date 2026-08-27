#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentRequest } = require('../agent/core');
const { createCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { buildContract } = require('../build-agent-contract');
const {
  beginOperation,
  bindAgentRuntime,
  changePhase,
  completeOperation,
  confirmStartObservation,
  createExecution,
  assertConclusionObservationRefs,
  finalizeExecution,
  recordKnowledgeQuery,
  sealTimeLimit,
  timelineEvents,
} = require('../execution/core');
const { commitAgentTurn } = require('../agent/turn');
const {
  acquireFileLock,
  readJson,
  readExecution,
  recoverExecution,
  releaseFileLock,
  writeJsonAtomic,
} = require('../lib/execution-lifecycle');
const {
  sha256File,
  validateEvidenceRecord,
} = require('../lib/execution-evidence');
const {
  CASE_TIME_LIMIT_MS,
  assertOperationAllowed,
  buildCounts,
  timeLimitState,
} = require('../lib/execution-time-limit');
const { withPlanSha } = require('../lib/plan-contract');
const { createTestWorkspace } = require('./current-fixture');
const { runAllowFailure } = require('./helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const EXECUTION_REQUEST_SHA = `execution-request-${'a'.repeat(24)}`;
const BATCH_CONTRACT_SHA = `batch-contract-${'b'.repeat(24)}`;
const COORDINATOR_PROTOCOL_SHA = `agent-protocol-${'c'.repeat(16)}`;
const CASE_EXECUTOR_CONTRACT = buildContract({
  skillRoot: path.resolve(__dirname, '..', '..'),
  role: 'case-executor',
  provider: 'codex',
  platform: 'harmony',
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function setupCase(workspaceRoot, name, options = {}) {
  const sourceText = options.sourceText || `验证 ${name} 的目标状态`;
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText, importPath: `/fixtures/${name}.md` });
  const caseDir = path.join(workspaceRoot, 'cases', `${name}__${caseKey}`);
  const runtimeDir = path.join(caseDir, 'platforms', 'harmony');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  const created = createExecution({
    workspaceRoot,
    runtimeDir,
    caseJson,
    sourceText,
    executionId: options.executionId || `execution-${name}`,
    batchId: 'batch-core-test',
    platform: 'harmony',
    implementationSha: CASE_EXECUTOR_CONTRACT.implementationSha,
    caseExecutorProtocolSha: CASE_EXECUTOR_CONTRACT.protocolSha,
    coordinatorProtocolSha: COORDINATOR_PROTOCOL_SHA,
    batchContractSha: BATCH_CONTRACT_SHA,
    executionRequestSha: EXECUTION_REQUEST_SHA,
    interactionPolicy: 'UNATTENDED',
    warmSessionGeneration: 1,
    now: options.now || '2026-08-13T10:00:00.000Z',
  });
  return { workspaceRoot, caseDir, runtimeDir, caseJson, sourceText, ...created };
}

function understandingFor(sourceText) {
  const quote = sourceText.split(/\r?\n/)[0];
  return {
    schemaVersion: 1,
    revision: 1,
    summary: '验证目标状态',
    startConditions: [{ id: 'start-001', text: '确认当前起点', basis: 'implied', sourceRefs: ['src-001'] }],
    requirements: [{ id: 'req-001', text: '目标状态符合原文', basis: 'explicit', sourceRefs: ['src-001'] }],
    sourceRefs: [{ id: 'src-001', sourceSha: sourceSha(sourceText), lineStart: 1, lineEnd: 1, quote }],
    uncertainties: [],
    requirementDispositions: [],
  };
}

function planFor(revision = 1, reason = '建立目标检查点', requirementId = 'req-001') {
  return withPlanSha({
    schemaVersion: 1,
    revision,
    reason,
    checkpoints: [{ id: 'cp-001', goal: '检查目标状态', requirementRefs: [requirementId], requiredAction: false }],
  });
}

let agentTurnNo = 0;

function commitTurn(item, value, options = {}) {
  agentTurnNo += 1;
  const facts = (value.facts || []).map((fact, index) => ({
    factId: fact.factId || `fact-core-${agentTurnNo}-${index + 1}`,
    ...fact,
  }));
  return commitAgentTurn(item.execDir, {
    schemaVersion: 1,
    turnId: `turn-core-${agentTurnNo}`,
    ...value,
    facts,
  }, options);
}

function recordFact(item, fact, options = {}) {
  return commitTurn(item, { facts: [fact] }, options);
}

function bindFormalRuntime(item) {
  bindAgentRuntime(item.execDir, {
    implementationSha: CASE_EXECUTOR_CONTRACT.implementationSha,
    batchId: 'batch-core-test',
    warmSessionGeneration: 1,
    sessionId: `session-${item.executionId}`,
  });
  createAgentRequest({ workspaceRoot: item.workspaceRoot, execDir: item.execDir, skillContract: CASE_EXECUTOR_CONTRACT });
}

function prepareExecution(item) {
  bindFormalRuntime(item);
  const understanding = understandingFor(item.sourceText);
  commitTurn(item, { understanding, plan: planFor() });
  changePhase(item.execDir, 'ESTABLISH_START', '理解完成');
  const startRef = addObservation(item, 'prepare-start', 'case-prepare');
  confirmStartObservation(item.execDir, startRef, '测试确认当前现场满足起点');
  changePhase(item.execDir, 'EXECUTE', '起点已建立');
  return understanding;
}

function addObservation(item, operationId = 'observe-001', scope = 'case-business', extra = {}) {
  const ref = `screenshots/${operationId}.png`;
  fs.writeFileSync(path.join(item.execDir, ref), PNG);
  const sha256 = sha256File(path.join(item.execDir, ref));
  const now = new Date(Date.parse(item.execution.startedAt) + 1000).toISOString();
  beginOperation(item.execDir, 'OBSERVE', operationId, { now });
  completeOperation(item.execDir, {
    type: 'observation', operationId, scope, ref, sha256, usable: true,
    warmSessionGeneration: readJson(path.join(item.execDir, 'execution.json')).warmSessionGeneration,
    ...(scope === 'case-prepare' ? { startConditionId: 'start-001', understandingRevision: 1 } : {}),
    ...extra,
  }, { now });
  return ref;
}

function resultFor(verdict, evidenceRef = null, options = {}) {
  const status = verdict === 'PASS' ? 'SATISFIED'
    : verdict === 'FAIL' ? 'NOT_SATISFIED'
      : verdict === 'BLOCKED' ? 'BLOCKED' : 'UNRESOLVED';
  return {
    verdict,
    executionStatus: verdict === 'BLOCKED' ? 'TECHNICALLY_BLOCKED' : options.executionStatus || 'COMPLETED',
    verdictBasis: verdict === 'BLOCKED' ? 'TECHNICAL_CONSTRAINT'
      : verdict === 'INCONCLUSIVE' ? 'INSUFFICIENT_EVIDENCE' : options.verdictBasis || 'DIRECT_EVIDENCE',
    summary: `${verdict} 目标结论`,
    requirementFindings: [{
      requirementId: 'req-001',
      status,
      evidenceRefs: evidenceRef ? [evidenceRef] : [],
      knowledgeRefs: options.knowledgeRefs || [],
      ...(verdict === 'INCONCLUSIVE' && !evidenceRef ? { reason: '现有信息不足以形成可靠判断' } : {}),
    }],
    uncertainties: verdict === 'INCONCLUSIVE' ? ['现有信息不足'] : [],
    technicalFailureCode: verdict === 'BLOCKED' ? 'AUTOMATION_CONNECTION_LOST' : null,
  };
}

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-execution-core-'));

const lifecycleRoot = path.join(temp, 'lifecycle');
createTestWorkspace(lifecycleRoot);
const lifecycle = setupCase(lifecycleRoot, 'lifecycle');
assert.strictEqual(readExecution(lifecycle.execDir).execution.phase, 'UNDERSTAND');
assert.strictEqual(readExecution(lifecycle.execDir, { liveSourceText: '外部文件已经变化' }).liveSourceChanged, true);
const originalSnapshot = fs.readFileSync(path.join(lifecycle.execDir, 'source.snapshot.md'), 'utf8');
fs.writeFileSync(path.join(lifecycle.execDir, 'source.snapshot.md'), `${originalSnapshot} changed`);
expectCode(() => readExecution(lifecycle.execDir), 'EXECUTION_SNAPSHOT_CHANGED');
fs.writeFileSync(path.join(lifecycle.execDir, 'source.snapshot.md'), originalSnapshot);

const conflictCase = createCaseContract({
  caseKey: 'ck-111111111111', title: 'conflict', sourceText: '冲突用例', importPath: '/fixtures/conflict.md',
});
const conflictRuntime = path.join(lifecycleRoot, 'cases', 'conflict', 'platforms', 'harmony');
expectCode(() => createExecution({
  workspaceRoot: lifecycleRoot,
  runtimeDir: conflictRuntime,
  caseJson: conflictCase,
  sourceText: '冲突用例',
  executionId: 'execution-conflict',
  batchId: 'batch-core-test',
  platform: 'harmony',
  implementationSha: 'implementation-core-test',
  executionRequestSha: EXECUTION_REQUEST_SHA,
  interactionPolicy: 'UNATTENDED',
}), 'EXECUTION_ACTIVE_CONFLICT');

const orphanDir = path.join(lifecycle.runtimeDir, 'executions', 'execution-orphan');
fs.mkdirSync(orphanDir);
assert.strictEqual(recoverExecution(orphanDir).status, 'ORPHANED');

const phaseRoot = path.join(temp, 'phase-interrupted');
createTestWorkspace(phaseRoot);
const phaseInterrupted = setupCase(phaseRoot, 'phase-interrupted');
bindFormalRuntime(phaseInterrupted);
commitTurn(phaseInterrupted, { understanding: understandingFor(phaseInterrupted.sourceText), plan: planFor() });
assert.throws(() => changePhase(phaseInterrupted.execDir, 'ESTABLISH_START', '冻结并恢复阶段迁移', {
  interruptAfter: 'state', now: '2026-08-13T10:01:00.000Z',
}), /MAVT_PHASE_CHANGE_INTERRUPTED/);
assert.strictEqual(readExecution(phaseInterrupted.execDir).execution.phase, 'ESTABLISH_START');
assert.strictEqual(recoverExecution(phaseInterrupted.execDir).status, 'RESUME_PHASE');
assert.strictEqual(timelineEvents(phaseInterrupted.execDir).filter((event) => event.type === 'phaseChanged').length, 0);
const resumedPhase = changePhase(phaseInterrupted.execDir, 'ESTABLISH_START', '冻结并恢复阶段迁移');
assert.strictEqual(resumedPhase.idempotent, true);
assert.strictEqual(recoverExecution(phaseInterrupted.execDir).status, 'RESUME');
assert.strictEqual(timelineEvents(phaseInterrupted.execDir).filter((event) => event.eventId === resumedPhase.eventId).length, 1);

const lockFile = path.join(temp, 'locks', 'execution.lock');
const lock = acquireFileLock(lockFile);
expectCode(() => acquireFileLock(lockFile), 'EXECUTION_LOCKED');
releaseFileLock(lock);
fs.mkdirSync(path.dirname(lockFile), { recursive: true });
fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, acquiredAt: 'old' }));
const recoveredLock = acquireFileLock(lockFile);
releaseFileLock(recoveredLock);

for (const stage of ['directory', 'snapshots', 'state']) {
  const root = path.join(temp, `interrupt-${stage}`);
  createTestWorkspace(root);
  const sourceText = `创建中断 ${stage}`;
  const caseJson = createCaseContract({ caseKey: `ck-${crypto.createHash('sha256').update(stage).digest('hex').slice(0, 12)}`, title: stage, sourceText, importPath: `/fixtures/${stage}.md` });
  const runtimeDir = path.join(root, 'cases', stage, 'platforms', 'harmony');
  assert.throws(() => createExecution({
    workspaceRoot: root, runtimeDir, caseJson, sourceText, executionId: `execution-${stage}`, batchId: 'batch', platform: 'harmony',
    implementationSha: 'implementation-core-test', interruptAfter: stage,
    executionRequestSha: EXECUTION_REQUEST_SHA, interactionPolicy: 'UNATTENDED',
  }), /MAVT_EXECUTION_CREATE_INTERRUPTED/);
  assert.strictEqual(recoverExecution(path.join(runtimeDir, 'executions', `execution-${stage}`)).status, 'ORPHANED');
}

const evidenceRoot = path.join(temp, 'evidence');
createTestWorkspace(evidenceRoot);
const evidenceCase = setupCase(evidenceRoot, 'evidence');
const pngRef = 'screenshots/evidence.png';
fs.writeFileSync(path.join(evidenceCase.execDir, pngRef), PNG);
const evidence = {
  ref: pngRef,
  executionId: evidenceCase.executionId,
  phase: 'case-business',
  writer: 'observe.sh',
  sha256: sha256File(path.join(evidenceCase.execDir, pngRef)),
};
assert.strictEqual(validateEvidenceRecord(evidence, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }).format, 'png');
expectCode(() => validateEvidenceRecord({ ...evidence, ref: '../outside.png' }, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_PATH_INVALID');
expectCode(() => validateEvidenceRecord({ ...evidence, ref: 'screenshots/missing.png' }, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_MISSING');
expectCode(() => validateEvidenceRecord({ ...evidence, executionId: 'execution-other' }, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_BINDING_MISMATCH');
expectCode(() => validateEvidenceRecord({ ...evidence, writer: 'agent' }, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_WRITER_INVALID');
expectCode(() => validateEvidenceRecord({ ...evidence, sha256: undefined }, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_INVALID');
fs.appendFileSync(path.join(evidenceCase.execDir, pngRef), 'changed');
expectCode(() => validateEvidenceRecord(evidence, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_CHANGED');
fs.writeFileSync(path.join(evidenceCase.execDir, 'screenshots', 'broken.png'), 'not png');
expectCode(() => validateEvidenceRecord({ ...evidence, ref: 'screenshots/broken.png', sha256: sha256File(path.join(evidenceCase.execDir, 'screenshots', 'broken.png')) }, { execDir: evidenceCase.execDir, executionId: evidenceCase.executionId }), 'EVIDENCE_PNG_INVALID');

const executionClock = { startedAt: '2026-08-13T10:00:00.000Z' };
assert.strictEqual(timeLimitState(executionClock, '2026-08-13T10:29:59.999Z').reached, false);
assert.strictEqual(timeLimitState(executionClock, '2026-08-13T10:30:00.000Z').elapsedMs, CASE_TIME_LIMIT_MS);
assertOperationAllowed(executionClock, 'observe', '2026-08-13T10:29:59.999Z');
expectCode(() => assertOperationAllowed(executionClock, 'observe', '2026-08-13T10:30:00.000Z'), 'CASE_TIME_LIMIT_REACHED');
expectCode(() => assertOperationAllowed(executionClock, 'action', '2026-08-13T10:30:00.000Z'), 'CASE_TIME_LIMIT_REACHED');
assertOperationAllowed(executionClock, 'conclude', '2026-08-13T11:00:00.000Z');
assertOperationAllowed(executionClock, 'record', '2026-08-13T11:00:00.000Z');
const manyEvents = Array.from({ length: 500 }, (_, index) => ({ type: index % 2 ? 'observation' : 'actionResult', scope: 'case-business' }));
assert.deepStrictEqual(buildCounts(manyEvents), { actions: 250, observations: 250, preparationActions: 0, knowledgeQueries: 0, knowledgeAssessments: 0, planRevisions: 0, reflections: 0 });

const unboundRoot = path.join(temp, 'unbound');
createTestWorkspace(unboundRoot);
const unbound = setupCase(unboundRoot, 'unbound');
expectCode(() => commitTurn(unbound, { understanding: understandingFor(unbound.sourceText), plan: planFor() }), 'AGENT_RUNTIME_NOT_BOUND');

const revisionRoot = path.join(temp, 'revision');
createTestWorkspace(revisionRoot);
const revision = setupCase(revisionRoot, 'revision');
prepareExecution(revision);
changePhase(revision.execDir, 'INVESTIGATE', '现场信息需要修订理解');
const revisedUnderstanding = {
  ...understandingFor(revision.sourceText),
  revision: 2,
  reason: '现场证据表明原目标应通过新的表现形式确认',
  requirements: [{ id: 'req-002', text: '目标状态以新的表现形式符合原文', basis: 'implied', sourceRefs: ['src-001'] }],
  requirementDispositions: [{ requirementId: 'req-001', disposition: 'REPLACED', replacementRefs: ['req-002'], reason: '保留原目标并修正表现形式' }],
};
commitTurn(revision, { understanding: revisedUnderstanding });
assert.strictEqual(readJson(path.join(revision.execDir, 'understanding.json')).revision, 2);
changePhase(revision.execDir, 'CONCLUDE', '检查过期计划守卫');
expectCode(() => finalizeExecution(revision.execDir, {
  ...resultFor('BLOCKED'),
  requirementFindings: [{ requirementId: 'req-002', status: 'BLOCKED', evidenceRefs: [], knowledgeRefs: [] }],
}), 'PLAN_REVISION_STALE');
changePhase(revision.execDir, 'INVESTIGATE', '修订过期计划');
commitTurn(revision, { plan: planFor(2, '按最新理解修订计划', 'req-002') });
expectCode(() => commitTurn(revision, { plan: planFor(1, '过期计划', 'req-002') }), 'PLAN_REVISION_STALE');
expectCode(() => recordFact(revision, {
  type: 'checkpointFinding', planRevision: 1, checkpointId: 'cp-001', requirementRefs: ['req-002'], evidenceRefs: [], finding: '过期计划',
}), 'PLAN_REVISION_STALE');
expectCode(() => recordFact(revision, {
  type: 'checkpointFinding', planRevision: 2, checkpointId: 'cp-001', requirementRefs: ['req-001'], evidenceRefs: [], finding: '失效要求引用',
}), 'EXECUTION_EVENT_REFERENCE_INVALID');
expectCode(() => changePhase(revision.execDir, 'UNDERSTAND', '非法回退'), 'EXECUTION_PHASE_TRANSITION_INVALID');

const missingEvidenceRoot = path.join(temp, 'missing-business-evidence');
createTestWorkspace(missingEvidenceRoot);
const missingEvidenceCase = setupCase(missingEvidenceRoot, 'missing-business-evidence');
prepareExecution(missingEvidenceCase);
changePhase(missingEvidenceCase.execDir, 'CONCLUDE', '尝试无证据结论');
expectCode(() => finalizeExecution(missingEvidenceCase.execDir, resultFor('PASS')), 'RESULT_EVIDENCE_INVALID');

const openRoot = path.join(temp, 'open-operation');
createTestWorkspace(openRoot);
const openCase = setupCase(openRoot, 'open-operation');
prepareExecution(openCase);
const openNow = new Date(Date.parse(openCase.execution.startedAt) + 1000).toISOString();
beginOperation(openCase.execDir, 'OBSERVE', 'observe-wrong-result', { now: openNow });
expectCode(() => completeOperation(openCase.execDir, {
  type: 'actionResult', operationId: 'observe-wrong-result', scope: 'case-business', ok: true,
}), 'EXECUTION_OPERATION_INVALID');
beginOperation(openCase.execDir, 'ACTION', 'action-wrong-scope', { now: openNow });
expectCode(() => completeOperation(openCase.execDir, {
  type: 'actionResult', operationId: 'action-wrong-scope', scope: 'case-prepare', ok: true,
}), 'START_CONDITION_REFERENCE_INVALID');
expectCode(() => recordFact(openCase, {
  type: 'checkpointFinding', planRevision: 1, checkpointId: 'cp-001', requirementRefs: ['req-001'],
  evidenceRefs: ['screenshots/not-recorded.png'], finding: '伪造证据引用',
}), 'EXECUTION_EVENT_REFERENCE_INVALID');
beginOperation(openCase.execDir, 'ACTION', 'action-open', { now: openNow });
changePhase(openCase.execDir, 'CONCLUDE', '准备结论');
expectCode(() => finalizeExecution(openCase.execDir, resultFor('BLOCKED')), 'EXECUTION_OPERATION_OPEN');

for (const verdict of ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']) {
  const root = path.join(temp, `verdict-${verdict.toLowerCase()}`);
  createTestWorkspace(root);
  const item = setupCase(root, verdict.toLowerCase(), { now: verdict === 'PASS' ? '2026-08-13T09:00:00.000Z' : undefined });
  prepareExecution(item);
  const evidenceRef = ['PASS', 'FAIL'].includes(verdict) ? addObservation(item) : null;
  if (['FAIL', 'INCONCLUSIVE'].includes(verdict)) {
    const reviewEvidence = evidenceRef || addObservation(item);
    changePhase(item.execDir, 'INVESTIGATE', '异常结论前查询知识');
    recordKnowledgeQuery(item.execDir, { queryId: 'query-001', query: { symptom: '目标状态', keywords: [] }, candidates: [], matchCount: 0 });
    changePhase(item.execDir, 'CONCLUDE', '形成结论');
    const currentUnderstanding = readJson(path.join(item.execDir, 'understanding.json'));
    const currentPlan = readJson(path.join(item.execDir, 'plan.json'));
    recordFact(item, {
      type: 'verdictReview', understandingRevision: currentUnderstanding.revision,
      planRevision: currentPlan.revision, planSha: currentPlan.planSha,
      requirementRefs: currentUnderstanding.requirements.map((entry) => entry.id),
      queryRefs: ['query-001'], requestedVerdict: verdict,
      sourceRecheck: { sourceRefs: ['src-001'], conclusion: '已重新核对原文目标状态' },
      currentObservationRefs: [reviewEvidence],
      recoveryAttempt: { performed: false, explanation: '重复观察后状态稳定，没有可消除异常的恢复动作', evidenceRefs: [] },
      remainingUncertainties: verdict === 'INCONCLUSIVE' ? ['现有信息不足'] : [],
      reason: '知识库没有可适用资料',
    });
  } else {
    changePhase(item.execDir, 'CONCLUDE', '形成结论');
  }
  const finalized = finalizeExecution(item.execDir, resultFor(verdict, evidenceRef), { now: verdict === 'PASS' ? '2026-08-13T10:00:00.000Z' : '2026-08-13T10:05:00.000Z' });
  assert.strictEqual(finalized.result.verdict, verdict);
  assert.strictEqual(finalized.metrics.executionId, item.executionId);
  assert.strictEqual(readExecution(item.execDir).execution.phase, 'FINALIZED');
  assert.strictEqual(finalizeExecution(item.execDir, resultFor(verdict, evidenceRef)).alreadyFinalized, true);
  expectCode(() => recordFact(item, { type: 'reflection', reason: '已结束后写入' }), 'EXECUTION_FINALIZED');
}

const knowledgeRoot = path.join(temp, 'knowledge-pass');
createTestWorkspace(knowledgeRoot);
const knowledgeCase = setupCase(knowledgeRoot, 'knowledge-pass');
prepareExecution(knowledgeCase);
const knowledgeEvidence = addObservation(knowledgeCase);
changePhase(knowledgeCase.execDir, 'INVESTIGATE', '查询正常场景资料');
const frozenKnowledge = '# K-001 正常现象\n\n当前现象属于已知表现。\n';
const frozenKnowledgeSha = crypto.createHash('sha256').update(frozenKnowledge).digest('hex');
fs.mkdirSync(path.join(knowledgeCase.execDir, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(knowledgeCase.execDir, 'knowledge', `${frozenKnowledgeSha}.md`), frozenKnowledge);
recordKnowledgeQuery(knowledgeCase.execDir, {
  queryId: 'query-knowledge', query: { symptom: '正常现象', keywords: [] }, matchCount: 1,
  candidates: [{ entryId: 'K-001', title: '正常现象', sourceNamespace: 'workspace', relativePath: 'normal.md', contentSha: frozenKnowledgeSha, snapshotRef: `knowledge/${frozenKnowledgeSha}.md`, score: 10, expired: false, validUntil: null, conflictsWith: [], snippets: ['正常现象', '属于已知表现'] }],
});
fs.writeFileSync(path.join(knowledgeCase.execDir, 'knowledge', `${frozenKnowledgeSha}.md`), `${frozenKnowledge}篡改`);
expectCode(() => recordFact(knowledgeCase, {
  type: 'knowledgeAssessment', queryId: 'query-knowledge', knowledgeRef: 'assessment-tampered', entryId: 'K-001', sourceNamespace: 'workspace', relativePath: 'normal.md', contentSha: frozenKnowledgeSha, assessment: 'APPLICABLE', reason: '不应接受已变化快照',
}), 'KNOWLEDGE_SNAPSHOT_CHANGED');
fs.writeFileSync(path.join(knowledgeCase.execDir, 'knowledge', `${frozenKnowledgeSha}.md`), frozenKnowledge);
recordFact(knowledgeCase, {
  type: 'knowledgeAssessment', queryId: 'query-knowledge', knowledgeRef: 'assessment-knowledge', entryId: 'K-001', sourceNamespace: 'workspace', relativePath: 'normal.md', contentSha: frozenKnowledgeSha, assessment: 'APPLICABLE', reason: 'App、版本和页面状态一致',
});
changePhase(knowledgeCase.execDir, 'CONCLUDE', '证据与适用知识支持结论');
fs.writeFileSync(path.join(knowledgeCase.execDir, 'knowledge', `${frozenKnowledgeSha}.md`), `${frozenKnowledge}再次篡改`);
expectCode(() => finalizeExecution(knowledgeCase.execDir, resultFor('PASS', knowledgeEvidence, {
  verdictBasis: 'KNOWLEDGE_SUPPORTED', knowledgeRefs: ['assessment-knowledge'],
})), 'KNOWLEDGE_SNAPSHOT_CHANGED');
fs.writeFileSync(path.join(knowledgeCase.execDir, 'knowledge', `${frozenKnowledgeSha}.md`), frozenKnowledge);
const knowledgeFinal = finalizeExecution(knowledgeCase.execDir, resultFor('PASS', knowledgeEvidence, {
  verdictBasis: 'KNOWLEDGE_SUPPORTED', knowledgeRefs: ['assessment-knowledge'],
}));
assert.strictEqual(knowledgeFinal.result.verdictBasis, 'KNOWLEDGE_SUPPORTED');

const staleRoot = path.join(temp, 'stale-pass-evidence');
createTestWorkspace(staleRoot);
const staleCase = setupCase(staleRoot, 'stale-pass-evidence');
prepareExecution(staleCase);
const staleEvidence = addObservation(staleCase, 'before-final-action');
beginOperation(staleCase.execDir, 'ACTION', 'final-action', { now: '2026-08-13T10:00:02.000Z' });
completeOperation(staleCase.execDir, {
  type: 'actionResult', operationId: 'final-action', scope: 'case-business', ok: true,
  warmSessionGeneration: 1, requestedAction: { type: 'tap' },
}, { now: '2026-08-13T10:00:02.000Z' });
addObservation(staleCase, 'after-final-action', 'case-business', { relatedOperationId: 'final-action' });
changePhase(staleCase.execDir, 'CONCLUDE', '验证最终证据时效');
expectCode(() => finalizeExecution(staleCase.execDir, resultFor('PASS', staleEvidence)), 'CURRENT_OBSERVATION_REQUIRED');

const limitRoot = path.join(temp, 'time-limit-after-action');
createTestWorkspace(limitRoot);
const limitCase = setupCase(limitRoot, 'time-limit-after-action');
prepareExecution(limitCase);
const limitEvidence = addObservation(limitCase, 'before-time-limit-action');
beginOperation(limitCase.execDir, 'ACTION', 'time-limit-action', { now: '2026-08-13T10:29:59.000Z' });
completeOperation(limitCase.execDir, {
  type: 'actionResult', operationId: 'time-limit-action', scope: 'case-business', ok: true,
  warmSessionGeneration: 1, requestedAction: { type: 'tap' },
}, { now: '2026-08-13T10:29:59.000Z' });
sealTimeLimit(limitCase.execDir, { now: '2026-08-13T10:30:00.000Z' });
assert.strictEqual(readExecution(limitCase.execDir).execution.phase, 'CONCLUDE');
assert.strictEqual(timelineEvents(limitCase.execDir).filter((event) => event.type === 'timeLimitReached').length, 1);
expectCode(() => assertConclusionObservationRefs(timelineEvents(limitCase.execDir), [limitEvidence], {
  warmSessionGeneration: 1,
}), 'CURRENT_OBSERVATION_STALE');
assert.deepStrictEqual(assertConclusionObservationRefs(timelineEvents(limitCase.execDir), [], {
  warmSessionGeneration: 1,
}).observations, []);
expectCode(() => finalizeExecution(limitCase.execDir, resultFor('PASS', limitEvidence), { now: '2026-08-13T10:30:00.000Z' }), 'RESULT_SEMANTICS_INVALID');
recordKnowledgeQuery(limitCase.execDir, { queryId: 'query-time-limit', query: { symptom: '时限后现场未知', keywords: [] }, candidates: [], matchCount: 0 });
recordFact(limitCase, {
  type: 'verdictReview', understandingRevision: 1, planRevision: 1,
  planSha: readJson(path.join(limitCase.execDir, 'plan.json')).planSha,
  requirementRefs: ['req-001'], queryRefs: ['query-time-limit'], requestedVerdict: 'INCONCLUSIVE',
  sourceRecheck: { sourceRefs: ['src-001'], conclusion: '已复核原始目标' },
  currentObservationRefs: [],
  observationUnavailable: true,
  recoveryAttempt: { performed: false, explanation: '达到时限后不能发起新的设备操作', evidenceRefs: [] },
  remainingUncertainties: ['最后一次动作后的页面状态未观察'],
  reason: '缺少最后一次状态变化后的现场证据',
});
assert.strictEqual(finalizeExecution(limitCase.execDir, resultFor('INCONCLUSIVE', null, {
  executionStatus: 'STOPPED_BY_BUDGET',
}), { now: '2026-08-13T10:30:00.000Z' }).result.executionStatus, 'STOPPED_BY_BUDGET');

const noObservationRoot = path.join(temp, 'time-limit-without-observation');
createTestWorkspace(noObservationRoot);
const noObservationCase = setupCase(noObservationRoot, 'time-limit-without-observation');
bindFormalRuntime(noObservationCase);
commitTurn(noObservationCase, { understanding: understandingFor(noObservationCase.sourceText), plan: planFor() });
changePhase(noObservationCase.execDir, 'ESTABLISH_START', '准备观察起点');
sealTimeLimit(noObservationCase.execDir, { now: '2026-08-13T10:30:00.000Z' });
recordKnowledgeQuery(noObservationCase.execDir, { queryId: 'query-no-observation', query: { symptom: '无法取得现场', keywords: [] }, candidates: [], matchCount: 0 });
recordFact(noObservationCase, {
  type: 'verdictReview', understandingRevision: 1, planRevision: 1,
  planSha: readJson(path.join(noObservationCase.execDir, 'plan.json')).planSha,
  requirementRefs: ['req-001'], queryRefs: ['query-no-observation'], requestedVerdict: 'INCONCLUSIVE',
  sourceRecheck: { sourceRefs: ['src-001'], conclusion: '已复核原始目标' },
  currentObservationRefs: [], observationUnavailable: true,
  recoveryAttempt: { performed: false, explanation: '达到时限后不能发起首次设备观察', evidenceRefs: [] },
  remainingUncertainties: ['没有取得可用页面现场'], reason: '设备现场不可得',
});
assert.strictEqual(finalizeExecution(noObservationCase.execDir, resultFor('INCONCLUSIVE', null, {
  executionStatus: 'STOPPED_BY_BUDGET',
}), { now: '2026-08-13T10:30:00.000Z' }).result.verdict, 'INCONCLUSIVE');

for (const interruptAfter of ['draft', 'result']) {
  const root = path.join(temp, `finalize-${interruptAfter}`);
  createTestWorkspace(root);
  const item = setupCase(root, `finalize-${interruptAfter}`);
  prepareExecution(item);
  changePhase(item.execDir, 'CONCLUDE', '形成技术阻塞结论');
  assert.throws(() => finalizeExecution(item.execDir, resultFor('BLOCKED'), { interruptAfter }), /MAVT_FINALIZE_INTERRUPTED/);
  assert.strictEqual(recoverExecution(item.execDir).status, 'RESUME_FINALIZE');
  const resumed = finalizeExecution(item.execDir, resultFor('BLOCKED'));
  assert.strictEqual(resumed.finalized, true);
  assert.strictEqual(timelineEvents(item.execDir).filter((event) => event.type === 'result').length, 1);
}

const realRoot = path.join(temp, 'real-workspace');
fs.mkdirSync(realRoot);
writeJsonAtomic(path.join(realRoot, 'workspace.json'), { schemaVersion: 1, type: 'mobile-ai-visual-test-workspace' });
assert.throws(() => createExecution({ workspaceRoot: realRoot }), (error) => error?.code === 'EXECUTION_IMPLEMENTATION_INVALID');
const forgedRealExec = path.join(realRoot, 'cases', 'forged', 'platforms', 'harmony', 'executions', 'execution-forged');
fs.mkdirSync(forgedRealExec, { recursive: true });
expectCode(() => bindAgentRuntime(forgedRealExec), 'EXECUTION_ORPHANED');

const unknownCommand = runAllowFailure('node', ['scripts/tests/current-core-cli.js', 'unknown'], { env: { ...process.env, MAVT_SELF_TEST: '1' } });
assert.notStrictEqual(unknownCommand.status, 0);
assert.ok(unknownCommand.stderr.includes('unknown command'));
const unknownOption = runAllowFailure('node', ['scripts/tests/current-core-cli.js', 'bind-runtime', '--unknown', 'value'], { env: { ...process.env, MAVT_SELF_TEST: '1' } });
assert.notStrictEqual(unknownOption.status, 0);
assert.ok(unknownOption.stderr.includes('unknown option'));
const missingValue = runAllowFailure('node', ['scripts/tests/current-core-cli.js', 'bind-runtime', '--exec-dir'], { env: { ...process.env, MAVT_SELF_TEST: '1' } });
assert.notStrictEqual(missingValue.status, 0);
assert.ok(missingValue.stderr.includes('missing value'));
const productionCli = runAllowFailure('node', ['scripts/tests/current-core-cli.js', 'bind-runtime', '--exec-dir', revision.execDir], {
  env: { ...process.env, MAVT_SELF_TEST: '' },
});
assert.notStrictEqual(productionCli.status, 0);
assert.ok(productionCli.stderr.includes('MAVT_SELF_TEST=1'));

delete process.env.MAVT_SELF_TEST;
fs.rmSync(temp, { recursive: true, force: true });
console.log('execution-core passed');
