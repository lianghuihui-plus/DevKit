#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildExecutionArtifactManifest,
  validateExecutionArtifactManifest,
} = require('../lib/execution-artifact-manifest');
const { completionPaths, sha256File, validateCompletionBinding, validatePublishedCompletion } = require('../lib/completion-contract');
const { readPublicationState, recordPublicationAttempt } = require('../report/publication-state');
const { refreshBatchIndex } = require('../report/report-service');
const { writeCaseReports } = require('../report/report-service');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mavt-publication-${name}-`));
  createTestWorkspace(root);
  const current = createCurrentFixture(root, { verdict: 'PASS', suffix: name });
  const execDir = current.execDir;
  fs.unlinkSync(path.join(execDir, 'artifact-manifest.json'));
  fs.unlinkSync(path.join(execDir, 'completion.json'));
  fs.mkdirSync(path.join(execDir, 'transactions'), { recursive: true });
  return { root, execDir };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

const published = fixture('published');
const manifest = buildExecutionArtifactManifest(published.execDir);
assert.ok(manifest.files.some((entry) => entry.path === 'result.json'));
assert.ok(manifest.files.some((entry) => entry.path === 'screenshots/scene-0001.png'));
assert.ok(manifest.files.some((entry) => entry.path.startsWith('scenes/')));
assert.ok(manifest.files.some((entry) => entry.path.startsWith('operations/')));
assert.strictEqual(manifest.files.some((entry) => entry.path === 'current-scene.json'), false);
assert.strictEqual(manifest.files.some((entry) => entry.path.startsWith('agent/')), false);
assert.deepStrictEqual(validateExecutionArtifactManifest(published.execDir), manifest);
fs.appendFileSync(path.join(published.execDir, 'metrics.json'), '\n');
expectCode(() => validateExecutionArtifactManifest(published.execDir), 'EXECUTION_ARTIFACT_CHANGED');

const missing = fixture('missing');
fs.unlinkSync(path.join(missing.execDir, 'result.json'));
expectCode(() => buildExecutionArtifactManifest(missing.execDir), 'EXECUTION_ARTIFACT_MISSING');

const unsettled = fixture('unsettled');
writeJson(path.join(unsettled.execDir, 'transactions', 'action-0001.draft.json'), { status: 'PREPARED' });
expectCode(() => buildExecutionArtifactManifest(unsettled.execDir), 'EXECUTION_TRANSACTION_UNSETTLED');

const emptyPass = fixture('empty-pass');
writeJson(path.join(emptyPass.execDir, 'result.json'), { verdict: 'PASS', summary: 'invalid', checks: [], uncertainties: [] });
expectCode(() => buildExecutionArtifactManifest(emptyPass.execDir), 'CASE_RESULT_CHECKS_REQUIRED');

const changedScene = fixture('changed-scene');
fs.appendFileSync(path.join(changedScene.execDir, 'screenshots', 'scene-0001.png'), 'changed');
expectCode(() => buildExecutionArtifactManifest(changedScene.execDir), 'EXECUTION_ARTIFACT_CHANGED');

const mismatchedBinding = fixture('mismatched-binding');
const bindingPath = path.join(mismatchedBinding.execDir, 'binding.snapshot.json');
const wrongBinding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
wrongBinding.bindingSha = 'target-binding-wrong';
writeJson(bindingPath, wrongBinding);
const mismatchedManifest = buildExecutionArtifactManifest(mismatchedBinding.execDir);
const mismatchedPaths = completionPaths(mismatchedBinding.execDir);
const mismatchedExecution = JSON.parse(fs.readFileSync(mismatchedPaths.execution, 'utf8'));
const mismatchedResult = JSON.parse(fs.readFileSync(mismatchedPaths.result, 'utf8'));
const mismatchedMetrics = JSON.parse(fs.readFileSync(mismatchedPaths.metrics, 'utf8'));
const mismatchedSnapshot = JSON.parse(fs.readFileSync(mismatchedPaths.snapshot, 'utf8'));
const mismatchedCompletion = {
  executionId: mismatchedExecution.executionId,
  batchId: mismatchedExecution.batchId,
  caseKey: mismatchedSnapshot.identity.caseKey,
  platform: mismatchedExecution.platform,
  completionSource: 'framework',
  runtimeSha: mismatchedExecution.runtimeSha,
  adapterSha: mismatchedExecution.adapterSha,
  contractSha: mismatchedExecution.contractSha,
  batchContractSha: mismatchedExecution.batchContractSha,
  validationProfileSha: mismatchedExecution.validationProfileSha,
  verdict: mismatchedResult.verdict,
  executionStatus: mismatchedMetrics.executionStatus,
  runtimeCompleted: true,
  resultSha256: sha256File(mismatchedPaths.result),
  metricsSha256: sha256File(mismatchedPaths.metrics),
  artifactManifestSha256: sha256File(mismatchedPaths.artifactManifest),
};
expectCode(() => validateCompletionBinding({ ...mismatchedCompletion, schemaVersion: 4 }, {}), 'FORMAT_UNSUPPORTED');
assert.ok(mismatchedManifest.files.some((entry) => entry.path === 'binding.snapshot.json'));
expectCode(() => validatePublishedCompletion(mismatchedBinding.execDir, mismatchedCompletion, {
  execution: mismatchedExecution,
  result: mismatchedResult,
  metrics: mismatchedMetrics,
  snapshot: mismatchedSnapshot,
}), 'EXECUTION_SNAPSHOT_BINDING_INVALID');

const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-retry-'));
writeJson(path.join(reportRoot, 'runs', 'batch-retry', 'report-publication.json'), {
  schemaVersion: 1,
  batchId: 'batch-retry',
  status: 'PENDING',
  attempts: [],
  caseTimings: { 'execution-001': { caseReportPublishedAt: '2026-09-10T10:00:01.000Z', reportPublicationDelayMs: 1000 } },
  publications: { legacyPublication: { preserved: true } },
});
recordPublicationAttempt(reportRoot, 'batch-retry', 'batch', { status: 'FAILED', errorCode: 'REPORT_TEST_FAILED', reason: 'simulated' });
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').status, 'RETRY_REQUIRED');
recordPublicationAttempt(reportRoot, 'batch-retry', 'batch', { status: 'PUBLISHED' });
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').status, 'PUBLISHED');
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').attempts.length, 2);
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').caseTimings['execution-001'].reportPublicationDelayMs, 1000);
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').publications.legacyPublication.preserved, true);

const repairRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-repair-'));
createTestWorkspace(repairRoot);
const repairFixture = createCurrentFixture(repairRoot, { verdict: 'PASS', suffix: 'repair' });
refreshBatchIndex(repairRoot, [repairFixture.caseDir]);
const platformReport = path.join(repairFixture.caseDir, 'platforms', 'harmony', 'CONTEXT.html');
fs.unlinkSync(platformReport);
assert.strictEqual(fs.existsSync(platformReport), false);
refreshBatchIndex(repairRoot, [repairFixture.caseDir]);
assert.strictEqual(fs.existsSync(platformReport), true);
const repairAlias = `${repairRoot}-alias`;
fs.symlinkSync(repairRoot, repairAlias, 'dir');
assert.doesNotThrow(() => refreshBatchIndex(repairAlias, [repairFixture.caseDir]));
fs.unlinkSync(repairAlias);

const failedFirstPublishRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-first-publish-'));
createTestWorkspace(failedFirstPublishRoot);
const failedFirstPublishFixture = createCurrentFixture(failedFirstPublishRoot, { verdict: 'PASS', suffix: 'first-publish' });
assert.throws(() => writeCaseReports(
  failedFirstPublishFixture.caseDir,
  failedFirstPublishFixture.caseJson,
  {},
  [],
  null,
  { platform: 'harmony', publishBundle: () => { throw new Error('simulated first publish failure'); } },
), /simulated first publish failure/);
const failedFirstPublishSidecar = path.join(
  failedFirstPublishRoot,
  'runs',
  failedFirstPublishFixture.execution.batchId,
  'report-publication.json',
);
assert.strictEqual(fs.existsSync(failedFirstPublishSidecar), false, 'failed publication must not record caseReportPublishedAt');

for (const item of [published, missing, unsettled, emptyPass, changedScene, mismatchedBinding]) fs.rmSync(item.root, { recursive: true, force: true });
fs.rmSync(reportRoot, { recursive: true, force: true });
fs.rmSync(repairRoot, { recursive: true, force: true });
fs.rmSync(failedFirstPublishRoot, { recursive: true, force: true });
console.log('publication-integrity passed');
