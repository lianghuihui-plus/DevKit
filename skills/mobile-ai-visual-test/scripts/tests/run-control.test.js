#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCaseContract } = require('../execution/contracts/case-contract');
const {
  confirmEnvironment,
  createExecutionRequest,
  executionRequestDraftPath,
  loadExecutionRequest,
  validateExecutionRequest,
} = require('../lib/run-control');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateBinding } = require('../lib/batch-contract');
const { createTestWorkspace } = require('./current-fixture');

const T0 = '2026-08-18T10:00:00.000Z';
const T1 = '2026-08-18T10:01:00.000Z';
const SKILL_ROOT = path.resolve(__dirname, '..', '..');
const BINDING = Object.freeze({
  platform: 'harmony',
  deviceId: 'device-control-001',
  appId: 'com.example.control',
  entry: 'EntryAbility',
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function makeCase(root, name) {
  const sourceText = `验证 ${name}`;
  const caseKey = `ck-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
  const caseJson = createCaseContract({ caseKey, title: name, sourceText, importPath: `/fixtures/${name}.md` });
  const caseDir = path.join(root, 'cases', `${name}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
  writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);
  return { caseKey, caseDir, sourceText };
}

function probe(binding = BINDING, ready = true) {
  return { schemaVersion: 1, platform: binding.platform, ready, devices: [{ id: binding.deviceId || binding.device }] };
}

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-run-control-'));
const root = path.join(temp, 'workspace');
createTestWorkspace(root);
const first = makeCase(root, 'first');
const second = makeCase(root, 'second');

expectCode(() => createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-before-confirmation',
  mode: 'SINGLE',
  targets: [first],
  userInstruction: '单独执行 first',
  now: T0,
}), 'ENVIRONMENT_NOT_CONFIRMED');
expectCode(() => confirmEnvironment({
  workspaceRoot: root,
  binding: BINDING,
  probe: probe(BINDING, false),
  userConfirmation: '确认环境',
  now: T0,
}), 'ENVIRONMENT_NOT_READY');
expectCode(() => confirmEnvironment({
  workspaceRoot: root,
  binding: BINDING,
  probe: { ...probe(), devices: [{ id: 'another-device' }] },
  userConfirmation: '确认环境',
  now: T0,
}), 'ENVIRONMENT_CONFIRMATION_INVALID');

const environment = confirmEnvironment({
  workspaceRoot: root,
  binding: BINDING,
  probe: probe(),
  userConfirmation: '确认使用 device-control-001 和目标应用',
  now: T0,
});
assert.strictEqual(environment.status, 'CONFIRMED');
assert.strictEqual(environment.binding.deviceId, BINDING.deviceId);
assert.strictEqual(Object.hasOwn(environment.binding, 'device'), false);
assert.strictEqual(fs.existsSync(path.join(root, 'runs')), false);

assert.deepStrictEqual(validateBinding({
  platform: 'android', device: 'legacy-android-device', appId: 'com.example.android', entry: '.MainActivity',
}), {
  platform: 'android', deviceId: 'legacy-android-device', appId: 'com.example.android', entry: '.MainActivity',
});
expectCode(() => validateBinding({
  platform: 'android', device: 'legacy-device', deviceId: 'different-device', appId: 'com.example.android', entry: '.MainActivity',
}), 'BATCH_CONTRACT_INVALID');
const legacyRoot = path.join(temp, 'legacy-device-workspace');
createTestWorkspace(legacyRoot);
const legacyEnvironment = confirmEnvironment({
  workspaceRoot: legacyRoot,
  binding: { platform: 'android', device: 'legacy-android-device', appId: 'com.example.android', entry: '.MainActivity' },
  probe: { schemaVersion: 1, platform: 'android', ready: true, devices: [{ serial: 'legacy-android-device' }] },
  userConfirmation: '确认旧设备字段输入',
  now: T0,
});
assert.deepStrictEqual(legacyEnvironment.binding, {
  platform: 'android', deviceId: 'legacy-android-device', appId: 'com.example.android', entry: '.MainActivity',
});
const numberedFirst = JSON.parse(fs.readFileSync(path.join(first.caseDir, 'case.json'), 'utf8'));
const numberedSecond = JSON.parse(fs.readFileSync(path.join(second.caseDir, 'case.json'), 'utf8'));
assert.strictEqual(numberedFirst.identity.caseNo, '001');
assert.strictEqual(numberedSecond.identity.caseNo, '002');

