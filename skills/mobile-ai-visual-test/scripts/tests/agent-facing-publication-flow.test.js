#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildContract } = require('../build-agent-contract');
const { buildCurrentCompletion, prepareCurrentCompletion, publishCurrentCompletion, releaseRuntime } = require('../batch/completion');
const { run } = require('../case-runtime/agent-facing-client');
const { createExecution } = require('../case-runtime/lifecycle');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { createInitialStatePreflight } = require('../lib/app-provisioning');
const { readExecutionReport, selectExecutionDir } = require('../lib/execution-reader');
const { refreshCommittedCaseReports } = require('../report/report-service');
const { createTestWorkspace } = require('./support/workspace-fixture');
const { simpleCaseFlow } = require('./support/case-flow');
const { validateResultIntegrity } = require('../case-runtime/result-integrity');
const { agentFacingFile } = require('../case-runtime/telemetry');
const { readAgentFacingEvents } = require('../lib/agent-facing-telemetry');

process.env.MAVT_SELF_TEST = '1';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-agent-facing-publication-'));
const root = path.join(temp, 'workspace');
createTestWorkspace(root);
fs.mkdirSync(path.join(root, 'knowledge'));

const source = '确认首页标题正常显示';
const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
const caseJson = createCaseContract({ caseKey, title: 'Agent-facing 发布闭环', sourceText: source, importPath: '/fixture/publication.md' });
const caseDir = path.join(root, 'cases', `001-agent-facing__${caseKey}`);
const runtimeDir = path.join(caseDir, 'platforms', 'harmony');
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, 'source.md'), source);
fs.writeFileSync(path.join(caseDir, 'case.json'), `${JSON.stringify(caseJson, null, 2)}\n`);

const initialStateRequirement = { schemaVersion: 1, targetState: 'KEEP_EXISTING', rationale: '测试已在目标页面' };
const preparationPolicy = { schemaVersion: 1, allowedEffects: [], targetAppOnly: true };
const initialStatePreflight = createInitialStatePreflight({
  requirement: initialStateRequirement,
  preparationPolicy,
  platform: 'harmony',
  now: '2026-09-16T01:00:00.000Z',
});
const contract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
const binding = { platform: 'harmony', deviceId: 'publication-device', appId: 'com.example.publication', entry: 'EntryAbility' };
const started = createExecution({
  workspaceRoot: root,
  runtimeDir,
  executionId: 'execution-agent-facing-publication',
  batchId: 'batch-agent-facing-publication',
  platform: 'harmony',
  sourceText: source,
  caseJson,
  targetBinding: binding,
  initialStateRequirement,
  initialStatePreflight,
  preparationPolicy,
  runtimeSha: contract.runtimeSha,
  adapterSha: contract.adapterSha,
  caseProtocolSha: contract.protocolSha,
  coordinatorProtocolSha: 'coordinator-publication-test',
  batchContractSha: 'batch-contract-publication-test',
  executionRequestSha: 'execution-request-publication-test',
  interactionPolicy: 'UNATTENDED',
  warmSessionGeneration: 1,
  initialObserve: false,
  now: '2026-09-16T01:00:00.000Z',
});

function runner(command, args, options) {
  assert.strictEqual(options.kind, 'OBSERVE');
  const out = args[args.indexOf('--out') + 1];
  const label = args[args.indexOf('--label') + 1];
  const screenshot = `screenshots/${label}.png`;
  fs.writeFileSync(path.join(out, screenshot), PNG);
  return { status: 0, stderr: '', stdout: JSON.stringify({
    schemaVersion: 1,
    type: 'observation',
    platform: 'harmony',
    device: { id: binding.deviceId },
    app: { appId: binding.appId, inTargetApp: true },
    artifacts: { screenshot, layout: null, logs: [] },
  }) };
}

assert.strictEqual(run(started.execDir, {
  operation: 'plan', input: {
    caseFlow: simpleCaseFlow(source, '首页标题正常显示'),
  },
}, { now: '2026-09-16T01:00:00.100Z' }).result.outcome, 'CASE_FLOW_RECORDED');

