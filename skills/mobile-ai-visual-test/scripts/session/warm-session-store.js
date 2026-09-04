'use strict';

const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { markRecovered } = require('../lib/warm-session-contract');

function validateSessionRef(value, batchId) {
  if (!value || value.schemaVersion !== 1 || value.batchId !== batchId
    || !path.isAbsolute(value.statePath || '') || !path.isAbsolute(value.lockPath || '')) {
    throw contractError('SESSION_REF_INVALID', 'execution sessionRef is invalid');
  }
  return { state: path.resolve(value.statePath), lock: path.resolve(value.lockPath) };
}

function commitRecoveryGeneration(options) {
  const target = validateSessionRef(options.sessionRef, options.batchId);
  return withFileLock(target.lock, () => {
    const state = readJson(target.state, null);
    if (!state) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${options.batchId}`);
    if (state.warmSession.generation < options.nextGeneration) {
      state.warmSession = markRecovered(state.warmSession, options.now);
      if (state.warmSession.generation !== options.nextGeneration) {
        throw contractError('RECOVERY_GENERATION_MISMATCH', 'batch warm session generation changed concurrently');
      }
      state.updatedAt = options.now;
      writeJsonAtomic(target.state, state);
    } else if (state.warmSession.generation !== options.nextGeneration) {
      throw contractError('RECOVERY_GENERATION_MISMATCH', 'batch warm session is ahead of this execution');
    }
    return state.warmSession;
  }, { now: options.now });
}

module.exports = { commitRecoveryGeneration, validateSessionRef };
