#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  COORDINATOR_CAPABILITIES,
  capabilityCards,
  validateCoordinatorRequest,
} = require('../coordinator/agent-facing-contract');
const {
  advanceRun,
  cancelRun,
  confirmRun,
  loadCoordinatorState,
  prepareRun,
} = require('../coordinator/agent-facing-service');
const coordinatorAgent = require('../coordinator-agent');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { publishCaseDefinition } = require('../case/definition-store');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-coordinator-facing-'));
const workspace = path.join(temp, 'workspace');
createTestWorkspace(workspace);
fs.mkdirSync(path.join(workspace, 'knowledge'));

function createCase(caseNo) {
  const source = `验证用例 ${caseNo} 的目标页面`;
  const caseKey = `ck-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
  const caseDir = path.join(workspace, 'cases', `${caseNo}__${caseKey}`);
  fs.mkdirSync(caseDir, { recursive: true });
  fs.writeFileSync(path.join(caseDir, 'source.md'), source);
  writeJsonAtomic(path.join(caseDir, 'case.json'), createCaseContract({
    caseKey, caseNo, title: `${caseNo} 用例`, sourceText: source, importPath: `/fixture/${caseNo}.md`,
  }));
  return { caseNo, caseKey, caseDir, source };
}

function publish(testCase) {
  return publishCaseDefinition({
    caseDir: testCase.caseDir,
    compilerProfileSha: 'coordinator-facing-test',
    now: '2026-09-11T02:00:00.000Z',
    candidate: {
      summary: testCase.source,
      preconditions: [],
      expectations: [{ text: testCase.source, sourceEvidence: [{ quote: testCase.source }] }],
      ambiguities: [],
      initialStateIntent: { targetState: 'KEEP_EXISTING', rationale: '测试夹具保留现有状态', sourceEvidence: [] },
    },
  });
}

const case014 = createCase('014');
const case015 = createCase('015');

assert.deepStrictEqual(COORDINATOR_CAPABILITIES, ['prepareRun', 'confirmRun', 'advanceRun', 'cancelRun']);
const cards = capabilityCards();
assert.deepStrictEqual(Object.keys(cards), COORDINATOR_CAPABILITIES);
for (const card of Object.values(cards)) {
  assert.ok(card.useWhen);
  assert.ok(card.example);
  assert.deepStrictEqual(validateCoordinatorRequest(card.example), []);
}
for (const hidden of ['batchId', 'definitionRef', 'runtimeSha', 'adapterSha', 'coordinatorProtocolSha']) {
  assert.strictEqual(JSON.stringify(cards).includes(hidden), false, `Agent-facing cards must not expose ${hidden}`);
}

const prepared = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014', '015'] }, {
  batchId: 'batch-coordinator-facing',
  now: '2026-09-11T02:00:00.000Z',
});
assert.strictEqual(prepared.status, 'NEED_COMPILER');
assert.strictEqual(prepared.caseNo, '014');
assert.ok(prepared.loaderCommand);
assert.match(prepared.delegationPrompt, /独立 Case Definition Compiler/);
assert.strictEqual(prepared.source, undefined);
assert.strictEqual(prepared.caseDir, undefined);
assert.strictEqual(prepared.definition, undefined);
assert.ok(prepared.commands.advance);
assert.ok(prepared.commands.confirm.command);
assert.ok(prepared.commands.confirm.requestPath);
assert.ok(prepared.commands.cancel.command);
assert.ok(fs.existsSync(prepared.statePath));
assert.strictEqual(Object.prototype.hasOwnProperty.call(loadCoordinatorState(prepared.statePath), 'schemaVersion'), false);

publish(case014);
const nextCompiler = advanceRun(prepared.statePath, { now: '2026-09-11T02:00:01.000Z' });
assert.strictEqual(nextCompiler.status, 'NEED_COMPILER');
assert.strictEqual(nextCompiler.caseNo, '015');
assert.notStrictEqual(nextCompiler.loaderCommand, prepared.loaderCommand);

publish(case015);
const needPlatform = advanceRun(prepared.statePath, { now: '2026-09-11T02:00:02.000Z' });
assert.strictEqual(needPlatform.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(needPlatform.reason, 'SELECT_PLATFORM');
assert.deepStrictEqual(needPlatform.confirmTemplate, { capability: 'confirmRun', platform: 'harmony' });

const probe = {
  schemaVersion: 1,
  type: 'environmentProbe',
  platform: 'harmony',
  ready: true,
  devices: [{ id: 'device-001', serial: 'device-001', deviceFormFactor: 'phone' }],
  diagnostics: [],
  capabilities: { screenshot: true, layout: true },
};
const needBinding = confirmRun(prepared.statePath, { capability: 'confirmRun', platform: 'harmony' }, {
  probeEnvironment: () => probe,
  now: '2026-09-11T02:00:03.000Z',
});
assert.strictEqual(needBinding.status, 'NEED_USER_CONFIRMATION');
assert.strictEqual(needBinding.reason, 'CONFIRM_ENVIRONMENT_AND_RUN');
assert.deepStrictEqual(needBinding.devices, probe.devices);
assert.deepStrictEqual(needBinding.confirmTemplate, {
  capability: 'confirmRun',
  userInstruction: '确认在所选设备和 App 上执行用例 014, 015',
  binding: {
    platform: 'harmony', deviceId: 'device-001', appId: '<target-app-id>', entry: '<entry-ability>',
    deviceFormFactor: 'phone',
  },
});
assert.strictEqual(JSON.stringify(needBinding).includes('probeJson'), false);

const initCalls = [];
const confirmed = confirmRun(prepared.statePath, {
  capability: 'confirmRun',
  userInstruction: '确认执行 014 和 015 用例',
  binding: {
    platform: 'harmony', deviceId: 'device-001', appId: 'com.example.coordinator', entry: 'EntryAbility',
    deviceFormFactor: 'phone',
  },
}, {
  batchExecute: (input) => { initCalls.push(input); return { state: { status: 'INITIALIZING' } }; },
  now: '2026-09-11T02:00:04.000Z',
});
assert.strictEqual(confirmed.status, 'CONFIRMED');
assert.deepStrictEqual(initCalls.map((item) => item.command), ['init']);
assert.strictEqual(readJson(path.join(workspace, 'runs', 'batch-coordinator-facing', 'execution-request.json'), null).targets.length, 2);
assert.strictEqual(loadCoordinatorState(prepared.statePath).phase, 'BATCH_READY');

const calls = [];
const sequence = [
  { action: 'BOOTSTRAP' },
  { action: 'NEED_CASE_AGENT', batchAction: 'START_CASE', batchId: 'batch-coordinator-facing', caseKey: case014.caseKey },
];
const needsCaseAgent = advanceRun(prepared.statePath, {
  batchExecute: (input) => {
    calls.push(input.command);
    if (input.command === 'reconcile') return sequence.shift();
    if (input.command === 'bootstrap') return { state: { status: 'RUNNING' } };
    if (input.command === 'start') return {
      action: 'DELEGATE_CASE_AGENT', agentRequired: true, batchId: 'batch-coordinator-facing',
      caseKey: case014.caseKey, executionId: 'execution-014',
      handoff: { loaderCommand: 'opaque-case-loader', path: '/must/not/leak', sha256: 'must-not-leak' },
    };
    throw new Error(`unexpected command ${input.command}`);
  },
  now: '2026-09-11T02:00:05.000Z',
});
assert.strictEqual(needsCaseAgent.status, 'NEED_CASE_AGENT');
assert.strictEqual(needsCaseAgent.loaderCommand, 'opaque-case-loader');
assert.match(needsCaseAgent.delegationPrompt, /独立 Case Agent/);
assert.deepStrictEqual(calls, ['reconcile', 'bootstrap', 'reconcile', 'start']);
for (const hidden of ['handoff', 'path', 'sha256', 'brief', 'source']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(needsCaseAgent, hidden), false, `dispatch response must not expose ${hidden}`);
}

const waiting = advanceRun(prepared.statePath, {
  batchExecute: () => ({ action: 'WAIT_CASE_AGENT', batchId: 'batch-coordinator-facing', caseKey: case014.caseKey, executionId: 'execution-014' }),
});
assert.deepStrictEqual(waiting.status, 'WAITING');
assert.strictEqual(waiting.reason, 'CASE_AGENT_RUNNING');
assert.strictEqual(waiting.commands.advance, prepared.commands.advance);

const complete = advanceRun(prepared.statePath, {
  batchExecute: () => ({ action: 'BATCH_COMPLETE', state: { status: 'COMPLETED' } }),
});
assert.strictEqual(complete.status, 'COMPLETE');
assert.strictEqual(complete.outcome, 'COMPLETED');
assert.strictEqual(complete.reportPath, path.join(workspace, 'index.html'));
assert.strictEqual(loadCoordinatorState(prepared.statePath).phase, 'COMPLETE');

function prepareConfirmedRun(batchId) {
  const start = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, { batchId });
  const ready = confirmRun(start.statePath, {
    capability: 'confirmRun', userInstruction: `确认执行 ${batchId}`,
  }, { batchExecute: () => ({ state: { status: 'INITIALIZING' } }) });
  assert.strictEqual(ready.status, 'CONFIRMED');
  return start;
}

const cancelledRun = prepareConfirmedRun('batch-coordinator-cancelled');
const cancelCalls = [];
const cancelled = cancelRun(cancelledRun.statePath, { capability: 'cancelRun', reason: '用户取消测试' }, {
  batchExecute: (input) => {
    cancelCalls.push(input.command);
    if (input.command === 'cancel') return { state: { status: 'CANCELLING' } };
    return { action: 'BATCH_CANCELLED', state: { status: 'CANCELLED' } };
  },
});
assert.strictEqual(cancelled.status, 'COMPLETE');
assert.strictEqual(cancelled.outcome, 'CANCELLED');
assert.deepStrictEqual(cancelCalls, ['cancel', 'reconcile']);

const blockedRun = prepareConfirmedRun('batch-coordinator-blocked');
const blocked = advanceRun(blockedRun.statePath, {
  batchExecute: () => ({ action: 'BATCH_BLOCKED', state: { status: 'BLOCKED' }, failureCode: 'PLATFORM_UNAVAILABLE', reason: '设备不可用' }),
});
assert.strictEqual(blocked.status, 'BLOCKED');
assert.strictEqual(blocked.code, 'PLATFORM_UNAVAILABLE');
assert.strictEqual(blocked.reason, '设备不可用');
assert.strictEqual(blocked.reportPath, path.join(workspace, 'index.html'));

const invalidConfirmRun = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-coordinator-invalid-confirm',
});
fs.writeFileSync(invalidConfirmRun.commands.confirm.requestPath, '{');
const invalidConfirmProcess = childProcess.spawnSync(process.execPath, [
  path.resolve(__dirname, '../coordinator-agent.js'), 'confirm', '--state', invalidConfirmRun.statePath,
], { encoding: 'utf8', env: process.env });
assert.strictEqual(invalidConfirmProcess.status, 2);
const invalidConfirm = JSON.parse(invalidConfirmProcess.stderr);
assert.strictEqual(invalidConfirm.status, 'REQUEST_INVALID');
assert.deepStrictEqual(invalidConfirm.retryWith, invalidConfirmRun.confirmTemplate);
fs.writeFileSync(invalidConfirmRun.commands.confirm.requestPath, '{');
const repeatedInvalidConfirmProcess = childProcess.spawnSync(process.execPath, [
  path.resolve(__dirname, '../coordinator-agent.js'), 'confirm', '--state', invalidConfirmRun.statePath,
], { encoding: 'utf8', env: process.env });
assert.strictEqual(repeatedInvalidConfirmProcess.status, 2);
const repeatedInvalidConfirm = JSON.parse(repeatedInvalidConfirmProcess.stderr);
assert.strictEqual(repeatedInvalidConfirm.status, 'AGENT_INPUT_STALLED');
assert.strictEqual(repeatedInvalidConfirm.code, 'AGENT_INPUT_STALLED');
assert.strictEqual(repeatedInvalidConfirm.retryWith, undefined);

const cancelledBeforeBatch = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  batchId: 'batch-coordinator-cancelled-before-init',
});
fs.writeFileSync(cancelledBeforeBatch.commands.cancel.requestPath, JSON.stringify({
  capability: 'cancelRun', reason: '确认前取消',
}));
const preBatchCancelled = coordinatorAgent.execute({
  command: 'cancel', statePath: cancelledBeforeBatch.statePath,
});
assert.strictEqual(preBatchCancelled.status, 'COMPLETE');
assert.strictEqual(preBatchCancelled.outcome, 'CANCELLED');
assert.strictEqual(fs.existsSync(cancelledBeforeBatch.commands.cancel.requestPath), false);
assert.strictEqual(preBatchCancelled.reportPath, path.join(workspace, 'index.html'));

const sameTimeA = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  now: '2026-09-11T03:00:00.000Z',
});
const sameTimeB = prepareRun({ capability: 'prepareRun', workspace, caseNos: ['014'] }, {
  now: '2026-09-11T03:00:00.000Z',
});
assert.notStrictEqual(sameTimeA.statePath, sameTimeB.statePath);

assert.throws(
  () => prepareRun({ capability: 'prepareRun', workspace, caseNos: ['999'] }, { batchId: 'batch-missing-case' }),
  (error) => error.code === 'COORDINATOR_INPUT_INVALID' && error.issues.some((item) => item.field === 'caseNos[0]'),
);

fs.rmSync(temp, { recursive: true, force: true });
console.log('coordinator Agent-facing facade passed');