const observed = run(started.execDir, { operation: 'observe', input: { purpose: '采集首页现场' } }, {
  runner,
  now: '2026-09-16T01:00:00.200Z',
});
assert.strictEqual(observed.status, 'SUCCEEDED');
assert.strictEqual(observed.data.type, 'scene');
// Exercise the real Facade, broker, action dispatch, and observation failure path.
const unknownDir = path.join(temp, 'unknown-action');
fs.cpSync(started.execDir, unknownDir, { recursive: true });
const unknownSceneId = require('../case-runtime/store').readCurrentScene(unknownDir).sceneId;
const unknownScene = require('../case-runtime/agent-resource-store').publishScene(unknownDir, unknownSceneId);
let deviceDispatches = 0;
let followupCaptures = 0;
const unknown = run(unknownDir, {
  operation: 'act', input: { sceneRef: unknownScene.data.ref, action: { ref: 'screen:back' } },
}, {
  now: '2026-09-16T01:00:00.250Z',
  invokeDeviceOperation(execDir, request, kind) {
    if (kind === 'ACTION') { deviceDispatches += 1; throw new Error('device transport lost'); }
    assert.strictEqual(kind, 'OBSERVE');
    followupCaptures += 1;
    throw new Error('follow-up capture failed');
  },
});
assert.strictEqual(unknown.status, 'UNKNOWN', JSON.stringify(unknown));
assert.strictEqual(unknown.error.code, 'ACTION_OUTCOME_UNKNOWN');
assert.strictEqual(unknown.error.retryable, false);
assert.strictEqual(deviceDispatches, 1, 'uncertain dispatch is never replayed');
assert.strictEqual(followupCaptures, 1);
const unknownFact = require('../case-runtime/store').events(unknownDir).find((event) => event.type === 'actionOutcomeUnknown');
assert.strictEqual(unknown.result.operationId, unknownFact.operationId);
assert.strictEqual(unknown.result.commandDeliveryKnown, false);
assert.strictEqual(Object.hasOwn(unknown.result, 'outcomeKnown'), false);
assert.strictEqual(unknown.result.deliveryStatus, 'UNKNOWN');
const factResource = unknown.resources.find((resource) => resource.type === 'technicalFact');
assert.ok(factResource);
assert.strictEqual(run(unknownDir, { operation: 'read', input: { ref: factResource.ref } }).data.content.eventId, unknownFact.eventId);
assert.ok(!JSON.stringify(unknown).includes('device transport lost'), 'internal diagnostics stay in resources');
const forged = require('../case-runtime/store').technicalResponse(unknownDir, Object.assign(new Error('untrusted metadata'), {
  actionOutcome: 'UNKNOWN', operationId: 'not-the-persisted-action', technicalFactRef: unknownFact.technicalFactRef,
  outcomeKnown: false, extraPayload: { arbitrary: true },
}), { operation: 'act' });
assert.strictEqual(forged.outcomeKnown, undefined, 'a mismatched fact must not establish an uncertain action');
assert.strictEqual(forged.operationId, undefined);
assert.strictEqual(forged.extraPayload, undefined);
assert.notStrictEqual(forged.technicalFactRef, unknownFact.technicalFactRef);
assert.strictEqual(run(started.execDir, {
  operation: 'inspect', input: {
    sceneRef: observed.data.ref,
    mode: 'visual',
    observation: '首页标题清晰可见',
    checkNodeRefs: ['N2'],
  },
}, { now: '2026-09-16T01:00:00.300Z' }).result.outcome, 'VISUAL_OBSERVATION_RECORDED');
assert.strictEqual(run(started.execDir, {
  operation: 'recordResult', input: {
    results: [{
      checkNodeRef: 'N2',
      status: 'PASS',
      actual: '首页标题正常显示',
      evidence: { sceneRefs: [observed.data.ref] },
    }],
  },
}, { now: '2026-09-16T01:00:00.400Z' }).result.outcome, 'RESULTS_RECORDED');
const interruptedDir = path.join(temp, 'interrupted-finish-publication');
fs.cpSync(started.execDir, interruptedDir, { recursive: true });
const interruptedScene = require('../case-runtime/store').readCurrentScene(interruptedDir);
interruptedScene.screenshot.path = path.join(interruptedDir, interruptedScene.screenshot.ref);
require('../case-runtime/store').writeScene(interruptedDir, interruptedScene);
let publicationBoundaryReached = false;
const resourceStore = require('../case-runtime/agent-resource-store');
const finished = run(started.execDir, {
  operation: 'finish', input: { mode: 'complete', summary: '首页标题验证完成', uncertainties: [] },
}, {
  now: '2026-09-16T01:00:00.500Z',
  resourceProvider(execDir, response, request) {
    publicationBoundaryReached = true;
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(execDir, 'execution.json'))).finalized, true);
    // Deterministically enter real Batch completion after Core finish, just before
    // the Facade publishes its final resources. It must contend on the same lock.
    assert.throws(() => prepareCurrentCompletion(execDir), { code: 'EXECUTION_LOCKED' });
    assert.strictEqual(fs.existsSync(path.join(execDir, 'artifact-manifest.json')), false);
    return resourceStore.provideOperationResources(execDir, response, request);
  },
});
assert.strictEqual(publicationBoundaryReached, true);
assert.strictEqual(finished.status, 'SUCCEEDED');
assert.strictEqual(finished.result.outcome, 'COMPLETED');
const finishMetrics = readAgentFacingEvents(agentFacingFile(started.execDir)).filter((event) => event.operation === 'finish');
assert.strictEqual(finishMetrics.length, 1, 'a real facade finish records exactly one telemetry event');
assert.strictEqual(finishMetrics[0].responseBytes, Buffer.byteLength(JSON.stringify(finished)),
  'finish telemetry measures the final public response including resource refs');
