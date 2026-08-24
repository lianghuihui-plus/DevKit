#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  caseContractSha,
  createCaseContract,
  sourceSha,
  validateCaseContract,
  validateSourceText,
} = require('../execution/contracts/case-contract');
const { validateExecutionEvent } = require('../execution/contracts/execution-event-contract');
const { validateMetrics, validateResult, withResultSha } = require('../execution/contracts/result-contract');
const {
  completionDisplayResult,
  completionPaths,
  sha256File,
  validateCompletionBinding,
  validatePublishedCompletion,
} = require('../lib/completion-contract');
const { validatePlan, withPlanSha } = require('../lib/plan-contract');
const { schemas: caseAgentSchemas } = require('../lib/case-agent-runtime-contract');
const { validateSourceReference, validateSourceReferences } = require('../lib/source-reference');
const { validateUnderstanding } = require('../lib/understanding-contract');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const sourceText = [
  '# AI 回复语音按钮',
  '',
  '进入包含 AI 回复的会话',
  '最新回复展示单条语音播放按钮',
].join('\n');
const sourceDigest = sourceSha(sourceText);

assert.strictEqual(validateSourceText('\ufeff任意描述'), '任意描述');
assert.strictEqual(validateSourceText('这是一段无法拆出明确目标、但仍应被接受的文本。').length > 0, true);
for (const value of ['', ' \n\t ', '\ufeff \r\n\t']) expectCode(() => validateSourceText(value), 'CASE_INPUT_EMPTY');

const currentCase = createCaseContract({
  caseKey: 'ck-0123456789ab',
  title: '',
  sourceText,
  importPath: '/external/cases/audio.md',
});
assert.strictEqual(currentCase.schemaVersion, 2);
assert.strictEqual(currentCase.identity.title, 'Untitled case');
assert.strictEqual(currentCase.identity.sourceSha, sourceDigest);
assert.strictEqual(currentCase.contractSha, caseContractSha(currentCase));
assert.strictEqual(validateCaseContract(currentCase), currentCase);
expectCode(() => validateCaseContract({ ...currentCase, schemaVersion: 1 }), 'CASE_SCHEMA_UNSUPPORTED');
expectCode(() => validateCaseContract({ ...currentCase, steps: [] }), 'CASE_CONTRACT_INVALID');
expectCode(() => validateCaseContract({ ...currentCase, contractSha: 'case-contract-deadbeef' }), 'CASE_CONTRACT_INVALID');

const sourceRefs = [
  { id: 'src-001', sourceSha: sourceDigest, lineStart: 2, lineEnd: 3, quote: '\n进入包含 AI 回复的会话' },
  { id: 'src-002', sourceSha: sourceDigest, lineStart: 4, lineEnd: 4, quote: '最新回复展示单条语音播放按钮' },
];
assert.strictEqual(validateSourceReference(sourceRefs[0], { sourceText }), sourceRefs[0]);
assert.deepStrictEqual([...validateSourceReferences(sourceRefs, { sourceText })], ['src-001', 'src-002']);
const crlfSource = sourceText.replace(/\n/g, '\r\n');
const crlfRef = { ...sourceRefs[1], sourceSha: sourceSha(crlfSource) };
assert.strictEqual(validateSourceReference(crlfRef, { sourceText: crlfSource }), crlfRef);
expectCode(() => validateSourceReference({ ...sourceRefs[0], lineEnd: 9 }, { sourceText }), 'SOURCE_REFERENCE_INVALID');
expectCode(() => validateSourceReference({ ...sourceRefs[0], quote: '错误摘录' }, { sourceText }), 'SOURCE_REFERENCE_MISMATCH');
expectCode(() => validateSourceReference({ ...sourceRefs[0], sourceSha: 'source-' + '0'.repeat(64) }, { sourceText }), 'SOURCE_REFERENCE_MISMATCH');
expectCode(() => validateSourceReferences([sourceRefs[0], sourceRefs[0]], { sourceText }), 'SOURCE_REFERENCE_INVALID');

