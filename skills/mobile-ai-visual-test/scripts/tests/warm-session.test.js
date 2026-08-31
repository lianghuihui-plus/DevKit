#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  batchPaths,
  bootstrapBatch,
  commitCurrentCase,
  initializeBatch,
  loadBatch,
  reconcileBatch,
  recoverApp,
  releaseRuntime,
  startCurrentCase,
} = require('../batch/core');
const {
  changePhase,
  completeOperation,
  confirmStartObservation,
  beginOperation,
  finalizeExecution,
  timelineEvents,
} = require('../execution/core');
const { commitAgentTurn } = require('../agent/turn');
const { createCaseContract, sourceSha } = require('../execution/contracts/case-contract');
const { validateCompletionBinding } = require('../lib/completion-contract');
const { sha256File } = require('../lib/execution-evidence');
const { writeJsonAtomic, readJson } = require('../lib/execution-lifecycle');
const { withPlanSha } = require('../lib/plan-contract');
const {
  createWarmSession,
  markBootstrapFailed,
  markBootstrapReady,
  markClosed,
  markDegraded,
  markRecovered,
  validateWarmSession,
} = require('../lib/warm-session-contract');
const { validateBatchContract } = require('../lib/batch-contract');
const { buildContract } = require('../build-agent-contract');
const { createAgentResult } = require('../agent/core');
const { controlRequestPath } = require('../agent/control-request');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const CASE_EXECUTOR_CONTRACT = buildContract({
  skillRoot: path.resolve(__dirname, '..', '..'), role: 'case-executor', provider: 'codex', platform: 'harmony',
});
const IMPLEMENTATION_SHA = CASE_EXECUTOR_CONTRACT.implementationSha;
const BINDING = Object.freeze({ platform: 'harmony', deviceId: 'device-warm-001', appId: 'com.example.warm', entry: 'EntryAbility' });
const T0 = '2026-08-13T10:00:00.000Z';

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function incidentRequest(value, category = 'TECHNICAL') {
  return value.triggerType === 'SOURCE_REQUIRED_COLD_START' ? value : {
    ...value,
    incidentId: `incident-${value.recoveryId}`,
    incidentCategory: category,
    incidentReason: `检测到 ${value.triggerType}，需要受控恢复`,
  };
}

function makeAdapter(options = {}) {
  const calls = [];
  return {
    calls,
    restartApp(request) {
      calls.push(request);
      if (typeof options.restart === 'function') return options.restart(request, calls.length);
      return options.restart || { ok: true, coldStartVerified: true, startupDisplayVerified: true };
    },
    probeSession(request) {
      if (typeof options.probe === 'function') return options.probe(request);
      return options.probe || { ok: true, binding: { ...BINDING } };
    },
  };
}

