'use strict';

const path = require('path');
const { canonicalJson, contractError, ensureId } = require('../lib/contract-utils');
const { assertBatchImplementation } = require('../lib/batch-contract');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { assertWorkspace } = require('../lib/workspace');
const { BATCH_SCHEMA_VERSION, validateBatchState } = require('./state-contract');

function assertBatchWorkspace(root) {
  try {
    return assertWorkspace(root, { allowTest: true });
  } catch (error) {
    throw contractError(error.code || 'WORKSPACE_INVALID', error.message);
  }
}

function batchPaths(workspaceRoot, batchId) {
  ensureId(batchId, 'batchId', 'BATCH_INVALID');
  const batchDir = path.join(workspaceRoot, 'runs', batchId);
  return {
    batchDir,
    state: path.join(batchDir, 'batch.json'),
    contract: path.join(batchDir, 'contract.json'),
    events: path.join(batchDir, 'events.jsonl'),
    lock: path.join(batchDir, '.write.lock'),
    initDraft: path.join(batchDir, 'batch-init.draft.json'),
    bootstrapDraft: path.join(batchDir, 'bootstrap.draft.json'),
    caseStartDraft: path.join(batchDir, 'case-start.draft.json'),
    caseCommitDraft: path.join(batchDir, 'case-commit.draft.json'),
  };
}

function loadBatch(workspaceRoot, batchId, versions = {}) {
  assertBatchWorkspace(workspaceRoot);
  const paths = batchPaths(workspaceRoot, batchId);
  const state = readJson(paths.state, null);
  const contract = readJson(paths.contract, null);
  if (!state || !contract) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${batchId}`);
  assertBatchImplementation(contract, versions);
  if (state.batchId !== contract.batchId || state.contractSha !== contract.contractSha
    || state.runtimeSha !== contract.runtimeSha || state.adapterSha !== contract.adapterSha
    || state.coordinatorSha !== contract.coordinatorSha) {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its frozen contract');
  }
  if (state.executionRequestId !== contract.executionRequestId || state.executionRequestSha !== contract.executionRequestSha
    || state.mode !== contract.mode || state.interactionPolicy !== 'UNATTENDED' || contract.interactionPolicy !== 'UNATTENDED') {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its explicit unattended execution request');
  }
  if (canonicalJson(state.binding) !== canonicalJson(contract.binding)
    || canonicalJson(state.bootstrapPolicy) !== canonicalJson(contract.bootstrapPolicy)
    || state.bootstrapPolicySha !== contract.bootstrapPolicySha) {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch state does not match its frozen bootstrap policy');
  }
  const stateTargets = Array.isArray(state.cases)
    ? state.cases.map((entry) => ({
      order: entry.order,
      ...(entry.caseNo ? { caseNo: entry.caseNo } : {}),
      caseKey: entry.caseKey,
      caseDir: entry.caseDir,
      snapshotPath: entry.snapshotPath,
      sourceSha: entry.sourceSha,
      caseContractSha: entry.caseContractSha,
      preparationPolicy: entry.preparationPolicy,
      preparationPolicySha: entry.preparationPolicySha,
      initialStateRequirement: entry.initialStateRequirement,
      initialStateRequirementSha: entry.initialStateRequirementSha,
      initialStatePreflight: entry.initialStatePreflight,
      initialStatePreflightSha: entry.initialStatePreflightSha,
    })) : null;
  if (!stateTargets || canonicalJson(stateTargets) !== canonicalJson(contract.targets)) {
    throw contractError('BATCH_BINDING_MISMATCH', 'batch cases do not match the frozen targets');
  }
  validateBatchState(state, contract, { schemaVersion: BATCH_SCHEMA_VERSION });
  return { paths, state, contract };
}

function saveBatch(paths, state, now) {
  state.updatedAt = now || new Date().toISOString();
  validateBatchState(state, readJson(paths.contract), { schemaVersion: BATCH_SCHEMA_VERSION });
  writeJsonAtomic(paths.state, state);
  return state;
}

function readBatchState(paths, contract) {
  return validateBatchState(readJson(paths.state), contract, { schemaVersion: BATCH_SCHEMA_VERSION });
}

module.exports = { assertBatchWorkspace, batchPaths, loadBatch, readBatchState, saveBatch };