const understanding = {
  schemaVersion: 1,
  revision: 1,
  summary: '验证最新 AI 回复是否展示单条语音播放按钮',
  startConditions: [{
    id: 'start-001', text: '已进入包含 AI 回复的会话', basis: 'implied', sourceRefs: ['src-001'],
  }],
  requirements: [{
    id: 'req-001', text: '最新回复展示单条语音播放按钮', basis: 'explicit', sourceRefs: ['src-002'],
  }],
  sourceRefs,
  uncertainties: [],
  requirementDispositions: [],
};
assert.strictEqual(validateUnderstanding(understanding, { sourceText }), understanding);
const ambiguousUnderstanding = {
  schemaVersion: 1,
  revision: 1,
  summary: '原文非空，但无法形成可靠测试目标',
  startConditions: [],
  requirements: [],
  sourceRefs: [],
  uncertainties: ['测试目标不明确'],
  requirementDispositions: [],
};
assert.strictEqual(validateUnderstanding(ambiguousUnderstanding, { sourceText: '随便看看' }), ambiguousUnderstanding);
expectCode(() => validateUnderstanding({ ...understanding, revision: 2 }, { sourceText }), 'UNDERSTANDING_REVISION_INVALID');
expectCode(() => validateUnderstanding({
  ...understanding,
  requirements: [{ ...understanding.requirements[0], sourceRefs: ['src-missing'] }],
}, { sourceText }), 'UNDERSTANDING_INVALID');
expectCode(() => validateUnderstanding({
  ...understanding,
  requirements: [{ ...understanding.requirements[0], basis: 'explicit', sourceRefs: [] }],
}, { sourceText }), 'UNDERSTANDING_INVALID');

const revisedUnderstanding = {
  ...understanding,
  revision: 2,
  reason: '现场证据表明原要求实际对应回复操作菜单',
  requirements: [{
    id: 'req-002', text: '最新回复操作菜单提供语音播放入口', basis: 'implied', sourceRefs: ['src-002'],
  }],
  requirementDispositions: [{
    requirementId: 'req-001', disposition: 'REPLACED', replacementRefs: ['req-002'], reason: '保留原目标并修正表现形式',
  }],
};
assert.strictEqual(validateUnderstanding(revisedUnderstanding, { sourceText, previous: understanding }), revisedUnderstanding);
expectCode(() => validateUnderstanding({ ...revisedUnderstanding, revision: 1 }, { sourceText, previous: understanding }), 'UNDERSTANDING_REVISION_STALE');
expectCode(() => validateUnderstanding({
  ...revisedUnderstanding, requirements: [], requirementDispositions: [],
}, { sourceText, previous: understanding }), 'UNDERSTANDING_REQUIREMENT_DROPPED');
expectCode(() => validateUnderstanding({
  ...revisedUnderstanding, requirementDispositions: [null],
}, { sourceText, previous: understanding }), 'UNDERSTANDING_INVALID');

const initialPlan = withPlanSha({
  schemaVersion: 1,
  revision: 1,
  reason: '根据当前理解建立初始检查点',
  checkpoints: [{
    id: 'cp-001',
    goal: '确认最新回复区域的播放按钮状态',
    requirementRefs: ['req-001'],
    requiredAction: false,
  }],
});
assert.strictEqual(validatePlan(initialPlan, { understanding }), initialPlan);
const revisedPlan = withPlanSha({
  schemaVersion: 1,
  revision: 2,
  reason: '当前已位于目标会话，拆分观察和操作检查点',
  checkpoints: [
    { id: 'cp-002', goal: '观察最新回复区域', requirementRefs: ['req-001'], requiredAction: false },
    { id: 'cp-003', goal: '必要时打开回复操作菜单', requirementRefs: ['req-001'], requiredAction: true },
  ],
});
assert.strictEqual(validatePlan(revisedPlan, { understanding, previous: initialPlan }), revisedPlan);
expectCode(() => validatePlan(withPlanSha({
  schemaVersion: 1, revision: 1, reason: '目标不明确，暂不建立检查点', checkpoints: [],
}), { understanding: ambiguousUnderstanding }), 'PLAN_INVALID');
expectCode(() => validatePlan({ ...revisedPlan, revision: 1 }, { understanding, previous: initialPlan }), 'PLAN_REVISION_STALE');
expectCode(() => validatePlan(withPlanSha({
  ...initialPlan,
  checkpoints: [{ ...initialPlan.checkpoints[0], id: 'cp-002', requirementRefs: ['req-missing'] }],
}), { understanding }), 'PLAN_INVALID');
expectCode(() => validatePlan(withPlanSha({
  ...initialPlan,
  checkpoints: [initialPlan.checkpoints[0], initialPlan.checkpoints[0]],
}), { understanding }), 'PLAN_INVALID');
expectCode(() => validatePlan({ ...initialPlan, planSha: 'plan-deadbeef' }, { understanding }), 'PLAN_INVALID');
expectCode(() => validatePlan(withPlanSha({
  ...initialPlan,
  checkpoints: [{ ...initialPlan.checkpoints[0], status: 'PENDING' }],
}), { understanding }), 'PLAN_INVALID');

