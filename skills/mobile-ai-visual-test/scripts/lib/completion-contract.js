#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateExecutionArtifactManifest } = require('./execution-artifact-manifest');

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
  };
}

function validateCompletionBinding(value, expected) {
  if (value?.schemaVersion !== 3) throw new Error('Execution completion protocol is unsupported');
  for (const field of ['executionId', 'batchId', 'caseKey', 'platform', 'completionSource', 'runtimeSha', 'adapterSha', 'contractSha', 'batchContractSha']) {
    if ((value[field] || null) !== (expected[field] || null)) throw new Error(`Execution completion ${field} mismatch`);
  }
  if (value.metricsSchemaVersion !== 3) throw new Error('Execution completion artifact schema mismatch');
  if (value.completionSource !== 'framework' || value.runtimeCompleted !== true) throw new Error('Case Runtime completion state is invalid');
  if (!['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'].includes(value.verdict)) throw new Error('Execution completion verdict is invalid');
  if (!['COMPLETED', 'TECHNICALLY_BLOCKED'].includes(value.executionStatus)) throw new Error('Execution completion executionStatus is invalid');
  for (const field of ['resultSha256', 'metricsSha256', 'artifactManifestSha256']) {
    if (!/^[0-9a-f]{64}$/.test(value[field] || '')) throw new Error(`Execution completion ${field} is invalid`);
  }
  return value;
}

function validatePublishedCompletion(execDir, completion, artifacts) {
  const paths = completionPaths(execDir);
  const { execution, result, metrics, snapshot } = artifacts;
  if (execution?.schemaVersion !== 10 || !execution.finalized || !result || !metrics || !snapshot) {
    throw new Error('Execution completion artifacts are incomplete or unsupported');
  }
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
  });
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
};
