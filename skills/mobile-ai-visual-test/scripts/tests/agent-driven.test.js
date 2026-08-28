#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentRequest, createAgentResult } = require('../agent/core');
const { recordSimulatedOperation } = require('./simulated-operation');
const { readAgentStatus } = require('../agent/status');
const { commitAgentTurn } = require('../agent/turn');
const { recoverInternalTransactions } = require('../batch/internal-recovery');
const { executeKnowledgeQuery } = require('../agent/query-knowledge');
const { finalizeWithReview } = require('../agent/finalize');
const {
  changePhase,
  confirmStartObservation,
  createExecution,
  bindAgentRuntime,
  assertCurrentObservationRefs,
  finalizeExecution,
  pendingPostActionObservation,
  recordRuntimeEvent,
  STATE_CHANGING_ACTIONS,
  timelineEvents,
} = require('../execution/core');
const { createCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { validatePlan, withPlanSha } = require('../lib/plan-contract');
const { validateUnderstanding } = require('../lib/understanding-contract');
const { withAuthorizationSha, validatePlanAuthorization } = require('../lib/plan-authorization');
const { sha256File } = require('../lib/execution-evidence');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateAgentRequest, validateAgentResult } = require('../lib/agent-driven-contract');
const { createTestWorkspace } = require('./current-fixture');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const T0 = '2026-08-13T10:00:00.000Z';
const BATCH_CONTRACT_SHA = `batch-contract-${'a'.repeat(24)}`;

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function buildContract() {
  return JSON.parse(childProcess.execFileSync(process.execPath, [
    'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony',
  ], { cwd: repo, env: { ...process.env, MAVT_SELF_TEST: '1' }, encoding: 'utf8' }));
}