const harmonyAgentSchemas = caseAgentSchemas('harmony');
assert.ok(harmonyAgentSchemas.requestRecovery.triggerTypes.includes('SOURCE_REQUIRED_COLD_START'));
assert.strictEqual('launchApp' in harmonyAgentSchemas.semanticAction.targetModes.rawFallback, false);
assert.strictEqual('restartApp' in harmonyAgentSchemas.semanticAction.targetModes.rawFallback, false);

const executionId = 'execution-contract-001';
const eventBase = { schemaVersion: 1, executionId };
const frozenCandidate = {
  entryId: 'K-00123', title: '已知现象', sourceNamespace: 'workspace', relativePath: 'known.md',
  contentSha: 'a'.repeat(64), score: 10, expired: false, validUntil: null, conflictsWith: [], snippets: ['现象', '建议'],
};
const reviewFields = {
  understandingRevision: understanding.revision,
  planRevision: revisedPlan.revision,
  planSha: revisedPlan.planSha,
  requirementRefs: understanding.requirements.map((item) => item.id),
  sourceRecheck: { sourceRefs: ['src-001'], conclusion: '原文明示播放入口要求' },
  currentObservationRefs: ['screenshots/observe-001.png'],
  recoveryAttempt: { performed: false, explanation: '当前状态稳定，重复观察足以复核，无可执行恢复动作', evidenceRefs: [] },
  remainingUncertainties: [],
};
const events = [
  { ...eventBase, type: 'phaseChanged', writer: 'runtime-core', phase: 'EXECUTE', from: 'ESTABLISH_START', to: 'EXECUTE', reason: '起点已建立' },
  { ...eventBase, type: 'caseUnderstood', writer: 'agent', phase: 'UNDERSTAND', understandingRevision: 1, sourceRefs: ['src-001'] },
  { ...eventBase, type: 'operationRejected', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'action-guarded', kind: 'ACTION', actionType: 'tap', relatedOperationId: 'action-prior', failureCode: 'POST_ACTION_OBSERVATION_REQUIRED', reason: '必须先观察现场' },
  { ...eventBase, type: 'planRevised', writer: 'agent', phase: 'EXECUTE', planRevision: 2, planSha: revisedPlan.planSha, reason: revisedPlan.reason },
  { ...eventBase, type: 'checkpointFinding', writer: 'agent', phase: 'EXECUTE', checkpointId: 'cp-002', planRevision: 2, requirementRefs: ['req-001'], evidenceRefs: ['screenshots/observe-001.png'], finding: '按钮可见' },
  { ...eventBase, type: 'knowledgeQuery', writer: 'knowledge-query', phase: 'INVESTIGATE', queryId: 'query-001', query: { symptom: '语音按钮', keywords: [] }, candidates: [frozenCandidate], matchCount: 1 },
  { ...eventBase, type: 'knowledgeAssessment', writer: 'agent', phase: 'INVESTIGATE', queryId: 'query-001', knowledgeRef: 'assessment-001', entryId: 'K-00123', sourceNamespace: 'workspace', relativePath: 'known.md', contentSha: 'a'.repeat(64), assessment: 'APPLICABLE', reason: '版本和页面状态一致' },
  { ...eventBase, type: 'verdictReview', writer: 'agent', phase: 'CONCLUDE', queryRefs: ['query-001'], requestedVerdict: 'PASS', ...reviewFields, reason: '证据与知识一致' },
  { ...eventBase, type: 'result', writer: 'runtime-core', phase: 'FINALIZED', resultSha: 'result-0123456789abcdef', verdict: 'PASS' },
];
events.forEach((event) => assert.strictEqual(validateExecutionEvent(event, { executionId }), event));
const incompleteReview = { ...events[7] };
delete incompleteReview.queryRefs;
assert.throws(() => validateExecutionEvent(incompleteReview, { executionId }), (error) => error?.code === 'EXECUTION_EVENT_INVALID'
  && error.fieldPath === 'queryRefs' && error.expected === 'array');
