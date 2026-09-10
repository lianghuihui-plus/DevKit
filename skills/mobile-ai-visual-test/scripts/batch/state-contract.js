'use strict';

const { canonicalJson, contractError, ensureId, ensureObject, ensureString } = require('../lib/contract-utils');
const { validateWarmSession } = require('../lib/warm-session-contract');

const BATCH_STATUSES = new Set([
  'INITIALIZING', 'RUNNING', 'FINALIZING', 'BLOCKING', 'CANCELLING',
  'COMPLETED', 'BLOCKED', 'CANCELLED',
]);
const CASE_STATUSES = new Set(['PENDING', 'RUNNING', 'COMPLETED', 'BLOCKED', 'CANCELLED', 'SKIPPED']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'BLOCKED', 'CANCELLED']);
const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const BATCH_SCHEMA_VERSION = 8;

function invalid(message) {
  return contractError('BATCH_STATE_INVALID', message);
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw invalid(`${field} must be boolean`);
}

function validateFinalization(state) {
  const finalization = ensureObject(state.finalization, 'finalization', 'BATCH_STATE_INVALID');
  for (const field of ['platformReleased', 'reportsPublished']) requireBoolean(finalization[field], `finalization.${field}`);
  if (state.status === 'INITIALIZING' || state.status === 'RUNNING') {
    if (finalization.platformReleased || finalization.reportsPublished) throw invalid('active batch cannot contain completed finalization steps');
    return;
  }
  requireBoolean(finalization.executionsSettled, 'finalization.executionsSettled');
  if (finalization.platformReleased && !finalization.executionsSettled) throw invalid('platform release requires settled executions');
  if (finalization.reportsPublished && !finalization.platformReleased) throw invalid('report publication requires platform release');
  const expectedCause = {
    FINALIZING: 'COMPLETED', COMPLETED: 'COMPLETED',
    CANCELLING: 'CANCELLED', CANCELLED: 'CANCELLED',
    BLOCKING: 'BLOCKED', BLOCKED: 'BLOCKED',
  }[state.status];
  if (finalization.cause !== expectedCause) throw invalid(`finalization.cause must be ${expectedCause} for ${state.status}`);
  if (expectedCause === 'COMPLETED' && finalization.casesCommitted !== true) throw invalid('completed finalization requires all cases committed');
  if (TERMINAL_STATUSES.has(state.status)
    && (!finalization.executionsSettled || !finalization.platformReleased || !finalization.reportsPublished)) {
    throw invalid('terminal batch requires a completed finalization checklist');
  }
}

