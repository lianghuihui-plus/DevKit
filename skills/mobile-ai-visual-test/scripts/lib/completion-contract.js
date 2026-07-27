#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256File(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing completion artifact: ${file}`);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function completionPaths(execDir) {
  return {
    completion: path.join(execDir, 'completion.json'),
    draft: path.join(execDir, 'completion.draft.json'),
    execution: path.join(execDir, 'execution.json'),
    snapshot: path.join(execDir, 'case.snapshot.json'),
    result: path.join(execDir, 'result.json'),
    metrics: path.join(execDir, 'metrics.json'),
    timeline: path.join(execDir, 'timeline.jsonl'),
    validation: path.join(execDir, 'agent', 'validation.json'),
    runtime: path.join(execDir, 'agent', 'runtime.json'),
  };
}

function validateCompletionBinding(value, expected) {
  if (!value || value.schemaVersion !== 1) throw new Error('Execution completion is invalid');
  for (const field of ['executionId', 'batchId', 'caseKey', 'platform', 'completionSource', 'environmentSha', 'preconditionInputsSha']) {
    if ((value[field] || null) !== (expected[field] || null)) throw new Error(`Execution completion ${field} mismatch`);
  }
  if (!/^environment-[0-9a-f]{16}$/.test(value.environmentSha || '') || !/^precondition-inputs-[0-9a-f]{16}$/.test(value.preconditionInputsSha || '')) throw new Error('Execution completion frozen binding is invalid');
  if (!['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN'].includes(value.status) || !['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN'].includes(value.businessStatus)) throw new Error('Execution completion status is invalid');
  if (value.completionSource === 'framework' && (value.controlStatus !== 'NOT_REQUIRED' || value.status !== value.businessStatus || value.validationSha256)) throw new Error('Framework execution completion control state is invalid');
  if (value.completionSource === 'agent' && (!['VALIDATED', 'BLOCKED'].includes(value.controlStatus) || !value.validationSha256)) throw new Error('Agent execution completion control state is invalid');
  if (value.controlStatus === 'BLOCKED' && value.status !== 'BLOCKED') throw new Error('Blocked execution completion must publish BLOCKED');
  return value;
}

function validatePublishedCompletion(execDir, completion, artifacts) {
  const paths = completionPaths(execDir);
  const execution = artifacts.execution;
  const result = artifacts.result;
  const metrics = artifacts.metrics;
  const snapshot = artifacts.snapshot;
  if (!execution?.finalized || !result || !metrics || !snapshot) throw new Error('Execution completion artifacts are incomplete');
  validateCompletionBinding(completion, {
    executionId: execution.executionId,
    batchId: execution.batchId,
    caseKey: snapshot.identity?.caseKey,
    platform: execution.environmentSnapshot?.binding?.platform || result.environment?.platform || null,
    completionSource: completion.completionSource,
    environmentSha: execution.environmentSha,
    preconditionInputsSha: execution.preconditionInputsSha,
  });
  if (result.executionId !== execution.executionId || metrics.executionId !== execution.executionId || result.caseKey !== snapshot.identity?.caseKey) throw new Error('Execution completion artifact binding mismatch');
  if (result.status !== metrics.status || (result.failureCode || null) !== (metrics.failureCode || null)) throw new Error('Execution completion business result mismatch');
  if (result.environmentSha !== execution.environmentSha || metrics.environmentSha !== execution.environmentSha || result.preconditionInputsSha !== execution.preconditionInputsSha || metrics.preconditionInputsSha !== execution.preconditionInputsSha) throw new Error('Execution completion frozen artifact binding mismatch');
  if (sha256File(paths.result) !== completion.resultSha256 || sha256File(paths.metrics) !== completion.metricsSha256) throw new Error('Execution completion artifact hash mismatch');
  if (completion.validationSha256 && sha256File(paths.validation) !== completion.validationSha256) throw new Error('Execution completion validation hash mismatch');
  return completion;
}

function completionDisplayResult(result, completion) {
  if (!completion) return result;
  return { ...result, status: completion.status, failureCode: completion.failureCode || null, reason: completion.reason || result.reason || '', businessStatus: completion.businessStatus, businessFailureCode: completion.businessFailureCode || null, businessReason: result.reason || '', controlStatus: completion.controlStatus, completionSource: completion.completionSource };
}

module.exports = { completionDisplayResult, completionPaths, sha256File, validateCompletionBinding, validatePublishedCompletion };
