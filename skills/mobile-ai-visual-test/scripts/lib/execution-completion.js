#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  caseRuntimeDir,
  nowIso,
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
  writeJson,
} = require('../common');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function completionPaths(execDir) {
  return {
    completion: path.join(execDir, 'completion.json'),
    draft: path.join(execDir, 'completion.draft.json'),
    execution: path.join(execDir, 'execution.json'),
    result: path.join(execDir, 'result.json'),
    metrics: path.join(execDir, 'metrics.json'),
    timeline: path.join(execDir, 'timeline.jsonl'),
    validation: path.join(execDir, 'agent', 'validation.json'),
    runtime: path.join(execDir, 'agent', 'runtime.json'),
  };
}

function validateCompletionBinding(value, expected) {
  if (!value || value.schemaVersion !== 1) throw new Error('Execution completion is invalid');
  for (const field of ['executionId', 'batchId', 'caseKey', 'platform', 'completionSource']) {
    if ((value[field] || null) !== (expected[field] || null)) throw new Error(`Execution completion ${field} mismatch`);
  }
  if (!['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN'].includes(value.status) || !['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN'].includes(value.businessStatus)) {
    throw new Error('Execution completion status is invalid');
  }
  if (value.completionSource === 'framework' && (value.controlStatus !== 'NOT_REQUIRED' || value.status !== value.businessStatus || value.validationSha256)) {
    throw new Error('Framework execution completion control state is invalid');
  }
  if (value.completionSource === 'agent' && (!['VALIDATED', 'BLOCKED'].includes(value.controlStatus) || !value.validationSha256)) {
    throw new Error('Agent execution completion control state is invalid');
  }
  if (value.controlStatus === 'BLOCKED' && value.status !== 'BLOCKED') throw new Error('Blocked execution completion must publish BLOCKED');
  return value;
}

function buildCompletion({ caseDir, platform, executionId, batchId, completionSource }) {
  const runtimeDir = caseRuntimeDir(caseDir, platform);
  const execDir = path.join(runtimeDir, 'executions', executionId);
  const paths = completionPaths(execDir);
  const execution = readJson(paths.execution);
  const result = readJson(paths.result);
  const metrics = readJson(paths.metrics);
  if (!execution?.finalized || !result || !metrics) throw new Error('Execution result artifacts are incomplete');
  if (!execution.batchId || execution.batchId !== batchId) throw new Error('Execution completion batch binding mismatch');
  if (result.executionId !== executionId || metrics.executionId !== executionId) throw new Error('Execution completion artifact binding mismatch');
  if (result.caseKey !== readJson(path.join(execDir, 'case.snapshot.json'))?.identity?.caseKey) throw new Error('Execution completion case binding mismatch');
  if (result.status !== metrics.status || (result.failureCode || null) !== (metrics.failureCode || null)) throw new Error('Execution completion business result mismatch');

  let validation = null;
  let runtime = null;
  let controlStatus = 'NOT_REQUIRED';
  let status = result.status;
  let failureCode = result.failureCode || null;
  let reason = result.reason || '';
  if (completionSource === 'agent') {
    validation = readJson(paths.validation);
    runtime = readJson(paths.runtime);
    if (!validation || !runtime) throw new Error('Agent completion requires runtime.json and validation.json');
    if (validation.executionId !== executionId || runtime.executionId !== executionId) throw new Error('Agent completion runtime binding mismatch');
    if ((runtime.batchId || null) !== batchId) throw new Error('Agent completion runtime batch binding mismatch');
    const releasedTerminal = runtime.releasedAt && ['COMPLETED', 'FAILED', 'INTERRUPTED', 'TIMED_OUT'].includes(runtime.state);
    if (!releasedTerminal) throw new Error('Agent completion requires a released terminal Runtime');
    if (validation.valid === true) {
      if (runtime.state !== 'COMPLETED') throw new Error('Valid Agent completion requires Runtime COMPLETED');
      if (validation.status !== result.status || (validation.failureCode || null) !== (result.failureCode || null)) throw new Error('Agent validation does not match business result');
      controlStatus = 'VALIDATED';
    } else {
      if (!['FAILED', 'INTERRUPTED', 'TIMED_OUT'].includes(runtime.state)) throw new Error('Invalid Agent completion requires a failed Runtime terminal state');
      controlStatus = 'BLOCKED';
      status = 'BLOCKED';
      failureCode = validation.failureCode || 'AGENT_RESULT_INVALID';
      reason = validation.reason || 'Agent Runtime validation failed.';
    }
  } else if (completionSource !== 'framework') {
    throw new Error('Execution completion source must be agent or framework');
  }

  return {
    schemaVersion: 1,
    executionId,
    batchId,
    caseKey: result.caseKey,
    platform,
    completionSource,
    businessStatus: result.status,
    businessFailureCode: result.failureCode || null,
    controlStatus,
    status,
    failureCode,
    reason,
    runtimeState: runtime?.state || null,
    sessionReleased: completionSource === 'framework' ? null : Boolean(runtime?.releasedAt),
    resultSha256: sha256File(paths.result),
    metricsSha256: sha256File(paths.metrics),
    validationSha256: validation ? sha256File(paths.validation) : null,
    completedAt: nowIso(),
  };
}

