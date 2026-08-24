'use strict';

const fs = require('fs');
const path = require('path');
const { createCaseContract, sourceSha, validateCaseContract } = require('../execution/contracts/case-contract');
const { validateMetrics, validateResult, withResultSha } = require('../execution/contracts/result-contract');
const { completionPaths, sha256File, validatePublishedCompletion } = require('../lib/completion-contract');
const { buildExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');
const { withPlanSha, validatePlan } = require('../lib/plan-contract');
const { confirmEnvironment, createExecutionRequest } = require('../lib/run-control');
const { validateUnderstanding } = require('../lib/understanding-contract');

const TEST_WORKSPACE_TYPE = 'mobile-ai-visual-test-test-workspace';
const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertTestRoot(root) {
  if (process.env.MAVT_SELF_TEST !== '1') throw new Error('CURRENT_FIXTURE_TEST_ONLY: MAVT_SELF_TEST=1 is required');
  const markerPath = path.join(root, 'workspace.json');
  const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null;
  if (marker?.type !== TEST_WORKSPACE_TYPE || marker.testOnly !== true) {
    throw new Error('CURRENT_FIXTURE_TEST_ONLY: target must be an explicit test workspace');
  }
}

function createTestWorkspace(root) {
  if (process.env.MAVT_SELF_TEST !== '1') throw new Error('CURRENT_FIXTURE_TEST_ONLY: MAVT_SELF_TEST=1 is required');
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw new Error('CURRENT_FIXTURE_TEST_ONLY: test workspace root must be empty');
  writeJson(path.join(root, 'workspace.json'), { schemaVersion: 1, type: TEST_WORKSPACE_TYPE, testOnly: true });
  fs.mkdirSync(path.join(root, 'cases'));
  return root;
}

function createTestExecutionRequest(root, batchId, binding, targets, options = {}) {
  assertTestRoot(root);
  const now = options.now || '2026-08-13T10:00:00.000Z';
  confirmEnvironment({
    workspaceRoot: root,
    binding,
    probe: { schemaVersion: 1, platform: binding.platform, ready: true, devices: [{ id: binding.deviceId }] },
    userConfirmation: options.environmentConfirmation || `确认测试环境 ${binding.deviceId}`,
    now,
  });
  return createExecutionRequest({
    workspaceRoot: root,
    batchId,
    mode: options.mode || (targets.length === 1 ? 'SINGLE' : 'BATCH'),
    targets,
    userInstruction: options.userInstruction || `${targets.length === 1 ? '单独' : '批量'}执行测试用例`,
    now,
  });
}

function createCurrentFixture(root, options = {}) {
  assertTestRoot(root);
  const verdict = options.verdict || 'PASS';
  const suffix = String(options.suffix || verdict).toLowerCase();
  const executionId = `execution-current-${suffix}`;
  const sourceText = options.sourceText || `验证当前报告 ${verdict}`;
  const caseKey = `ck-${Buffer.from(suffix).toString('hex').padEnd(12, '0').slice(0, 12)}`;
  const caseJson = createCaseContract({
    caseKey,
    title: options.title || `${verdict} 当前用例`,
    sourceText,
    importPath: `/fixtures/${suffix}.txt`,
  });
  validateCaseContract(caseJson);
  const caseDir = path.join(root, 'cases', `${suffix}__${caseKey}`);
  const runtimeDir = path.join(caseDir, 'platforms', 'harmony');
  const execDir = path.join(runtimeDir, 'executions', executionId);
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJson(path.join(caseDir, 'case.json'), caseJson);
  fs.writeFileSync(path.join(execDir, 'source.snapshot.md'), sourceText);
  writeJson(path.join(execDir, 'case.snapshot.json'), caseJson);

  const sourceRef = { id: 'src-001', sourceSha: sourceSha(sourceText), lineStart: 1, lineEnd: 1, quote: sourceText.split(/\r?\n/)[0] };
  const includePreparation = options.includePreparation === true;
  const understanding = {
    schemaVersion: 1,
    revision: 1,
    summary: `理解 ${verdict} 用例`,
    startConditions: includePreparation ? [{ id: 'start-001', text: '进入用例目标页面', basis: 'implied', sourceRefs: ['src-001'] }] : [],
    requirements: [{ id: 'req-001', text: '验证当前报告结果', basis: 'explicit', sourceRefs: ['src-001'] }],
    sourceRefs: [sourceRef],
    uncertainties: [],
    requirementDispositions: [],
  };
  validateUnderstanding(understanding, { sourceText });
  const plan = withPlanSha({
    schemaVersion: 1,
    revision: 1,
    reason: '建立报告 fixture 检查点',
    checkpoints: [{ id: 'cp-001', goal: '形成可展示结论', requirementRefs: ['req-001'], requiredAction: false }],
  });
  validatePlan(plan, { understanding });
  writeJson(path.join(execDir, 'understanding.json'), understanding);
  writeJson(path.join(execDir, 'plan.json'), plan);

  const prepareEvidenceRef = 'screenshots/prepare-start.png';
  const beforeEvidenceRef = 'screenshots/observe-before.png';
  const evidenceRef = 'screenshots/observe-after.png';
  const evidence = [
    ...(includePreparation ? [{ ref: prepareEvidenceRef, executionId, phase: 'case-prepare', usable: true }] : []),
    ...[beforeEvidenceRef, evidenceRef].map((ref) => ({ ref, executionId, phase: 'case-business', usable: true })),
  ];
  fs.mkdirSync(path.join(execDir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(execDir, 'layouts'), { recursive: true });
  fs.mkdirSync(path.join(execDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(execDir, 'agent'), { recursive: true });
  if (includePreparation) fs.writeFileSync(path.join(execDir, prepareEvidenceRef), FIXTURE_PNG);
  fs.writeFileSync(path.join(execDir, beforeEvidenceRef), FIXTURE_PNG);
  fs.writeFileSync(path.join(execDir, evidenceRef), FIXTURE_PNG);
  fs.writeFileSync(path.join(execDir, 'layouts', 'observe-before.json'), '{}\n');
  fs.writeFileSync(path.join(execDir, 'layouts', 'observe-after.json'), '{}\n');
  fs.writeFileSync(path.join(execDir, 'logs', 'observe-after-errors.txt'), 'fixture observation diagnostics\n');
  const needsEvidence = ['PASS', 'FAIL'].includes(verdict);
  const needsReview = ['FAIL', 'INCONCLUSIVE'].includes(verdict);
  const verdictBasis = verdict === 'BLOCKED'
    ? 'TECHNICAL_CONSTRAINT'
    : verdict === 'INCONCLUSIVE' ? 'INSUFFICIENT_EVIDENCE' : 'DIRECT_EVIDENCE';
  const findingStatus = verdict === 'PASS'
    ? 'SATISFIED'
    : verdict === 'FAIL' ? 'NOT_SATISFIED' : verdict === 'BLOCKED' ? 'BLOCKED' : 'UNRESOLVED';
  const result = withResultSha({
    schemaVersion: 2,
    executionId,
    platform: 'harmony',
    verdict,
    executionStatus: verdict === 'BLOCKED' ? 'TECHNICALLY_BLOCKED' : 'COMPLETED',
    verdictBasis,
    summary: options.summary || `${verdict} 当前报告结论`,
    requirementFindings: [{
      requirementId: 'req-001',
      status: findingStatus,
      evidenceRefs: needsEvidence ? [evidenceRef] : [],
      knowledgeRefs: [],
      ...(findingStatus === 'UNRESOLVED' ? { reason: '目标状态仍不确定' } : {}),
    }],
    uncertainties: options.uncertainties || (verdict === 'INCONCLUSIVE' ? ['目标状态仍不确定'] : []),
    technicalFailureCode: verdict === 'BLOCKED' ? 'AUTOMATION_CONNECTION_LOST' : null,
    startedAt: '2026-08-13T10:00:00.000+08:00',
    endedAt: '2026-08-13T10:00:05.000+08:00',
  });
  const verdictReviews = needsReview ? [{
    executionId, understandingRevision: understanding.revision, planRevision: plan.revision, planSha: plan.planSha,
    requirementRefs: understanding.requirements.map((item) => item.id), queryRefs: ['query-001'], requestedVerdict: verdict,
    sourceRecheck: { sourceRefs: ['src-001'], conclusion: '已重新核对原始要求' },
    currentObservationRefs: [evidenceRef],
    recoveryAttempt: { performed: false, explanation: '报告 fixture 无需执行恢复动作', evidenceRefs: [] },
    remainingUncertainties: verdict === 'INCONCLUSIVE' ? ['目标状态仍不确定'] : [],
  }] : [];
  const knowledgeQueries = needsReview ? [{ ref: 'query-001', executionId, matchCount: 0 }] : [];
  validateResult(result, { executionId, understanding, plan, evidence, verdictReviews, knowledgeQueries });
  const metrics = {
    schemaVersion: 2,
    executionId,
    verdict,
    executionStatus: result.executionStatus,
    elapsedMs: 5000,
    warmSessionGeneration: 1,
    warmSessionReused: options.warmSessionReused === true,
    recoveryCount: options.recoveryCount || 0,
    timeLimitStopped: false,
    counts: { actions: 1, observations: includePreparation ? 3 : 2, preparationActions: 0, knowledgeQueries: needsReview ? 1 : 0, knowledgeAssessments: 0, planRevisions: 1 },
  };
  validateMetrics(metrics, { executionId });
  writeJson(path.join(execDir, 'result.json'), result);
  writeJson(path.join(execDir, 'metrics.json'), metrics);

  const execution = {
    schemaVersion: 3,
    executionId,
    batchId: `batch-${suffix}`,
    platform: 'harmony',
    finalized: true,
    implementationSha: 'implementation-fixture-0123456789abcdef',
    contractSha: caseJson.contractSha,
    batchContractSha: `batch-contract-${'a'.repeat(24)}`,
    executionRequestSha: `execution-request-${'a'.repeat(24)}`,
    interactionPolicy: 'UNATTENDED',
    warmSessionGeneration: 1,
    warmSessionReused: options.warmSessionReused === true,
    recoveryCount: options.recoveryCount || 0,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  };
  writeJson(path.join(execDir, 'execution.json'), execution);
  const authorization = {
    schemaVersion: 1, source: 'agent-plan', executionId, phase: 'case-business', understandingRevision: 1,
    planRevision: 1, checkpointId: 'cp-001', purpose: '打开目标并验证结果', requirementRefs: ['req-001'],
    sourceRefs: ['src-001'], sideEffect: false, authorizationSha: `authorization-${'a'.repeat(24)}`,
  };
  const preparationAuthorization = {
    schemaVersion: 1, source: 'agent-plan', executionId, phase: 'case-prepare', understandingRevision: 1,
    startConditionId: 'start-001', purpose: '确认并建立用例起点', requirementRefs: [], sourceRefs: ['src-001'],
    sideEffect: false, authorizationSha: `authorization-${'b'.repeat(24)}`,
  };
  const action = options.action || { type: 'tap', x: 120, y: 240, target: '目标按钮', coordinateSource: 'visual', targetBounds: [80, 210, 160, 270], coordinateEvidence: '操作前截图中的目标按钮' };
  const timeline = [
    { schemaVersion: 1, executionId, time: result.startedAt, type: 'caseUnderstood', writer: 'agent', phase: 'UNDERSTAND', understandingRevision: 1, sourceRefs: ['src-001'] },
    { schemaVersion: 1, executionId, time: result.startedAt, type: 'planRevised', writer: 'agent', phase: 'UNDERSTAND', planRevision: 1, planSha: plan.planSha, reason: plan.reason },
    ...(includePreparation ? [
      { schemaVersion: 1, executionId, time: '2026-08-13T10:00:00.100+08:00', type: 'operationStarted', writer: 'runtime-core', phase: 'ESTABLISH_START', operationId: 'prepare-start', kind: 'OBSERVE' },
      { schemaVersion: 1, executionId, time: '2026-08-13T10:00:00.200+08:00', type: 'observation', writer: 'observe.sh', phase: 'ESTABLISH_START', operationId: 'prepare-start', scope: 'case-prepare', ref: prepareEvidenceRef, sha256: 'c'.repeat(64), usable: true, warmSessionGeneration: 1, observationPurpose: 'ESTABLISH_START', intent: '确认用例起点', expectedOutcome: '目标页面已就绪', artifacts: { screenshot: prepareEvidenceRef, layout: null, logs: [] }, authorization: preparationAuthorization },
      { schemaVersion: 1, executionId, time: '2026-08-13T10:00:00.300+08:00', type: 'operationCompleted', writer: 'runtime-core', phase: 'ESTABLISH_START', operationId: 'prepare-start', outcome: 'SUCCEEDED' },
    ] : []),
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:00.500+08:00', type: 'operationStarted', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'observe-before', kind: 'OBSERVE' },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:01.000+08:00', type: 'observation', writer: 'observe.sh', phase: 'EXECUTE', operationId: 'observe-before', scope: 'case-business', ref: beforeEvidenceRef, sha256: 'a'.repeat(64), usable: true, warmSessionGeneration: 1, observationPurpose: 'PRE_ACTION', intent: '确认操作前目标位置', expectedOutcome: '目标按钮可见', artifacts: { screenshot: beforeEvidenceRef, layout: 'layouts/observe-before.json', logs: [] }, authorization },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:01.000+08:00', type: 'operationCompleted', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'observe-before', outcome: 'SUCCEEDED' },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:01.500+08:00', type: 'operationStarted', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'action-tap', kind: 'ACTION' },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:02.000+08:00', type: 'actionResult', writer: 'action.sh', phase: 'EXECUTE', operationId: 'action-tap', scope: 'case-business', ok: true, warmSessionGeneration: 1, requestedAction: action, authorization, intent: '打开目标内容', expectedOutcome: '页面展示验证结果', deviceResult: { ok: true } },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:02.000+08:00', type: 'operationCompleted', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'action-tap', outcome: 'SUCCEEDED' },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:02.500+08:00', type: 'operationStarted', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'observe-after', kind: 'OBSERVE' },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:03.000+08:00', type: 'observation', writer: 'observe.sh', phase: 'EXECUTE', operationId: 'observe-after', scope: 'case-business', ref: evidenceRef, sha256: 'b'.repeat(64), usable: true, warmSessionGeneration: 1, observationPurpose: 'POST_ACTION', relatedOperationId: 'action-tap', intent: '确认点击后的现场', expectedOutcome: '页面展示验证结果', artifacts: { screenshot: evidenceRef, layout: 'layouts/observe-after.json', logs: ['logs/observe-after-errors.txt'] }, authorization },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:03.000+08:00', type: 'operationCompleted', writer: 'runtime-core', phase: 'EXECUTE', operationId: 'observe-after', outcome: 'SUCCEEDED' },
    { schemaVersion: 1, executionId, time: '2026-08-13T10:00:03.200+08:00', type: 'checkpointFinding', writer: 'agent', phase: 'EXECUTE', checkpointId: 'cp-001', planRevision: 1, requirementRefs: ['req-001'], evidenceRefs: needsEvidence ? [evidenceRef] : [], finding: `检查点已完成，结果为 ${findingStatus}` },
    ...(needsReview ? [{ schemaVersion: 1, executionId, time: '2026-08-13T10:00:03.500+08:00', type: 'knowledgeQuery', writer: 'knowledge-query', phase: 'INVESTIGATE', queryId: 'query-001', query: { symptom: verdict, keywords: [] }, candidates: [], matchCount: 0 }] : []),
    ...(needsReview ? [{ schemaVersion: 1, executionId, time: result.endedAt, type: 'verdictReview', writer: 'agent', phase: 'CONCLUDE', ...verdictReviews[0], reason: '已完成疑似失败复核' }] : []),
    { schemaVersion: 1, executionId, time: result.endedAt, type: 'result', writer: 'runtime-core', phase: 'FINALIZED', resultSha: result.resultSha, verdict },
  ];
  fs.writeFileSync(path.join(execDir, 'timeline.jsonl'), `${timeline.map((event) => JSON.stringify(event)).join('\n')}\n`);
  if (includePreparation) writeJson(path.join(execDir, 'agent', 'operation-prepare-start.json'), { schemaVersion: 2, kind: 'OBSERVE', request: { operationId: 'prepare-start', purpose: 'ESTABLISH_START', intent: '确认用例起点', expectedOutcome: '目标页面已就绪', authorization: preparationAuthorization }, fact: timeline.find((event) => event.operationId === 'prepare-start' && event.type === 'observation') });
  writeJson(path.join(execDir, 'agent', 'operation-action-tap.json'), { schemaVersion: 2, kind: 'ACTION', request: { operationId: 'action-tap', intent: '打开目标内容', expectedOutcome: '页面展示验证结果', authorization, action }, fact: timeline.find((event) => event.type === 'actionResult') });
  writeJson(path.join(execDir, 'agent', 'operation-observe-before.json'), { schemaVersion: 2, kind: 'OBSERVE', request: { operationId: 'observe-before', purpose: 'PRE_ACTION', intent: '确认操作前目标位置', expectedOutcome: '目标按钮可见', authorization }, fact: timeline.find((event) => event.operationId === 'observe-before' && event.type === 'observation') });
  writeJson(path.join(execDir, 'agent', 'operation-observe-after.json'), { schemaVersion: 2, kind: 'OBSERVE', request: { operationId: 'observe-after', purpose: 'POST_ACTION', relatedOperationId: 'action-tap', intent: '确认点击后的现场', expectedOutcome: '页面展示验证结果', authorization }, fact: timeline.find((event) => event.operationId === 'observe-after' && event.type === 'observation'), deviceResult: { artifacts: { screenshot: evidenceRef, layout: 'layouts/observe-after.json', logs: ['logs/observe-after-errors.txt'] }, app: { foregroundApp: 'com.example.fixture', inTargetApp: true } } });
  if (options.attempts?.length) {
    fs.writeFileSync(path.join(execDir, 'agent', 'attempts.jsonl'), `${options.attempts.map(JSON.stringify).join('\n')}\n`);
  }
  const paths = completionPaths(execDir);
  writeJson(paths.agentResult, { schemaVersion: 2, executionId, fixture: true });
  const artifactManifest = buildExecutionArtifactManifest(execDir, { now: result.endedAt });
  const completion = {
    schemaVersion: 2,
    executionId,
    batchId: execution.batchId,
    caseKey,
    platform: 'harmony',
    completionSource: 'framework',
    implementationSha: execution.implementationSha,
    contractSha: execution.contractSha,
    batchContractSha: execution.batchContractSha,
    resultSchemaVersion: 2,
    metricsSchemaVersion: 2,
    verdict,
    executionStatus: result.executionStatus,
    sessionReleased: true,
    resultSha256: sha256File(paths.result),
    metricsSha256: sha256File(paths.metrics),
    agentResultSha256: sha256File(paths.agentResult),
    artifactManifestSha256: sha256File(paths.artifactManifest),
    validationSha256: null,
  };
  writeJson(paths.completion, completion);
  validatePublishedCompletion(execDir, completion, { execution, result, metrics, snapshot: caseJson });
  return { caseDir, runtimeDir, execDir, execution, result, metrics, completion, caseJson };
}

module.exports = {
  TEST_WORKSPACE_TYPE,
  createCurrentFixture,
  createTestExecutionRequest,
  createTestWorkspace,
};
