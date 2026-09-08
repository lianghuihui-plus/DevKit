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
const { buildContract } = require('../build-agent-contract');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { findActiveExecutions, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { refreshBatchIndex } = require('../report/report-service');
const { createTestExecutionRequest, createTestWorkspace } = require('./current-fixture');

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
createTestExecutionRequest(root, batchId, binding, [{ caseKey, caseDir }]);
initializeBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha });
const adapter = {
  restartApp: () => ({ ok: true, coldStartVerified: true, startupDisplayVerified: true }),
  probeSession: () => ({ ok: true, binding }),
};
bootstrapBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter });
const started = startCurrentCase({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha });
assert.strictEqual(findActiveExecutions(root).length, 1);

const cancelled = cancelBatch({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  reason: '用户停止本批执行',
});
assert.strictEqual(cancelled.state.status, 'CANCELLING');
assert.strictEqual(cancelled.state.cases[0].status, 'CANCELLED');
assert.strictEqual(findActiveExecutions(root).length, 0);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(started.execDir, 'execution.json'), 'utf8')).status, 'CANCELLED');
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter }).action, 'RELEASE_PLATFORM');
const repeatedCancellation = cancelBatch({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  reason: '重复取消不应重置收尾状态',
});
assert.strictEqual(repeatedCancellation.idempotent, true);
assert.strictEqual(repeatedCancellation.nextAction, 'RELEASE_PLATFORM');
assert.strictEqual(repeatedCancellation.state.reason, '用户停止本批执行');

recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  step: 'platformReleased',
  result: { ok: true },
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter }).action, 'PUBLISH_REPORTS');
const repeatedAfterRelease = cancelBatch({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
});
assert.strictEqual(repeatedAfterRelease.idempotent, true);
assert.strictEqual(repeatedAfterRelease.nextAction, 'PUBLISH_REPORTS');
assert.strictEqual(repeatedAfterRelease.state.finalization.platformReleased, true);
assert.ok(fs.existsSync(refreshBatchIndex(root, [caseDir])));
recordFinalizationStep({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
  step: 'reportsPublished',
  result: { status: 'PUBLISHED' },
});
assert.strictEqual(reconcileBatch({ workspaceRoot: root, batchId, implementationSha: contract.implementationSha, adapter }).action, 'BATCH_CANCELLED');
assert.strictEqual(cancelBatch({
  workspaceRoot: root,
  batchId,
  implementationSha: contract.implementationSha,
}).idempotent, true);

fs.rmSync(root, { recursive: true, force: true });
console.log('batch cancellation passed');
