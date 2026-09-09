#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildContract } = require('../build-agent-contract');
const { createExecution } = require('../case-runtime/lifecycle');
const { run } = require('../case-runtime/runtime-client');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { createCaseSpec } = require('../execution/contracts/case-spec-contract');
const { createInitialStatePreflight } = require('../lib/app-provisioning');
const { readExecutionReport } = require('../lib/execution-reader');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestWorkspace } = require('./current-fixture');

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
  const caseSpec = createCaseSpec({
    sourceText: source,
    spec: {
      summary: source,
      preconditions: ['目标 App 已启动'],
      expectations: [{ text: '目标页面符合用例预期', sourceEvidence: [{ quote: source }] }],
      ambiguities: [],
    },
  });
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
    caseSpec,
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
  let technicalFactRef = null;
  const observed = run(started.execDir, {
    operation: 'observe',
    decision: {
      observation: options.technical ? '技术错误后重新取得现场' : '开始检查目标页面',
      conclusion: '当前 Scene 可用于结果判断',
      purpose: '确认目标页面表现',
      expectedOutcome: '获得验证点的客观现场',
      expectationRefs: ['E1'],
    },
  }, { runner, now: '2026-09-04T02:00:01.000Z' });
  assert.strictEqual(observed.status, 'SCENE');
  const visualInspection = run(started.execDir, {
    operation: 'inspectVisual',
    basedOnSceneId: observed.scene.sceneId,
    decision: {
      purpose: '检查结果矩阵现场截图',
      expectationRefs: ['E1'],
      observation: `截图中的目标页面表现可用于 ${verdict} 判断`,
    },
  }, { now: '2026-09-04T02:00:01.100Z' });
  assert.strictEqual(visualInspection.status, 'VISUAL_INSPECTED');

  if (options.technical) {
    const technical = run(started.execDir, {
      operation: 'observe',
      decision: {
        observation: '当前 Scene 仍需刷新才能完成验证',
        conclusion: '继续采集最终现场',
        purpose: '获取可用于最终判断的现场',
        expectedOutcome: '获得最新目标页面截图',
        expectationRefs: ['E1'],
      },
    }, {
      now: '2026-09-04T02:00:01.500Z',
      runner: () => { throw Object.assign(new Error('simulated adapter disconnection'), { code: 'ADAPTER_DISCONNECTED' }); },
    });
    assert.strictEqual(technical.status, 'TECHNICAL');
    assert.match(technical.technicalFactRef, /^technical-fact-\d{4}$/);
    technicalFactRef = technical.technicalFactRef;
  }

  if (verdict !== 'PASS' && !options.technical) {
    const knowledge = run(started.execDir, {
      operation: 'knowledge',
      basedOnSceneId: observed.scene.sceneId,
      query: `${verdict} 现场是否存在已知解释`,
      decision: {
        observation: '现场没有满足目标验证点',
        conclusion: '需要查询知识后再形成负向结论',
        purpose: '调查异常现场',
        expectedOutcome: '确认是否存在适用的业务解释',
        expectationRefs: ['E1'],
      },
    }, { now: '2026-09-04T02:00:01.500Z' });
    assert.strictEqual(knowledge.status, 'KNOWLEDGE');
    assert.strictEqual(knowledge.candidates.length, 0);
  }

  const check = {
    expectationRef: 'E1',
    status: verdict,
    actual: options.technical ? 'Adapter 连接中断，验证点无法继续' : `现场判断为 ${verdict}`,
    sceneRefs: ['PASS', 'FAIL'].includes(verdict) ? [observed.scene.sceneId] : [],
    ...(technicalFactRef ? { technicalRefs: [technicalFactRef] } : {}),
  };
  const finished = run(started.execDir, {
    operation: 'finish',
    basedOnSceneId: observed.scene.sceneId,
    decision: {
      observation: check.actual,
      conclusion: `E1 最终状态为 ${verdict}`,
      purpose: '提交最终结论',
      expectedOutcome: '验证点与结论完整关联',
      expectationRefs: ['E1'],
    },
    result: { verdict, summary: `${verdict} Runtime 结果`, checks: [check], uncertainties: verdict === 'INCONCLUSIVE' ? ['现场不足以可靠判断'] : [] },
  }, { now: '2026-09-04T02:00:02.000Z' });
  assert.strictEqual(finished.status, 'COMPLETED');
  const report = readExecutionReport(started.execDir);
  assert.strictEqual(report.display.verdict, verdict);
  if (technicalFactRef) {
    const fact = report.events.find((event) => event.technicalFactRef === technicalFactRef);
    assert.strictEqual(fact.executionId, started.execution.executionId);
    assert.strictEqual(fact.decisionId !== null, true);
    assert.deepStrictEqual(fact.expectationRefs, ['E1']);
    assert.strictEqual(fact.sceneId, observed.scene.sceneId);
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