assert.strictEqual(validateExecutionEvent({ ...events[5], phase: 'EXECUTE' }, { executionId }).phase, 'EXECUTE');
expectCode(() => validateExecutionEvent({ ...events[7], phase: 'INVESTIGATE' }, { executionId }), 'EXECUTION_EVENT_PHASE_INVALID');
expectCode(() => validateExecutionEvent({ ...events[1], writer: 'runtime-core' }, { executionId }), 'EXECUTION_EVENT_WRITER_INVALID');
expectCode(() => validateExecutionEvent({ ...events[2], executionId: 'execution-other' }, { executionId }), 'EXECUTION_EVENT_BINDING_MISMATCH');
expectCode(() => validateExecutionEvent({ ...events[3], phase: 'INVESTIGATE' }, { executionId, phase: 'EXECUTE' }), 'EXECUTION_EVENT_PHASE_INVALID');

const evidence = [{ ref: 'screenshots/observe-001.png', executionId, phase: 'case-business', usable: true }];
const knowledgeAssessments = [{ ref: 'assessment-001', executionId, assessment: 'APPLICABLE' }];
const verdictReviews = [{ executionId, queryRefs: ['query-001'], requestedVerdict: 'FAIL', ...reviewFields }];
const knowledgeQueries = [{ ref: 'query-001', executionId, matchCount: 0 }];
const directResult = withResultSha({
  schemaVersion: 2,
  executionId,
  verdict: 'PASS',
  executionStatus: 'COMPLETED',
  verdictBasis: 'DIRECT_EVIDENCE',
  summary: '播放按钮可见',
  requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: ['screenshots/observe-001.png'], knowledgeRefs: [] }],
  uncertainties: [],
  technicalFailureCode: null,
});
assert.strictEqual(validateResult(directResult, { executionId, understanding, plan: revisedPlan, evidence }), directResult);
expectCode(() => validateResult(withResultSha({
  ...directResult,
  requirementFindings: [{ ...directResult.requirementFindings[0], status: 'NOT_SATISFIED' }],
}), { executionId, understanding, plan: revisedPlan, evidence }), 'RESULT_SEMANTICS_INVALID');
expectCode(() => validateResult(withResultSha({
  ...directResult,
  executionStatus: 'TECHNICALLY_BLOCKED',
  verdictBasis: 'TECHNICAL_CONSTRAINT',
  technicalFailureCode: 'DEVICE_OFFLINE',
}), { executionId, understanding, plan: revisedPlan, evidence }), 'RESULT_SEMANTICS_INVALID');
const knowledgeResult = withResultSha({
  ...directResult,
  verdictBasis: 'KNOWLEDGE_SUPPORTED',
  summary: '当前现象符合适用知识',
  requirementFindings: [{ ...directResult.requirementFindings[0], knowledgeRefs: ['assessment-001'] }],
});
assert.strictEqual(validateResult(knowledgeResult, { executionId, understanding, evidence, knowledgeAssessments }), knowledgeResult);
const failResult = withResultSha({
  ...directResult,
  verdict: 'FAIL',
  summary: '播放入口不符合明确要求',
  requirementFindings: [{ requirementId: 'req-001', status: 'NOT_SATISFIED', evidenceRefs: ['screenshots/observe-001.png'], knowledgeRefs: [] }],
});
assert.strictEqual(validateResult(failResult, { executionId, understanding, plan: revisedPlan, evidence, verdictReviews, knowledgeQueries }), failResult);
const newerPlan = withPlanSha({ ...revisedPlan, revision: revisedPlan.revision + 1, reason: '复核后再次修订计划' });
expectCode(() => validateResult(failResult, {
  executionId, understanding, plan: newerPlan, evidence, verdictReviews, knowledgeQueries,
}), 'RESULT_REVIEW_REQUIRED');
expectCode(() => validateResult(failResult, {
  executionId, understanding: { ...understanding, revision: understanding.revision + 1 }, plan: revisedPlan,
  evidence, verdictReviews, knowledgeQueries,
}), 'RESULT_REVIEW_REQUIRED');
const inconclusiveResult = withResultSha({
  schemaVersion: 2,
  executionId,
  verdict: 'INCONCLUSIVE',
  executionStatus: 'COMPLETED',
  verdictBasis: 'INSUFFICIENT_EVIDENCE',
  summary: '现有信息不足以判断',
  requirementFindings: [{ requirementId: 'req-001', status: 'UNRESOLVED', evidenceRefs: [], knowledgeRefs: [], reason: '目标状态无法稳定观察' }],
  uncertainties: ['目标状态无法稳定观察'],
  technicalFailureCode: null,
});
assert.strictEqual(validateResult(inconclusiveResult, { executionId, understanding, plan: revisedPlan, evidence, verdictReviews: [{ ...verdictReviews[0], requestedVerdict: 'INCONCLUSIVE', remainingUncertainties: ['目标状态无法稳定观察'] }], knowledgeQueries }), inconclusiveResult);
const blockedResult = withResultSha({
  ...inconclusiveResult,
  verdict: 'BLOCKED',
  executionStatus: 'TECHNICALLY_BLOCKED',
  verdictBasis: 'TECHNICAL_CONSTRAINT',
  summary: '自动化连接不可用',
  requirementFindings: [{ requirementId: 'req-001', status: 'BLOCKED', evidenceRefs: [], knowledgeRefs: [] }],
  technicalFailureCode: 'AUTOMATION_CONNECTION_LOST',
});
assert.strictEqual(validateResult(blockedResult, { executionId, understanding }), blockedResult);
expectCode(() => validateResult(knowledgeResult, { executionId, understanding, evidence }), 'RESULT_KNOWLEDGE_INVALID');
expectCode(() => validateResult(failResult, { executionId, understanding, evidence }), 'RESULT_REVIEW_REQUIRED');
expectCode(() => validateResult(failResult, {
  executionId, understanding, plan: revisedPlan, evidence, verdictReviews, knowledgeQueries: [{ ref: 'query-001', executionId: 'execution-other' }],
}), 'RESULT_REVIEW_REQUIRED');
expectCode(() => validateResult(directResult, {
  executionId,
  understanding,
  evidence: [{ ...evidence[0], executionId: 'execution-other' }],
}), 'RESULT_EVIDENCE_INVALID');
expectCode(() => validateResult(withResultSha({
  ...directResult,
  requirementFindings: [{ ...directResult.requirementFindings[0], requirementId: 'req-missing' }],
}), { executionId, understanding, evidence }), 'RESULT_REFERENCE_INVALID');
expectCode(() => validateResult(withResultSha({
  ...directResult,
  requirementFindings: [null],
}), { executionId, understanding, evidence }), 'RESULT_INVALID');
const assumedUnderstanding = {
  ...understanding,
  requirements: [{ id: 'req-assumed', text: 'Agent 假设的附加要求', basis: 'assumed', sourceRefs: [] }],
};
const assumedFail = withResultSha({
  ...failResult,
  requirementFindings: [{ requirementId: 'req-assumed', status: 'NOT_SATISFIED', evidenceRefs: ['screenshots/observe-001.png'], knowledgeRefs: [] }],
});
expectCode(() => validateResult(assumedFail, {
  executionId, understanding: assumedUnderstanding, plan: revisedPlan, evidence, verdictReviews, knowledgeQueries,
}), 'RESULT_INVALID');

