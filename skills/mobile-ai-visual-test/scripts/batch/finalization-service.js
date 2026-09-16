'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { appendJsonl, findActiveExecutions, readJson, withFileLock } = require('../lib/execution-lifecycle');
const { markClosed } = require('../lib/warm-session-contract');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');
const { loadBatch, readBatchState, saveBatch } = require('./state-repository');
const { caseRuntimeDir, currentCase, protocolBindings } = require('./service-support');

function commitBusinessTerminal(state, now = null) {
  const platformSettled = state.finalization?.platformReleased === true
    || state.finalization?.platformCleanupDeferred === true;
  if (state.finalization?.executionsSettled !== true || !platformSettled) return false;
  const terminalStatus = state.finalization.cause;
  if (!['COMPLETED', 'CANCELLED', 'BLOCKED'].includes(terminalStatus)) return false;
  state.status = terminalStatus;
  const field = { CANCELLED: 'cancelledAt', BLOCKED: 'blockedAt', COMPLETED: 'completedAt' }[terminalStatus];
  state[field] = state[field] || now || new Date().toISOString();
  return true;
}

function recordFinalizationStep(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readBatchState(loaded.paths, loaded.contract);
    if (['COMPLETED', 'CANCELLED', 'BLOCKED'].includes(state.status)) return { state, idempotent: true };
    if (!['FINALIZING', 'CANCELLING', 'BLOCKING'].includes(state.status)
      || (state.status === 'FINALIZING' && state.finalization?.casesCommitted !== true)) {
      throw contractError('BATCH_FINALIZATION_INVALID', 'batch is not ready for finalization');
    }
    if (options.step === 'executionsSettled') {
      const active = findActiveExecutions(options.workspaceRoot).filter((entry) => entry.execution.batchId === state.batchId);
      if (active.length) throw contractError('BATCH_EXECUTIONS_UNSETTLED', `batch still has active executions: ${active.map((entry) => entry.execution.executionId).join(', ')}`);
      state.finalization.executionsSettled = true;
    } else if (options.step === 'platformReleased') {
      if (state.finalization.executionsSettled !== true) throw contractError('BATCH_FINALIZATION_INVALID', 'executions must be settled before platform release');
      if (options.result?.ok !== true) throw contractError('PLATFORM_RUNTIME_RELEASE_FAILED', options.result?.reason || 'platform runtime release failed');
      state.finalization.platformReleased = true;
      delete state.finalization.platformCleanupDeferred;
      if (state.warmSession.status !== 'CLOSED') state.warmSession = markClosed(state.warmSession, options.now || new Date().toISOString());
    } else if (options.step === 'platformCleanupDeferred') {
      if (state.finalization.executionsSettled !== true) throw contractError('BATCH_FINALIZATION_INVALID', 'executions must be settled before deferring platform cleanup');
      state.finalization.platformCleanupDeferred = true;
      state.finalization.platformCleanup = {
        status: 'DEFERRED',
        ...(options.result?.failureCode ? { failureCode: options.result.failureCode } : {}),
        ...(options.result?.reason ? { reason: options.result.reason } : {}),
        ...(options.result?.diagnostic ? { diagnostic: options.result.diagnostic } : {}),
      };
      if (state.warmSession.status !== 'CLOSED') state.warmSession = markClosed(state.warmSession, options.now || new Date().toISOString());
    } else {
      throw contractError('BATCH_FINALIZATION_INVALID', `unknown finalization step: ${options.step}`);
    }
    commitBusinessTerminal(state, options.now);
    saveBatch(loaded.paths, state, options.now);
    return { state, finalization: state.finalization };
  }, { now: options.now });
}

function archiveBatchDrafts(paths, options = {}) {
  const drafts = [paths.bootstrapDraft, paths.caseStartDraft, ...(options.preserveCaseCommit ? [] : [paths.caseCommitDraft])]
    .filter((file) => fs.existsSync(file));
  if (!drafts.length) return [];
  const target = path.join(paths.batchDir, 'cancelled-transactions');
  fs.mkdirSync(target, { recursive: true });
  return drafts.map((file) => {
    const destination = path.join(target, path.basename(file));
    fs.renameSync(file, destination);
    return path.relative(paths.batchDir, destination).replace(/\\/g, '/');
  });
}

function cancelBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readBatchState(loaded.paths, loaded.contract);
    if (state.status === 'CANCELLED') return { action: 'BATCH_CANCELLED', state, idempotent: true };
    if (state.status === 'CANCELLING') {
      const nextAction = state.finalization?.executionsSettled !== true ? 'SETTLE_EXECUTIONS'
        : 'RELEASE_PLATFORM';
      return { action: 'CANCELLING', state, cancelledExecutions: [], nextAction, idempotent: true };
    }
    if (state.status === 'COMPLETED') throw contractError('BATCH_ALREADY_COMPLETED', 'a completed batch cannot be cancelled');
    const reason = String(options.reason || 'batch cancelled by user').trim();
    const active = findActiveExecutions(options.workspaceRoot)
      .filter((entry) => entry.execution.batchId === state.batchId);
    const cancelledExecutions = active.map((entry) => caseRuntimeLifecycle.cancelExecution({
      executionDir: entry.execDir, reason, now: options.now,
    }).execution.executionId);
    const item = currentCase(state);
    if (item?.status === 'RUNNING') {
      const execDir = item.executionId
        ? path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId) : null;
      const execution = execDir ? readJson(path.join(execDir, 'execution.json'), null) : null;
      const result = execDir ? readJson(path.join(execDir, 'result.json'), null) : null;
      if (execution?.finalized === true && execution.status !== 'CANCELLED' && result?.verdict) {
        if (state.cancellationRequested) {
          return { action: 'CANCELLATION_PENDING_COMMIT', state, cancelledExecutions: [], nextAction: 'COMMIT_CASE', idempotent: true };
        }
        state.cancellationRequested = {
          reason,
          requestedAt: options.now || new Date().toISOString(),
        };
        state.reason = reason;
        state.stoppedAt = state.stoppedAt || options.now || new Date().toISOString();
        state.cleanupDeadlineAt = new Date(Date.parse(state.stoppedAt) + 120000).toISOString();
        const archivedDrafts = archiveBatchDrafts(loaded.paths, { preserveCaseCommit: true });
        saveBatch(loaded.paths, state, options.now);
        appendJsonl(loaded.paths.events, {
          schemaVersion: 1,
          eventId: `batch-cancel-requested-${state.batchId}`,
          time: options.now || new Date().toISOString(),
          type: 'batchCancellationRequested',
          reason,
          cancelledExecutions: [],
          archivedDrafts,
          deferredCaseCommit: true,
        });
        return { action: 'CANCELLATION_PENDING_COMMIT', state, cancelledExecutions: [], nextAction: 'COMMIT_CASE' };
      } else {
        Object.assign(item, { status: 'CANCELLED', executionStatus: 'CANCELLED', endedAt: options.now || new Date().toISOString() });
      }
    }
    for (const pending of state.cases.filter((entry) => entry.status === 'PENDING')) pending.status = 'SKIPPED';
    const archivedDrafts = archiveBatchDrafts(loaded.paths);
    state.status = 'CANCELLING';
    state.reason = reason;
    state.stoppedAt = state.stoppedAt || options.now || new Date().toISOString();
    state.cleanupDeadlineAt = new Date(Date.parse(state.stoppedAt) + 120000).toISOString();
    state.finalization = { cause: 'CANCELLED', executionsSettled: false, casesCommitted: false, executionTerminated: true, platformReleased: false };
    saveBatch(loaded.paths, state, options.now);
    appendJsonl(loaded.paths.events, {
      schemaVersion: 1,
      eventId: `batch-cancelled-${state.batchId}`,
      time: options.now || new Date().toISOString(),
      type: 'batchCancellationRequested',
      reason,
      cancelledExecutions,
      archivedDrafts,
    });
    return { action: 'CANCELLING', state, cancelledExecutions, nextAction: 'SETTLE_EXECUTIONS' };
  }, { now: options.now });
}

module.exports = { cancelBatch, commitBusinessTerminal, recordFinalizationStep };
