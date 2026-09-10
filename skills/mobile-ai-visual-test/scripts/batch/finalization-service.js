'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { appendJsonl, findActiveExecutions, readJson, withFileLock } = require('../lib/execution-lifecycle');
const { markClosed } = require('../lib/warm-session-contract');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');
const { loadBatch, readBatchState, saveBatch } = require('./state-repository');
const { caseRuntimeDir, currentCase, protocolBindings } = require('./service-support');

function recordFinalizationStep(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options, 'FINALIZE'));
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
      if (state.warmSession.status !== 'CLOSED') state.warmSession = markClosed(state.warmSession, options.now || new Date().toISOString());
    } else if (options.step === 'reportsPublished') {
      if (state.finalization.platformReleased !== true) {
        throw contractError('BATCH_FINALIZATION_INVALID', 'platform must be released before report publication');
      }
      if (options.result?.status !== 'PUBLISHED') throw contractError('REPORT_PUBLICATION_FAILED', options.result?.reason || 'report publication failed');
      state.finalization.reportsPublished = true;
    } else {
      throw contractError('BATCH_FINALIZATION_INVALID', `unknown finalization step: ${options.step}`);
    }
    if (state.finalization.executionsSettled && state.finalization.platformReleased && state.finalization.reportsPublished) {
      const terminalStatus = state.finalization?.cause || (state.status === 'CANCELLING' ? 'CANCELLED' : 'COMPLETED');
      state.status = terminalStatus;
      const field = { CANCELLED: 'cancelledAt', BLOCKED: 'blockedAt', COMPLETED: 'completedAt' }[terminalStatus];
      state[field] = options.now || new Date().toISOString();
    }
    saveBatch(loaded.paths, state, options.now);
    return { state, finalization: state.finalization };
  }, { now: options.now });
}

function archiveBatchDrafts(paths) {
  const drafts = [paths.bootstrapDraft, paths.caseStartDraft, paths.caseCommitDraft].filter((file) => fs.existsSync(file));
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
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options, 'CANCEL'));
  return withFileLock(loaded.paths.lock, () => {
    const state = readBatchState(loaded.paths, loaded.contract);
    if (state.status === 'CANCELLED') return { action: 'BATCH_CANCELLED', state, idempotent: true };
    if (state.status === 'CANCELLING') {
      const nextAction = state.finalization?.executionsSettled !== true ? 'SETTLE_EXECUTIONS'
        : state.finalization?.platformReleased === true ? 'PUBLISH_REPORTS' : 'RELEASE_PLATFORM';
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
        Object.assign(item, { status: 'COMPLETED', verdict: result.verdict, executionStatus: execution.executionStatus || 'COMPLETED', endedAt: execution.endedAt });
      } else {
        Object.assign(item, { status: 'CANCELLED', executionStatus: 'CANCELLED', endedAt: options.now || new Date().toISOString() });
      }
    }
    for (const pending of state.cases.filter((entry) => entry.status === 'PENDING')) pending.status = 'SKIPPED';
    const archivedDrafts = archiveBatchDrafts(loaded.paths);
    state.status = 'CANCELLING';
    state.reason = reason;
    state.finalization = { cause: 'CANCELLED', executionsSettled: false, casesCommitted: false, executionTerminated: true, platformReleased: false, reportsPublished: false };
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

module.exports = { cancelBatch, recordFinalizationStep };