function completionDisplayResult(result, completion) {
  if (!completion) return result;
  return {
    ...result,
    status: completion.status,
    failureCode: completion.failureCode,
    reason: completion.reason || result.reason || '',
    businessStatus: completion.businessStatus,
    businessFailureCode: completion.businessFailureCode,
    businessReason: result.reason || '',
    controlStatus: completion.controlStatus,
    completionSource: completion.completionSource,
  };
}

function applyCompletionState(state, completion, result) {
  const committed = Array.isArray(state.committedExecutionIds) ? state.committedExecutionIds : [];
  if (!committed.includes(completion.executionId)) {
    state.executionCount = (state.executionCount || 0) + 1;
    state.statusCounts = state.statusCounts || { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 };
    state.statusCounts[completion.status] = (state.statusCounts[completion.status] || 0) + 1;
    state.committedExecutionIds = [...committed, completion.executionId];
  }
  state.latestStatus = completion.status;
  state.latestBusinessStatus = completion.businessStatus;
  state.latestExecutionId = completion.executionId;
  state.latestFailedStep = result.failedStep || null;
  state.latestFailureCode = completion.failureCode || null;
  state.latestReason = completion.reason || result.reason || '';
  if (completion.status === 'PASS') state.lastPassedAt = completion.completedAt;
  else state.lastFailedAt = completion.completedAt;
  return state;
}

function publishExecution({ caseDir, platform, executionId, batchId, completionSource }) {
  const runtimeDir = caseRuntimeDir(caseDir, platform);
  const execDir = path.join(runtimeDir, 'executions', executionId);
  const paths = completionPaths(execDir);
  const expected = {
    executionId,
    batchId,
    caseKey: readJson(path.join(execDir, 'result.json'))?.caseKey || null,
    platform,
    completionSource,
  };
  let completion = readJson(paths.completion);
  if (completion) {
    validateCompletionBinding(completion, expected);
  } else {
    completion = readJson(paths.draft) || buildCompletion({ caseDir, platform, executionId, batchId, completionSource });
    validateCompletionBinding(completion, expected);
    writeJson(paths.draft, completion);
  }

  const result = readJson(paths.result);
  const metrics = readJson(paths.metrics);
  if (sha256File(paths.result) !== completion.resultSha256 || sha256File(paths.metrics) !== completion.metricsSha256) {
    throw new Error('Execution completion artifact hash mismatch');
  }
  if (completion.validationSha256 && sha256File(paths.validation) !== completion.validationSha256) {
    throw new Error('Execution completion validation hash mismatch');
  }

  const statePath = path.join(runtimeDir, 'state.json');
  const state = applyCompletionState(readJson(statePath, {
    schemaVersion: 1,
    executionCount: 0,
    statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 },
    environment: {},
  }), completion, result);
  writeJson(statePath, state);

  // completion.json 是 Runtime 校验后的可信发布标记。先原子发布，再刷新可重建的报告；
  // 即使报告写入中断，重复 batch commit 也会基于同一 completion 幂等重建。
  if (!fs.existsSync(paths.completion)) fs.renameSync(paths.draft, paths.completion);
  else if (fs.existsSync(paths.draft)) fs.unlinkSync(paths.draft);

  const caseJson = readJson(path.join(caseDir, 'case.json')) || readJson(path.join(execDir, 'case.snapshot.json'));
  const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));
  const displayResult = completionDisplayResult(result, completion);
  const events = readJsonl(paths.timeline);
  writeCaseReports(caseDir, caseJson, state, notes, { latest: execDir, result: displayResult, metrics, events, completion }, { platform });
  refreshIndexForCase(caseDir);
  return completion;
}

module.exports = {
  buildCompletion,
  completionDisplayResult,
  completionPaths,
  publishExecution,
  validateCompletionBinding,
};
