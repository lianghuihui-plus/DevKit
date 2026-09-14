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
const { claimDispatch, claimTokenFor } = require('../lib/dispatch-lease');
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
  throw new Error('reconcile must not resume the Case Runtime');
};
try {
  const dispatchRequired = reconcileBatch({ workspaceRoot: root, batchId, adapter });
  assert.deepStrictEqual(dispatchRequired, {
    action: 'NEED_CASE_AGENT',
    batchId,
    caseKey,
    executionId: started.executionId,
  });
} finally {
  lifecycle.resumeExecution = originalResumeExecution;
}

const handoffEnvelope = readJson(started.handoff.path);
claimDispatch(path.dirname(started.handoff.path), handoffEnvelope, {
  handoffSha: started.handoff.sha256,
  claimToken: claimTokenFor(handoffEnvelope),
  now: '2026-09-14T08:00:00.000Z',
});
assert.deepStrictEqual(reconcileBatch({ workspaceRoot: root, batchId, adapter }), {
  action: 'WAIT_EXECUTION_RESULT',
  batchId,
  caseKey,
  executionId: started.executionId,
});

const locked = () => {
  const error = new Error('runtime lock is busy');
  error.code = 'EXECUTION_LOCKED';
  throw error;
};
for (const count of [1, 2]) {
  const waiting = reconcileBatch({ workspaceRoot: root, batchId, adapter, reconcileExecution: locked });
  assert.strictEqual(waiting.action, 'WAIT_EXECUTION_RESULT');
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
const terminal = reconcileBatch({ workspaceRoot: root, batchId, adapter });
assert.strictEqual(terminal.state.status, 'BLOCKED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, adapter }).action, 'BATCH_BLOCKED');
const paths = batchPaths(root, batchId);
const corruptedTerminal = readJson(paths.state);
const recoverableFinalization = { ...corruptedTerminal, status: 'BLOCKING' };
delete recoverableFinalization.blockedAt;
writeJsonAtomic(paths.state, recoverableFinalization);
const recoveredTerminal = reconcileBatch({ workspaceRoot: root, batchId, adapter });
assert.strictEqual(recoveredTerminal.action, 'BATCH_BLOCKED');
assert.strictEqual(recoveredTerminal.state.status, 'BLOCKED');
assert.ok(recoveredTerminal.state.blockedAt);
const deferredCleanup = {
  ...corruptedTerminal,
  status: 'BLOCKING',
  warmSession: { ...corruptedTerminal.warmSession, status: 'CLOSED' },
  finalization: {
    cause: 'BLOCKED',
    executionsSettled: true,
    platformReleased: false,
    platformCleanupDeferred: true,
  },
};
delete deferredCleanup.blockedAt;
writeJsonAtomic(paths.state, deferredCleanup);
const deferredTerminal = reconcileBatch({ workspaceRoot: root, batchId, adapter });
assert.strictEqual(deferredTerminal.action, 'BATCH_BLOCKED');
assert.strictEqual(deferredTerminal.state.status, 'BLOCKED');
assert.strictEqual(deferredTerminal.state.finalization.platformCleanupDeferred, true);
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
  (state) => ({ ...state, finalization: { ...state.finalization, executionsSettled: false, platformReleased: true } }),
]) {
  writeJsonAtomic(paths.state, mutate(corruptedTerminal));
  assert.throws(
    () => reconcileBatch({ workspaceRoot: root, batchId, adapter }),
    (error) => error.code === 'BATCH_STATE_INVALID',
  );
}

const interruptedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-batch-dispatch-recovery-'));
createTestWorkspace(interruptedRoot);
const interruptedSource = '验证 execution 创建后、Handoff 创建前中断能够恢复委托';
const interruptedCaseKey = `ck-${crypto.createHash('sha256').update(interruptedSource).digest('hex').slice(0, 12)}`;
const interruptedCaseDir = path.join(interruptedRoot, 'cases', `dispatch-recovery__${interruptedCaseKey}`);
fs.mkdirSync(interruptedCaseDir, { recursive: true });
fs.writeFileSync(path.join(interruptedCaseDir, 'source.md'), interruptedSource);
writeJsonAtomic(path.join(interruptedCaseDir, 'case.json'), createCaseContract({
  caseKey: interruptedCaseKey,
  title: 'dispatch 恢复',
  sourceText: interruptedSource,
  importPath: '/fixture/dispatch-recovery.md',
}));
const interruptedBatchId = 'batch-dispatch-recovery';
const interruptedBinding = { platform: 'harmony', deviceId: 'dispatch-device', appId: 'com.example.dispatch', entry: 'EntryAbility' };
createTestExecutionRequest(interruptedRoot, interruptedBatchId, interruptedBinding, [{
  caseKey: interruptedCaseKey,
  caseDir: interruptedCaseDir,
}]);
initializeBatch({ workspaceRoot: interruptedRoot, batchId: interruptedBatchId });
const interruptedAdapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding: interruptedBinding }),
};
bootstrapBatch({ workspaceRoot: interruptedRoot, batchId: interruptedBatchId, adapter: interruptedAdapter });
const originalLinkSync = fs.linkSync;
fs.linkSync = (source, destination) => {
  if (String(destination).includes(`${path.sep}handoffs${path.sep}`)) {
    throw new Error('simulated initial Handoff write failure');
  }
  return originalLinkSync(source, destination);
};
try {
  assert.throws(
    () => startCurrentCase({ workspaceRoot: interruptedRoot, batchId: interruptedBatchId }),
    /simulated initial Handoff write failure/,
  );
} finally {
  fs.linkSync = originalLinkSync;
}
const dispatchRecovery = reconcileBatch({ workspaceRoot: interruptedRoot, batchId: interruptedBatchId, adapter: interruptedAdapter });
assert.strictEqual(dispatchRecovery.action, 'NEED_CASE_AGENT');
const recoveredDispatch = startCurrentCase({ workspaceRoot: interruptedRoot, batchId: interruptedBatchId });
assert.strictEqual(recoveredDispatch.executionId, dispatchRecovery.executionId);
assert.ok(recoveredDispatch.handoff.loaderCommand);
fs.rmSync(interruptedRoot, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });
console.log('batch reconcile policy passed');
