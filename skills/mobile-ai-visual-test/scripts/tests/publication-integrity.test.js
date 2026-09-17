#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildExecutionArtifactManifest,
  validateExecutionArtifactManifest,
} = require('../lib/execution-artifact-manifest');
const { completionPaths, sha256File, validateCompletionBinding, validatePublishedCompletion } = require('../lib/completion-contract');
const { classifyPublicationFailure, readPublicationState, recordPublicationAttempt } = require('../report/publication-state');
const {
  rebuildCaseDerivedArtifacts,
  refreshBatchIndex,
  refreshCommittedCaseReports,
  renderIndexForRoot,
} = require('../report/report-service');
const { writeCaseReports } = require('../report/report-service');
const { withWorkspaceReportPublication } = require('../report/publication-lock');
const { commitWithDashboard } = require('../batch');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

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

function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
  assert.strictEqual(fs.existsSync(file), true, `timed out waiting for ${file}`);
}

function fileAppears(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
  return fs.existsSync(file);
}

function holdReportLock(workspaceRoot, holdMs = 250) {
  const lockPath = path.join(workspaceRoot, '.report-publication.lock');
  const readyPath = path.join(workspaceRoot, '.report-lock-holder-ready');
  const releasedPath = path.join(workspaceRoot, '.report-lock-holder-released');
  const lifecyclePath = path.resolve(__dirname, '../lib/execution-lifecycle.js');
  const script = `
    const fs = require('fs');
    const { acquireFileLock, releaseFileLock } = require(${JSON.stringify(lifecyclePath)});
    const [lockPath, readyPath, releasedPath, holdMs] = process.argv.slice(1);
    const lock = acquireFileLock(lockPath);
    fs.writeFileSync(readyPath, 'ready');
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
    } finally {
      releaseFileLock(lock);
      fs.writeFileSync(releasedPath, 'released');
    }
  `;
  const child = childProcess.spawn(process.execPath, [
    '-e', script, lockPath, readyPath, releasedPath, String(holdMs),
  ], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
  waitForFile(readyPath);
  return { child, lockPath, releasedPath };
}

function spawnCommittedReportRefresh(caseDir, platform) {
  const resultPath = path.join(caseDir, `.concurrent-refresh-${platform}.json`);
  const reportServicePath = path.resolve(__dirname, '../report/report-service.js');
  const script = `
    const fs = require('fs');
    const { refreshCommittedCaseReports } = require(${JSON.stringify(reportServicePath)});
    const [caseDir, platform, resultPath] = process.argv.slice(1);
    try {
      refreshCommittedCaseReports(caseDir, platform);
      fs.writeFileSync(resultPath, JSON.stringify({ ok: true }));
    } catch (error) {
      fs.writeFileSync(resultPath, JSON.stringify({
        ok: false,
        code: error && error.code,
        message: error && error.message,
      }));
    }
  `;
  const child = childProcess.spawn(process.execPath, [
    '-e', script, caseDir, platform, resultPath,
  ], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
  return { child, resultPath };
}

function readRefreshResult(refresh) {
  waitForFile(refresh.resultPath);
  const result = JSON.parse(fs.readFileSync(refresh.resultPath, 'utf8'));
  assert.deepStrictEqual(result, { ok: true });
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
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').status, 'DEGRADED');
recordPublicationAttempt(reportRoot, 'batch-retry', 'batch', { status: 'PUBLISHED' });
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').status, 'PUBLISHED');
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').attempts.length, 2);
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').caseTimings['execution-001'].reportPublicationDelayMs, 1000);
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').publications.legacyPublication.preserved, true);

assert.strictEqual(classifyPublicationFailure({ errorCode: 'EXECUTION_LOCKED' }).classification, 'TRANSIENT');
assert.strictEqual(classifyPublicationFailure({ errorCode: 'REPORT_ARTIFACT_MISSING' }).classification, 'PERMANENT');
assert.strictEqual(classifyPublicationFailure({ errorCode: 'FORMAT_UNSUPPORTED' }).classification, 'DISPLAYABLE');
const displayable = recordPublicationAttempt(reportRoot, 'batch-displayable', 'batch', {
  status: 'FAILED', errorCode: 'FORMAT_UNSUPPORTED', reason: 'historical execution',
});
assert.strictEqual(displayable.status, 'PENDING');
assert.strictEqual(displayable.attempts[0].status, 'DISPLAYABLE');

const corruptedCommitPublicationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-corrupted-commit-publication-'));
fs.mkdirSync(path.join(corruptedCommitPublicationRoot, 'runs', 'batch-corrupted-commit'), { recursive: true });
fs.writeFileSync(path.join(corruptedCommitPublicationRoot, 'runs', 'batch-corrupted-commit', 'report-publication.json'), '{ invalid json');
const committedWithDegradedPublication = commitWithDashboard(
  { workspaceRoot: corruptedCommitPublicationRoot, batchId: 'batch-corrupted-commit' },
  () => ({ status: 'UPDATED' }),
  () => ({ item: { caseDir: '/fixture/case' }, completion: { platform: 'harmony' } }),
);
assert.strictEqual(committedWithDegradedPublication.dashboardRefresh.status, 'UPDATED');
assert.strictEqual(committedWithDegradedPublication.publicationState.status, 'DEGRADED');
assert.strictEqual(committedWithDegradedPublication.publicationState.errorCode, 'REPORT_PUBLICATION_STATE_INVALID');

const corruptedTimingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-corrupted-publication-timing-'));
createTestWorkspace(corruptedTimingRoot);
const corruptedTimingFixture = createCurrentFixture(corruptedTimingRoot, { verdict: 'PASS', suffix: 'corrupted-timing' });
const corruptedTimingSidecar = path.join(
  corruptedTimingRoot,
  'runs',
  corruptedTimingFixture.execution.batchId,
  'report-publication.json',
);
fs.mkdirSync(path.dirname(corruptedTimingSidecar), { recursive: true });
fs.writeFileSync(corruptedTimingSidecar, '{ invalid json');
assert.doesNotThrow(() => renderIndexForRoot(corruptedTimingRoot));
assert.strictEqual(require('../report/report-service').collectIndexCases(corruptedTimingRoot)[0].status, 'PASS');
assert.strictEqual(fs.readFileSync(corruptedTimingSidecar, 'utf8'), '{ invalid json');
for (const expected of ['RETRY_REQUIRED', 'RETRY_REQUIRED', 'DEGRADED']) {
  recordPublicationAttempt(reportRoot, 'batch-transient', 'batch', {
    status: 'FAILED', errorCode: 'EXECUTION_LOCKED', reason: 'same lock contention',
  });
  assert.strictEqual(readPublicationState(reportRoot, 'batch-transient').status, expected);
}
const capped = recordPublicationAttempt(reportRoot, 'batch-transient', 'batch', {
  status: 'FAILED', errorCode: 'EXECUTION_LOCKED', reason: 'same lock contention',
});
assert.strictEqual(capped.status, 'DEGRADED');
assert.strictEqual(capped.attempts.at(-1).retryCount, 4);

const retryRecoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-retry-recovery-'));
createTestWorkspace(retryRecoveryRoot);
const retryRecoveryFixture = createCurrentFixture(retryRecoveryRoot, { verdict: 'PASS', suffix: 'retry-recovery' });
writeJson(path.join(retryRecoveryRoot, 'runs', 'batch-retry-recovery', 'contract.json'), {
  targets: [{ caseDir: retryRecoveryFixture.caseDir }],
});
recordPublicationAttempt(retryRecoveryRoot, 'batch-retry-recovery', 'batch', {
  status: 'FAILED', errorCode: 'EXECUTION_LOCKED', reason: 'temporary report lock',
});
recordPublicationAttempt(retryRecoveryRoot, 'batch-orphaned-retry', 'batch', {
  status: 'FAILED', errorCode: 'EXECUTION_LOCKED', reason: 'target metadata is unavailable',
});
recordPublicationAttempt(retryRecoveryRoot, 'batch-degraded', 'batch', {
  status: 'FAILED', errorCode: 'REPORT_ARTIFACT_MISSING', reason: 'permanent missing artifact',
});
renderIndexForRoot(retryRecoveryRoot);
assert.strictEqual(readPublicationState(retryRecoveryRoot, 'batch-retry-recovery').status, 'PUBLISHED');
assert.strictEqual(readPublicationState(retryRecoveryRoot, 'batch-orphaned-retry').status, 'RETRY_REQUIRED');
assert.strictEqual(readPublicationState(retryRecoveryRoot, 'batch-degraded').status, 'DEGRADED');

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

const callbackFailure = new Error('simulated report callback failure');
assert.throws(
  () => withWorkspaceReportPublication(repairRoot, () => { throw callbackFailure; }),
  (error) => error === callbackFailure,
);
assert.strictEqual(fs.existsSync(path.join(repairRoot, '.report-publication.lock')), false);
assert.doesNotThrow(() => withWorkspaceReportPublication(repairRoot, () => 'recovered'));

withWorkspaceReportPublication(repairRoot, () => {
  const expectedCode = 'REPORT_PUBLICATION_REENTRANT';
  expectCode(() => withWorkspaceReportPublication(repairAlias, () => null), expectedCode);
  expectCode(() => renderIndexForRoot(repairAlias), expectedCode);
  expectCode(() => refreshBatchIndex(repairAlias, [repairFixture.caseDir]), expectedCode);
  expectCode(() => refreshCommittedCaseReports(repairFixture.caseDir, 'harmony'), expectedCode);
  expectCode(() => rebuildCaseDerivedArtifacts(repairFixture.caseDir), expectedCode);
});

const reportLock = holdReportLock(repairRoot);
const reportLockStartedAt = Date.now();
refreshBatchIndex(repairAlias, [repairFixture.caseDir]);
const reportLockWaitMs = Date.now() - reportLockStartedAt;
waitForFile(reportLock.releasedPath);
assert.ok(reportLockWaitMs >= 150, `report refresh ignored the active publication lock (${reportLockWaitMs}ms)`);
assert.strictEqual(fs.existsSync(reportLock.lockPath), false);
fs.unlinkSync(repairAlias);

fs.writeFileSync(reportLock.lockPath, `${JSON.stringify({
  pid: 2147483647,
  acquiredAt: '2026-09-16T00:00:00.000Z',
})}\n`);
assert.doesNotThrow(() => refreshBatchIndex(repairRoot, [repairFixture.caseDir]));
assert.strictEqual(fs.existsSync(reportLock.lockPath), false, 'stale report publication lock must be recovered');

const malformedLockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-malformed-lock-'));
createTestWorkspace(malformedLockRoot);
const malformedLockPath = path.join(malformedLockRoot, '.report-publication.lock');
const malformedResultPath = path.join(malformedLockRoot, '.report-publication-result.json');
fs.writeFileSync(malformedLockPath, '{ malformed');
const publicationLockPath = path.resolve(__dirname, '../report/publication-lock.js');
const malformedLockScript = `
  const fs = require('fs');
  const { withWorkspaceReportPublication } = require(${JSON.stringify(publicationLockPath)});
  const [root, resultPath] = process.argv.slice(1);
  try {
    withWorkspaceReportPublication(root, () => null);
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, code: error && error.code }));
  }
`;
const malformedLockChild = childProcess.spawn(process.execPath, [
  '-e', malformedLockScript, malformedLockRoot, malformedResultPath,
], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
const malformedLockCompleted = fileAppears(malformedResultPath, 1000);
if (!malformedLockCompleted) malformedLockChild.kill('SIGKILL');
assert.strictEqual(malformedLockCompleted, true, 'malformed report lock must not wait forever');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(malformedResultPath, 'utf8')), {
  ok: false,
  code: 'REPORT_PUBLICATION_LOCK_INVALID',
});

const unpublishedSiblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-unpublished-sibling-'));
createTestWorkspace(unpublishedSiblingRoot);
const publishedSibling = createCurrentFixture(unpublishedSiblingRoot, {
  suffix: 'published-sibling',
  platform: 'harmony',
  verdict: 'PASS',
});
const unpublishedSibling = createCurrentFixture(unpublishedSiblingRoot, {
  suffix: 'unpublished-sibling',
  platform: 'ios',
  verdict: 'PASS',
});
writeCaseReports(unpublishedSibling.caseDir, unpublishedSibling.caseJson);
assert.doesNotThrow(() => refreshCommittedCaseReports(publishedSibling.caseDir, 'harmony'));
const unpublishedSiblingIndex = fs.readFileSync(path.join(unpublishedSiblingRoot, 'index.html'), 'utf8');
assert.ok(unpublishedSiblingIndex.includes('published-sibling'));
assert.strictEqual(
  unpublishedSiblingIndex.includes('platforms/ios/CONTEXT.html'),
  false,
  'an execution must not appear in the index before its platform report is published',
);
refreshCommittedCaseReports(unpublishedSibling.caseDir, 'ios');
fs.unlinkSync(path.join(unpublishedSibling.runtimeDir, 'CONTEXT.html'));
assert.throws(
  () => refreshCommittedCaseReports(publishedSibling.caseDir, 'harmony'),
  /REPORT_LINK_TARGET_MISSING: .*platforms\/ios\/CONTEXT\.html/,
  'a missing artifact from an actually published snapshot must remain an integrity error',
);

const platformBoundaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-platform-boundary-'));
createTestWorkspace(platformBoundaryRoot);
const boundaryIos = createCurrentFixture(platformBoundaryRoot, {
  suffix: 'platform-boundary',
  platform: 'ios',
  verdict: 'PASS',
  sourceText: '相同平台边界原文',
  title: '平台发布边界用例',
});
const boundaryAndroid = createCurrentFixture(platformBoundaryRoot, {
  suffix: 'platform-boundary',
  platform: 'android',
  verdict: 'PASS',
  sourceText: '相同平台边界原文',
  title: '平台发布边界用例',
});
refreshCommittedCaseReports(boundaryIos.caseDir, 'ios');
assert.strictEqual(fs.existsSync(path.join(boundaryIos.runtimeDir, 'CONTEXT.html')), true);
assert.strictEqual(
  fs.existsSync(path.join(boundaryAndroid.runtimeDir, 'CONTEXT.html')),
  false,
  'publishing one platform must not publish another session platform',
);
assert.strictEqual(
  fs.readFileSync(path.join(platformBoundaryRoot, 'index.html'), 'utf8').includes('data-platform-run="android"'),
  false,
);
refreshCommittedCaseReports(boundaryAndroid.caseDir, 'android');
const platformBoundaryIndex = fs.readFileSync(path.join(platformBoundaryRoot, 'index.html'), 'utf8');
assert.ok(platformBoundaryIndex.includes('iOS'));
assert.ok(platformBoundaryIndex.includes('Android'));

const concurrentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-concurrent-'));
createTestWorkspace(concurrentRoot);
const concurrentIos = createCurrentFixture(concurrentRoot, {
  suffix: 'concurrent-shared',
  platform: 'ios',
  verdict: 'PASS',
  sourceText: '相同原文',
  title: '并发平台用例',
});
const concurrentAndroid = createCurrentFixture(concurrentRoot, {
  suffix: 'concurrent-shared',
  platform: 'android',
  verdict: 'FAIL',
  sourceText: '相同原文',
  title: '并发平台用例',
});
assert.strictEqual(concurrentIos.caseDir, concurrentAndroid.caseDir);
const concurrentFactsBefore = [concurrentIos, concurrentAndroid].map(({ execDir }) => ({
  execution: sha256File(path.join(execDir, 'execution.json')),
  result: sha256File(path.join(execDir, 'result.json')),
}));
const concurrentLock = holdReportLock(concurrentRoot, 300);
const iosRefresh = spawnCommittedReportRefresh(concurrentIos.caseDir, 'ios');
const androidRefresh = spawnCommittedReportRefresh(concurrentAndroid.caseDir, 'android');
readRefreshResult(iosRefresh);
readRefreshResult(androidRefresh);
waitForFile(concurrentLock.releasedPath);

const concurrentIndex = fs.readFileSync(path.join(concurrentRoot, 'index.html'), 'utf8');
const concurrentMetadata = JSON.parse(fs.readFileSync(path.join(concurrentRoot, 'report-metadata.json'), 'utf8'));
const concurrentCaseContext = fs.readFileSync(path.join(concurrentIos.caseDir, 'CONTEXT.html'), 'utf8');
for (const [platform, verdict] of [['iOS', 'PASS'], ['Android', 'FAIL']]) {
  assert.ok(concurrentIndex.includes(platform), `index must retain ${platform}`);
  assert.ok(concurrentIndex.includes(verdict), `index must retain ${platform} ${verdict}`);
}
assert.ok(concurrentCaseContext.includes('相同原文'), 'case source report must remain intact');
assert.ok(fs.readFileSync(path.join(concurrentIos.runtimeDir, 'CONTEXT.html'), 'utf8').includes('PASS'));
assert.ok(fs.readFileSync(path.join(concurrentAndroid.runtimeDir, 'CONTEXT.html'), 'utf8').includes('FAIL'));
assert.strictEqual(concurrentMetadata.artifacts['index.html'].sha256, sha256File(path.join(concurrentRoot, 'index.html')));
assert.deepStrictEqual([concurrentIos, concurrentAndroid].map(({ execDir }) => ({
  execution: sha256File(path.join(execDir, 'execution.json')),
  result: sha256File(path.join(execDir, 'result.json')),
})), concurrentFactsBefore, 'report publication must not rewrite execution facts');
assert.strictEqual(fs.existsSync(path.join(concurrentRoot, '.report-publication.lock')), false);
assert.strictEqual(fs.existsSync(path.join(concurrentRoot, 'report-publication.draft.json')), false);
assert.strictEqual(fs.existsSync(path.join(concurrentIos.caseDir, 'report-publication.draft.json')), false);

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
fs.rmSync(retryRecoveryRoot, { recursive: true, force: true });
fs.rmSync(corruptedCommitPublicationRoot, { recursive: true, force: true });
fs.rmSync(corruptedTimingRoot, { recursive: true, force: true });
fs.rmSync(concurrentRoot, { recursive: true, force: true });
fs.rmSync(unpublishedSiblingRoot, { recursive: true, force: true });
fs.rmSync(platformBoundaryRoot, { recursive: true, force: true });
fs.rmSync(malformedLockRoot, { recursive: true, force: true });
console.log('publication-integrity passed');
