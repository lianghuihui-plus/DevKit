#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildContract } = require('../build-agent-contract');
const { createExecution } = require('../case-runtime/lifecycle');
const { run } = require('../case-runtime/agent-facing-client');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { createInitialStatePreflight } = require('../lib/app-provisioning');
const { readExecutionReport } = require('../lib/execution-reader');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestWorkspace } = require('./support/workspace-fixture');
const { simpleCaseFlow } = require('./support/case-flow');

process.env.MAVT_SELF_TEST = '1';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-result-matrix-'));
const root = path.join(temp, 'workspace');
const binding = { platform: 'harmony', deviceId: 'matrix-device', appId: 'com.example.matrix', entry: 'EntryAbility' };
const currentContract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
createTestWorkspace(root);
fs.mkdirSync(path.join(root, 'knowledge'));

function runner(command, args, options) {
  if (options.kind !== 'OBSERVE') throw new Error('result matrix only observes');
  const out = args[args.indexOf('--out') + 1];
  const label = args[args.indexOf('--label') + 1];
  const screenshot = `screenshots/${label}.png`;
  fs.writeFileSync(path.join(out, screenshot), PNG);
  return { status: 0, stderr: '', stdout: JSON.stringify({
    schemaVersion: 1,
    type: 'observation',
    platform: binding.platform,
    device: { id: binding.deviceId },
    app: { appId: binding.appId, inTargetApp: true },
    artifacts: { screenshot, layout: null, logs: [] },
  }) };
}