const numberedRequest = createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-by-case-no',
  mode: 'SINGLE',
  targets: [{ caseNo: '002' }],
  userInstruction: '单独执行用例 002',
  now: T0,
});
assert.strictEqual(numberedRequest.targets[0].caseKey, second.caseKey);
assert.strictEqual(numberedRequest.targets[0].caseNo, '002');
assert.strictEqual(createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-by-case-no',
  mode: 'SINGLE',
  targets: [{ caseNo: 2 }],
  userInstruction: '单独执行用例 002',
  now: T1,
}).requestSha, numberedRequest.requestSha);
expectCode(() => createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-missing-case-no',
  mode: 'SINGLE',
  targets: [{ caseNo: '999' }],
  userInstruction: '单独执行不存在的用例',
  now: T0,
}), 'EXECUTION_REQUEST_TARGET_NOT_FOUND');

expectCode(() => createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-empty-instruction',
  mode: 'SINGLE',
  targets: [first],
  userInstruction: '   ',
  now: T0,
}), 'EXECUTION_REQUEST_INVALID');
expectCode(() => createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-single-many',
  mode: 'SINGLE',
  targets: [first, second],
  userInstruction: '单独执行用例',
  now: T0,
}), 'EXECUTION_REQUEST_INVALID');

const outsideRoot = path.join(temp, 'outside-workspace');
createTestWorkspace(outsideRoot);
const outside = makeCase(outsideRoot, 'outside');
expectCode(() => createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-outside',
  mode: 'SINGLE',
  targets: [outside],
  userInstruction: '单独执行外部用例',
  now: T0,
}), 'EXECUTION_REQUEST_TARGET_OUTSIDE_WORKSPACE');

const batch = createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-ordered',
  mode: 'BATCH',
  targets: [second, first],
  userInstruction: '按 second、first 的顺序批量执行',
  now: T0,
});
assert.strictEqual(batch.interactionPolicy, 'UNATTENDED');
assert.deepStrictEqual(batch.targets.map((target) => target.caseKey), [second.caseKey, first.caseKey]);
assert.strictEqual(fs.existsSync(path.join(root, 'runs', 'batch-ordered', 'batch.json')), false);
expectCode(() => validateExecutionRequest({ ...batch, interactionPolicy: 'INTERACTIVE' }), 'EXECUTION_REQUEST_INVALID');
const repeated = createExecutionRequest({
  workspaceRoot: root,
  batchId: 'batch-ordered',
  mode: 'BATCH',
  targets: [second, first],
  userInstruction: '按 second、first 的顺序批量执行',
  now: T1,
});
assert.strictEqual(repeated.requestSha, batch.requestSha);

for (const interruptAfter of ['draft', 'snapshot-1', 'request']) {
  const interruptedBatchId = `batch-interrupted-${interruptAfter}`;
  assert.throws(() => createExecutionRequest({
    workspaceRoot: root,
    batchId: interruptedBatchId,
    mode: 'SINGLE',
    targets: [{ caseKey: first.caseKey, caseDir: first.caseDir }],
    userInstruction: '单个执行冻结恢复用例',
    skillRoot: SKILL_ROOT,
    provider: 'codex',
    interruptAfter,
    now: T0,
  }), /MAVT_EXECUTION_REQUEST_INTERRUPTED/);
  fs.writeFileSync(path.join(first.caseDir, 'source.md'), '授权后实时用例被修改');
  const resumed = createExecutionRequest({
    workspaceRoot: root,
    batchId: interruptedBatchId,
    mode: 'SINGLE',
    targets: [{ caseKey: first.caseKey, caseDir: first.caseDir }],
    userInstruction: '单个执行冻结恢复用例',
    skillRoot: SKILL_ROOT,
    provider: 'codex',
    now: '2026-08-13T10:05:00.000Z',
  });
  assert.strictEqual(fs.readFileSync(path.join(resumed.targets[0].snapshotPath, 'source.snapshot.md'), 'utf8'), first.sourceText);
  assert.strictEqual(fs.existsSync(executionRequestDraftPath(root, interruptedBatchId)), false);
  fs.writeFileSync(path.join(first.caseDir, 'source.md'), first.sourceText);
}

const frozenSecond = fs.readFileSync(path.join(batch.targets[0].snapshotPath, 'source.snapshot.md'), 'utf8');
fs.writeFileSync(path.join(second.caseDir, 'source.md'), '删除账号并确认不可恢复');
assert.strictEqual(fs.readFileSync(path.join(batch.targets[0].snapshotPath, 'source.snapshot.md'), 'utf8'), frozenSecond);
assert.strictEqual(loadExecutionRequest(root, 'batch-ordered').targets[0].sourceSha, batch.targets[0].sourceSha);

const changedBinding = { ...BINDING, deviceId: 'device-control-002' };
confirmEnvironment({
  workspaceRoot: root,
  binding: changedBinding,
  probe: probe(changedBinding),
  userConfirmation: '改为使用 device-control-002',
  now: T1,
});
expectCode(() => loadExecutionRequest(root, 'batch-ordered'), 'EXECUTION_REQUEST_ENVIRONMENT_CHANGED');

fs.rmSync(temp, { recursive: true, force: true });
console.log('run-control passed');
