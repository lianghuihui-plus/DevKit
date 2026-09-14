'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { appendJsonl, readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { loadBatch, readBatchState, saveBatch } = require('./state-repository');
const {
  buildCurrentCompletion,
  prepareCurrentCompletion,
  publishCurrentCompletion,
  releaseRuntime,
} = require('./completion');
const { caseRuntimeDir, currentCase, hasBatchEvent, protocolBindings } = require('./service-support');

function commitCurrentCase(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options, 'FINALIZE'));
  return withFileLock(loaded.paths.lock, () => {
    const state = readBatchState(loaded.paths, loaded.contract);
    let draft = readJson(loaded.paths.caseCommitDraft, null);
    let item;
    if (draft) {
      if (draft.schemaVersion !== 1 || draft.batchId !== state.batchId || !Number.isInteger(draft.caseIndex)
        || draft.caseIndex < 0 || draft.caseIndex >= state.cases.length
        || !['STARTED', 'VALIDATED', 'RUNTIME_RELEASED', 'COMPLETION_WRITTEN', 'STATE_COMMITTED'].includes(draft.stage)) {
        throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'case commit draft is invalid');
      }
      item = state.cases[draft.caseIndex];
      if (!item || item.caseKey !== draft.caseKey || item.executionId !== draft.executionId) {
        throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'case commit draft does not match batch state');
      }
    } else {
      item = currentCase(state);
      if (!item || item.status !== 'RUNNING') throw contractError('BATCH_CASE_INVALID', 'current case is not running');
      draft = {
        schemaVersion: 1,
        stage: 'STARTED',
        batchId: state.batchId,
        caseIndex: state.currentIndex,
        caseKey: item.caseKey,
        executionId: item.executionId,
        eventId: `case-committed-${state.batchId}-${item.order}`,
      };
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
    const execution = readJson(path.join(execDir, 'execution.json'));
    if (execution?.schemaVersion !== 11) throw contractError('FORMAT_UNSUPPORTED', `unsupported execution schema: ${execution?.schemaVersion ?? 'missing'}`);
    if (!execution?.finalized) throw contractError('EXECUTION_NOT_FINALIZED', 'current execution must be finalized before commit');
    if (execution.batchContractSha !== state.contractSha || execution.runtimeSha !== state.runtimeSha
      || execution.adapterSha !== state.adapterSha) {
      throw contractError('BATCH_BINDING_MISMATCH', 'execution does not match current batch implementation and contract');
    }
    const prepared = prepareCurrentCompletion(execDir, options);
    if (draft.stage === 'STARTED') {
      draft.stage = 'VALIDATED';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'validation') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: validation');
    const runtime = releaseRuntime(execDir, options);
    if (draft.stage === 'VALIDATED') {
      draft.stage = 'RUNTIME_RELEASED';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'runtime') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: runtime');
    const completion = publishCurrentCompletion(execDir, buildCurrentCompletion(execDir, state, item, prepared, runtime));
    if (draft.stage === 'RUNTIME_RELEASED') {
      draft.stage = 'COMPLETION_WRITTEN';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'completion') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: completion');
    if (item.status === 'RUNNING') {
      if (state.currentIndex !== draft.caseIndex) throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'currentIndex changed before case commit');
      Object.assign(item, { status: 'COMPLETED', verdict: completion.verdict, executionStatus: completion.executionStatus, endedAt: execution.endedAt });
      state.currentIndex = draft.caseIndex + 1;
      if (state.currentIndex >= state.cases.length) {
        state.status = 'FINALIZING';
        state.finalization = { cause: 'COMPLETED', executionsSettled: false, casesCommitted: true, platformReleased: false };
      }
      saveBatch(loaded.paths, state, options.now);
    } else if (item.status !== 'COMPLETED' || item.verdict !== completion.verdict
      || item.executionStatus !== completion.executionStatus || state.currentIndex < draft.caseIndex + 1) {
      throw contractError('BATCH_CASE_COMMIT_CORRUPTED', 'batch state contains a conflicting case commit');
    }
    if (draft.stage === 'COMPLETION_WRITTEN') {
      draft.stage = 'STATE_COMMITTED';
      writeJsonAtomic(loaded.paths.caseCommitDraft, draft);
    }
    if (options.interruptAfter === 'state') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: state');
    if (!hasBatchEvent(loaded.paths.events, (event) => event.eventId === draft.eventId)) {
      appendJsonl(loaded.paths.events, { schemaVersion: 1, eventId: draft.eventId, time: options.now || new Date().toISOString(), type: 'caseCommitted', caseKey: item.caseKey, executionId: item.executionId, verdict: item.verdict });
    }
    if (options.interruptAfter === 'event') throw new Error('MAVT_BATCH_COMMIT_INTERRUPTED: event');
    if (fs.existsSync(loaded.paths.caseCommitDraft)) fs.unlinkSync(loaded.paths.caseCommitDraft);
    return { state, item, completion, runtime };
  }, { now: options.now });
}

module.exports = { commitCurrentCase };