function validateCases(state, contract) {
  if (!Array.isArray(state.cases) || state.cases.length === 0) throw invalid('cases must be a non-empty array');
  if (!Number.isInteger(state.currentIndex) || state.currentIndex < 0 || state.currentIndex > state.cases.length) {
    throw invalid('currentIndex is outside the cases array');
  }
  if (contract?.targets?.length !== state.cases.length) throw invalid('cases length does not match the frozen contract');
  let runningCount = 0;
  state.cases.forEach((item, index) => {
    ensureObject(item, `cases[${index}]`, 'BATCH_STATE_INVALID');
    ensureId(item.caseKey, `cases[${index}].caseKey`, 'BATCH_STATE_INVALID');
    if (item.order !== index + 1) throw invalid(`cases[${index}].order is invalid`);
    if (!CASE_STATUSES.has(item.status)) throw invalid(`cases[${index}].status is invalid`);
    if (item.status === 'RUNNING') runningCount += 1;
    if (['RUNNING', 'COMPLETED', 'BLOCKED', 'CANCELLED'].includes(item.status)) {
      ensureId(item.executionId, `cases[${index}].executionId`, 'BATCH_STATE_INVALID');
    }
    if (['PENDING', 'SKIPPED'].includes(item.status) && item.executionId !== null) {
      throw invalid(`cases[${index}] cannot bind an execution while ${item.status}`);
    }
    if (item.status === 'COMPLETED') {
      if (!VERDICTS.has(item.verdict)) throw invalid(`cases[${index}].verdict is invalid`);
      ensureString(item.executionStatus, `cases[${index}].executionStatus`, 'BATCH_STATE_INVALID');
    }
    if (contract?.targets?.[index]) {
      const frozen = contract.targets[index];
      for (const field of ['order', 'caseNo', 'caseKey', 'caseDir', 'snapshotPath', 'sourceSha', 'caseContractSha', 'definitionId', 'definitionSha', 'caseSpecSha', 'preparationPolicySha', 'initialStateRequirementSha', 'initialStatePreflightSha']) {
        if (canonicalJson(item[field]) !== canonicalJson(frozen[field])) throw invalid(`cases[${index}].${field} does not match the frozen contract`);
      }
      if (canonicalJson(item.preparationPolicy) !== canonicalJson(frozen.preparationPolicy)) {
        throw invalid(`cases[${index}].preparationPolicy does not match the frozen contract`);
      }
      if (canonicalJson(item.initialStateRequirement) !== canonicalJson(frozen.initialStateRequirement)
        || canonicalJson(item.initialStatePreflight) !== canonicalJson(frozen.initialStatePreflight)) {
        throw invalid(`cases[${index}] initial state contract does not match the frozen contract`);
      }
    }
  });
  if (runningCount > 1) throw invalid('at most one case may be RUNNING');
  if (state.status === 'INITIALIZING' && (state.currentIndex !== 0 || state.cases.some((item) => item.status !== 'PENDING'))) {
    throw invalid('INITIALIZING batch must contain only pending cases at index zero');
  }
  if (state.status === 'RUNNING') {
    if (state.currentIndex >= state.cases.length) throw invalid('RUNNING batch must have a current case');
    if (!['PENDING', 'RUNNING'].includes(state.cases[state.currentIndex].status)) throw invalid('RUNNING batch current case must be PENDING or RUNNING');
    if (state.cases.slice(0, state.currentIndex).some((item) => item.status !== 'COMPLETED')) throw invalid('cases before currentIndex must be COMPLETED');
    if (state.cases.slice(state.currentIndex + 1).some((item) => item.status !== 'PENDING')) throw invalid('cases after currentIndex must be PENDING');
  }
  if (['FINALIZING', 'COMPLETED'].includes(state.status)) {
    if (state.currentIndex !== state.cases.length || state.cases.some((item) => item.status !== 'COMPLETED')) {
      throw invalid(`${state.status} batch requires every case to be COMPLETED`);
    }
  }
  if (['BLOCKING', 'BLOCKED'].includes(state.status)
    && state.cases.some((item) => !['COMPLETED', 'BLOCKED', 'SKIPPED'].includes(item.status))) {
    throw invalid(`${state.status} batch contains an unsettled case`);
  }
  if (['CANCELLING', 'CANCELLED'].includes(state.status)
    && state.cases.some((item) => !['COMPLETED', 'CANCELLED', 'SKIPPED'].includes(item.status))) {
    throw invalid(`${state.status} batch contains an unsettled case`);
  }
}

function validateBatchState(state, contract, options = {}) {
  ensureObject(state, 'batch state', 'BATCH_STATE_INVALID');
  if (options.schemaVersion !== undefined && state.schemaVersion !== options.schemaVersion) {
    throw contractError('BATCH_SCHEMA_UNSUPPORTED', `unsupported batch schema: ${state.schemaVersion ?? 'missing'}`);
  }
  ensureId(state.batchId, 'batchId', 'BATCH_STATE_INVALID');
  if (!BATCH_STATUSES.has(state.status)) throw invalid(`unsupported batch status: ${state.status || 'missing'}`);
  if (contract?.batchId !== state.batchId) throw invalid('batchId does not match the frozen contract');
  validateWarmSession(state.warmSession);
  validateCases(state, contract);
  validateFinalization(state);
  if (state.status === 'RUNNING' && !['READY', 'DEGRADED'].includes(state.warmSession.status)) {
    throw invalid('RUNNING batch requires a READY or DEGRADED warm session');
  }
  if (TERMINAL_STATUSES.has(state.status) && state.warmSession.status !== 'CLOSED') throw invalid('terminal batch requires a CLOSED warm session');
  return state;
}

module.exports = { BATCH_SCHEMA_VERSION, BATCH_STATUSES, CASE_STATUSES, TERMINAL_STATUSES, validateBatchState };
