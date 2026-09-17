#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bootstrapBatch,
  cancelBatch,
  initializeBatch,
  reconcileBatch,
  recordFinalizationStep,
  startCurrentCase,
} = require('../batch/core');
const { reconcileWithFinalization } = require('../batch');
const { buildContract } = require('../build-agent-contract');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { findActiveExecutions, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { refreshBatchIndex } = require('../report/report-service');
const { createTestExecutionRequest, createTestWorkspace } = require('./support/workspace-fixture');

process.env.MAVT_SELF_TEST = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-batch-cancel-'));
createTestWorkspace(root);
const sourceText = '打开页面后检查目标内容。';
const caseKey = `ck-${crypto.createHash('sha256').update(sourceText).digest('hex').slice(0, 12)}`;
const caseJson = createCaseContract({ caseKey, title: '取消执行测试', sourceText, importPath: '/fixture/cancel.txt' });
const caseDir = path.join(root, 'cases', `cancel__${caseKey}`);
fs.mkdirSync(caseDir, { recursive: true });
fs.writeFileSync(path.join(caseDir, 'source.md'), sourceText);
writeJsonAtomic(path.join(caseDir, 'case.json'), caseJson);

const batchId = 'batch-cancel';
const binding = { platform: 'harmony', deviceId: 'cancel-device', appId: 'com.example.cancel', appName: 'Cancel', entry: 'EntryAbility' };
const contract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'case-executor', platform: 'harmony' });
const coordinatorContract = buildContract({ skillRoot: path.resolve(__dirname, '../..'), role: 'batch-coordinator', platform: 'harmony' });
const currentProtocol = {
  runtimeSha: contract.runtimeSha,
  adapterSha: contract.adapterSha,
  coordinatorSha: coordinatorContract.coordinatorSha,
  caseProtocolSha: contract.protocolSha,
  coordinatorProtocolSha: coordinatorContract.protocolSha,
};
createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }]);
initializeBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha });
const adapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter });
const started = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha });
const startedExecDir = fs.realpathSync(path.join(caseDir, 'platforms', binding.platform, 'executions', started.executionId));
assert.strictEqual(findActiveExecutions(root).length, 1);

const upgradedProtocol = {
  runtimeSha: 'case-runtime-newer',
  adapterSha: 'platform-adapter-newer',
  coordinatorSha: 'batch-coordinator-newer',
  caseProtocolSha: 'agent-protocol-case-newer',
  coordinatorProtocolSha: 'agent-protocol-coordinator-newer',
};

assert.throws(() => reconcileBatch({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
  adapter,
}), (error) => error.code === 'BATCH_IMPLEMENTATION_MISMATCH');
const cancelled = cancelBatch({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
  reason: '用户停止本批执行',
});
assert.strictEqual(cancelled.state.status, 'CANCELLING');
assert.strictEqual(cancelled.state.cases[0].status, 'CANCELLED');
assert.strictEqual(findActiveExecutions(root).length, 0);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(startedExecDir, 'execution.json'), 'utf8')).status, 'CANCELLED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, ...upgradedProtocol, adapter }).action, 'SETTLE_EXECUTIONS');
const repeatedCancellation = cancelBatch({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
  reason: '重复取消不应重置收尾状态',
});
assert.strictEqual(repeatedCancellation.idempotent, true);
assert.strictEqual(repeatedCancellation.nextAction, 'SETTLE_EXECUTIONS');
assert.strictEqual(repeatedCancellation.state.reason, '用户停止本批执行');
assert.throws(() => recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  ...currentProtocol,
  step: 'platformReleased',
  result: { status: 'PUBLISHED' },
}), (error) => error.code === 'BATCH_FINALIZATION_INVALID');

recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
  step: 'executionsSettled',
  result: { ok: true },
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, ...upgradedProtocol, adapter }).action, 'RELEASE_PLATFORM');
recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
  step: 'platformReleased',
  result: { ok: true },
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, ...upgradedProtocol, adapter }).action, 'BATCH_CANCELLED');
const repeatedAfterRelease = cancelBatch({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
});
assert.strictEqual(repeatedAfterRelease.idempotent, true);
assert.strictEqual(repeatedAfterRelease.state.status, 'CANCELLED');
assert.strictEqual(repeatedAfterRelease.state.finalization.platformReleased, true);
const publicationFailure = new Error('renderer contract is invalid');
publicationFailure.code = 'REPORT_RENDERER_INVALID';
const terminalWithDegradedReport = reconcileWithFinalization(
  { workspaceRoot: root, batchId, ...upgradedProtocol },
  { adapter, refreshBatchIndex: () => { throw publicationFailure; } },
);
assert.strictEqual(terminalWithDegradedReport.action, 'BATCH_CANCELLED');
assert.strictEqual(terminalWithDegradedReport.state.status, 'CANCELLED');
assert.strictEqual(terminalWithDegradedReport.publicationState.status, 'DEGRADED');
assert.strictEqual(terminalWithDegradedReport.publicationState.errorCode, 'REPORT_RENDERER_INVALID');
assert.strictEqual(terminalWithDegradedReport.retryable, undefined);
fs.writeFileSync(path.join(root, 'runs', batchId, 'report-publication.json'), '{ invalid json');
const terminalWithCorruptedPublicationState = reconcileWithFinalization(
  { workspaceRoot: root, batchId, ...upgradedProtocol },
  { adapter },
);
assert.strictEqual(terminalWithCorruptedPublicationState.action, 'BATCH_CANCELLED');
assert.strictEqual(terminalWithCorruptedPublicationState.state.status, 'CANCELLED');
assert.strictEqual(terminalWithCorruptedPublicationState.publicationState.status, 'DEGRADED');
assert.strictEqual(terminalWithCorruptedPublicationState.publicationState.errorCode, 'REPORT_PUBLICATION_STATE_INVALID');
assert.strictEqual(cancelBatch({
  workspaceRoot: root,
  batchId,
  ...upgradedProtocol,
}).idempotent, true);

const deferredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-batch-cancel-finalized-'));
createTestWorkspace(deferredRoot);
const deferredCaseText = '取消前已完成但尚未提交的用例。';
const deferredCaseKey = `ck-${crypto.createHash('sha256').update(deferredCaseText).digest('hex').slice(0, 12)}`;
const deferredCaseJson = createCaseContract({ caseKey: deferredCaseKey, title: '取消前完成测试', sourceText: deferredCaseText, importPath: '/fixture/deferred-cancel.txt' });
const deferredCaseDir = path.join(deferredRoot, 'cases', `deferred__${deferredCaseKey}`);
fs.mkdirSync(deferredCaseDir, { recursive: true });
fs.writeFileSync(path.join(deferredCaseDir, 'source.md'), deferredCaseText);
writeJsonAtomic(path.join(deferredCaseDir, 'case.json'), deferredCaseJson);
const deferredBatchId = 'batch-cancel-finalized';
const deferredBinding = { platform: 'harmony', deviceId: 'deferred-device', appId: 'com.example.deferred', appName: 'Deferred', entry: 'EntryAbility' };
createTestExecutionRequest(deferredRoot, deferredBatchId, deferredBinding, [{ caseKey: deferredCaseKey, caseDir: deferredCaseDir }]);
initializeBatch({ workspaceRoot: deferredRoot, batchId: deferredBatchId, implementationSha: contract.implementationSha });
bootstrapBatch({ workspaceRoot: deferredRoot, batchId: deferredBatchId, implementationSha: contract.implementationSha, adapter });
const deferredStarted = startCurrentCase({ workspaceRoot: deferredRoot, batchId: deferredBatchId, implementationSha: contract.implementationSha });
const deferredExecDir = path.join(deferredCaseDir, 'platforms', deferredBinding.platform, 'executions', deferredStarted.executionId);
const deferredExecution = JSON.parse(fs.readFileSync(path.join(deferredExecDir, 'execution.json'), 'utf8'));
writeJsonAtomic(path.join(deferredExecDir, 'execution.json'), {
  ...deferredExecution,
  status: 'FINISHED', lifecycle: 'FINALIZED', finalized: true, executionStatus: 'COMPLETED',
  endedAt: '2026-09-15T10:00:00.000Z',
});
writeJsonAtomic(path.join(deferredExecDir, 'result.json'), { verdict: 'PASS', summary: '已完成结果' });
const deferredCancel = cancelBatch({
  workspaceRoot: deferredRoot,
  batchId: deferredBatchId,
  ...currentProtocol,
  reason: '完成当前用例后取消剩余用例',
});
assert.strictEqual(deferredCancel.action, 'CANCELLATION_PENDING_COMMIT');
assert.strictEqual(deferredCancel.state.status, 'RUNNING');
assert.strictEqual(deferredCancel.state.cases[0].status, 'RUNNING');
assert.strictEqual(deferredCancel.state.cancellationRequested.reason, '完成当前用例后取消剩余用例');
assert.strictEqual(reconcileBatch({ workspaceRoot: deferredRoot, batchId: deferredBatchId, ...currentProtocol, adapter }).action, 'COMMIT_CASE');
fs.rmSync(deferredRoot, { recursive: true, force: true });

fs.rmSync(root, { recursive: true, force: true });
console.log('batch cancellation passed');