const metrics = {
  schemaVersion: 2,
  executionId,
  verdict: 'PASS',
  executionStatus: 'COMPLETED',
  elapsedMs: 1234,
  warmSessionGeneration: 1,
  warmSessionReused: false,
  recoveryCount: 0,
  timeLimitStopped: false,
  counts: { actions: 2, observations: 3, preparationActions: 1, knowledgeQueries: 0, knowledgeAssessments: 0, planRevisions: 1 },
};
assert.strictEqual(validateMetrics(metrics, { executionId }), metrics);
expectCode(() => validateMetrics({ ...metrics, counts: { ...metrics.counts, actions: -1 } }, { executionId }), 'METRICS_INVALID');

const completionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-completion-contract-'));
const completionArtifactPaths = completionPaths(completionRoot);
const execution = {
  schemaVersion: 3,
  executionId,
  batchId: 'batch-contract-001',
  platform: 'harmony',
  finalized: true,
  implementationSha: 'implementation-0123456789abcdef',
  contractSha: currentCase.contractSha,
  batchContractSha: `batch-contract-${'a'.repeat(24)}`,
};
const snapshot = { identity: { caseKey: currentCase.identity.caseKey } };
fs.mkdirSync(path.dirname(completionArtifactPaths.agentResult), { recursive: true });
fs.writeFileSync(completionArtifactPaths.execution, JSON.stringify(execution));
fs.writeFileSync(completionArtifactPaths.snapshot, JSON.stringify(snapshot));
fs.writeFileSync(completionArtifactPaths.result, JSON.stringify(directResult));
fs.writeFileSync(completionArtifactPaths.metrics, JSON.stringify(metrics));
fs.writeFileSync(completionArtifactPaths.agentResult, JSON.stringify({ schemaVersion: 2, executionId }));
const completion = {
  schemaVersion: 2,
  executionId,
  batchId: execution.batchId,
  caseKey: currentCase.identity.caseKey,
  platform: 'harmony',
  completionSource: 'framework',
  implementationSha: execution.implementationSha,
  contractSha: execution.contractSha,
  batchContractSha: execution.batchContractSha,
  resultSchemaVersion: 2,
  metricsSchemaVersion: 2,
  verdict: 'PASS',
  executionStatus: 'COMPLETED',
  sessionReleased: true,
  resultSha256: sha256File(completionArtifactPaths.result),
  metricsSha256: sha256File(completionArtifactPaths.metrics),
  agentResultSha256: sha256File(completionArtifactPaths.agentResult),
  validationSha256: null,
};
assert.strictEqual(validateCompletionBinding(completion, completion), completion);
assert.strictEqual(validatePublishedCompletion(completionRoot, completion, { execution, result: directResult, metrics, snapshot }), completion);
assert.strictEqual(completionDisplayResult(directResult, completion).verdict, 'PASS');
assert.throws(() => validateCompletionBinding({ ...completion, schemaVersion: 99 }, completion), /Unsupported execution completion schema/);
assert.throws(() => validateCompletionBinding({ ...completion, completionSource: 'unknown' }, { ...completion, completionSource: 'unknown' }), /source is invalid/);
assert.throws(() => validateCompletionBinding({ ...completion, implementationSha: null }, { ...completion, implementationSha: null }), /implementation binding is invalid/);
fs.appendFileSync(completionArtifactPaths.metrics, '\n');
assert.throws(() => validatePublishedCompletion(completionRoot, completion, { execution, result: directResult, metrics, snapshot }), /artifact hash mismatch/);
fs.rmSync(completionRoot, { recursive: true, force: true });

console.log('contract passed');
