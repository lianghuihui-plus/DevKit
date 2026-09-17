'use strict';

const fs = require('fs');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { createBatchContract } = require('../lib/batch-contract');
const { createExecutionClosure } = require('../lib/execution-closure');
const { appendJsonl, findActiveExecutions, readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { loadExecutionRequest, resolveExecutionTargets } = require('../lib/run-control');
const { createWarmSession } = require('../lib/warm-session-contract');
const { BATCH_SCHEMA_VERSION, validateBatchState } = require('./state-contract');
const { assertBatchWorkspace, batchPaths, loadBatch } = require('./state-repository');
const { hasBatchEvent, protocolBindings } = require('./service-support');

function closeStaleExecutionsForPlatform(workspaceRoot, platform, components, options = {}) {
  return findActiveExecutions(workspaceRoot)
    .filter(({ execution }) => execution.platform === platform)
    .filter(({ execution }) => (
      execution.runtimeSha !== components.runtimeSha
      || execution.adapterSha !== components.adapterSha
    ))
    .map(({ execDir }) => createExecutionClosure(workspaceRoot, execDir, {
      closedByRuntimeSha: components.runtimeSha,
      closedByAdapterSha: components.adapterSha,
      replacementBatchId: options.replacementBatchId,
      reason: options.reason,
      now: options.now,
    }).closure);
}

function initializeBatch(options) {
  assertBatchWorkspace(options.workspaceRoot);
  if (options.binding !== undefined || options.targets !== undefined) {
    throw contractError('EXECUTION_REQUEST_REQUIRED', 'batch init does not accept direct binding or targets');
  }
  const paths = batchPaths(options.workspaceRoot, options.batchId);
  const executionRequest = loadExecutionRequest(options.workspaceRoot, options.batchId);
  const targets = resolveExecutionTargets(options.workspaceRoot, executionRequest.targets, options.batchId);
  if ((options.runtimeSha && executionRequest.runtimeSha !== options.runtimeSha)
    || (options.adapterSha && executionRequest.adapterSha !== options.adapterSha)
    || (options.coordinatorSha && executionRequest.coordinatorSha !== options.coordinatorSha)) {
    throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'execution request belongs to different runtime components');
  }
  if ((options.caseProtocolSha && executionRequest.caseProtocolSha !== options.caseProtocolSha)
    || (options.coordinatorProtocolSha && executionRequest.coordinatorProtocolSha !== options.coordinatorProtocolSha)) {
    throw contractError('BATCH_PROTOCOL_MISMATCH', 'execution request belongs to a different Agent protocol');
  }
  const closedExecutions = closeStaleExecutionsForPlatform(
    options.workspaceRoot,
    executionRequest.binding.platform,
    {
      runtimeSha: executionRequest.runtimeSha,
      adapterSha: executionRequest.adapterSha,
    },
    {
      replacementBatchId: options.batchId,
      reason: '新批次使用当前实现，同平台其他实现的未完成 execution 不再续写',
      now: options.now,
    },
  );
  let draft = readJson(paths.initDraft, null);
  const existingState = readJson(paths.state, null);
  const existingContract = readJson(paths.contract, null);
  if (!draft && (existingState || existingContract)) {
    if (!existingState || !existingContract) throw contractError('BATCH_INIT_CORRUPTED', 'partial batch initialization has no recovery draft');
    const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
    if (executionRequest.requestSha !== loaded.contract.executionRequestSha
      || canonicalJson(targets) !== canonicalJson(loaded.contract.targets)) {
      throw contractError('BATCH_BINDING_MISMATCH', 'existing batch cannot be initialized with a different execution request');
    }
    if (!hasBatchEvent(paths.events, (event) => event.type === 'batchInitialized' && event.batchId === options.batchId)) {
      appendJsonl(paths.events, {
        schemaVersion: 1, eventId: `batch-initialized-${options.batchId}`, time: loaded.state.createdAt,
        type: 'batchInitialized', batchId: loaded.state.batchId, contractSha: loaded.state.contractSha,
        runtimeSha: loaded.state.runtimeSha, adapterSha: loaded.state.adapterSha,
        coordinatorSha: loaded.state.coordinatorSha, executionRequestSha: loaded.state.executionRequestSha,
        interactionPolicy: loaded.state.interactionPolicy,
      });
    }
    return { ...loaded, closedExecutions };
  }
  if (!draft) {
    const contract = createBatchContract({
      batchId: options.batchId,
      executionRequest: { ...executionRequest, targets },
    });
    const now = options.now || new Date().toISOString();
    const state = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      batchId: options.batchId,
      runtimeSha: contract.runtimeSha,
      adapterSha: contract.adapterSha,
      coordinatorSha: contract.coordinatorSha,
      caseProtocolSha: contract.caseProtocolSha,
      coordinatorProtocolSha: contract.coordinatorProtocolSha,
      contractSha: contract.contractSha,
      executionRequestId: contract.executionRequestId,
      executionRequestSha: contract.executionRequestSha,
      mode: contract.mode,
      interactionPolicy: contract.interactionPolicy,
      binding: contract.binding,
      bootstrapPolicy: contract.bootstrapPolicy,
      bootstrapPolicySha: contract.bootstrapPolicySha,
      status: 'INITIALIZING',
      currentIndex: 0,
      warmSession: createWarmSession(contract.binding, now),
      cases: targets.map((target) => ({ ...target, status: 'PENDING', executionId: null, runtimePath: null })),
      finalization: { casesCommitted: false, platformReleased: false },
      createdAt: now,
      updatedAt: now,
    };
    draft = { schemaVersion: 1, status: 'STARTED', contract, state };
    fs.mkdirSync(paths.batchDir, { recursive: true });
    writeJsonAtomic(paths.initDraft, draft);
  }
  if (draft.schemaVersion !== 1 || draft.status !== 'STARTED'
    || draft.contract?.batchId !== options.batchId || draft.state?.batchId !== options.batchId
    || draft.contract?.executionRequestSha !== executionRequest.requestSha
    || canonicalJson(draft.contract?.targets) !== canonicalJson(targets)) {
    throw contractError('BATCH_INIT_DRAFT_INVALID', 'batch initialization draft does not match the execution request');
  }
  if (options.interruptAfter === 'draft') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: draft');
  writeJsonAtomic(paths.contract, draft.contract);
  if (options.interruptAfter === 'contract') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: contract');
  validateBatchState(draft.state, draft.contract, { schemaVersion: BATCH_SCHEMA_VERSION });
  writeJsonAtomic(paths.state, draft.state);
  if (options.interruptAfter === 'state') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: state');
  if (!hasBatchEvent(paths.events, (event) => event.type === 'batchInitialized' && event.batchId === options.batchId)) appendJsonl(paths.events, {
    schemaVersion: 1,
    eventId: `batch-initialized-${options.batchId}`,
    time: draft.state.createdAt,
    type: 'batchInitialized',
    batchId: draft.state.batchId,
    contractSha: draft.state.contractSha,
    runtimeSha: draft.state.runtimeSha,
    adapterSha: draft.state.adapterSha,
    coordinatorSha: draft.state.coordinatorSha,
    executionRequestSha: draft.state.executionRequestSha,
    interactionPolicy: draft.state.interactionPolicy,
  });
  if (options.interruptAfter === 'event') throw new Error('MAVT_BATCH_INIT_INTERRUPTED: event');
  fs.unlinkSync(paths.initDraft);
  return { paths, state: draft.state, contract: draft.contract, closedExecutions };
}

module.exports = { initializeBatch };
