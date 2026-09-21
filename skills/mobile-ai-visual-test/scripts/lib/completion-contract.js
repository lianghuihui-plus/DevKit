#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateExecutionArtifactManifest } = require('./execution-artifact-manifest');
const { canonicalJson, contractError } = require('./contract-utils');
const { sourceSha, validateCaseContract } = require('../execution/contracts/case-contract');
const { readJson } = require('./execution-lifecycle');
const { resolveArtifact } = require('./execution-evidence');

function sha256File(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing completion artifact: ${file}`);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function completionPaths(execDir) {
  return {
    completion: path.join(execDir, 'completion.json'),
    execution: path.join(execDir, 'execution.json'),
    snapshot: path.join(execDir, 'case.snapshot.json'),
    result: path.join(execDir, 'result.json'),
    metrics: path.join(execDir, 'metrics.json'),
    events: path.join(execDir, 'events.jsonl'),
    runtime: path.join(execDir, 'runtime.json'),
    artifactManifest: path.join(execDir, 'artifact-manifest.json'),
    validationProfile: path.join(execDir, 'validation-profile.snapshot.json'),
  };
}

function validateCompletionBinding(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('FORMAT_UNSUPPORTED', 'Execution completion format is unsupported');
  }
  const allowed = new Set([
    'executionId', 'batchId', 'caseKey', 'platform', 'completionSource', 'runtimeSha', 'adapterSha',
    'contractSha', 'batchContractSha', 'validationProfileSha', 'verdict', 'executionStatus',
    'runtimeCompleted', 'resultSha256', 'metricsSha256', 'artifactManifestSha256',
  ]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw contractError('FORMAT_UNSUPPORTED', 'Execution completion format is unsupported');
  }
  for (const field of ['executionId', 'batchId', 'caseKey', 'platform', 'completionSource', 'runtimeSha', 'adapterSha', 'contractSha', 'batchContractSha']) {
    if ((value[field] || null) !== (expected[field] || null)) throw new Error(`Execution completion ${field} mismatch`);
  }
  if (!/^validation-profile-[0-9a-f]{24}$/.test(value.validationProfileSha || '')) throw new Error('Execution completion validationProfileSha is invalid');
  if (value.validationProfileSha !== expected.validationProfileSha) throw new Error('Execution completion validationProfileSha mismatch');
  if (value.completionSource !== 'framework' || value.runtimeCompleted !== true) throw new Error('Case Runtime completion state is invalid');
  if (!['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'NOT_RUN'].includes(value.verdict)) throw new Error('Execution completion verdict is invalid');
  if (!['COMPLETED', 'TECHNICALLY_BLOCKED'].includes(value.executionStatus)) throw new Error('Execution completion executionStatus is invalid');
  for (const field of ['resultSha256', 'metricsSha256', 'artifactManifestSha256']) {
    if (!/^[0-9a-f]{64}$/.test(value[field] || '')) throw new Error(`Execution completion ${field} is invalid`);
  }
  return value;
}

function validateExecutionSnapshotBindings(execDir, execution, snapshot) {
  try {
    validateCaseContract(snapshot);
    const sourceText = fs.readFileSync(resolveArtifact(execDir, 'source.snapshot.md'), 'utf8');
    const binding = readJson(resolveArtifact(execDir, 'binding.snapshot.json'), null);
    if (snapshot.identity.caseKey == null
      || snapshot.identity.sourceSha !== sourceSha(sourceText)
      || snapshot.identity.sourceSha !== execution.sourceSha
      || snapshot.contractSha !== execution.contractSha
      || binding?.bindingSha !== execution.targetBindingSha
      || binding?.batchContractSha !== execution.batchContractSha
      || canonicalJson(binding?.binding) !== canonicalJson(execution.targetBinding)) {
      throw new Error('execution snapshots do not match their source or environment bindings');
    }
  } catch (cause) {
    throw contractError('EXECUTION_SNAPSHOT_BINDING_INVALID', cause.message || String(cause));
  }
}

function validatePublishedCompletion(execDir, completion, artifacts) {
  const paths = completionPaths(execDir);
  const { execution, result, metrics, snapshot } = artifacts;
  if (execution?.schemaVersion !== 13 || !execution.finalized || !result || !metrics || !snapshot) {
    throw new Error('Execution completion artifacts are incomplete or unsupported');
  }
  validateExecutionSnapshotBindings(execDir, execution, snapshot);
  validateCompletionBinding(completion, {
    executionId: execution.executionId,
    batchId: execution.batchId,
    caseKey: snapshot.identity?.caseKey,
    platform: execution.platform,
    completionSource: 'framework',
    runtimeSha: execution.runtimeSha,
    adapterSha: execution.adapterSha,
    contractSha: execution.contractSha,
    batchContractSha: execution.batchContractSha,
    validationProfileSha: execution.validationProfileSha,
  });
  require('../execution/contracts/validation-profile-contract').loadValidationProfile(execDir, execution);
  if (metrics.schemaVersion !== 3 || metrics.executionId !== execution.executionId) {
    throw new Error('Execution completion artifact binding mismatch');
  }
  if (result.verdict !== completion.verdict || metrics.verdict !== completion.verdict || metrics.executionStatus !== completion.executionStatus) {
    throw new Error('Execution completion result mismatch');
  }
  if (sha256File(paths.result) !== completion.resultSha256 || sha256File(paths.metrics) !== completion.metricsSha256) {
    throw new Error('Execution completion artifact hash mismatch');
  }
  validateExecutionArtifactManifest(execDir, completion.artifactManifestSha256);
  return completion;
}

module.exports = {
  completionPaths,
  sha256File,
  validateCompletionBinding,
  validatePublishedCompletion,
  validateExecutionSnapshotBindings,
};
