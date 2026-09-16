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
const { createTestWorkspace } = require('./current-fixture');

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
  capability: 'plan',
  caseModel: {
    baseRevision: null,
    understanding: source,
    preconditions: [],
    verificationPoints: [{ text: '首页标题正常显示' }],
    items: ['观察首页', '检查标题', '记录验证结果'],
    uncertainties: [],
  },
}, { now: '2026-09-16T01:00:00.100Z' }).status, 'CASE_MODEL_RECORDED');

const observed = run(started.execDir, { capability: 'observe', purpose: '采集首页现场' }, {
  runner,
  now: '2026-09-16T01:00:00.200Z',
});
assert.strictEqual(observed.status, 'SCENE');
assert.strictEqual(run(started.execDir, {
  capability: 'inspect',
  basedOnSceneRef: observed.scene.sceneRef,
  channel: 'visual',
  observation: '首页标题清晰可见',
  expectationRefs: ['E1'],
}, { now: '2026-09-16T01:00:00.300Z' }).status, 'VISUAL_INSPECTED');
assert.strictEqual(run(started.execDir, {
  capability: 'recordResult',
  results: [{
    expectationRef: 'E1',
    status: 'PASS',
    actual: '首页标题正常显示',
    evidence: { sceneRefs: [observed.scene.sceneRef] },
  }],
}, { now: '2026-09-16T01:00:00.400Z' }).status, 'RESULTS_RECORDED');
assert.strictEqual(run(started.execDir, {
  capability: 'finish', summary: '首页标题验证完成', uncertainties: [],
}, { now: '2026-09-16T01:00:00.500Z' }).status, 'COMPLETED');

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
