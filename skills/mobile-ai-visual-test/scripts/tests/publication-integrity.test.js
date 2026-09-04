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
const { readPublicationState, recordPublicationAttempt } = require('../report/publication-state');
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

const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-retry-'));
recordPublicationAttempt(reportRoot, 'batch-retry', 'batch', { status: 'FAILED', errorCode: 'REPORT_TEST_FAILED', reason: 'simulated' });
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').status, 'RETRY_REQUIRED');
recordPublicationAttempt(reportRoot, 'batch-retry', 'batch', { status: 'PUBLISHED' });
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').status, 'PUBLISHED');
assert.strictEqual(readPublicationState(reportRoot, 'batch-retry').attempts.length, 2);

for (const item of [published, missing, unsettled, emptyPass, changedScene]) fs.rmSync(item.root, { recursive: true, force: true });
fs.rmSync(reportRoot, { recursive: true, force: true });
console.log('publication-integrity passed');