function makeExecution(name, sourceText = `验证 ${name} 的目标状态`) {
  const root = path.join(temp, name);
  createTestWorkspace(root);
  fs.mkdirSync(path.join(root, 'knowledge'));
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText, importPath: `/fixtures/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  const runtimeDir = path.join(caseDir, 'platforms', 'harmony');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  const contract = buildContract();
  const executionId = `execution-${name}`;
  const created = createExecution({
    workspaceRoot: root,
    runtimeDir,
    caseJson,
    sourceText,
    executionId,
    batchId: `batch-${name}`,
    platform: 'harmony',
    implementationSha: contract.implementationSha,
    caseExecutorProtocolSha: contract.protocolSha,
    coordinatorProtocolSha: `agent-protocol-${'b'.repeat(16)}`,
    batchContractSha: BATCH_CONTRACT_SHA,
    executionRequestSha: `execution-request-${'a'.repeat(24)}`,
    interactionPolicy: 'UNATTENDED',
    warmSessionGeneration: 1,
    now: T0,
  });
  const runtime = bindAgentRuntime(created.execDir, {
    implementationSha: contract.implementationSha,
    batchId: `batch-${name}`,
    warmSessionGeneration: 1,
    sessionId: `session-${name}`,
    now: T0,
  });
  const item = { root, caseDir, runtimeDir, caseJson, sourceText, contract, runtime, ...created };
  item.request = createAgentRequest({ workspaceRoot: root, execDir: created.execDir, skillContract: contract });
  return item;
}

function understandingFor(item, revision = 1, requirementText = '目标状态符合原文') {
  return {
    schemaVersion: 1,
    revision,
    ...(revision > 1 ? { reason: '现场信息需要修订用例理解' } : {}),
    summary: '验证当前目标状态',
    startConditions: [{ id: 'start-001', text: '目标入口可建立', basis: 'implied', sourceRefs: ['src-001'] }],
    requirements: [{ id: 'req-001', text: requirementText, basis: 'explicit', sourceRefs: ['src-001'] }],
    sourceRefs: [{ id: 'src-001', sourceSha: sourceSha(item.sourceText), lineStart: 1, lineEnd: 1, quote: item.sourceText.split(/\r?\n/)[0] }],
    uncertainties: [],
    requirementDispositions: [],
  };
}

function planFor(revision = 1, checkpoints = ['cp-001']) {
  return withPlanSha({
    schemaVersion: 1,
    revision,
    reason: revision === 1 ? '建立初始动态检查点' : '根据现场修订检查点',
    checkpoints: checkpoints.map((id) => ({ id, goal: `处理 ${id}`, requirementRefs: ['req-001'], requiredAction: false })),
  });
}

function initialTurn(item, checkpoints = ['cp-001']) {
  return {
    schemaVersion: 1,
    turnId: 'turn-initial',
    understanding: understandingFor(item),
    plan: planFor(1, checkpoints),
    facts: [],
  };
}

function prepareAuthorization(item, overrides = {}) {
  return withAuthorizationSha({
    schemaVersion: 1,
    source: 'agent-plan',
    executionId: item.executionId,
    phase: 'case-prepare',
    understandingRevision: 1,
    startConditionId: 'start-001',
    purpose: '建立本用例起点',
    requirementRefs: [],
    sourceRefs: [],
    sideEffect: false,
    ...overrides,
  });
}

function businessAuthorization(item, checkpointId = 'cp-001', overrides = {}) {
  return withAuthorizationSha({
    schemaVersion: 1,
    source: 'agent-plan',
    executionId: item.executionId,
    phase: 'case-business',
    understandingRevision: 1,
    planRevision: 1,
    checkpointId,
    purpose: `处理 ${checkpointId}`,
    requirementRefs: ['req-001'],
    sourceRefs: [],
    sideEffect: false,
    ...overrides,
  });
}

function reviewBinding(item) {
  const currentUnderstanding = readJson(path.join(item.execDir, 'understanding.json'));
  const currentPlan = readJson(path.join(item.execDir, 'plan.json'));
  return {
    understandingRevision: currentUnderstanding.revision,
    planRevision: currentPlan.revision,
    planSha: currentPlan.planSha,
    requirementRefs: currentUnderstanding.requirements.map((entry) => entry.id),
  };
}

function writeEvidence(item, operationId) {
  const ref = `screenshots/${operationId}.png`;
  fs.writeFileSync(path.join(item.execDir, ref), PNG);
  return { ref, sha256: sha256File(path.join(item.execDir, ref)), usable: true };
}

function observe(item, operationId, authorization) {
  return recordSimulatedOperation(item.execDir, { operationId, authorization }, writeEvidence(item, operationId), { now: T0 });
}

function action(item, operationId, authorization, requestedAction = { type: 'wait', ms: 1, reason: '等待页面稳定' }, options = {}) {
  const basis = [...timelineEvents(item.execDir)].reverse().find((entry) => entry.type === 'observation' && entry.usable);
  const actionRequest = { ...requestedAction };
  if (actionRequest.coordinateSource && basis) actionRequest.coordinateArtifactRef = basis.artifacts?.screenshot || basis.ref;
  return recordSimulatedOperation(item.execDir, {
    operationId, authorization, action: actionRequest,
    ...(STATE_CHANGING_ACTIONS.has(actionRequest.type) && basis ? { basisObservationRef: basis.ref } : {}),
  }, { ok: true }, { now: T0, ...options });
}

function establishBusiness(item, checkpoints = ['cp-001']) {
  commitAgentTurn(item.execDir, initialTurn(item, checkpoints), { now: T0 });
  changePhase(item.execDir, 'ESTABLISH_START', '理解和计划已建立', { implementationSha: item.contract.implementationSha, now: T0 });
  const startRef = observe(item, 'prepare-observation', prepareAuthorization(item)).fact.ref;
  confirmStartObservation(item.execDir, startRef, '测试确认当前现场满足起点', { now: T0 });
  changePhase(item.execDir, 'EXECUTE', '起点已确认', { implementationSha: item.contract.implementationSha, now: T0 });
}

function finalizePass(item, evidenceRef) {
  changePhase(item.execDir, 'CONCLUDE', '已有充分证据', { implementationSha: item.contract.implementationSha, now: T0 });
  return finalizeExecution(item.execDir, {
    verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '目标状态符合原文',
    requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: [evidenceRef], knowledgeRefs: [] }],
    uncertainties: [], technicalFailureCode: null,
  }, { implementationSha: item.contract.implementationSha, now: T0 });
}

function knowledgeEntry(id, options = {}) {
  return `# ${id} ${options.title || '目标状态的已知延迟'}

## 适用范围
- App: 测试应用
- Platform: harmony
- Version: 3.2.x
- Page: 目标页
${options.validUntil ? `- Valid until: ${options.validUntil}\n` : ''}
## 可观察现象
${options.symptom || '目标按钮可能延迟出现。'}

## 结论与处理建议
重新观察页面后再形成结论。

## 追溯信息
专项验证记录。
`;
}

process.env.MAVT_SELF_TEST = '1';
const repo = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-driven-'));

// The formal contract exposes only the Agent-controlled execution entrypoints.
const defaultContract = JSON.parse(childProcess.execFileSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony',
], { cwd: repo, encoding: 'utf8' }));
const targetContract = buildContract();
assert.strictEqual(defaultContract.schemaVersion, 2);
assert.strictEqual(targetContract.schemaVersion, 2);
assert.strictEqual(targetContract.profile, undefined);
for (const relative of [
  'scripts/lib/action-common.sh',
  'scripts/execution/resolve-execution-environment.js',
  'scripts/lib/startup-display.js',
  'scripts/probe-env.sh',
  'scripts/prepare-env.sh',
]) assert.strictEqual(targetContract.implementationFiles.includes(relative), true, `${relative} must affect implementationSha`);
for (const relative of [
  'scripts/lib/execution-reader.js',
  'scripts/report/report-service.js',
  'scripts/report/renderer-manifest.js',
]) assert.strictEqual(targetContract.implementationFiles.includes(relative), false, `${relative} must not block an active execution`);
assert.deepStrictEqual(defaultContract.allowedEntrypoints, targetContract.allowedEntrypoints);
assert.strictEqual(targetContract.allowedEntrypoints.includes('scripts/execute-next-work.js'), false);
assert.strictEqual(targetContract.allowedEntrypoints.some((entry) => entry.includes('batch') || entry.includes('restart') || entry.includes('/adapters/')), false);
for (const relative of [...targetContract.requiredResources, ...targetContract.allowedEntrypoints]) assert.ok(fs.existsSync(path.join(repo, relative)), relative);
for (const relative of targetContract.implementationFiles) {
  assert.strictEqual(/execute-next-work|execution-reducer|get-next-work/.test(relative), false, relative);
}
const forbiddenContract = childProcess.spawnSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony',
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '' } });
assert.strictEqual(forbiddenContract.status, 0);
const protocolRoot = path.join(temp, 'protocol-root');
fs.cpSync(repo, protocolRoot, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) });
fs.unlinkSync(path.join(protocolRoot, 'references', 'agent-execution.md'));
const missingResource = childProcess.spawnSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony', '--skill-root', protocolRoot,
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '1' } });
assert.notStrictEqual(missingResource.status, 0);
assert.match(missingResource.stderr, /AGENT_PROTOCOL_MISMATCH/);
fs.copyFileSync(path.join(repo, 'references', 'agent-execution.md'), path.join(protocolRoot, 'references', 'agent-execution.md'));
const implementationBefore = JSON.parse(childProcess.execFileSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony', '--skill-root', protocolRoot,
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '1' } }));
fs.appendFileSync(path.join(protocolRoot, 'scripts', 'agent', 'status.js'), '\n// implementation digest test\n');
const implementationAfter = JSON.parse(childProcess.execFileSync(process.execPath, [
  'scripts/build-agent-contract.js', '--role', 'case-executor', '--platform', 'harmony', '--skill-root', protocolRoot,
], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAVT_SELF_TEST: '1' } }));
assert.strictEqual(implementationBefore.protocolSha, implementationAfter.protocolSha);
assert.notStrictEqual(implementationBefore.implementationSha, implementationAfter.implementationSha);
expectCode(() => validateAgentRequest({
  ...makeExecution('tampered-contract-request').request,
  skillContract: { ...targetContract, allowedEntrypoints: [...targetContract.allowedEntrypoints, 'scripts/run-case.js'] },
}), 'AGENT_PROTOCOL_MISMATCH');

// Request/result freeze source, execution, batch, implementation, generation, and paths.
const requestCase = makeExecution('request-contract');
const request = createAgentRequest({ workspaceRoot: requestCase.root, execDir: requestCase.execDir, skillContract: requestCase.contract });
assert.strictEqual(validateAgentRequest(request), request);
assert.strictEqual(request.sourcePath, path.join(fs.realpathSync(requestCase.execDir), 'source.snapshot.md'));
assert.strictEqual(request.warmSessionGeneration, 1);
assert.strictEqual(request.executionPolicy.maxDurationMs, 30 * 60 * 1000);
assert.strictEqual(request.agentContractPath, path.join(fs.realpathSync(requestCase.execDir), 'agent', 'contract.json'));
const runtimeContract = readJson(request.agentContractPath);
assert.strictEqual(runtimeContract.contractSha, request.agentContractSha);
assert.deepStrictEqual(runtimeContract.schemas.understand.basis, ['assumed', 'explicit', 'implied']);
assert.match(runtimeContract.commands.understand, /--request-json/);
assert.match(runtimeContract.commands.step, /--request-json/);
assert.match(runtimeContract.commands.conclude, /--request-json/);
for (const hidden of ['action', 'observe', 'commitTurn', 'phase', 'finalize', 'result']) {
  assert.strictEqual(runtimeContract.commands[hidden], undefined, hidden);
}
assert.ok(runtimeContract.schemas.runtimeState.required.includes('frameworkRecoveryPending'));
assert.ok(runtimeContract.schemas.runtimeState.required.includes('activeCheckpointRef'));
assert.match(runtimeContract.commands.requestRecovery, /--request-json/);
assert.match(runtimeContract.behavior.state, /successful responses/);
assert.match(runtimeContract.behavior.planRevision, /do not create plan revisions/);
assert.match(runtimeContract.schemas.conclude.knowledgeRule, /direct-evidence PASS/);
assert.deepStrictEqual(request.skillContract.requiredResources, ['SKILL.md', 'references/agent-execution.md', 'references/knowledge.md']);
assert.deepStrictEqual(runtimeContract.schemas.understand.generated, [
  'schemaVersion', 'turnId', 'understanding.revision', 'understanding.sourceRefs', 'statement.sourceRefs', 'plan.revision', 'plan.planSha',
]);
assert.ok(runtimeContract.schemas.step.generated.includes('operationId'));
assert.ok(runtimeContract.schemas.step.generated.includes('authorization'));
assert.ok(runtimeContract.schemas.conclude.generated.includes('verdictReview'));
for (const forbidden of ['preconditionPlan', 'preconditionInputs', 'history', 'timeline', 'screenshots']) assert.strictEqual(forbidden in request, false);
expectCode(() => validateAgentRequest({ ...request, warmSessionGeneration: 2 }), 'AGENT_REQUEST_INVALID');
expectCode(() => validateAgentRequest({ ...request, requestSha: request.requestSha, history: [] }), 'AGENT_REQUEST_CONTEXT_FORBIDDEN');
const rootsCannotBeOverridden = createAgentRequest({
  workspaceRoot: requestCase.root, execDir: requestCase.execDir, skillContract: requestCase.contract,
  knowledgeRoots: ['/tmp/foreign-skill-knowledge', '/tmp/foreign-workspace-knowledge'],
});
assert.deepStrictEqual(rootsCannotBeOverridden.knowledgeRoots, [path.join(repo, 'knowledge'), path.join(fs.realpathSync(requestCase.root), 'knowledge')]);
const changedRuntime = { ...readJson(path.join(requestCase.execDir, 'agent', 'runtime.json')), warmSessionGeneration: 2 };
writeJsonAtomic(path.join(requestCase.execDir, 'agent', 'runtime.json'), changedRuntime);
expectCode(() => createAgentRequest({ workspaceRoot: requestCase.root, execDir: requestCase.execDir, skillContract: requestCase.contract }), 'AGENT_REQUEST_BINDING_MISMATCH');
writeJsonAtomic(path.join(requestCase.execDir, 'agent', 'runtime.json'), requestCase.runtime);
const helpResult = childProcess.spawnSync(process.execPath, ['scripts/agent/status.js', '--help'], { cwd: repo, encoding: 'utf8' });
assert.strictEqual(helpResult.status, 0);
assert.match(helpResult.stdout, /--exec-dir/);
const rejectedCli = childProcess.spawnSync(process.execPath, ['scripts/agent/status.js', '--exec-dir', requestCase.execDir, '--unknown'], { cwd: repo, encoding: 'utf8' });
assert.notStrictEqual(rejectedCli.status, 0);
assert.strictEqual(JSON.parse(rejectedCli.stderr).code, 'AGENT_STATUS_CLI_INVALID');
assert.strictEqual(fs.readFileSync(path.join(requestCase.execDir, 'agent', 'attempts.jsonl'), 'utf8').trim().split(/\r?\n/).length, 1);

// Plan authorization validates current references without evaluating their semantic quality.
const authorizationCase = makeExecution('authorization');
commitAgentTurn(authorizationCase.execDir, initialTurn(authorizationCase), { now: T0 });
changePhase(authorizationCase.execDir, 'ESTABLISH_START', '准备起点', { implementationSha: authorizationCase.contract.implementationSha, now: T0 });
assert.strictEqual(validatePlanAuthorization(prepareAuthorization(authorizationCase), {
  execution: readJson(path.join(authorizationCase.execDir, 'execution.json')),
  understanding: readJson(path.join(authorizationCase.execDir, 'understanding.json')),
  plan: readJson(path.join(authorizationCase.execDir, 'plan.json')),
}).phase, 'case-prepare');
assert.strictEqual(validatePlanAuthorization(prepareAuthorization(authorizationCase, { sideEffect: true }), {
  execution: readJson(path.join(authorizationCase.execDir, 'execution.json')),
  understanding: readJson(path.join(authorizationCase.execDir, 'understanding.json')),
  plan: readJson(path.join(authorizationCase.execDir, 'plan.json')),
}).sideEffect, true);
const authorizationStartRef = observe(authorizationCase, 'prepare-own-evidence', prepareAuthorization(authorizationCase)).fact.ref;
confirmStartObservation(authorizationCase.execDir, authorizationStartRef, '测试确认当前现场满足起点', { now: T0 });
changePhase(authorizationCase.execDir, 'EXECUTE', '开始业务执行', { implementationSha: authorizationCase.contract.implementationSha, now: T0 });
expectCode(() => validatePlanAuthorization(businessAuthorization(authorizationCase, 'cp-missing'), {
  execution: readJson(path.join(authorizationCase.execDir, 'execution.json')),
  understanding: readJson(path.join(authorizationCase.execDir, 'understanding.json')),
  plan: readJson(path.join(authorizationCase.execDir, 'plan.json')),
}), 'PLAN_AUTHORIZATION_REFERENCE_INVALID');
expectCode(() => validatePlanAuthorization(businessAuthorization(authorizationCase, 'cp-001', { planRevision: 2 }), {
  execution: readJson(path.join(authorizationCase.execDir, 'execution.json')),
  understanding: readJson(path.join(authorizationCase.execDir, 'understanding.json')),
  plan: readJson(path.join(authorizationCase.execDir, 'plan.json')),
}), 'PLAN_AUTHORIZATION_STALE');
assert.strictEqual(validatePlanAuthorization(businessAuthorization(authorizationCase, 'cp-001', { sideEffect: true }), {
  execution: readJson(path.join(authorizationCase.execDir, 'execution.json')),
  understanding: readJson(path.join(authorizationCase.execDir, 'understanding.json')),
  plan: readJson(path.join(authorizationCase.execDir, 'plan.json')),
}).sideEffect, true);
const sideEffectAuthorization = businessAuthorization(authorizationCase, 'cp-001', { sideEffect: true, sourceRefs: ['src-001'] });
assert.strictEqual(validatePlanAuthorization(sideEffectAuthorization, {
  execution: readJson(path.join(authorizationCase.execDir, 'execution.json')),
  understanding: readJson(path.join(authorizationCase.execDir, 'understanding.json')),
  plan: readJson(path.join(authorizationCase.execDir, 'plan.json')),
}).sideEffect, true);

// Investigation cannot bypass the per-case start establishment lifecycle.
const startGateCase = makeExecution('start-gate-investigate');
commitAgentTurn(startGateCase.execDir, initialTurn(startGateCase), { now: T0 });
changePhase(startGateCase.execDir, 'ESTABLISH_START', '准备建立起点', { implementationSha: startGateCase.contract.implementationSha, now: T0 });
changePhase(startGateCase.execDir, 'INVESTIGATE', '调查当前暖状态', { implementationSha: startGateCase.contract.implementationSha, now: T0 });
assert.strictEqual(readAgentStatus(startGateCase.execDir, T0).signals.startEstablished, false);
expectCode(() => observe(startGateCase, 'business-before-start', businessAuthorization(startGateCase)), 'START_OBSERVATION_REQUIRED');
const investigatedStartRef = observe(startGateCase, 'prepare-during-investigation', prepareAuthorization(startGateCase)).fact.ref;
assert.strictEqual(readAgentStatus(startGateCase.execDir, T0).signals.startEstablished, false);
confirmStartObservation(startGateCase.execDir, investigatedStartRef, '测试确认调查后的现场满足起点', { now: T0 });
assert.strictEqual(readAgentStatus(startGateCase.execDir, T0).signals.startEstablished, true);
changePhase(startGateCase.execDir, 'EXECUTE', '调查后的起点已确认', { implementationSha: startGateCase.contract.implementationSha, now: T0 });
assert.strictEqual(observe(startGateCase, 'business-after-start', businessAuthorization(startGateCase)).fact.usable, true);

const startRecoveryCase = makeExecution('start-recovery-action');
commitAgentTurn(startRecoveryCase.execDir, initialTurn(startRecoveryCase), { now: T0 });
changePhase(startRecoveryCase.execDir, 'ESTABLISH_START', '准备未登录起点', { implementationSha: startRecoveryCase.contract.implementationSha, now: T0 });
observe(startRecoveryCase, 'observe-logged-in', prepareAuthorization(startRecoveryCase));
executeKnowledgeQuery({
  execDir: startRecoveryCase.execDir,
  queryId: 'query-start-recovery',
  query: { symptom: '当前已登录但用例要求未登录', keywords: ['登录态', '退出登录', '起点恢复'] },
  now: T0,
});
assert.strictEqual(readJson(path.join(startRecoveryCase.execDir, 'execution.json')).phase, 'ESTABLISH_START');
const startRecoveryAction = action(startRecoveryCase, 'logout-current-account', prepareAuthorization(startRecoveryCase, { sideEffect: true }), {
  type: 'tap', target: '退出登录', x: 0, y: 0, coordinateSource: 'visual', targetBounds: [0, 0, 0, 0], coordinateEvidence: '当前页面退出登录按钮', reason: '建立原文明示的未登录起点',
});
assert.strictEqual(startRecoveryAction.fact.scope, 'case-prepare');
assert.strictEqual(startRecoveryAction.fact.ok, true);

const optionalStartCase = makeExecution('optional-start-condition');
const optionalStartTurn = initialTurn(optionalStartCase);
optionalStartTurn.understanding.startConditions = [];
commitAgentTurn(optionalStartCase.execDir, optionalStartTurn, { now: T0 });
const optionalStartAuthorization = prepareAuthorization(optionalStartCase);
delete optionalStartAuthorization.startConditionId;
delete optionalStartAuthorization.authorizationSha;
const optionalStartRef = observe(optionalStartCase, 'observe-without-start-condition', optionalStartAuthorization).fact.ref;
confirmStartObservation(optionalStartCase.execDir, optionalStartRef, '无显式起点条件时确认当前现场', { now: T0 });
assert.strictEqual(readJson(path.join(optionalStartCase.execDir, 'execution.json')).phase, 'ESTABLISH_START');
assert.strictEqual(observe(optionalStartCase, 'observe-business-with-auto-phase', businessAuthorization(optionalStartCase)).fact.usable, true);
assert.strictEqual(readJson(path.join(optionalStartCase.execDir, 'execution.json')).phase, 'EXECUTE');

// Operation retry resumes an open operation and rejects a changed authorization.
const operationCase = makeExecution('operation-recovery');
establishBusiness(operationCase);
const operationAuthorization = businessAuthorization(operationCase);
assert.throws(() => action(operationCase, 'action-interrupted', operationAuthorization, undefined, { interruptAfter: 'begin' }), /MAVT_AGENT_OPERATION_INTERRUPTED/);
assert.strictEqual(readAgentStatus(operationCase.execDir, T0).signals.mayConclude, false);
expectCode(() => commitAgentTurn(operationCase.execDir, {
  schemaVersion: 1, turnId: 'turn-during-operation-recovery',
  facts: [{ factId: 'reflection-during-operation-recovery', type: 'reflection', reason: '不得越过待恢复操作提交判断' }],
}), 'EXECUTION_OPERATION_RECOVERY_REQUIRED');
expectCode(() => executeKnowledgeQuery({
  execDir: operationCase.execDir, queryId: 'query-during-operation-recovery',
  query: { symptom: '不得在操作恢复期间查询', keywords: [] }, now: T0,
}), 'EXECUTION_OPERATION_RECOVERY_REQUIRED');
expectCode(() => action(operationCase, 'action-interrupted', businessAuthorization(operationCase, 'cp-001', { purpose: '改变请求' })), 'AGENT_OPERATION_BINDING_MISMATCH');
assert.strictEqual(action(operationCase, 'action-interrupted', operationAuthorization).recovered, true);
assert.strictEqual(commitAgentTurn(operationCase.execDir, {
  schemaVersion: 1, turnId: 'turn-after-operation-recovery',
  facts: [{ factId: 'reflection-after-operation-recovery', type: 'reflection', reason: '恢复完成后允许继续判断' }],
}).turnId, 'turn-after-operation-recovery');
assert.strictEqual(action(operationCase, 'action-interrupted', operationAuthorization).idempotent, true);
expectCode(() => action(operationCase, 'action-interrupted', businessAuthorization(operationCase, 'cp-001', { purpose: '完成后改变请求' })), 'AGENT_OPERATION_BINDING_MISMATCH');
const staleRuntime = { ...readJson(path.join(operationCase.execDir, 'agent', 'runtime.json')), warmSessionGeneration: 2 };
writeJsonAtomic(path.join(operationCase.execDir, 'agent', 'runtime.json'), staleRuntime);
expectCode(() => action(operationCase, 'action-stale-generation', operationAuthorization), 'AGENT_REQUEST_BINDING_MISMATCH');
writeJsonAtomic(path.join(operationCase.execDir, 'agent', 'runtime.json'), operationCase.runtime);
assert.throws(() => action(operationCase, 'action-after-fact', operationAuthorization, undefined, { interruptAfter: 'fact' }), /MAVT_OPERATION_INTERRUPTED/);
assert.strictEqual(timelineEvents(operationCase.execDir).filter((entry) => entry.type === 'actionResult' && entry.operationId === 'action-after-fact').length, 1);
assert.strictEqual(action(operationCase, 'action-after-fact', operationAuthorization).recovered, true);
assert.strictEqual(timelineEvents(operationCase.execDir).filter((entry) => entry.type === 'actionResult' && entry.operationId === 'action-after-fact').length, 1);

// Agent turn prevalidates the whole turn and recovers idempotently by turnId/factId.
const unsignedPlanCase = makeExecution('unsigned-plan');
const unsignedPlanTurn = initialTurn(unsignedPlanCase);
delete unsignedPlanTurn.plan.planSha;
const unsignedPlanResult = commitAgentTurn(unsignedPlanCase.execDir, unsignedPlanTurn, { now: T0 });
assert.match(unsignedPlanResult.turn.plan.planSha, /^plan-[0-9a-f]{24}$/);
assert.strictEqual(readJson(path.join(unsignedPlanCase.execDir, 'plan.json')).planSha, unsignedPlanResult.turn.plan.planSha);

const emptyInitialCase = makeExecution('empty-initial-turn');
expectCode(() => commitAgentTurn(emptyInitialCase.execDir, {
  schemaVersion: 1,
  turnId: 'turn-empty-initial',
  understanding: { schemaVersion: 1, revision: 1, summary: '暂未提取', sourceRefs: [], startConditions: [], requirements: [], uncertainties: [] },
  plan: { schemaVersion: 1, revision: 1, reason: '暂未建立', checkpoints: [] },
  facts: [],
}), 'AGENT_TURN_NOT_EXECUTABLE');

const turnCase = makeExecution('turn-atomic');
const invalidTurn = initialTurn(turnCase);
invalidTurn.plan = planFor(1, ['cp-invalid']);
invalidTurn.plan.checkpoints[0].requirementRefs = ['req-missing'];
invalidTurn.plan = withPlanSha(invalidTurn.plan);
expectCode(() => commitAgentTurn(turnCase.execDir, invalidTurn), 'PLAN_INVALID');
assert.strictEqual(fs.existsSync(path.join(turnCase.execDir, 'understanding.json')), false);
const validTurn = initialTurn(turnCase);
assert.throws(() => commitAgentTurn(turnCase.execDir, validTurn, { interruptAfter: 'understanding', now: T0 }), /MAVT_AGENT_TURN_INTERRUPTED/);
assert.deepStrictEqual(readAgentStatus(turnCase.execDir, T0).turnRecoveries.map((entry) => entry.turnId), ['turn-initial']);
expectCode(() => commitAgentTurn(turnCase.execDir, {
  schemaVersion: 1, turnId: 'turn-overtake', facts: [{ factId: 'reflection-overtake', type: 'reflection', reason: '不应越过冻结 turn' }],
}), 'AGENT_TURN_RECOVERY_REQUIRED');
expectCode(() => changePhase(turnCase.execDir, 'ESTABLISH_START', '不应越过冻结 turn', {
  implementationSha: turnCase.contract.implementationSha, now: T0,
}), 'AGENT_TURN_RECOVERY_REQUIRED');
const recoveredTurn = recoverInternalTransactions(turnCase.execDir, { now: T0 });
assert.deepStrictEqual(recoveredTurn.recovered, [{ type: 'turn', id: validTurn.turnId }]);
assert.deepStrictEqual(readAgentStatus(turnCase.execDir, T0).turnRecoveries, []);
assert.strictEqual(commitAgentTurn(turnCase.execDir, validTurn).idempotent, true);
expectCode(() => commitAgentTurn(turnCase.execDir, { ...validTurn, facts: [{ factId: 'reflection-001', type: 'reflection', reason: '改变同一 turn' }] }), 'AGENT_TURN_BINDING_MISMATCH');

changePhase(turnCase.execDir, 'ESTABLISH_START', '验证并发 revision', { implementationSha: turnCase.contract.implementationSha, now: T0 });
const revisionTwo = understandingFor(turnCase, 2, '修订后的目标状态符合原文');
const planTwo = planFor(2, ['cp-002']);
const revisionTurn = { schemaVersion: 1, turnId: 'turn-revision-two', understanding: revisionTwo, plan: planTwo, facts: [] };
assert.throws(() => commitAgentTurn(turnCase.execDir, revisionTurn, { interruptAfter: 'plan', now: T0 }), /MAVT_AGENT_TURN_INTERRUPTED/);
assert.strictEqual(commitAgentTurn(turnCase.execDir, revisionTurn, { now: T0 }).committed.includes('plan'), true);
expectCode(() => commitAgentTurn(turnCase.execDir, {
  schemaVersion: 1, turnId: 'turn-stale-revision', understanding: understandingFor(turnCase, 2), facts: [],
}), 'UNDERSTANDING_REVISION_STALE');

// Dynamic loop supports fewer steps, extra steps, zero-action checkpoints, and plan correction.
const fewer = makeExecution('fewer-steps');
establishBusiness(fewer, ['cp-001', 'cp-002']);
const fewerEvidence = observe(fewer, 'fewer-business', businessAuthorization(fewer, 'cp-001')).fact.ref;
commitAgentTurn(fewer.execDir, {
  schemaVersion: 1, turnId: 'turn-fewer-finding', facts: [{
    factId: 'finding-fewer', type: 'checkpointFinding', planRevision: 1, checkpointId: 'cp-001',
    requirementRefs: ['req-001'], evidenceRefs: [fewerEvidence], finding: '一次观察已覆盖目标，无需执行第二检查点',
  }],
});
finalizePass(fewer, fewerEvidence);
assert.strictEqual(timelineEvents(fewer.execDir).filter((entry) => entry.type === 'actionResult').length, 0);

const extra = makeExecution('extra-step');
establishBusiness(extra);
expectCode(() => action(extra, 'invalid-action', businessAuthorization(extra), { type: 'tap', x: 10, target: '缺少 y 的非法动作' }), 'ACTION_CONTRACT_INVALID');
action(extra, 'corrected-action-parameters', businessAuthorization(extra), { type: 'tap', x: 10, y: 10, target: '修正后的目标', coordinateSource: 'visual', targetBounds: [0, 0, 20, 20], coordinateEvidence: '当前截图目标区域' });
expectCode(() => action(extra, 'guarded-second-tap', businessAuthorization(extra), { type: 'tap', x: 12, y: 12, target: '未观察前的第二个目标', coordinateSource: 'visual', targetBounds: [0, 0, 20, 20], coordinateEvidence: '旧截图目标区域' }), 'POST_ACTION_OBSERVATION_REQUIRED');
expectCode(() => changePhase(extra.execDir, 'CONCLUDE', '尚未完成动作后观察'), 'POST_ACTION_OBSERVATION_REQUIRED');
assert.strictEqual(readAgentStatus(extra.execDir, T0).signals.mayConclude, false);
action(extra, 'extra-action-001', businessAuthorization(extra));
action(extra, 'extra-action-002', businessAuthorization(extra));
const extraEvidence = observe(extra, 'extra-business', businessAuthorization(extra)).fact.ref;
assert.strictEqual(timelineEvents(extra.execDir).filter((entry) => entry.type === 'operationRejected' && entry.operationId === 'guarded-second-tap').length, 1);
assert.strictEqual(readAgentStatus(extra.execDir, T0).signals.mayConclude, true);
finalizePass(extra, extraEvidence);
assert.strictEqual(timelineEvents(extra.execDir).filter((entry) => entry.type === 'actionResult').length, 3);
expectCode(() => commitAgentTurn(extra.execDir, {
  schemaVersion: 1, turnId: 'turn-after-finalize', facts: [{ factId: 'reflection-finalized', type: 'reflection', reason: '不得写入' }],
}), 'EXECUTION_FINALIZED');

// Only a usable observation bound to the pending action clears the post-action guard.
const observationTiming = makeExecution('observation-timing');
establishBusiness(observationTiming);
action(observationTiming, 'timing-tap', businessAuthorization(observationTiming), {
  type: 'tap', x: 0, y: 0, target: '目标入口', coordinateSource: 'visual', targetBounds: [0, 0, 0, 0], coordinateEvidence: '当前截图目标位置',
});
recordSimulatedOperation(observationTiming.execDir, {
  operationId: 'timing-mismatched-observation', authorization: businessAuthorization(observationTiming), relatedOperationId: 'another-action',
}, writeEvidence(observationTiming, 'timing-mismatched-observation'), { now: T0 });
assert.strictEqual(pendingPostActionObservation(timelineEvents(observationTiming.execDir)).operationId, 'timing-tap');
const unusableEvidence = writeEvidence(observationTiming, 'timing-unusable-observation');
recordSimulatedOperation(observationTiming.execDir, {
  operationId: 'timing-unusable-observation', authorization: businessAuthorization(observationTiming), relatedOperationId: 'timing-tap',
}, { ...unusableEvidence, usable: false }, { now: T0 });
assert.strictEqual(pendingPostActionObservation(timelineEvents(observationTiming.execDir)).operationId, 'timing-tap');
expectCode(() => changePhase(observationTiming.execDir, 'CONCLUDE', '错误观察不能清除守卫', { implementationSha: observationTiming.contract.implementationSha, now: T0 }), 'POST_ACTION_OBSERVATION_REQUIRED');
const currentAfterAction = recordSimulatedOperation(observationTiming.execDir, {
  operationId: 'timing-current-observation', authorization: businessAuthorization(observationTiming), relatedOperationId: 'timing-tap',
}, writeEvidence(observationTiming, 'timing-current-observation'), { now: T0 }).fact.ref;
assert.strictEqual(pendingPostActionObservation(timelineEvents(observationTiming.execDir)), null);
const latestObservation = observe(observationTiming, 'timing-latest-observation', businessAuthorization(observationTiming)).fact.ref;
expectCode(() => assertCurrentObservationRefs(timelineEvents(observationTiming.execDir), [currentAfterAction]), 'CURRENT_OBSERVATION_STALE');
assert.strictEqual(assertCurrentObservationRefs(timelineEvents(observationTiming.execDir), [latestObservation]).latest.ref, latestObservation);
recordRuntimeEvent(observationTiming.execDir, {
  type: 'recoveryCompleted', recoveryId: 'recovery-timing', incidentId: null, status: 'SUCCEEDED', warmSessionGeneration: 1,
  requestSha: 'recovery-request-test',
}, { implementationSha: observationTiming.contract.implementationSha, now: T0 });
expectCode(() => assertCurrentObservationRefs(timelineEvents(observationTiming.execDir), [latestObservation]), 'CURRENT_OBSERVATION_STALE');
assert.deepStrictEqual([
  readAgentStatus(observationTiming.execDir, T0).signals.startEstablished,
  readAgentStatus(observationTiming.execDir, T0).postRecoveryObservationRequired,
], [false, true]);
expectCode(() => recordSimulatedOperation(observationTiming.execDir, {
  operationId: 'stale-after-recovery', authorization: prepareAuthorization(observationTiming), basisObservationRef: latestObservation,
  action: { type: 'tap', x: 0, y: 0, target: '旧现场目标', coordinateSource: 'visual', targetBounds: [0, 0, 0, 0], coordinateEvidence: '恢复前截图', coordinateArtifactRef: latestObservation },
}, { ok: true }, { now: T0 }), 'ACTION_BASIS_STALE');
const recoveredStartRef = observe(observationTiming, 'prepare-after-recovery', prepareAuthorization(observationTiming)).fact.ref;
assert.deepStrictEqual([
  readAgentStatus(observationTiming.execDir, T0).signals.startEstablished,
  readAgentStatus(observationTiming.execDir, T0).postRecoveryObservationRequired,
], [false, false]);
confirmStartObservation(observationTiming.execDir, recoveredStartRef, '恢复后重新确认起点', { now: T0 });
assert.strictEqual(readAgentStatus(observationTiming.execDir, T0).signals.startEstablished, true);

const zeroAction = makeExecution('zero-action');
establishBusiness(zeroAction);
const zeroEvidence = observe(zeroAction, 'zero-business', businessAuthorization(zeroAction)).fact.ref;
finalizePass(zeroAction, zeroEvidence);
assert.strictEqual(timelineEvents(zeroAction.execDir).filter((entry) => entry.type === 'actionResult').length, 0);

const swipeCase = makeExecution('swipe-coordinate-contract');
establishBusiness(swipeCase);
expectCode(() => action(swipeCase, 'swipe-without-evidence', businessAuthorization(swipeCase), {
  type: 'swipe', fromX: 1000, fromY: 500, toX: 200, toY: 500, velocity: 800, reason: '缺少坐标证据',
}), 'ACTION_CONTRACT_INVALID');
assert.strictEqual(action(swipeCase, 'swipe-with-evidence', businessAuthorization(swipeCase), {
  type: 'swipe', fromX: 1000, fromY: 500, toX: 200, toY: 500, velocity: 800,
  coordinateSource: 'visual', targetBounds: [0, 0, 1200, 700], coordinateEvidence: '当前截图横滑区域', reason: '依据当前截图横滑',
}).accepted, true);

const corrected = makeExecution('corrected-plan');
establishBusiness(corrected);
changePhase(corrected.execDir, 'INVESTIGATE', '初始计划与现场不符', { implementationSha: corrected.contract.implementationSha, now: T0 });
const revisedPlan = planFor(2, ['cp-revised']);
commitAgentTurn(corrected.execDir, { schemaVersion: 1, turnId: 'turn-plan-corrected', plan: revisedPlan, facts: [] }, { now: T0 });
const revisedAuthorization = businessAuthorization(corrected, 'cp-revised', { planRevision: 2 });
action(corrected, 'corrected-action', revisedAuthorization);
const correctedEvidence = observe(corrected, 'corrected-business', revisedAuthorization).fact.ref;
changePhase(corrected.execDir, 'EXECUTE', '新计划已验证', { implementationSha: corrected.contract.implementationSha, now: T0 });
finalizePass(corrected, correctedEvidence);
assert.strictEqual(readJson(path.join(corrected.execDir, 'plan.json')).revision, 2);

const status = readAgentStatus(corrected.execDir, '2026-08-13T10:05:00.000Z');
assert.deepStrictEqual([status.phase, status.planRevision, status.signals.mayOperate, status.signals.mayConclude], ['FINALIZED', 2, false, false]);
for (const forbidden of ['nextWork', 'action', 'recommendation']) assert.strictEqual(forbidden in status, false);

const timeLimitCase = makeExecution('time-limit-status');
establishBusiness(timeLimitCase);
const timedStatus = readAgentStatus(timeLimitCase.execDir, '2026-08-13T10:30:00.000Z');
assert.deepStrictEqual([timedStatus.timeLimitReached, timedStatus.signals.mayOperate, timedStatus.signals.mayConclude, timedStatus.signals.knowledgeAvailable], [true, false, true, true]);

// Knowledge entrypoint queries the two bound roots and freezes candidate content for Agent assessment.
const knowledgeCase = makeExecution('knowledge-entrypoint');
fs.writeFileSync(path.join(knowledgeCase.root, 'knowledge', 'known.md'), knowledgeEntry('K-known-001'));
fs.writeFileSync(path.join(knowledgeCase.root, 'knowledge', 'expired.md'), knowledgeEntry('K-expired-001', { title: '过期目标状态资料', validUntil: '2026-08-12' }));
establishBusiness(knowledgeCase);
const knowledgeEvidence = observe(knowledgeCase, 'knowledge-business', businessAuthorization(knowledgeCase)).fact.ref;
changePhase(knowledgeCase.execDir, 'INVESTIGATE', '查询目标状态资料', { implementationSha: knowledgeCase.contract.implementationSha, now: T0 });
const queryResult = executeKnowledgeQuery({
  execDir: knowledgeCase.execDir, queryId: 'query-known', query: { platform: 'harmony', version: '3.2.5', page: '目标页', symptom: '目标按钮延迟', keywords: ['重新观察'] }, now: T0,
});
assert.strictEqual(queryResult.matchCount, 2);
assert.strictEqual(executeKnowledgeQuery({ execDir: knowledgeCase.execDir, queryId: 'query-known', query: queryResult.query, now: T0 }).idempotent, true);
const known = queryResult.candidates.find((item) => item.entryId === 'K-known-001');
const expired = queryResult.candidates.find((item) => item.entryId === 'K-expired-001');
const knownSnapshot = path.join(knowledgeCase.execDir, known.snapshotRef);
assert.strictEqual(fs.existsSync(knownSnapshot), true);
assert.strictEqual(sha256File(knownSnapshot), known.contentSha);
assert.deepStrictEqual(known.metadata.platform, ['harmony']);
assert.match(known.applicability, /Version: 3.2.x/);
assert.match(known.traceability, /专项验证记录/);
expectCode(() => commitAgentTurn(knowledgeCase.execDir, {
  schemaVersion: 1, turnId: 'turn-forged-assessment', facts: [{ factId: 'assessment-forged', type: 'knowledgeAssessment', queryId: 'query-known', knowledgeRef: 'assessment-forged', entryId: known.entryId, sourceNamespace: known.sourceNamespace, relativePath: known.relativePath, contentSha: 'f'.repeat(64), assessment: 'APPLICABLE', reason: '伪造内容版本' }],
}), 'EXECUTION_EVENT_REFERENCE_INVALID');
expectCode(() => commitAgentTurn(knowledgeCase.execDir, {
  schemaVersion: 1, turnId: 'turn-expired-assessment', facts: [{ factId: 'assessment-expired', type: 'knowledgeAssessment', queryId: 'query-known', knowledgeRef: 'assessment-expired', entryId: expired.entryId, sourceNamespace: expired.sourceNamespace, relativePath: expired.relativePath, contentSha: expired.contentSha, assessment: 'APPLICABLE', reason: '错误地使用过期资料' }],
}), 'EXECUTION_EVENT_REFERENCE_INVALID');
fs.writeFileSync(path.join(knowledgeCase.root, 'knowledge', 'known.md'), knowledgeEntry('K-known-001', { symptom: '文件后来已更新，但不改变已冻结候选。' }));
const recoveredQuery = executeKnowledgeQuery({ execDir: knowledgeCase.execDir, queryId: 'query-known', query: queryResult.query, now: T0 });
assert.strictEqual(recoveredQuery.idempotent, true);
assert.strictEqual(recoveredQuery.candidates.find((item) => item.entryId === 'K-known-001').contentSha, known.contentSha);
assert.strictEqual(sha256File(knownSnapshot), known.contentSha);
commitAgentTurn(knowledgeCase.execDir, {
  schemaVersion: 1, turnId: 'turn-valid-assessment', facts: [{ factId: 'assessment-valid', type: 'knowledgeAssessment', queryId: 'query-known', knowledgeRef: 'assessment-valid', entryId: known.entryId, sourceNamespace: known.sourceNamespace, relativePath: known.relativePath, contentSha: known.contentSha, assessment: 'APPLICABLE', reason: '冻结候选与当前版本、页面和现象一致' }],
});
assert.strictEqual(timelineEvents(knowledgeCase.execDir).find((entry) => entry.knowledgeRef === 'assessment-valid').contentSha, known.contentSha);
expectCode(() => commitAgentTurn(knowledgeCase.execDir, {
  schemaVersion: 1, turnId: 'turn-duplicate-assessment-ref', facts: [{ factId: 'assessment-duplicate', type: 'knowledgeAssessment', queryId: 'query-known', knowledgeRef: 'assessment-valid', entryId: known.entryId, sourceNamespace: known.sourceNamespace, relativePath: known.relativePath, contentSha: known.contentSha, assessment: 'INSUFFICIENT', reason: '重复引用不得覆盖历史判断' }],
}), 'EXECUTION_EVENT_REFERENCE_INVALID');
assert.ok(knowledgeEvidence);

// Knowledge query publication is recoverable at every write boundary and keeps the first frozen result.
for (const stage of ['draft', 'snapshots', 'event']) {
  const transactionCase = makeExecution(`knowledge-transaction-${stage}`);
  const entryPath = path.join(transactionCase.root, 'knowledge', 'transaction.md');
  fs.writeFileSync(entryPath, knowledgeEntry(`K-transaction-${stage}`, { title: `事务候选 ${stage}`, symptom: `事务现象 ${stage}` }));
  establishBusiness(transactionCase);
  observe(transactionCase, `transaction-business-${stage}`, businessAuthorization(transactionCase));
  changePhase(transactionCase.execDir, 'INVESTIGATE', '验证知识查询事务恢复', { implementationSha: transactionCase.contract.implementationSha, now: T0 });
  const query = { platform: 'harmony', page: '目标页', symptom: `事务现象 ${stage}`, keywords: [`事务候选 ${stage}`] };
  assert.throws(() => executeKnowledgeQuery({ execDir: transactionCase.execDir, queryId: `query-transaction-${stage}`, query, now: T0, interruptAfter: stage }), /MAVT_KNOWLEDGE_QUERY_INTERRUPTED/);
  const draftPath = path.join(transactionCase.execDir, 'agent', `knowledge-query-query-transaction-${stage}.draft.json`);
  assert.strictEqual(fs.existsSync(draftPath), true);
  const frozenContentSha = readJson(draftPath).candidates[0].contentSha;
  assert.deepStrictEqual(readAgentStatus(transactionCase.execDir, T0).knowledgeQueryRecoveries, [{ queryId: `query-transaction-${stage}`, recoveryMode: 'COMMIT_FROZEN_QUERY' }]);
  expectCode(() => changePhase(transactionCase.execDir, 'CONCLUDE', '不得绕过查询恢复', { implementationSha: transactionCase.contract.implementationSha, now: T0 }), 'KNOWLEDGE_QUERY_RECOVERY_REQUIRED');
  expectCode(() => commitAgentTurn(transactionCase.execDir, {
    schemaVersion: 1, turnId: `turn-during-query-${stage}`, facts: [{ factId: `reflection-during-query-${stage}`, type: 'reflection', reason: '不得在查询恢复期间插入事实' }],
  }, { now: T0 }), 'KNOWLEDGE_QUERY_RECOVERY_REQUIRED');
  fs.writeFileSync(entryPath, knowledgeEntry(`K-transaction-${stage}`, { title: `事务候选 ${stage}`, symptom: `事务现象 ${stage} 已变化` }));
  const recoveredQueryTransaction = recoverInternalTransactions(transactionCase.execDir, { now: T0 });
  assert.deepStrictEqual(recoveredQueryTransaction.recovered, [{ type: 'knowledge-query', id: `query-transaction-${stage}` }]);
  const resumed = timelineEvents(transactionCase.execDir).find((entry) => entry.type === 'knowledgeQuery' && entry.queryId === `query-transaction-${stage}`);
  assert.strictEqual(resumed.matchCount, 1);
  assert.strictEqual(resumed.candidates[0].entryId, `K-transaction-${stage}`);
  assert.strictEqual(resumed.candidates[0].contentSha, frozenContentSha);
  assert.strictEqual(fs.existsSync(draftPath), false);
  assert.strictEqual(timelineEvents(transactionCase.execDir).filter((entry) => entry.type === 'knowledgeQuery' && entry.queryId === `query-transaction-${stage}`).length, 1);
  assert.deepStrictEqual(readAgentStatus(transactionCase.execDir, T0).knowledgeQueryRecoveries, []);
}

// Knowledge investigation and negative-result convergence do not require separate phase calls.
const convergedCase = makeExecution('converged-negative-result');
establishBusiness(convergedCase);
const convergedEvidence = observe(convergedCase, 'converged-business', businessAuthorization(convergedCase)).fact.ref;
executeKnowledgeQuery({
  execDir: convergedCase.execDir,
  queryId: 'query-converged',
  query: { symptom: '目标状态缺失', keywords: ['目标状态'] },
  reason: '当前业务证据与原文不一致，需要调查知识',
  now: T0,
});
assert.strictEqual(readJson(path.join(convergedCase.execDir, 'execution.json')).phase, 'EXECUTE');
const converged = finalizeWithReview(convergedCase.execDir, {
  verdict: 'FAIL', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '目标状态不符合原文',
  requirementFindings: [{ requirementId: 'req-001', status: 'NOT_SATISFIED', evidenceRefs: [convergedEvidence], knowledgeRefs: [] }],
  uncertainties: [], technicalFailureCode: null,
}, {
  factId: 'review-converged', type: 'verdictReview', ...reviewBinding(convergedCase), queryRefs: ['query-converged'], requestedVerdict: 'FAIL',
  sourceRecheck: { sourceRefs: ['src-001'], conclusion: '冻结原文明示目标状态要求' },
  currentObservationRefs: [convergedEvidence],
  recoveryAttempt: { performed: false, explanation: '当前现场稳定，不存在可执行的技术恢复动作', evidenceRefs: [] },
  remainingUncertainties: [], reason: '当前业务观察与原文明示要求不一致',
}, { now: T0 });
assert.strictEqual(converged.finalized, true);
assert.strictEqual(fs.existsSync(path.join(convergedCase.execDir, 'agent', 'result.json')), true);
assert.strictEqual(timelineEvents(convergedCase.execDir).filter((entry) => entry.type === 'verdictReview').length, 1);

// Finalize validates review and result together before persisting the review.
const atomicFinalizeCase = makeExecution('atomic-finalize-review');
establishBusiness(atomicFinalizeCase);
const atomicEvidence = observe(atomicFinalizeCase, 'atomic-final-evidence', businessAuthorization(atomicFinalizeCase)).fact.ref;
executeKnowledgeQuery({
  execDir: atomicFinalizeCase.execDir,
  queryId: 'query-atomic-finalize',
  query: { symptom: '目标状态缺失', keywords: ['目标状态'] },
  now: T0,
});
const atomicResult = {
  verdict: 'FAIL', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '目标状态不符合原文',
  requirementFindings: [{ requirementId: 'req-001', status: 'NOT_SATISFIED', evidenceRefs: [atomicEvidence], knowledgeRefs: [] }],
  uncertainties: [], technicalFailureCode: null,
};
const atomicReview = {
  factId: 'review-atomic-finalize', type: 'verdictReview', ...reviewBinding(atomicFinalizeCase), queryRefs: ['query-atomic-finalize'], requestedVerdict: 'INCONCLUSIVE',
  sourceRecheck: { sourceRefs: ['src-001'], conclusion: '冻结原文明示目标状态要求' },
  currentObservationRefs: [atomicEvidence],
  recoveryAttempt: { performed: false, explanation: '当前现场稳定，无需技术恢复', evidenceRefs: [] },
  remainingUncertainties: ['当前现象仍需确认'], reason: '先提交一个与最终结论不一致的复核',
};
expectCode(() => finalizeWithReview(atomicFinalizeCase.execDir, atomicResult, atomicReview, { now: T0 }), 'RESULT_REVIEW_VERDICT_MISMATCH');
assert.strictEqual(timelineEvents(atomicFinalizeCase.execDir).filter((entry) => entry.type === 'verdictReview').length, 0);
const atomicFinalized = finalizeWithReview(atomicFinalizeCase.execDir, atomicResult, {
  ...atomicReview,
  factId: 'review-atomic-finalize-corrected',
  requestedVerdict: 'FAIL',
  remainingUncertainties: ['复核描述允许与最终结果采用不同表述'],
  reason: '知识调查后仍有直接证据支持失败结论',
}, { now: T0 });
assert.strictEqual(atomicFinalized.finalized, true);
assert.strictEqual(timelineEvents(atomicFinalizeCase.execDir).filter((entry) => entry.type === 'verdictReview').length, 1);

const resultCase = fewer;
const agentResult = createAgentResult({ execDir: resultCase.execDir });
assert.strictEqual(validateAgentResult(agentResult, { request: readJson(path.join(resultCase.execDir, 'agent', 'request.json')) }), agentResult);
expectCode(() => validateAgentResult({ ...agentResult, warmSessionGeneration: 2 }, { request: readJson(path.join(resultCase.execDir, 'agent', 'request.json')) }), 'AGENT_RESULT_BINDING_MISMATCH');
const resultRuntime = readJson(path.join(resultCase.execDir, 'agent', 'runtime.json'));
writeJsonAtomic(path.join(resultCase.execDir, 'agent', 'runtime.json'), { ...resultRuntime, status: 'RELEASED' });
expectCode(() => createAgentResult({ execDir: resultCase.execDir }), 'AGENT_RESULT_BINDING_MISMATCH');
writeJsonAtomic(path.join(resultCase.execDir, 'agent', 'runtime.json'), resultRuntime);

fs.rmSync(temp, { recursive: true, force: true });
delete process.env.MAVT_SELF_TEST;
console.log('agent-driven passed');
