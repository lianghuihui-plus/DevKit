'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('./contract-utils');
const { readJson, withFileLock, writeJsonAtomic } = require('./execution-lifecycle');

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function statePaths(directory) {
  return { state: path.join(directory, 'dispatch-state.json'), lock: path.join(directory, '.dispatch-state.lock') };
}

function claimTokenFor(envelope) {
  return digest(canonicalJson({ handoffId: envelope.handoffId, payloadSha256: envelope.payloadSha256 }));
}

function initialState(executionId) {
  return { schemaVersion: 1, executionId, activeDispatchId: null, dispatches: {} };
}

function validateState(state, executionId) {
  if (!state || state.schemaVersion !== 1 || state.executionId !== executionId
    || !state.dispatches || typeof state.dispatches !== 'object') {
    throw contractError('HANDOFF_LEASE_INVALID', 'dispatch lease state is invalid');
  }
  return state;
}

function activeDispatch(state) {
  return state.dispatches[state.activeDispatchId] || null;
}

function readActiveDispatch(directory, executionId) {
  const paths = statePaths(directory);
  if (!fs.existsSync(paths.state)) return null;
  const state = validateState(readJson(paths.state, null), executionId);
  const dispatch = activeDispatch(state);
  if (!dispatch) return null;
  if (dispatch.executionId !== executionId || !['PREPARED', 'CONSUMED'].includes(dispatch.status)) {
    throw contractError('HANDOFF_LEASE_INVALID', 'active dispatch state is invalid');
  }
  return JSON.parse(JSON.stringify(dispatch));
}

function assertActiveDispatch(directory, executionId, sequence) {
  const state = validateState(readJson(statePaths(directory).state, null), executionId);
  const dispatch = activeDispatch(state);
  const requested = Object.values(state.dispatches).find((item) => item.sequence === sequence) || null;
  if (!requested) {
    throw contractError('HANDOFF_SEQUENCE_MISMATCH', 'dispatch sequence is unknown; reuse the command from the loaded handoff exactly');
  }
  if (!dispatch || requested.dispatchId !== dispatch.dispatchId || requested.status === 'REPLACED') {
    throw contractError('HANDOFF_REPLACED', 'handoff was replaced by a newer continuation');
  }
  if (requested.status !== 'CONSUMED') {
    throw contractError('HANDOFF_NOT_CLAIMED', 'handoff must be claimed before using the Runtime client');
  }
  return requested;
}

function registerDispatch(directory, envelope, options = {}) {
  if (envelope.mode === 'CONTINUATION' && !String(options.continuationReason || '').trim()) {
    throw contractError('HANDOFF_CONTINUATION_INVALID', 'continuation requires an explicit native Agent handle loss reason');
  }
  const paths = statePaths(directory);
  return withFileLock(paths.lock, () => {
    const state = validateState(readJson(paths.state, initialState(envelope.executionId)), envelope.executionId);
    const existing = state.dispatches[envelope.handoffId];
    const tokenSha = digest(claimTokenFor(envelope));
    if (existing) {
      if (existing.sequence !== envelope.sequence || existing.handoffSha !== options.handoffSha || existing.claimTokenSha !== tokenSha) {
        throw contractError('HANDOFF_LEASE_INVALID', 'dispatch state does not match immutable handoff');
      }
      return state;
    }
    state.dispatches[envelope.handoffId] = {
      dispatchId: envelope.handoffId,
      executionId: envelope.executionId,
      handoffSha: options.handoffSha,
      sequence: envelope.sequence,
      status: 'PREPARED',
      claimTokenSha: tokenSha,
      createdAt: envelope.createdAt,
      ...(options.continuationReason ? { continuationReason: String(options.continuationReason) } : {}),
    };
    const dispatches = Object.values(state.dispatches);
    const active = dispatches.sort((left, right) => right.sequence - left.sequence)[0];
    state.activeDispatchId = active.dispatchId;
    for (const dispatch of dispatches) {
      if (dispatch.dispatchId !== active.dispatchId && dispatch.sequence < active.sequence && dispatch.status !== 'REPLACED') {
        dispatch.status = 'REPLACED';
        dispatch.replacedByDispatchId = active.dispatchId;
      }
    }
    writeJsonAtomic(paths.state, state);
    return state;
  }, { now: options.now });
}

function claimDispatch(directory, envelope, options = {}) {
  const paths = statePaths(directory);
  if (!fs.existsSync(paths.state)) registerDispatch(directory, envelope, {
    handoffSha: options.handoffSha,
    continuationReason: envelope.mode === 'CONTINUATION' ? 'continuation handoff load' : null,
    now: options.now,
  });
  return withFileLock(paths.lock, () => {
    const state = validateState(readJson(paths.state, null), envelope.executionId);
    const dispatch = state.dispatches[envelope.handoffId];
    if (!dispatch || dispatch.handoffSha !== options.handoffSha) throw contractError('HANDOFF_LEASE_INVALID', 'handoff has no matching dispatch state');
    if (dispatch.status === 'REPLACED' || state.activeDispatchId !== dispatch.dispatchId) {
      throw contractError('HANDOFF_REPLACED', 'handoff was replaced by a newer continuation');
    }
    if (!String(options.claimToken || '').trim()) {
      throw contractError('HANDOFF_CLAIM_REJECTED', 'handoff claim token is required');
    }
    const token = options.claimToken;
    if (digest(token) !== dispatch.claimTokenSha) throw contractError('HANDOFF_CLAIM_REJECTED', 'handoff claim token does not match');
    const now = options.now || new Date().toISOString();
    const wasConsumed = Boolean(dispatch.consumedAt);
    if (!dispatch.claimedAt) dispatch.claimedAt = now;
    dispatch.status = 'CONSUMED';
    if (!dispatch.consumedAt) dispatch.consumedAt = now;
    writeJsonAtomic(paths.state, state);
    return { state, dispatch, idempotent: wasConsumed };
  }, { now: options.now });
}

module.exports = {
  assertActiveDispatch,
  claimDispatch,
  claimTokenFor,
  readActiveDispatch,
  registerDispatch,
  statePaths,
};