function makeCase(root, name, sourceText = `验证 ${name} 的目标状态`) {
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText, importPath: `/fixtures/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  return { caseKey, caseDir, caseJson, sourceText };
}

function makeWorkspace(name, caseNames = ['case-a']) {
  const root = path.join(temp, name);
  createTestWorkspace(root);
  const cases = caseNames.map((caseName) => makeCase(root, caseName));
  return { root, cases };
}

function initializeAndBootstrap(name, caseNames = ['case-a'], adapter = makeAdapter()) {
  const fixture = makeWorkspace(name, caseNames);
  const batchId = `batch-${name}`;
  const targets = fixture.cases.map(({ caseKey, caseDir }) => ({ caseKey, caseDir }));
  createTestExecutionRequest(fixture.root, batchId, BINDING, targets, { now: T0 });
  initializeBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  bootstrapBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0 });
  return { ...fixture, batchId, adapter };
}

function understandingFor(item, options = {}) {
  const quote = item.sourceText.split(/\r?\n/)[0];
  const sourceRef = { id: 'src-001', sourceSha: sourceSha(item.sourceText), lineStart: 1, lineEnd: 1, quote };
  return {
    schemaVersion: 1,
    revision: 1,
    summary: '验证当前用例目标',
    startConditions: options.noStart ? [] : [{ id: 'start-001', text: '目标页面起点可建立', basis: 'implied', sourceRefs: ['src-001'] }],
    requirements: [{
      id: 'req-001', text: '目标状态符合原文', basis: 'explicit', sourceRefs: ['src-001'],
      requiredInteractions: [], expectedOutcomes: ['目标状态符合原文'],
    }],
    sourceRefs: [sourceRef],
    uncertainties: [],
  };
}

function planFor(checkpoints = ['cp-001']) {
  return withPlanSha({
    schemaVersion: 1,
    revision: 1,
    reason: '建立当前用例检查点',
    checkpoints: checkpoints.map((id) => ({ id, objective: `验证 ${id}`, requirementRefs: ['req-001'] })),
  });
}

function startPrepared(fixture, index = 0, options = {}) {
  const executionId = options.executionId || `execution-${fixture.batchId}-${index + 1}`;
  const started = startCurrentCase({
    workspaceRoot: fixture.root,
    batchId: fixture.batchId,
    implementationSha: IMPLEMENTATION_SHA,
    executionId,
    now: options.now || T0,
  });
  const sourceItem = fixture.cases[index];
  const understanding = understandingFor(sourceItem, options);
  commitAgentTurn(started.execDir, {
    schemaVersion: 1,
    turnId: `turn-initial-${executionId}`,
    understanding,
    plan: planFor(options.checkpoints),
    facts: [],
  }, { now: options.now || T0 });
  if (options.noStart || options.skipPhase) return { ...started, sourceItem, understanding };
  changePhase(started.execDir, 'ESTABLISH_START', '理解已完成', { implementationSha: IMPLEMENTATION_SHA, now: options.now || T0 });
  return { ...started, sourceItem, understanding };
}

function addObservation(started, operationId, scope = 'case-business', extra = {}) {
  const ref = `screenshots/${operationId}.png`;
  fs.writeFileSync(path.join(started.execDir, ref), PNG);
  beginOperation(started.execDir, 'OBSERVE', operationId, { implementationSha: IMPLEMENTATION_SHA, now: T0 });
  completeOperation(started.execDir, {
    type: 'observation', operationId, scope, ref,
    warmSessionGeneration: readJson(path.join(started.execDir, 'execution.json')).warmSessionGeneration,
    sha256: sha256File(path.join(started.execDir, ref)), usable: true,
    ...extra,
  }, { implementationSha: IMPLEMENTATION_SHA, now: T0 });
  return ref;
}

function enterBusiness(started) {
  const existing = [...timelineEvents(started.execDir)].reverse()
    .find((entry) => entry.type === 'observation' && entry.scope === 'case-prepare');
  const startRef = existing?.ref
    || addObservation(started, 'prepare-start', 'case-prepare', { startConditionId: 'start-001', understandingRevision: 1 });
  confirmStartObservation(started.execDir, startRef, '测试确认当前现场满足起点', { now: T0 });
  changePhase(started.execDir, 'EXECUTE', '起点已建立', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
}

function finalize(started, verdict = 'PASS', evidenceRef = null) {
  changePhase(started.execDir, 'CONCLUDE', '形成结论', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
  const findingStatus = verdict === 'PASS' ? 'SATISFIED' : verdict === 'BLOCKED' ? 'BLOCKED' : 'UNRESOLVED';
  return finalizeExecution(started.execDir, {
    verdict,
    executionStatus: verdict === 'BLOCKED' ? 'TECHNICALLY_BLOCKED' : 'COMPLETED',
    verdictBasis: verdict === 'BLOCKED' ? 'TECHNICAL_CONSTRAINT' : 'DIRECT_EVIDENCE',
    summary: `${verdict} 当前用例`,
    requirementFindings: [{ requirementId: 'req-001', status: findingStatus, evidenceRefs: evidenceRef ? [evidenceRef] : [], knowledgeRefs: [] }],
    uncertainties: [],
    technicalFailureCode: verdict === 'BLOCKED' ? 'AUTOMATION_CONNECTION_LOST' : null,
  }, { implementationSha: IMPLEMENTATION_SHA, now: T0 });
}

function completeCase(fixture, index, verdict = 'PASS') {
  const started = startPrepared(fixture, index);
  enterBusiness(started);
  const evidenceRef = verdict === 'PASS' ? addObservation(started, `business-${index + 1}`) : null;
  finalize(started, verdict, evidenceRef);
  createAgentResult({ execDir: started.execDir });
  const committed = commitCurrentCase({ workspaceRoot: fixture.root, batchId: fixture.batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  return { started, evidenceRef, committed };
}

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-warm-session-'));

// Warm-session and batch contracts.
const initial = createWarmSession(BINDING, T0);
const ready = markBootstrapReady(initial, T0);
const degraded = markDegraded(ready, T0);
const recovered = markRecovered(degraded, T0);
const closed = markClosed(recovered, T0);
assert.deepStrictEqual([ready.generation, recovered.generation, recovered.appStartCount, recovered.recoveryCount], [1, 2, 2, 1]);
assert.strictEqual(markBootstrapFailed(initial, T0).generation, 0);
expectCode(() => validateWarmSession({ ...ready, binding: { ...BINDING, deviceId: 'other' } }, { previous: ready }), 'WARM_SESSION_BINDING_CHANGED');
expectCode(() => validateWarmSession({ ...recovered, generation: 1 }, { previous: recovered }), 'WARM_SESSION_COUNTER_REGRESSION');
expectCode(() => markBootstrapReady(closed, T0), 'WARM_SESSION_TRANSITION_INVALID');
expectCode(() => validateWarmSession({ ...ready, plan: {} }), 'WARM_SESSION_BUSINESS_CONTEXT_FORBIDDEN');
expectCode(() => validateWarmSession({ ...ready, businessContext: {} }), 'WARM_SESSION_BUSINESS_CONTEXT_FORBIDDEN');
expectCode(() => validateWarmSession({ ...ready, schemaVersion: 99 }), 'WARM_SESSION_SCHEMA_UNSUPPORTED');
expectCode(() => validateBatchContract({ schemaVersion: 99 }), 'BATCH_CONTRACT_SCHEMA_UNSUPPORTED');

const initFixture = makeWorkspace('initialize-contract', ['one']);
expectCode(() => initializeBatch({ workspaceRoot: initFixture.root, batchId: 'batch-no-request', implementationSha: IMPLEMENTATION_SHA }), 'EXECUTION_REQUEST_REQUIRED');
expectCode(() => initializeBatch({ workspaceRoot: initFixture.root, batchId: 'batch-direct', implementationSha: IMPLEMENTATION_SHA, binding: BINDING, targets: initFixture.cases }), 'EXECUTION_REQUEST_REQUIRED');
createTestExecutionRequest(initFixture.root, 'batch-no-sha', BINDING, initFixture.cases, { now: T0 });
expectCode(() => initializeBatch({ workspaceRoot: initFixture.root, batchId: 'batch-no-sha', now: T0 }), 'BATCH_IMPLEMENTATION_MISMATCH');

for (const stage of ['draft', 'contract', 'state', 'event']) {
  const fixture = makeWorkspace(`batch-init-${stage}`);
  const batchId = `batch-init-${stage}`;
  createTestExecutionRequest(fixture.root, batchId, BINDING, fixture.cases, { now: T0 });
  assert.throws(() => initializeBatch({
    workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, interruptAfter: stage, now: T0,
  }), /MAVT_BATCH_INIT_INTERRUPTED/);
  const paths = batchPaths(fixture.root, batchId);
  assert.strictEqual(fs.existsSync(paths.initDraft), true);
  const resumed = initializeBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  assert.strictEqual(resumed.state.contractSha, resumed.contract.contractSha);
  assert.strictEqual(fs.existsSync(paths.initDraft), false);
  const initializedEvents = fs.readFileSync(paths.events, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.type === 'batchInitialized');
  assert.strictEqual(initializedEvents.length, 1);
  assert.strictEqual(initializedEvents[0].contractSha, resumed.contract.contractSha);
}

const implementationFixture = initializeAndBootstrap('implementation-binding');
expectCode(() => loadBatch(implementationFixture.root, implementationFixture.batchId, 'implementation-other'), 'BATCH_IMPLEMENTATION_MISMATCH');
expectCode(() => initializeBatch({
  workspaceRoot: implementationFixture.root, batchId: implementationFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA, binding: { ...BINDING, deviceId: 'device-other' },
  targets: implementationFixture.cases,
}), 'EXECUTION_REQUEST_REQUIRED');
const implementationPaths = batchPaths(implementationFixture.root, implementationFixture.batchId);
const implementationState = readJson(implementationPaths.state);
writeJsonAtomic(implementationPaths.state, {
  ...implementationState,
  cases: implementationState.cases.map((entry) => ({ ...entry, caseDir: path.join(temp, 'tampered-case') })),
});
expectCode(() => loadBatch(implementationFixture.root, implementationFixture.batchId, IMPLEMENTATION_SHA), 'BATCH_BINDING_MISMATCH');
writeJsonAtomic(implementationPaths.state, implementationState);
const completion = {
  schemaVersion: 2, executionId: 'execution-a', batchId: 'batch-a', caseKey: 'ck-aaaaaaaaaaaa', platform: 'harmony',
  completionSource: 'framework', implementationSha: IMPLEMENTATION_SHA, contractSha: 'case-contract-a', batchContractSha: 'batch-contract-a',
  resultSchemaVersion: 2, metricsSchemaVersion: 2, verdict: 'PASS', executionStatus: 'COMPLETED', sessionReleased: true,
  resultSha256: 'a'.repeat(64), metricsSha256: 'b'.repeat(64), agentResultSha256: 'c'.repeat(64), validationSha256: null,
};
assert.throws(() => validateCompletionBinding(completion, { ...completion, batchContractSha: 'batch-contract-other' }), /batchContractSha mismatch/);

// Bootstrap always restarts once, then resumes idempotently.
for (const name of ['already-foreground', 'not-started']) {
  const adapter = makeAdapter();
  const fixture = makeWorkspace(`bootstrap-${name}`);
  const batchId = `batch-bootstrap-${name}`;
  createTestExecutionRequest(fixture.root, batchId, BINDING, fixture.cases, { now: T0 });
  initializeBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  bootstrapBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0 });
  bootstrapBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0 });
  assert.strictEqual(adapter.calls.length, 1);
}

const interruptedAdapter = makeAdapter();
const interruptedFixture = makeWorkspace('bootstrap-interrupted');
createTestExecutionRequest(interruptedFixture.root, 'batch-bootstrap-interrupted', BINDING, interruptedFixture.cases, { now: T0 });
initializeBatch({ workspaceRoot: interruptedFixture.root, batchId: 'batch-bootstrap-interrupted', implementationSha: IMPLEMENTATION_SHA, now: T0 });
assert.throws(() => bootstrapBatch({ workspaceRoot: interruptedFixture.root, batchId: 'batch-bootstrap-interrupted', implementationSha: IMPLEMENTATION_SHA, adapter: interruptedAdapter, interruptAfter: 'action', now: T0 }), /MAVT_BATCH_BOOTSTRAP_INTERRUPTED/);
assert.strictEqual(reconcileBatch({ workspaceRoot: interruptedFixture.root, batchId: 'batch-bootstrap-interrupted', implementationSha: IMPLEMENTATION_SHA, adapter: interruptedAdapter, now: T0 }).action, 'BOOTSTRAP');
bootstrapBatch({ workspaceRoot: interruptedFixture.root, batchId: 'batch-bootstrap-interrupted', implementationSha: IMPLEMENTATION_SHA, adapter: interruptedAdapter, now: T0 });
assert.strictEqual(interruptedAdapter.calls.length, 1);

for (const stage of ['state', 'event']) {
  const adapter = makeAdapter();
  const fixture = makeWorkspace(`bootstrap-commit-${stage}`);
  const batchId = `batch-bootstrap-commit-${stage}`;
  createTestExecutionRequest(fixture.root, batchId, BINDING, fixture.cases, { now: T0 });
  initializeBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  assert.throws(() => bootstrapBatch({
    workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, interruptAfter: stage, now: T0,
  }), /MAVT_BATCH_BOOTSTRAP_INTERRUPTED/);
  assert.strictEqual(reconcileBatch({
    workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0,
  }).action, 'BOOTSTRAP');
  bootstrapBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0 });
  assert.strictEqual(adapter.calls.length, 1);
  const events = fs.readFileSync(batchPaths(fixture.root, batchId).events, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.type === 'batchBootstrap');
  assert.deepStrictEqual(events.map((event) => [event.eventId, event.outcome]), [[`batch-bootstrap-${batchId}`, 'SUCCEEDED']]);
}

for (const stage of ['state', 'event']) {
  const adapter = makeAdapter({ restart: { ok: false, reason: 'bootstrap transaction failure' } });
  const fixture = makeWorkspace(`bootstrap-failure-${stage}`);
  const batchId = `batch-bootstrap-failure-${stage}`;
  createTestExecutionRequest(fixture.root, batchId, BINDING, fixture.cases, { now: T0 });
  initializeBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  assert.throws(() => bootstrapBatch({
    workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, interruptAfter: stage, now: T0,
  }), /MAVT_BATCH_BOOTSTRAP_INTERRUPTED/);
  assert.strictEqual(reconcileBatch({
    workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0,
  }).action, 'BOOTSTRAP');
  expectCode(() => bootstrapBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter, now: T0 }), 'BATCH_BOOTSTRAP_FAILED');
  assert.strictEqual(adapter.calls.length, 1);
  assert.strictEqual(fs.existsSync(batchPaths(fixture.root, batchId).bootstrapDraft), false);
  const events = fs.readFileSync(batchPaths(fixture.root, batchId).events, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.type === 'batchBootstrap');
  assert.deepStrictEqual(events.map((event) => [event.eventId, event.outcome]), [[`batch-bootstrap-${batchId}`, 'FAILED']]);
}

const tamperedFixture = makeWorkspace('bootstrap-draft-tampered');
createTestExecutionRequest(tamperedFixture.root, 'batch-bootstrap-draft-tampered', BINDING, tamperedFixture.cases, { now: T0 });
initializeBatch({ workspaceRoot: tamperedFixture.root, batchId: 'batch-bootstrap-draft-tampered', implementationSha: IMPLEMENTATION_SHA, now: T0 });
const tamperedPaths = batchPaths(tamperedFixture.root, 'batch-bootstrap-draft-tampered');
writeJsonAtomic(tamperedPaths.bootstrapDraft, { schemaVersion: 1, requestId: 'batch-bootstrap-001', eventId: 'batch-bootstrap-batch-bootstrap-draft-tampered', status: 'STARTED', binding: { ...BINDING, deviceId: 'other-device' } });
expectCode(() => bootstrapBatch({ workspaceRoot: tamperedFixture.root, batchId: 'batch-bootstrap-draft-tampered', implementationSha: IMPLEMENTATION_SHA, adapter: makeAdapter(), now: T0 }), 'BATCH_BOOTSTRAP_BINDING_MISMATCH');

// Case start is resumable at every publication boundary and preserves one execution/session.
for (const stage of ['execution', 'runtime', 'request', 'batch', 'event']) {
  const fixture = initializeAndBootstrap(`case-start-${stage}`);
  const executionId = `execution-case-start-${stage}`;
  assert.throws(() => startCurrentCase({
    workspaceRoot: fixture.root,
    batchId: fixture.batchId,
    implementationSha: IMPLEMENTATION_SHA,
    executionId,
    interruptAfter: stage,
    now: T0,
  }), /MAVT_CASE_START_INTERRUPTED/);
  assert.strictEqual(reconcileBatch({
    workspaceRoot: fixture.root, batchId: fixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: fixture.adapter, now: T0,
  }).action, 'RESUME_CASE_START');
  const resumed = startCurrentCase({ workspaceRoot: fixture.root, batchId: fixture.batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  assert.strictEqual(resumed.execution.executionId, executionId);
  assert.strictEqual(resumed.runtime.sessionId, `session-${executionId}`);
  assert.strictEqual(resumed.request.schemaVersion, 2);
  assert.strictEqual(resumed.request.executionId, executionId);
  const startedEvents = fs.readFileSync(batchPaths(fixture.root, fixture.batchId).events, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.type === 'caseStarted');
  assert.strictEqual(startedEvents.length, 1);
}

for (const [name, result] of [
  ['restart-failed', { ok: false, reason: 'process did not start' }],
  ['verification-missing', { ok: true }],
  ['display-failed', { ok: true, coldStartVerified: true, startupDisplayVerified: false, reason: 'startup display invalid' }],
]) {
  const fixture = makeWorkspace(`bootstrap-${name}`);
  const batchId = `batch-bootstrap-${name}`;
  createTestExecutionRequest(fixture.root, batchId, BINDING, fixture.cases, { now: T0 });
  initializeBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  expectCode(() => bootstrapBatch({ workspaceRoot: fixture.root, batchId, implementationSha: IMPLEMENTATION_SHA, adapter: makeAdapter({ restart: result }), now: T0 }), 'BATCH_BOOTSTRAP_FAILED');
  const state = readJson(batchPaths(fixture.root, batchId).state);
  assert.deepStrictEqual([state.status, state.warmSession.status, state.warmSession.generation, state.warmSession.appStartCount], ['BLOCKED', 'DEGRADED', 0, 1]);
}

// Three serial cases share one App start but have independent executions and Agent sessions.
const serial = initializeAndBootstrap('three-serial', ['serial-a', 'serial-b', 'serial-c']);
const serialResults = [completeCase(serial, 0), completeCase(serial, 1, 'BLOCKED'), completeCase(serial, 2)];
const serialState = serialResults[2].committed.state;
assert.strictEqual(serial.adapter.calls.length, 1);
assert.deepStrictEqual([serialState.status, serialState.warmSession.status, serialState.warmSession.appStartCount, serialState.warmSession.generation], ['COMPLETED', 'CLOSED', 1, 1]);
assert.strictEqual(new Set(serialResults.map((entry) => entry.started.execution.executionId)).size, 3);
assert.strictEqual(new Set(serialResults.map((entry) => entry.started.runtime.sessionId)).size, 3);
for (const [index, entry] of serialResults.entries()) {
  assert.strictEqual(entry.started.request.executionId, entry.started.execution.executionId);
  assert.strictEqual(entry.started.request.sessionId, entry.started.runtime.sessionId);
  const observations = timelineEvents(entry.started.execDir).filter((event) => event.type === 'observation');
  if (entry.evidenceRef) {
    const businessObservation = observations.find((event) => event.scope === 'case-business');
    assert.strictEqual(businessObservation.executionId, entry.started.execution.executionId);
    assert.strictEqual(businessObservation.ref, entry.evidenceRef);
    const foreignRefs = serialResults.filter((_, otherIndex) => otherIndex !== index).map((other) => other.evidenceRef).filter(Boolean);
    assert.strictEqual(observations.some((event) => foreignRefs.includes(event.ref)), false);
  }
}

// Retrying an old recovery after the next case starts must remain bound to the original execution.
const crossCaseRecovery = initializeAndBootstrap('cross-case-recovery', ['recovery-first', 'recovery-second']);
const recoveryFirst = startPrepared(crossCaseRecovery, 0);
enterBusiness(recoveryFirst);
const recoveryFirstEvidence = addObservation(recoveryFirst, 'recovery-first-before');
const oldRecoveryRequest = incidentRequest({
  recoveryId: 'recovery-cross-case', executionId: recoveryFirst.execution.executionId,
  checkpointId: 'cp-001', triggerType: 'SYSTEM_KILLED', evidenceRefs: [recoveryFirstEvidence],
});
recoverApp({ workspaceRoot: crossCaseRecovery.root, batchId: crossCaseRecovery.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: crossCaseRecovery.adapter, request: oldRecoveryRequest, now: T0 });
const recoveryFirstStart = addObservation(recoveryFirst, 'recovery-first-prepare-after', 'case-prepare', { startConditionId: 'start-001', understandingRevision: 1 });
changePhase(recoveryFirst.execDir, 'ESTABLISH_START', '恢复后重新建立起点', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
confirmStartObservation(recoveryFirst.execDir, recoveryFirstStart, '恢复后重新确认当前起点', { now: T0 });
changePhase(recoveryFirst.execDir, 'EXECUTE', '恢复后起点已建立', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
const recoveryFirstCurrent = addObservation(recoveryFirst, 'recovery-first-after');
finalize(recoveryFirst, 'PASS', recoveryFirstCurrent);
createAgentResult({ execDir: recoveryFirst.execDir });
commitCurrentCase({ workspaceRoot: crossCaseRecovery.root, batchId: crossCaseRecovery.batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
const recoverySecond = startPrepared(crossCaseRecovery, 1);
const secondTimelineBefore = timelineEvents(recoverySecond.execDir).length;
assert.strictEqual(recoverApp({ workspaceRoot: crossCaseRecovery.root, batchId: crossCaseRecovery.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: crossCaseRecovery.adapter, request: oldRecoveryRequest, now: T0 }).idempotent, true);
assert.strictEqual(timelineEvents(recoverySecond.execDir).length, secondTimelineBefore);
expectCode(() => startCurrentCase({ workspaceRoot: serial.root, batchId: serial.batchId, implementationSha: IMPLEMENTATION_SHA }), 'WARM_SESSION_NOT_READY');

// Preparation can change session state and its evidence can support the result.
const prepareFixture = initializeAndBootstrap('prepare-boundaries');
const prepared = startPrepared(prepareFixture);
const prepareRef = addObservation(prepared, 'prepare-observe', 'case-prepare', { startConditionId: 'start-001', understandingRevision: 1 });
beginOperation(prepared.execDir, 'ACTION', 'prepare-action', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
completeOperation(prepared.execDir, {
  type: 'actionResult', operationId: 'prepare-action', scope: 'case-prepare', ok: true,
  warmSessionGeneration: readJson(path.join(prepared.execDir, 'execution.json')).warmSessionGeneration,
  startConditionId: 'start-001', understandingRevision: 1, sideEffect: true,
}, { implementationSha: IMPLEMENTATION_SHA, now: T0 });
enterBusiness(prepared);
changePhase(prepared.execDir, 'CONCLUDE', '验证准备证据隔离', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
assert.strictEqual(finalizeExecution(prepared.execDir, {
  verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '准备证据已确认目标状态',
  requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: [prepareRef], knowledgeRefs: [] }],
  uncertainties: [], technicalFailureCode: null,
}, { implementationSha: IMPLEMENTATION_SHA, now: T0 }).result.verdict, 'PASS');

const unknownStartFixture = initializeAndBootstrap('unknown-start');
const unknownStart = startPrepared(unknownStartFixture, 0, { noStart: true });
assert.strictEqual(changePhase(unknownStart.execDir, 'ESTABLISH_START', '无需预设起点条件', {
  implementationSha: IMPLEMENTATION_SHA, now: T0,
}).to, 'ESTABLISH_START');

// Agent may request a controlled restart without fabricating a runtime incident.
const agentRecoveryFixture = initializeAndBootstrap('agent-decided-recovery');
const agentRecoveryCase = startPrepared(agentRecoveryFixture, 0, { checkpoints: ['cp-agent-restart'] });
enterBusiness(agentRecoveryCase);
const agentRecoveryEvidence = addObservation(agentRecoveryCase, 'agent-recovery-evidence');
const agentRecovery = recoverApp({
  workspaceRoot: agentRecoveryFixture.root,
  batchId: agentRecoveryFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA,
  adapter: agentRecoveryFixture.adapter,
  now: T0,
  request: {
    recoveryId: 'recovery-agent-decided', executionId: agentRecoveryCase.execution.executionId,
    checkpointId: 'cp-agent-restart', triggerType: 'AGENT_DECIDED_RESTART',
    evidenceRefs: [agentRecoveryEvidence], decisionReason: '当前现场无法继续，Agent 判断受控重启后重新观察更合适',
  },
});
assert.strictEqual(agentRecovery.recovery.status, 'SUCCEEDED');
assert.strictEqual(agentRecovery.recovery.decisionReason.includes('Agent 判断'), true);
assert.strictEqual(timelineEvents(agentRecoveryCase.execDir).some((event) => event.type === 'runtimeIncident'), false);

// Invalid incident categories are rejected by the current consumer contract.
const invalidCategoryFixture = initializeAndBootstrap('invalid-incident-category');
const invalidCategoryCase = startPrepared(invalidCategoryFixture, 0, { checkpoints: ['cp-invalid-category'] });
enterBusiness(invalidCategoryCase);
const invalidCategoryEvidence = addObservation(invalidCategoryCase, 'invalid-category-evidence');
const invalidCategoryRequest = {
  ...incidentRequest({
    recoveryId: 'recovery-invalid-category',
    executionId: invalidCategoryCase.execution.executionId,
    checkpointId: 'cp-invalid-category',
    triggerType: 'UNKNOWN_EXIT',
    evidenceRefs: [invalidCategoryEvidence],
  }, 'TARGET_APP_LEFT_FOREGROUND'),
  generatedBy: 'agent-facade',
};
expectCode(() => recoverApp({
  workspaceRoot: invalidCategoryFixture.root,
  batchId: invalidCategoryFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA,
  adapter: invalidCategoryFixture.adapter,
  request: invalidCategoryRequest,
  now: T0,
}), 'RECOVERY_INVALID');

// Recovery validates trigger evidence, is idempotent, and updates both warm and Agent generations.
const recoveryFixture = initializeAndBootstrap('recovery', ['recovery-case']);
const recoveryCase = startPrepared(recoveryFixture, 0, { checkpoints: ['cp-recovery'] });
enterBusiness(recoveryCase);
const recoveryEvidence = addObservation(recoveryCase, 'exit-evidence');
expectCode(() => recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter,
  request: { recoveryId: 'recovery-vague', executionId: recoveryCase.execution.executionId, checkpointId: 'cp-recovery', triggerType: 'CANNOT_FIND_PAGE', sourceRefs: ['src-001'] },
}), 'RECOVERY_TRIGGER_INVALID');
expectCode(() => recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter,
  request: { recoveryId: 'recovery-missing-source', executionId: recoveryCase.execution.executionId, checkpointId: 'cp-recovery', triggerType: 'SOURCE_REQUIRED_COLD_START', sourceRefs: ['src-missing'] },
}), 'RECOVERY_REFERENCE_INVALID');
expectCode(() => recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter,
  request: incidentRequest({ recoveryId: 'recovery-missing-evidence', executionId: recoveryCase.execution.executionId, checkpointId: 'cp-recovery', triggerType: 'APP_CRASH', evidenceRefs: ['screenshots/foreign.png'] }, 'PRODUCT'),
}), 'RECOVERY_REFERENCE_INVALID');

const sourceRecovery = recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, now: T0,
  request: { recoveryId: 'recovery-source', executionId: recoveryCase.execution.executionId, checkpointId: 'cp-recovery', triggerType: 'SOURCE_REQUIRED_COLD_START', sourceRefs: ['src-001'] },
});
assert.strictEqual(sourceRecovery.recovery.noAutomaticReplay, true);
assert.deepStrictEqual([sourceRecovery.state.warmSession.generation, sourceRecovery.state.warmSession.appStartCount], [2, 2]);
assert.strictEqual(readJson(path.join(recoveryCase.execDir, 'agent', 'runtime.json')).warmSessionGeneration, 2);
const repeatedSourceRecovery = recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter,
  request: { recoveryId: 'recovery-source-repeat', executionId: recoveryCase.execution.executionId, checkpointId: 'cp-recovery', triggerType: 'SOURCE_REQUIRED_COLD_START', sourceRefs: ['src-001'] },
});
assert.strictEqual(repeatedSourceRecovery.recovery.status, 'SUCCEEDED');

const crashEvidence = addObservation(recoveryCase, 'evidence-after-source-recoveries');
const crashRequest = incidentRequest({ recoveryId: 'recovery-crash', executionId: recoveryCase.execution.executionId, checkpointId: 'cp-recovery', triggerType: 'APP_CRASH', evidenceRefs: [crashEvidence] }, 'PRODUCT');
assert.throws(() => recoverApp({ workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, request: crashRequest, interruptAfter: 'action', now: T0 }), /MAVT_BATCH_RECOVERY_INTERRUPTED/);
assert.strictEqual(reconcileBatch({ workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, now: T0 }).action, 'RESUME_RECOVERY');
const callsAfterInterruptedRecovery = recoveryFixture.adapter.calls.length;
const crashRecovery = recoverApp({ workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, request: crashRequest, now: T0 });
assert.strictEqual(recoveryFixture.adapter.calls.length, callsAfterInterruptedRecovery);
assert.strictEqual(crashRecovery.recovery.status, 'SUCCEEDED');
assert.strictEqual(recoverApp({ workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, request: crashRequest, now: T0 }).idempotent, true);
expectCode(() => recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter,
  request: { ...crashRequest, incidentReason: '同一恢复 ID 不能改写事故原因' }, now: T0,
}), 'RECOVERY_BINDING_MISMATCH');
writeJsonAtomic(batchPaths(recoveryFixture.root, recoveryFixture.batchId).recoveryDraft, {
  schemaVersion: 1, request: crashRequest, requestId: 'batch-recovery-recovery-crash', status: 'ACTION_RECORDED',
  result: { ok: true, coldStartVerified: true, startupDisplayVerified: true },
});
const recoveryEventsPath = batchPaths(recoveryFixture.root, recoveryFixture.batchId).events;
const recoveryEvents = fs.readFileSync(recoveryEventsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
fs.writeFileSync(recoveryEventsPath, `${recoveryEvents.filter((event) => event.recoveryId !== crashRequest.recoveryId).map((event) => JSON.stringify(event)).join('\n')}\n`);
assert.strictEqual(recoverApp({ workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, request: crashRequest, now: T0 }).idempotent, true);
assert.strictEqual(fs.existsSync(batchPaths(recoveryFixture.root, recoveryFixture.batchId).recoveryDraft), false);
assert.strictEqual(fs.readFileSync(recoveryEventsPath, 'utf8').includes('"recoveryId":"recovery-crash"'), true);
expectCode(() => recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter,
  request: { ...crashRequest, triggerType: 'SYSTEM_KILLED' }, now: T0,
}), 'RECOVERY_BINDING_MISMATCH');

const stateInterruptedEvidence = addObservation(recoveryCase, 'evidence-after-crash-recovery');
const stateInterruptedRequest = incidentRequest({
  recoveryId: 'recovery-state-interrupted', executionId: recoveryCase.execution.executionId,
  checkpointId: 'cp-recovery', triggerType: 'AUTOMATION_SESSION_LOST', evidenceRefs: [stateInterruptedEvidence],
});
assert.throws(() => recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA,
  adapter: recoveryFixture.adapter, request: stateInterruptedRequest, interruptAfter: 'state', now: T0,
}), /MAVT_BATCH_RECOVERY_INTERRUPTED/);
assert.strictEqual(timelineEvents(recoveryCase.execDir).some((event) => event.type === 'recoveryCompleted'
  && event.recoveryId === stateInterruptedRequest.recoveryId), false);
assert.strictEqual(recoverApp({
  workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA,
  adapter: recoveryFixture.adapter, request: stateInterruptedRequest, now: T0,
}).idempotent, true);
assert.strictEqual(timelineEvents(recoveryCase.execDir).filter((event) => event.type === 'recoveryCompleted'
  && event.recoveryId === stateInterruptedRequest.recoveryId).length, 1);

for (const [id, checkpointId, triggerType] of [
  ['recovery-system', 'cp-recovery', 'SYSTEM_KILLED'],
  ['recovery-unknown', 'cp-recovery', 'UNKNOWN_EXIT'],
]) {
  const loopEvidence = addObservation(recoveryCase, `${id}-evidence`);
  const recoveredResult = recoverApp({
    workspaceRoot: recoveryFixture.root, batchId: recoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: recoveryFixture.adapter, now: T0,
    request: incidentRequest({ recoveryId: id, executionId: recoveryCase.execution.executionId, checkpointId, triggerType, evidenceRefs: [loopEvidence] }),
  });
  assert.strictEqual(recoveredResult.recovery.status, 'SUCCEEDED');
}
assert.deepStrictEqual([
  readJson(batchPaths(recoveryFixture.root, recoveryFixture.batchId).state).warmSession.generation,
  readJson(batchPaths(recoveryFixture.root, recoveryFixture.batchId).state).warmSession.appStartCount,
], [7, 7]);
const currentStartEvidence = addObservation(recoveryCase, 'prepare-after-all-recoveries', 'case-prepare', { startConditionId: 'start-001', understandingRevision: 1 });
changePhase(recoveryCase.execDir, 'ESTABLISH_START', '全部恢复完成后重新建立起点', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
confirmStartObservation(recoveryCase.execDir, currentStartEvidence, '全部恢复完成后确认起点', { now: T0 });
changePhase(recoveryCase.execDir, 'EXECUTE', '全部恢复完成后起点已建立', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
const currentPassEvidence = addObservation(recoveryCase, 'evidence-after-all-recoveries');
changePhase(recoveryCase.execDir, 'CONCLUDE', '由 Agent 根据当前证据形成结论', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
assert.strictEqual(finalizeExecution(recoveryCase.execDir, {
  verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '恢复后当前证据满足原文要求',
  requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: [currentPassEvidence], knowledgeRefs: [] }],
  uncertainties: [], technicalFailureCode: null,
}, { implementationSha: IMPLEMENTATION_SHA, now: T0 }).result.verdict, 'PASS');

const failedRecoveryFixture = initializeAndBootstrap('recovery-failed');
const failedRecoveryCase = startPrepared(failedRecoveryFixture, 0, { checkpoints: ['cp-failure'] });
enterBusiness(failedRecoveryCase);
const failedEvidence = addObservation(failedRecoveryCase, 'failed-recovery-evidence');
const failedAdapter = makeAdapter({ restart: { ok: false, reason: 'cannot restart App' } });
const failedRecovery = recoverApp({
  workspaceRoot: failedRecoveryFixture.root, batchId: failedRecoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: failedAdapter, now: T0,
  request: incidentRequest({ recoveryId: 'recovery-failed', executionId: failedRecoveryCase.execution.executionId, checkpointId: 'cp-failure', triggerType: 'AUTOMATION_SESSION_LOST', evidenceRefs: [failedEvidence] }),
});
assert.deepStrictEqual([failedRecovery.recovery.status, failedRecovery.state.status, failedRecovery.state.warmSession.status], ['FAILED', 'BLOCKED', 'DEGRADED']);
assert.strictEqual(failedRecovery.state.failureCode, 'APP_RECOVERY_FAILED');
assert.strictEqual(failedRecovery.state.reason, 'APP_RECOVERY_FAILED: cannot restart App');
assert.strictEqual(failedRecovery.state.stoppedAt, T0);
assert.strictEqual(failedRecovery.state.stopContext.source, 'app-recovery');
assert.strictEqual(failedRecovery.state.stopContext.recoveryId, 'recovery-failed');
assert.strictEqual(failedRecovery.state.stopContext.executionId, failedRecoveryCase.execution.executionId);
assert.strictEqual(failedRecovery.state.stopContext.caseKey, failedRecovery.state.cases[0].caseKey);
assert.strictEqual(failedRecovery.state.stopContext.adapter.ok, false);
const failedBatchEvents = fs.readFileSync(batchPaths(failedRecoveryFixture.root, failedRecoveryFixture.batchId).events, 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.strictEqual(failedBatchEvents.filter((event) => event.type === 'batchStopped').length, 1);
assert.strictEqual(recoverApp({
  workspaceRoot: failedRecoveryFixture.root, batchId: failedRecoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: failedAdapter, now: T0,
  request: incidentRequest({ recoveryId: 'recovery-failed', executionId: failedRecoveryCase.execution.executionId, checkpointId: 'cp-failure', triggerType: 'AUTOMATION_SESSION_LOST', evidenceRefs: [failedEvidence] }),
}).idempotent, true);
assert.strictEqual(failedAdapter.calls.length, 1);
assert.strictEqual(reconcileBatch({ workspaceRoot: failedRecoveryFixture.root, batchId: failedRecoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: failedAdapter }).action, 'BATCH_BLOCKED');

const interruptedFailedRecoveryFixture = initializeAndBootstrap('recovery-failed-state-interrupted');
const interruptedFailedRecoveryCase = startPrepared(interruptedFailedRecoveryFixture, 0, { checkpoints: ['cp-failed-state'] });
enterBusiness(interruptedFailedRecoveryCase);
const interruptedFailedEvidence = addObservation(interruptedFailedRecoveryCase, 'failed-state-recovery-evidence');
const interruptedFailedAdapter = makeAdapter({ restart: { ok: false, reason: 'cannot restart after interrupted failure' } });
const interruptedFailedRequest = incidentRequest({
  recoveryId: 'recovery-failed-state', executionId: interruptedFailedRecoveryCase.execution.executionId,
  checkpointId: 'cp-failed-state', triggerType: 'AUTOMATION_SESSION_LOST', evidenceRefs: [interruptedFailedEvidence],
});
assert.throws(() => recoverApp({
  workspaceRoot: interruptedFailedRecoveryFixture.root, batchId: interruptedFailedRecoveryFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: interruptedFailedAdapter,
  request: interruptedFailedRequest, interruptAfter: 'state', now: T0,
}), /MAVT_BATCH_RECOVERY_INTERRUPTED/);
assert.strictEqual(reconcileBatch({
  workspaceRoot: interruptedFailedRecoveryFixture.root, batchId: interruptedFailedRecoveryFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: interruptedFailedAdapter, now: T0,
}).action, 'RESUME_RECOVERY');
assert.strictEqual(recoverApp({
  workspaceRoot: interruptedFailedRecoveryFixture.root, batchId: interruptedFailedRecoveryFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: interruptedFailedAdapter, request: interruptedFailedRequest, now: T0,
}).idempotent, true);
assert.strictEqual(fs.existsSync(batchPaths(interruptedFailedRecoveryFixture.root, interruptedFailedRecoveryFixture.batchId).recoveryDraft), false);
assert.strictEqual(timelineEvents(interruptedFailedRecoveryCase.execDir).filter((event) => event.type === 'recoveryCompleted'
  && event.recoveryId === interruptedFailedRequest.recoveryId).length, 1);
assert.strictEqual(reconcileBatch({
  workspaceRoot: interruptedFailedRecoveryFixture.root, batchId: interruptedFailedRecoveryFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: interruptedFailedAdapter, now: T0,
}).action, 'BATCH_BLOCKED');

const throwingRecoveryFixture = initializeAndBootstrap('recovery-throws');
const throwingRecoveryCase = startPrepared(throwingRecoveryFixture, 0, { checkpoints: ['cp-throw'] });
enterBusiness(throwingRecoveryCase);
const throwingEvidence = addObservation(throwingRecoveryCase, 'throwing-recovery-evidence');
const throwingAdapter = makeAdapter({ restart() { throw new Error('adapter transport failed'); } });
const throwingRecovery = recoverApp({
  workspaceRoot: throwingRecoveryFixture.root, batchId: throwingRecoveryFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: throwingAdapter, now: T0,
  request: incidentRequest({ recoveryId: 'recovery-throws', executionId: throwingRecoveryCase.execution.executionId, checkpointId: 'cp-throw', triggerType: 'SYSTEM_KILLED', evidenceRefs: [throwingEvidence] }),
});
assert.deepStrictEqual([throwingRecovery.recovery.status, throwingRecovery.state.status], ['FAILED', 'BLOCKED']);
assert.strictEqual(throwingAdapter.calls.length, 1);

const failedCrashFixture = initializeAndBootstrap('recovery-crash-failed');
const failedCrashCase = startPrepared(failedCrashFixture, 0, { checkpoints: ['cp-crash-failed'] });
enterBusiness(failedCrashCase);
const failedCrashEvidence = addObservation(failedCrashCase, 'failed-crash-evidence');
const failedCrash = recoverApp({
  workspaceRoot: failedCrashFixture.root, batchId: failedCrashFixture.batchId, implementationSha: IMPLEMENTATION_SHA,
  adapter: makeAdapter({ restart: { ok: false, reason: 'crashed App cannot restart' } }), now: T0,
  request: incidentRequest({ recoveryId: 'recovery-crash-failed', executionId: failedCrashCase.execution.executionId, checkpointId: 'cp-crash-failed', triggerType: 'APP_CRASH', evidenceRefs: [failedCrashEvidence] }, 'PRODUCT'),
});
assert.strictEqual(failedCrash.recovery.status, 'FAILED');
assert.strictEqual(timelineEvents(failedCrashCase.execDir).some((event) => event.type === 'runtimeIncident'
  && event.category === 'PRODUCT'), true);

// Reconcile handles running, finalizing, release-pending, commit-pending, and degraded states.
const pendingReconcile = makeWorkspace('reconcile-bootstrap');
createTestExecutionRequest(pendingReconcile.root, 'batch-reconcile-bootstrap', BINDING, pendingReconcile.cases, { now: T0 });
initializeBatch({ workspaceRoot: pendingReconcile.root, batchId: 'batch-reconcile-bootstrap', implementationSha: IMPLEMENTATION_SHA, now: T0 });
assert.strictEqual(reconcileBatch({ workspaceRoot: pendingReconcile.root, batchId: 'batch-reconcile-bootstrap', implementationSha: IMPLEMENTATION_SHA, adapter: makeAdapter(), now: T0 }).action, 'BOOTSTRAP');

const runningReconcile = initializeAndBootstrap('reconcile-running');
const runningCase = startPrepared(runningReconcile);
assert.strictEqual(reconcileBatch({ workspaceRoot: runningReconcile.root, batchId: runningReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: runningReconcile.adapter, now: T0 }).action, 'RESUME_EXECUTION');

const phaseReconcile = initializeAndBootstrap('reconcile-phase');
const phaseCase = startPrepared(phaseReconcile, 0, { skipPhase: true });
assert.throws(() => changePhase(phaseCase.execDir, 'ESTABLISH_START', '恢复阶段事务', {
  implementationSha: IMPLEMENTATION_SHA, interruptAfter: 'state', now: T0,
}), /MAVT_PHASE_CHANGE_INTERRUPTED/);
const phaseRecovery = reconcileBatch({
  workspaceRoot: phaseReconcile.root, batchId: phaseReconcile.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: phaseReconcile.adapter, now: T0,
});
assert.strictEqual(phaseRecovery.action, 'RESUME_PHASE');
assert.strictEqual(phaseRecovery.draft.to, 'ESTABLISH_START');
changePhase(phaseCase.execDir, phaseRecovery.draft.to, phaseRecovery.draft.reason, { implementationSha: IMPLEMENTATION_SHA, now: T0 });
assert.strictEqual(reconcileBatch({ workspaceRoot: phaseReconcile.root, batchId: phaseReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: phaseReconcile.adapter, now: T0 }).action, 'RESUME_EXECUTION');

const bindReconcile = initializeAndBootstrap('reconcile-bind');
const bindCase = startPrepared(bindReconcile);
fs.unlinkSync(path.join(bindCase.execDir, 'agent', 'runtime.json'));
assert.strictEqual(reconcileBatch({ workspaceRoot: bindReconcile.root, batchId: bindReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: bindReconcile.adapter, now: T0 }).action, 'CORRUPTED');

const finalizingReconcile = initializeAndBootstrap('reconcile-finalizing');
const finalizingCase = startPrepared(finalizingReconcile);
enterBusiness(finalizingCase);
const finalizingEvidence = addObservation(finalizingCase, 'finalizing-evidence');
changePhase(finalizingCase.execDir, 'CONCLUDE', '准备中断 finalize', { implementationSha: IMPLEMENTATION_SHA, now: T0 });
assert.throws(() => finalizeExecution(finalizingCase.execDir, {
  verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', summary: '等待恢复 finalize',
  requirementFindings: [{ requirementId: 'req-001', status: 'SATISFIED', evidenceRefs: [finalizingEvidence], knowledgeRefs: [] }],
  uncertainties: [], technicalFailureCode: null,
}, { implementationSha: IMPLEMENTATION_SHA, interruptAfter: 'draft', now: T0 }), /MAVT_FINALIZE_INTERRUPTED/);
assert.strictEqual(reconcileBatch({ workspaceRoot: finalizingReconcile.root, batchId: finalizingReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: finalizingReconcile.adapter, now: T0 }).action, 'RESUME_FINALIZE');

const releaseReconcile = initializeAndBootstrap('reconcile-release');
const releaseCase = startPrepared(releaseReconcile);
enterBusiness(releaseCase);
const releaseEvidence = addObservation(releaseCase, 'release-evidence');
finalize(releaseCase, 'PASS', releaseEvidence);
writeJsonAtomic(path.join(releaseCase.execDir, 'agent', 'attempt.current.json'), {
  schemaVersion: 1,
  attemptId: 'conclude-interrupted-after-finalize',
  entrypoint: 'conclude',
  startedAt: '2026-08-13T09:59:59.000Z',
});
assert.strictEqual(reconcileBatch({ workspaceRoot: releaseReconcile.root, batchId: releaseReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: releaseReconcile.adapter, now: T0 }).action, 'CREATE_AGENT_RESULT');
assert.strictEqual(fs.existsSync(path.join(releaseCase.execDir, 'agent', 'attempt.current.json')), false);
const settledAttempt = JSON.parse(fs.readFileSync(path.join(releaseCase.execDir, 'agent', 'attempts.jsonl'), 'utf8').trim());
assert.strictEqual(settledAttempt.executionCompleted, true);
assert.strictEqual(settledAttempt.error.code, 'AGENT_ENTRYPOINT_OUTPUT_INTERRUPTED');
assert.throws(() => commitCurrentCase({ workspaceRoot: releaseReconcile.root, batchId: releaseReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 }), (error) => error?.code === 'AGENT_RESULT_INVALID');
assert.strictEqual(readJson(path.join(releaseCase.execDir, 'agent', 'runtime.json')).status, 'BOUND');
createAgentResult({ execDir: releaseCase.execDir });
assert.strictEqual(reconcileBatch({ workspaceRoot: releaseReconcile.root, batchId: releaseReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: releaseReconcile.adapter, now: T0 }).action, 'COMMIT_CASE');
assert.strictEqual(commitCurrentCase({ workspaceRoot: releaseReconcile.root, batchId: releaseReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 }).state.status, 'COMPLETED');

const offlineFinalize = initializeAndBootstrap('reconcile-finalized-offline');
const offlineFinalizeCase = startPrepared(offlineFinalize);
enterBusiness(offlineFinalizeCase);
const offlineFinalizeEvidence = addObservation(offlineFinalizeCase, 'offline-finalized-evidence');
finalize(offlineFinalizeCase, 'PASS', offlineFinalizeEvidence);
createAgentResult({ execDir: offlineFinalizeCase.execDir });
const offlineAdapter = makeAdapter({ probe: { ok: false, binding: BINDING } });
assert.strictEqual(reconcileBatch({
  workspaceRoot: offlineFinalize.root, batchId: offlineFinalize.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: offlineAdapter, now: T0,
}).action, 'COMMIT_CASE');
assert.strictEqual(commitCurrentCase({
  workspaceRoot: offlineFinalize.root, batchId: offlineFinalize.batchId,
  implementationSha: IMPLEMENTATION_SHA, now: T0,
}).state.status, 'COMPLETED');
assert.strictEqual(offlineAdapter.calls.length, 0);

for (const stage of ['validation', 'runtime', 'completion', 'state', 'event']) {
  const commitFixture = initializeAndBootstrap(`case-commit-${stage}`);
  const commitCase = startPrepared(commitFixture);
  enterBusiness(commitCase);
  const commitEvidence = addObservation(commitCase, `case-commit-${stage}-evidence`);
  finalize(commitCase, 'PASS', commitEvidence);
  createAgentResult({ execDir: commitCase.execDir });
  assert.throws(() => commitCurrentCase({
    workspaceRoot: commitFixture.root, batchId: commitFixture.batchId,
    implementationSha: IMPLEMENTATION_SHA, interruptAfter: stage, now: T0,
  }), /MAVT_BATCH_COMMIT_INTERRUPTED/);
  assert.strictEqual(reconcileBatch({
    workspaceRoot: commitFixture.root, batchId: commitFixture.batchId,
    implementationSha: IMPLEMENTATION_SHA, adapter: commitFixture.adapter, now: T0,
  }).action, 'COMMIT_CASE');
  const recommitted = commitCurrentCase({ workspaceRoot: commitFixture.root, batchId: commitFixture.batchId, implementationSha: IMPLEMENTATION_SHA, now: T0 });
  assert.strictEqual(recommitted.state.status, 'COMPLETED');
  assert.strictEqual(fs.existsSync(batchPaths(commitFixture.root, commitFixture.batchId).caseCommitDraft), false);
  const committedEvents = fs.readFileSync(batchPaths(commitFixture.root, commitFixture.batchId).events, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.type === 'caseCommitted' && event.executionId === commitCase.execution.executionId);
  assert.strictEqual(committedEvents.length, 1);
}

const invalidRuntimeFixture = initializeAndBootstrap('reconcile-invalid-runtime');
const invalidRuntimeCase = startPrepared(invalidRuntimeFixture);
enterBusiness(invalidRuntimeCase);
const invalidRuntimeEvidence = addObservation(invalidRuntimeCase, 'invalid-runtime-evidence');
finalize(invalidRuntimeCase, 'PASS', invalidRuntimeEvidence);
const invalidRuntime = readJson(path.join(invalidRuntimeCase.execDir, 'agent', 'runtime.json'));
writeJsonAtomic(path.join(invalidRuntimeCase.execDir, 'agent', 'runtime.json'), { ...invalidRuntime, status: 'UNKNOWN' });
assert.strictEqual(reconcileBatch({ workspaceRoot: invalidRuntimeFixture.root, batchId: invalidRuntimeFixture.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: invalidRuntimeFixture.adapter, now: T0 }).action, 'BLOCKED');

const deadlineReconcile = initializeAndBootstrap('reconcile-deadline');
startPrepared(deadlineReconcile);
assert.strictEqual(reconcileBatch({ workspaceRoot: deadlineReconcile.root, batchId: deadlineReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: deadlineReconcile.adapter, now: '2026-08-13T10:29:59.999Z' }).action, 'RESUME_EXECUTION');
assert.strictEqual(reconcileBatch({ workspaceRoot: deadlineReconcile.root, batchId: deadlineReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: deadlineReconcile.adapter, now: '2026-08-13T10:30:00.000Z' }).action, 'CONCLUDE_TIME_LIMIT');

const deadlineControlFixture = initializeAndBootstrap('reconcile-deadline-control');
const deadlineControlCase = startPrepared(deadlineControlFixture, 0, { checkpoints: ['cp-deadline-control'] });
enterBusiness(deadlineControlCase);
const deadlineControlEvidence = addObservation(deadlineControlCase, 'deadline-control-evidence');
const deadlineControlRequest = incidentRequest({
  recoveryId: 'recovery-deadline-control', executionId: deadlineControlCase.execution.executionId,
  checkpointId: 'cp-deadline-control', triggerType: 'UNKNOWN_EXIT', evidenceRefs: [deadlineControlEvidence],
});
writeJsonAtomic(controlRequestPath(deadlineControlCase.execDir), deadlineControlRequest);
const deadlineControlResult = reconcileBatch({
  workspaceRoot: deadlineControlFixture.root, batchId: deadlineControlFixture.batchId,
  implementationSha: IMPLEMENTATION_SHA, adapter: deadlineControlFixture.adapter, now: '2026-08-13T10:30:00.000Z',
});
assert.strictEqual(deadlineControlResult.action, 'CONCLUDE_TIME_LIMIT');
assert.strictEqual(fs.existsSync(controlRequestPath(deadlineControlCase.execDir)), false);
const closedControl = timelineEvents(deadlineControlCase.execDir).find((event) => event.type === 'controlRequestClosed');
assert.strictEqual(closedControl.recoveryId, deadlineControlRequest.recoveryId);
assert.strictEqual(closedControl.closureReason, 'TIME_LIMIT_REACHED');
assert.match(closedControl.requestSha, /^recovery-request-/);

const degradedReconcile = initializeAndBootstrap('reconcile-degraded');
const degradedAdapter = makeAdapter({ probe: { ok: false, binding: BINDING } });
const degradedResult = reconcileBatch({ workspaceRoot: degradedReconcile.root, batchId: degradedReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: degradedAdapter, now: T0 });
assert.deepStrictEqual([degradedResult.action, degradedResult.state.status, degradedResult.state.warmSession.status], ['DEGRADED', 'BLOCKED', 'DEGRADED']);
assert.strictEqual(degradedResult.state.failureCode, 'WARM_SESSION_PROBE_FAILED');
assert.strictEqual(degradedResult.state.stopContext.source, 'warm-session-probe');
assert.strictEqual(reconcileBatch({ workspaceRoot: degradedReconcile.root, batchId: degradedReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: degradedAdapter, now: T0 }).action, 'BATCH_BLOCKED');

const mismatchReconcile = initializeAndBootstrap('reconcile-mismatch');
const mismatchCase = startPrepared(mismatchReconcile);
writeJsonAtomic(path.join(mismatchCase.execDir, 'execution.json'), { ...readJson(path.join(mismatchCase.execDir, 'execution.json')), implementationSha: 'implementation-other' });
expectCode(() => reconcileBatch({ workspaceRoot: mismatchReconcile.root, batchId: mismatchReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: mismatchReconcile.adapter, now: T0 }), 'BATCH_IMPLEMENTATION_MISMATCH');

const multipleReconcile = initializeAndBootstrap('reconcile-multiple', ['multiple-a', 'multiple-b']);
const multipleCase = startPrepared(multipleReconcile);
const secondExecDir = path.join(multipleReconcile.cases[1].caseDir, 'platforms', 'harmony', 'executions', 'execution-extra-active');
fs.mkdirSync(secondExecDir, { recursive: true });
writeJsonAtomic(path.join(secondExecDir, 'execution.json'), { ...readJson(path.join(multipleCase.execDir, 'execution.json')), executionId: 'execution-extra-active' });
const multipleResult = reconcileBatch({ workspaceRoot: multipleReconcile.root, batchId: multipleReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: multipleReconcile.adapter, now: T0 });
assert.strictEqual(multipleResult.action, 'CORRUPTED');
assert.strictEqual(multipleResult.executions.length, 2);
assert.deepStrictEqual([multipleResult.state.status, multipleResult.state.warmSession.status], ['BLOCKED', 'DEGRADED']);
assert.strictEqual(reconcileBatch({ workspaceRoot: multipleReconcile.root, batchId: multipleReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: multipleReconcile.adapter, now: T0 }).action, 'BATCH_BLOCKED');

const foreignReconcile = initializeAndBootstrap('reconcile-foreign');
const foreignCase = startPrepared(foreignReconcile);
const foreignExecDir = path.join(foreignReconcile.cases[0].caseDir, 'platforms', 'harmony', 'executions', 'execution-foreign-active');
fs.mkdirSync(foreignExecDir, { recursive: true });
writeJsonAtomic(path.join(foreignExecDir, 'execution.json'), { ...readJson(path.join(foreignCase.execDir, 'execution.json')), executionId: 'execution-foreign-active', batchId: 'batch-foreign' });
const foreignResult = reconcileBatch({ workspaceRoot: foreignReconcile.root, batchId: foreignReconcile.batchId, implementationSha: IMPLEMENTATION_SHA, adapter: foreignReconcile.adapter, now: T0 });
assert.strictEqual(foreignResult.action, 'CORRUPTED');
assert.ok(foreignResult.executions.includes('execution-foreign-active'));

fs.rmSync(temp, { recursive: true, force: true });
delete process.env.MAVT_SELF_TEST;
console.log('warm-session passed');