assert.doesNotThrow(() => validateResultIntegrity(started.execDir,
  JSON.parse(fs.readFileSync(path.join(started.execDir, 'result.json'), 'utf8'))),
  'recording finish telemetry must preserve post-finish result integrity');

const decisionDrafts = fs.readdirSync(path.join(started.execDir, 'transactions'))
  .filter((name) => /^decision-.*\.draft\.json$/.test(name));
assert.deepStrictEqual(decisionDrafts, []);

const runtime = releaseRuntime(started.execDir);
const prepared = prepareCurrentCompletion(started.execDir);
const completion = buildCurrentCompletion(started.execDir, {
  batchId: started.execution.batchId,
  contractSha: started.execution.batchContractSha,
}, { caseKey }, prepared, runtime);
publishCurrentCompletion(started.execDir, completion);
const { validateExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');
assert.doesNotThrow(() => validateExecutionArtifactManifest(started.execDir));
assert.deepStrictEqual(prepareCurrentCompletion(started.execDir).validationContext, prepared.validationContext);
assert.strictEqual(run(started.execDir, { operation: 'read', input: { ref: finished.result.caseResultRef } }).status, 'SUCCEEDED');
assert.doesNotThrow(() => validateExecutionArtifactManifest(started.execDir));

// Crash after finalization but before any final resource publication is recovered
// by completion, without re-running finish or constructing an Agent response.
const interrupted = run(interruptedDir, {
  operation: 'finish', input: { mode: 'complete', summary: '首页标题验证完成', uncertainties: [] },
}, { now: '2026-09-16T01:00:00.500Z', resourceProvider() { throw new Error('publication interrupted'); } });
assert.strictEqual(interrupted.status, 'FAILED');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(interruptedDir, 'execution.json'))).finalized, true, JSON.stringify(interrupted));
const finalResultRef = resourceStore.resourceRef(interruptedDir, 'caseResult', 'result.json');
assert.throws(() => resourceStore.readPublishedResource(interruptedDir, finalResultRef), { code: 'RESOURCE_UNKNOWN' });
const recovered = prepareCurrentCompletion(interruptedDir);
assert.strictEqual(run(interruptedDir, { operation: 'read', input: { ref: finalResultRef } }).status, 'SUCCEEDED');
assert.ok(recovered.validationContext.artifactManifest.files.some((entry) => entry.path.includes('checkpointLedger')));
assert.deepStrictEqual(prepareCurrentCompletion(interruptedDir).validationContext, recovered.validationContext);
assert.doesNotThrow(() => validateExecutionArtifactManifest(interruptedDir));
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'artifact-manifest.json')), true);
assert.strictEqual(fs.existsSync(path.join(started.execDir, 'completion.json')), true);

refreshCommittedCaseReports(caseDir, 'harmony');
const selected = selectExecutionDir(runtimeDir);
assert.strictEqual(selected.execDir, started.execDir);
const report = readExecutionReport(selected.execDir);
assert.strictEqual(report.readability, 'READABLE');
assert.strictEqual(report.display.verdict, 'PASS');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'report-metadata.json'), 'utf8')).executionId,
  started.execution.executionId);

fs.rmSync(temp, { recursive: true, force: true });
console.log('agent-facing publication flow passed');
