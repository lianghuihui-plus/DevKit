#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrapBatch, initializeBatch, startCurrentCase } = require('../batch/core');
const { run } = require('../case-runtime/agent-facing-client');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { derivePreparationPolicy, preparationPolicySha } = require('../lib/app-provisioning');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-app-preparation-'));
const root = path.join(temp, 'workspace');
const binding = { platform: 'harmony', deviceId: 'preparation-device', appId: 'com.example.preparation', entry: 'EntryAbility' };
const T0 = '2026-09-08T10:00:00.000Z';
createTestWorkspace(root);

function makeCase(name) {
  const source = `验证 ${name} 的首次启动状态`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText: source, importPath: `/fixture/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  return { caseKey, caseDir, source };
}

function observeRunner(command, args, options) {
  assert.strictEqual(options.kind, 'OBSERVE');
  const out = args[args.indexOf('--out') + 1];
  const label = args[args.indexOf('--label') + 1];
  const screenshot = `screenshots/${label}.png`;
  fs.writeFileSync(path.join(out, screenshot), PNG);
  return { status: 0, stderr: '', stdout: JSON.stringify({
    schemaVersion: 1, type: 'observation', platform: binding.platform, time: T0,
    device: { id: binding.deviceId }, app: { appId: binding.appId, inTargetApp: true },
    artifacts: { screenshot, layout: null, logs: [] },
  }) };
}

function start(batchId, target) {
  createTestExecutionRequest(root, batchId, binding, [target], { now: T0 });
  initializeBatch({ workspaceRoot: root, batchId, now: T0 });
  bootstrapBatch({
    workspaceRoot: root, batchId,
    adapter: { restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }) },
    now: T0,
  });
  const started = startCurrentCase({ workspaceRoot: root, batchId, now: T0, runtimeOptions: { runner: observeRunner } });
  const execDir = fs.realpathSync(path.join(target.caseDir, 'platforms', binding.platform, 'executions', started.executionId));
  const plan = run(execDir, {
    capability: 'plan', understanding: `验证 ${target.source} 的空数据首次启动状态`,
    preconditions: ['目标 App 本地数据为空'], verificationPoints: [{ text: '首次启动页面可见' }],
    items: ['建立空数据状态', '观察首次启动页面'], uncertainties: [],
  }, { now: T0 });
  assert.strictEqual(plan.status, 'CASE_MODEL_RECORDED');
  return { started, execDir };
}

const allowed = makeCase('允许清理');
const allowedRun = start('batch-preparation-allowed', allowed);
const executionPath = path.join(allowedRun.execDir, 'execution.json');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
const authorizedPolicy = derivePreparationPolicy('harmony', 'APP_LOCAL_STATE_EMPTY');
writeJsonAtomic(executionPath, {
  ...execution,
  preparationPolicy: authorizedPolicy,
  preparationPolicySha: preparationPolicySha(authorizedPolicy),
});
let preparationCalls = 0;
const prepared = run(allowedRun.execDir, {
  capability: 'recover', reason: '用例前置条件要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY',
}, {
  now: T0,
  runner: observeRunner,
  invokeAppPreparation: (execDir, request) => {
    preparationCalls += 1;
    assert.strictEqual(request.strategy, 'CLEAR_APP_DATA');
    return { schemaVersion: 1, type: 'appPreparationResult', platform: 'harmony', strategy: request.strategy, ok: true, status: 'SUCCEEDED', device: { id: binding.deviceId }, app: { appId: binding.appId } };
  },
  restartApp: () => ({ coldStartVerified: true, startupDisplayVerified: true }),
});
assert.strictEqual(allowedRun.started.agentRequired, true);
assert.strictEqual(prepared.status, 'SCENE');
assert.strictEqual(prepared.preparation.status, 'SATISFIED');
assert.strictEqual(prepared.preparation.sessionId, 'warm-0002');
assert.strictEqual(preparationCalls, 1);
const preparedEvents = fs.readFileSync(path.join(allowedRun.execDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const preparationEvent = preparedEvents.find((event) => event.type === 'appPreparationCompleted');
assert.strictEqual(preparationEvent.caseModelRevision, 1);

const denied = makeCase('未授权清理');
const deniedRun = start('batch-preparation-denied', denied);
let deniedCalls = 0;
const deniedResponse = run(deniedRun.execDir, {
  capability: 'recover', reason: '用例前置条件要求空本地状态', targetState: 'APP_LOCAL_STATE_EMPTY',
}, {
  now: T0,
  invokeAppPreparation: () => { deniedCalls += 1; },
});
assert.strictEqual(deniedResponse.status, 'TECHNICAL');
assert.strictEqual(deniedResponse.code, 'APP_INITIAL_STATE_UNAVAILABLE');
assert.match(deniedResponse.technicalFactRef, /^technical-fact-/);
assert.strictEqual(deniedCalls, 0);
assert.strictEqual(deniedResponse.technicalContext.scope, 'EXECUTION');
assert.deepStrictEqual(deniedResponse.technicalContext.resume, { capability: 'observe' });

fs.rmSync(temp, { recursive: true, force: true });
console.log('app preparation passed');
