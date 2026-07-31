#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  caseRuntimeDir,
  nowIso,
  readJson,
  rebuildCaseDerivedArtifacts,
  writeJson,
} = require('../common');
const { validateExecutionEnvironment } = require('./execution-environment');
const { validateFrozenPreconditionInputs } = require('./precondition-inputs');
const { completionDisplayResult, completionPaths, sha256File, validateCompletionBinding, validatePublishedCompletion } = require('./completion-contract');

function buildCompletion({ caseDir, platform, executionId, batchId, completionSource }) {
  const runtimeDir = caseRuntimeDir(caseDir, platform);
  const execDir = path.join(runtimeDir, 'executions', executionId);
  const paths = completionPaths(execDir);
  const execution = readJson(paths.execution);
  const result = readJson(paths.result);
  const metrics = readJson(paths.metrics);
  if (!execution?.finalized || !result || !metrics) throw new Error('Execution result artifacts are incomplete');
  validateExecutionEnvironment(execution, platform);
  validateFrozenPreconditionInputs(execution);
  if (!execution.batchId || execution.batchId !== batchId) throw new Error('Execution completion batch binding mismatch');
  if (result.executionId !== executionId || metrics.executionId !== executionId) throw new Error('Execution completion artifact binding mismatch');
  if (result.caseKey !== readJson(path.join(execDir, 'case.snapshot.json'))?.identity?.caseKey) throw new Error('Execution completion case binding mismatch');
  if (result.status !== metrics.status || (result.failureCode || null) !== (metrics.failureCode || null)) throw new Error('Execution completion business result mismatch');
  if (result.environmentSha !== execution.environmentSha || metrics.environmentSha !== execution.environmentSha) throw new Error('Execution completion environment binding mismatch');
  if (result.preconditionInputsSha !== execution.preconditionInputsSha || metrics.preconditionInputsSha !== execution.preconditionInputsSha) throw new Error('Execution completion precondition input binding mismatch');

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
      if (validation.environmentSha !== execution.environmentSha || validation.preconditionInputsSha !== execution.preconditionInputsSha) throw new Error('Agent validation execution binding mismatch');
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
    environmentSha: execution.environmentSha,
    preconditionInputsSha: execution.preconditionInputsSha,
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
    environmentSha: readJson(paths.execution)?.environmentSha || null,
    preconditionInputsSha: readJson(paths.execution)?.preconditionInputsSha || null,
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
  validatePublishedCompletion(execDir, completion, { execution: readJson(paths.execution), result, metrics, snapshot: readJson(paths.snapshot) });

  // completion.json 是 Runtime 校验后的可信发布标记。先原子发布，再刷新可重建的报告；
  // 即使报告写入中断，重复 batch commit 也会基于同一 completion 幂等重建。
  if (!fs.existsSync(paths.completion)) fs.renameSync(paths.draft, paths.completion);
  else if (fs.existsSync(paths.draft)) fs.unlinkSync(paths.draft);
  if (process.env.MAVT_SELF_TEST === '1' && process.env.MAVT_SELF_TEST_COMPLETION_INTERRUPT === 'after-publish') {
    throw new Error('MAVT_SELF_TEST_COMPLETION_INTERRUPT: after-publish');
  }

  const statePath = path.join(runtimeDir, 'state.json');
  const state = applyCompletionState(readJson(statePath, {
    schemaVersion: 1,
    executionCount: 0,
    statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 },
    environment: {},
  }), completion, result);
  writeJson(statePath, state);
  rebuildCaseDerivedArtifacts(caseDir, { scope: 'platform', platform });
  return completion;
}

module.exports = {
  buildCompletion,
  completionDisplayResult,
  completionPaths,
  publishExecution,
  validateCompletionBinding,
};
