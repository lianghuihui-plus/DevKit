#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrapBatch, commitCurrentCase, initializeBatch, startCurrentCase } = require('../batch/core');
const { buildContract } = require('../build-agent-contract');
const { run: runAgentFacing } = require('../case-runtime/agent-facing-client');
const { executeFacadeRequest: run } = require('../case-runtime/runtime-broker');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./support/workspace-fixture');
const { simpleCaseFlow } = require('./support/case-flow');

process.env.MAVT_SELF_TEST = '1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-warm-current-')), 'workspace');
createTestWorkspace(root);
const binding = { platform: 'harmony', deviceId: 'warm-device', appId: 'com.example.warm', entry: 'EntryAbility' };

function createCase(index) {
  const source = `验证暖会话中的第 ${index} 个用例`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const contract = createCaseContract({ caseKey, title: `暖会话用例 ${index}`, sourceText: source, importPath: `/fixture/${index}.md` });
  const caseDir = path.join(root, 'cases', `warm-${index}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), contract);
  return { caseKey, caseDir };
}

const targets = [createCase(1), createCase(2)];
const batchId = 'batch-warm-current';
const protocol = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
createTestExecutionRequest(root, batchId, binding, targets, { mode: 'BATCH', now: '2026-09-04T10:00:00.000Z' });
initializeBatch({ workspaceRoot: root, batchId, implementationSha: protocol.implementationSha, now: '2026-09-04T10:00:00.000Z' });
let appStartCount = 0;
const adapter = {
  restartApp: () => {
    appStartCount += 1;
    return { ok: true, coldStartVerified: true, startupDisplayVerified: true };
  },
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId, implementationSha: protocol.implementationSha, adapter, now: '2026-09-04T10:00:00.100Z' });
assert.strictEqual(appStartCount, 1);

function runner(command, args, options) {
  if (options.kind !== 'OBSERVE') throw new Error('warm-session test does not need a device action');
  const out = args[args.indexOf('--out') + 1];
  const label = args[args.indexOf('--label') + 1];
  const screenshot = `screenshots/${label}.png`;
  fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(out, screenshot), PNG);
  return { status: 0, stderr: '', stdout: JSON.stringify({
    schemaVersion: 1, type: 'observation', platform: 'harmony',
    device: { id: binding.deviceId }, app: { appId: binding.appId, inTargetApp: true },
    artifacts: { screenshot, layout: null, logs: [] },
  }) };
}

function completeCase(started, index) {
  const at = `2026-09-04T10:00:0${index}.000Z`;
  const observed = run(started.execDir, { operation: 'observe' }, { runner, now: at });
  assert.strictEqual(observed.status, 'SCENE');
  const planned = runAgentFacing(started.execDir, {
    capability: 'plan', caseFlow: simpleCaseFlow(`验证第 ${index} 个暖会话用例`, '目标页面正常显示'),
  }, { now: at });
  assert.strictEqual(planned.status, 'CASE_FLOW_RECORDED');
  const visualInspection = run(started.execDir, {
    operation: 'inspectVisual',
    basedOnSceneId: observed.scene.sceneId,
    decision: {
      purpose: `检查第 ${index} 个暖会话用例截图`,
      expectationRefs: ['N2'],
      observation: '截图显示目标页面',
    },
  }, { now: at });
  assert.strictEqual(visualInspection.status, 'VISUAL_INSPECTED');
  const finished = run(started.execDir, {
    operation: 'finish',
    basedOnSceneId: observed.scene.sceneId,
    decision: {
      observation: '目标页面可见', conclusion: '验证点已满足', purpose: '提交最终结论',
      expectedOutcome: '结果与当前 Scene 关联', expectationRefs: ['N2'],
    },
    result: {
      verdict: 'PASS', summary: '目标页面正常显示',
      checks: [{ checkNodeRef: 'N2', status: 'PASS', actual: '目标页面可见', sceneRefs: [observed.scene.sceneId] }],
      uncertainties: [],
    },
  }, { now: at });
  assert.strictEqual(finished.status, 'COMPLETED');
  return JSON.parse(fs.readFileSync(path.join(started.execDir, 'metrics.json'), 'utf8'));
}

const firstResponse = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: protocol.implementationSha, executionId: 'execution-warm-001', now: '2026-09-04T10:00:01.000Z' });
const firstExecDir = fs.realpathSync(path.join(targets[0].caseDir, 'platforms', binding.platform, 'executions', firstResponse.executionId));
const first = {
  execDir: firstExecDir,
  execution: JSON.parse(fs.readFileSync(path.join(firstExecDir, 'execution.json'), 'utf8')),
};
const firstRuntime = JSON.parse(fs.readFileSync(path.join(firstExecDir, 'runtime.json'), 'utf8'));
assert.strictEqual(Object.hasOwn(firstRuntime.sessionRef, 'platformResource'), false);
assert.strictEqual(first.execution.warmSessionReused, false);
const firstMetrics = completeCase(first, 1);
assert.strictEqual(firstMetrics.warmSessionReused, false);
commitCurrentCase({ workspaceRoot: root, batchId, implementationSha: protocol.implementationSha, now: '2026-09-04T10:00:01.500Z' });

const secondResponse = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: protocol.implementationSha, executionId: 'execution-warm-002', now: '2026-09-04T10:00:02.000Z' });
const secondExecDir = fs.realpathSync(path.join(targets[1].caseDir, 'platforms', binding.platform, 'executions', secondResponse.executionId));
const second = {
  execDir: secondExecDir,
  execution: JSON.parse(fs.readFileSync(path.join(secondExecDir, 'execution.json'), 'utf8')),
};
assert.strictEqual(second.execution.warmSessionReused, true);
assert.strictEqual(appStartCount, 1);
const secondMetrics = completeCase(second, 2);
assert.strictEqual(secondMetrics.warmSessionReused, true);
commitCurrentCase({ workspaceRoot: root, batchId, implementationSha: protocol.implementationSha, now: '2026-09-04T10:00:02.500Z' });
assert.strictEqual(appStartCount, 1);

fs.rmSync(path.dirname(root), { recursive: true, force: true });
console.log('current warm session passed');
