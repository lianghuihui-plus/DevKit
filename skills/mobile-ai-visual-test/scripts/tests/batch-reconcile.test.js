#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bootstrapBatch,
  batchPaths,
  initializeBatch,
  reconcileBatch,
  recordFinalizationStep,
  startCurrentCase,
} = require('../batch/core');
const { createCaseContract } = require('../execution/contracts/case-contract');
const lifecycle = require('../case-runtime/lifecycle');
const { findActiveExecutions, readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-batch-reconcile-'));
createTestWorkspace(root);
const sourceText = '验证 Runtime reconcile 错误能够有限重试并完成阻塞收口';
const caseKey = `ck-${crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 12)}`;
const caseDir = path.join(root, 'cases', `reconcile__${caseKey}`);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
writeJsonAtomic(path.join(caseDir, 'case.json'), createCaseContract({
  caseKey, title: 'reconcile 收口', sourceText, importPath: '/fixture/reconcile.md',
}));
const batchId = 'batch-reconcile-policy';
const binding = { platform: 'harmony', deviceId: 'reconcile-device', appId: 'com.example.reconcile', entry: 'EntryAbility' };
createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }]);
initializeBatch({ workspaceRoot: root, batchId });
const adapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId, adapter });
const started = startCurrentCase({ workspaceRoot: root, batchId });
assert.deepStrictEqual(Object.keys(started).sort(), ['action', 'agentRequired', 'batchId', 'caseKey', 'executionId', 'handoff']);
assert.strictEqual(started.action, 'DELEGATE_CASE_AGENT');
assert.strictEqual(started.agentRequired, true);
assert.ok(started.handoff?.path);
for (const key of ['brief', 'runtime', 'execution', 'scene', 'source', 'execDir', 'state', 'item', 'initialState']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(started, key), false, `start response must not expose ${key}`);
}
const repeatedStart = startCurrentCase({ workspaceRoot: root, batchId });
assert.deepStrictEqual(repeatedStart.handoff, started.handoff);
const originalResumeExecution = lifecycle.resumeExecution;
lifecycle.resumeExecution = () => {
  throw new Error('WAIT_CASE_AGENT must not resume the Case Runtime');
};
try {
  const waiting = reconcileBatch({ workspaceRoot: root, batchId, adapter });
  assert.deepStrictEqual(waiting, {
    action: 'WAIT_CASE_AGENT',
    batchId,
    caseKey,
    executionId: started.executionId,
  });
} finally {
  lifecycle.resumeExecution = originalResumeExecution;
}

const locked = () => {
  const error = new Error('runtime lock is busy');
  error.code = 'EXECUTION_LOCKED';
  throw error;
};
for (const count of [1, 2]) {
  const waiting = reconcileBatch({ workspaceRoot: root, batchId, adapter, reconcileExecution: locked });
  assert.strictEqual(waiting.action, 'WAIT_CASE_AGENT');
  assert.deepStrictEqual(waiting.retry, { count, limit: 3 });
}
const fatal = reconcileBatch({ workspaceRoot: root, batchId, adapter, reconcileExecution: locked });
assert.strictEqual(fatal.action, 'RECONCILE_FATAL');
assert.strictEqual(fatal.state.status, 'BLOCKING');
assert.strictEqual(fatal.state.finalization.cause, 'BLOCKED');
assert.strictEqual(fatal.state.reconcileFailure.count, 3);
assert.strictEqual(findActiveExecutions(root).length, 0);
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, adapter }).action, 'SETTLE_EXECUTIONS');
recordFinalizationStep({ workspaceRoot: root, batchId, step: 'executionsSettled', result: { ok: true } });
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, adapter }).action, 'RELEASE_PLATFORM');
recordFinalizationStep({ workspaceRoot: root, batchId, step: 'platformReleased', result: { ok: true } });
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, adapter }).action, 'PUBLISH_REPORTS');
const terminal = recordFinalizationStep({ workspaceRoot: root, batchId, step: 'reportsPublished', result: { status: 'PUBLISHED' } });
assert.strictEqual(terminal.state.status, 'BLOCKED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, adapter }).action, 'BATCH_BLOCKED');
const paths = batchPaths(root, batchId);
const corruptedTerminal = readJson(paths.state);
writeJsonAtomic(paths.state, {
  ...corruptedTerminal,
  warmSession: { ...corruptedTerminal.warmSession, status: 'READY' },
});
assert.throws(
  () => reconcileBatch({ workspaceRoot: root, batchId, adapter }),
  (error) => error.code === 'BATCH_STATE_INVALID',
);

for (const mutate of [
  (state) => ({ ...state, status: 'BOGUS' }),
  (state) => ({ ...state, currentIndex: state.cases.length + 1 }),
  (state) => ({ ...state, finalization: { ...state.finalization, platformReleased: false, reportsPublished: true } }),
]) {
  writeJsonAtomic(paths.state, mutate(corruptedTerminal));
  assert.throws(
    () => reconcileBatch({ workspaceRoot: root, batchId, adapter }),
    (error) => error.code === 'BATCH_STATE_INVALID',
  );
}

fs.rmSync(root, { recursive: true, force: true });
console.log('batch reconcile policy passed');