function executeResult(verdict, options = {}) {
  const source = `验证 ${verdict} Runtime 结果闭环`;
  const suffix = verdict.toLowerCase() + (options.technical ? '-technical' : '');
  const caseKey = `ck-${crypto.createHash('sha256').update(source + suffix).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: `${verdict} Runtime`, sourceText: source, importPath: `/matrix/${suffix}.md` });
  const caseDir = path.join(root, 'cases', `${suffix}__${caseKey}`);
  const runtimeDir = path.join(caseDir, 'platforms', 'harmony');
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  const initialStateRequirement = {
    schemaVersion: 1,
    targetState: 'KEEP_EXISTING',
    rationale: '该结果矩阵用例不要求重置 App 状态',
  };
  const preparationPolicy = { schemaVersion: 1, allowedEffects: [], targetAppOnly: true };
  const initialStatePreflight = createInitialStatePreflight({
    requirement: initialStateRequirement,
    preparationPolicy,
    platform: 'harmony',
    now: '2026-09-04T02:00:00.000Z',
  });
  const started = createExecution({
    workspaceRoot: root,
    runtimeDir,
    executionId: `execution-${suffix}`,
    batchId: null,
    platform: 'harmony',
    sourceText: source,
    caseJson,
    targetBinding: binding,
    initialStateRequirement,
    initialStatePreflight,
    preparationPolicy,
    runtimeSha: currentContract.runtimeSha,
    adapterSha: currentContract.adapterSha,
    caseProtocolSha: currentContract.protocolSha,
    coordinatorProtocolSha: 'coordinator-protocol-matrix',
    batchContractSha: 'batch-contract-matrix',
    executionRequestSha: 'execution-request-matrix',
    interactionPolicy: 'UNATTENDED',
    warmSessionGeneration: 1,
    knowledgeRoots: [path.resolve(__dirname, '../../knowledge'), path.join(root, 'knowledge')],
    initialObserve: false,
    now: '2026-09-04T02:00:00.000Z',
  });
  assert.strictEqual(started.execution.schemaVersion, 14);
  assert.ok(started.execution.validationProfileSha);
  const planned = run(started.execDir, {
    operation: 'plan', input: { caseFlow: simpleCaseFlow(source, '目标页面符合用例预期') },
  }, { now: '2026-09-04T02:00:00.500Z' });
  assert.strictEqual(planned.result.outcome, 'CASE_FLOW_RECORDED');
  let technicalFactRef = null;
  const observed = run(started.execDir, {
    operation: 'observe', input: { purpose: '确认目标页面表现' },
  }, { runner, now: '2026-09-04T02:00:01.000Z' });
  assert.strictEqual(observed.status, 'SUCCEEDED');
  const visualInspection = run(started.execDir, {
    operation: 'inspect', input: { sceneRef: observed.data.ref, mode: 'visual', checkNodeRefs: ['N2'],
      observation: `截图中的目标页面表现可用于 ${verdict} 判断`,
    },
  }, { now: '2026-09-04T02:00:01.100Z' });
  assert.strictEqual(visualInspection.result.outcome, 'VISUAL_OBSERVATION_RECORDED');
  if (options.technical) {
    const technical = run(started.execDir, {
      operation: 'observe', input: { purpose: '获取可用于最终判断的现场' },
    }, {
      now: '2026-09-04T02:00:01.500Z',
      runner: () => { throw Object.assign(new Error('simulated adapter disconnection'), { code: 'ADAPTER_DISCONNECTED' }); },
    });
    assert.strictEqual(technical.status, 'FAILED');
    technicalFactRef = technical.resources.find((resource) => resource.type === 'technicalFact').ref;
    const fact = run(started.execDir, { operation: 'read', input: { ref: technicalFactRef } });
    assert.strictEqual(fact.status, 'SUCCEEDED');
    assert.strictEqual(fact.data.type, 'technicalFact');
  }

  const check = {
    checkNodeRef: 'N2',
    status: verdict,
    actual: options.technical ? 'Adapter 连接中断，验证点无法继续' : `现场判断为 ${verdict}`,
    sceneRefs: ['PASS', 'FAIL'].includes(verdict) ? [observed.data.ref] : [],
    ...(technicalFactRef ? { technicalRefs: [technicalFactRef] } : {}),
  };
  const recorded = run(started.execDir, {
    operation: 'recordResult', input: { results: [{
      checkNodeRef: check.checkNodeRef,
      status: check.status,
      actual: check.actual,
      evidence: {
        ...(['PASS', 'FAIL'].includes(verdict) ? { sceneRefs: [observed.data.ref] } : {}),
        ...(technicalFactRef ? { technicalRefs: [technicalFactRef] } : {}),
      },
    }] },
  }, { now: '2026-09-04T02:00:01.900Z' });
  assert.strictEqual(recorded.result.outcome, 'RESULTS_RECORDED', JSON.stringify(recorded));
  const finishInput = {
    operation: 'finish', input: { mode: 'complete', summary: `${verdict} Runtime 结果`,
      uncertainties: verdict === 'INCONCLUSIVE' ? ['现场不足以可靠判断'] : [],
    },
  };
  const review = run(started.execDir, finishInput, { now: '2026-09-04T02:00:02.000Z' });
  assert.strictEqual(review.error.code, 'CASE_FINAL_REVIEW_REQUIRED');
  const finished = run(started.execDir, finishInput, { now: '2026-09-04T02:00:03.000Z' });
  assert.strictEqual(finished.result.outcome, 'COMPLETED');
  const report = readExecutionReport(started.execDir);
  assert.strictEqual(report.display.verdict, verdict);
  if (technicalFactRef) {
    const fact = report.events.find((event) => event.code === 'ADAPTER_DISCONNECTED');
    assert.strictEqual(fact.executionId, started.execution.executionId);
    assert.strictEqual(fact.decisionId !== null, true);
    assert.deepStrictEqual(fact.expectationRefs, ['N2']);
    assert.strictEqual(fact.sceneId, report.events.find((event) => event.type === 'visualInspected').sceneId);
    assert.strictEqual(fact.generation, started.execution.warmSessionGeneration);
  }
  return report;
}

for (const verdict of ['PASS', 'FAIL', 'INCONCLUSIVE']) executeResult(verdict);
const businessBlocked = executeResult('BLOCKED');
assert.strictEqual(businessBlocked.display.verdictBasis, 'INSUFFICIENT_EVIDENCE');
const technicalBlocked = executeResult('BLOCKED', { technical: true });
assert.strictEqual(technicalBlocked.display.verdictBasis, 'TECHNICAL_CONSTRAINT');
assert.strictEqual(technicalBlocked.display.failureCode, 'ADAPTER_DISCONNECTED');

fs.rmSync(temp, { recursive: true, force: true });
console.log('runtime result matrix passed');
