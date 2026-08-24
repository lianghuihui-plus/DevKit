'use strict';

const fs = require('fs');
const { factFromResult } = require('../agent/operation-facts');
const {
  alignOperationPhase,
  freezeOperationRequest,
  operationPaths,
  validateOperationRequest,
} = require('../agent/operations');
const {
  assertNoTurnRecovery,
  beginOperation,
  knowledgeQueryDraftIds,
  operationDraftIds,
  pendingPostActionObservation,
  rejectOperation,
  STATE_CHANGING_ACTIONS,
  timelineEvents,
} = require('../execution/core');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { assertOperationAllowed } = require('../lib/execution-time-limit');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

function recordSimulatedOperation(execDir, input, result, options = {}) {
  const request = freezeOperationRequest(input);
  assertNoTurnRecovery(execDir);
  alignOperationPhase(execDir, request, options);
  const pendingQueries = knowledgeQueryDraftIds(execDir);
  if (pendingQueries.length) {
    throw contractError('KNOWLEDGE_QUERY_RECOVERY_REQUIRED', `recover knowledge query before recording an operation: ${pendingQueries.join(', ')}`);
  }
  const otherDrafts = operationDraftIds(execDir).filter((operationId) => operationId !== request.operationId);
  if (otherDrafts.length) {
    throw contractError('EXECUTION_OPERATION_RECOVERY_REQUIRED', `recover operation before starting another: ${otherDrafts.join(', ')}`);
  }
  const kind = request.action ? 'ACTION' : 'OBSERVE';
  if (kind === 'ACTION' && STATE_CHANGING_ACTIONS.has(request.action?.type)) {
    const pending = pendingPostActionObservation(timelineEvents(execDir));
    if (pending && pending.operationId !== request.operationId) {
      rejectOperation(execDir, { operationId: request.operationId, kind, actionType: request.action.type, relatedOperationId: pending.operationId, failureCode: 'POST_ACTION_OBSERVATION_REQUIRED', reason: `observe the current state after ${pending.operationId} before another state-changing action` }, { now: options.now });
      throw contractError('POST_ACTION_OBSERVATION_REQUIRED', `observe the current state after ${pending.operationId} before another state-changing action`);
    }
  }
  const validated = validateOperationRequest(execDir, request, kind);
  validated.request = request;
  assertOperationAllowed(validated.context.execution, kind.toLowerCase(), options.now || new Date());
  const paths = operationPaths(execDir, request.operationId);
  const completedRecord = readJson(paths.completed, null);
  if (completedRecord) {
    if (canonicalJson(completedRecord.request) !== canonicalJson(request)) {
      throw contractError('AGENT_OPERATION_BINDING_MISMATCH', 'operationId is already bound to another request');
    }
    return { accepted: true, idempotent: true, fact: completedRecord.fact };
  }
  const draft = readJson(paths.draft, null);
  const frozen = { schemaVersion: 1, kind, request };
  if (draft && canonicalJson(draft) !== canonicalJson(frozen)) {
    throw contractError('AGENT_OPERATION_BINDING_MISMATCH', 'operationId is already bound to another request');
  }
  if (!draft) writeJsonAtomic(paths.draft, frozen);
  const started = timelineEvents(execDir).some((entry) => entry.type === 'operationStarted' && entry.operationId === request.operationId);
  if (!started) beginOperation(execDir, kind, request.operationId, { implementationSha: validated.context.execution.implementationSha, now: options.now });
  if (options.interruptAfter === 'begin') throw new Error('MAVT_AGENT_OPERATION_INTERRUPTED: begin');
  const fact = factFromResult(execDir, validated, kind, result, options);
  if (options.interruptAfter === 'timeline') throw new Error('MAVT_AGENT_OPERATION_INTERRUPTED: timeline');
  writeJsonAtomic(paths.completed, { schemaVersion: 1, kind, request, fact });
  if (fs.existsSync(paths.draft)) fs.unlinkSync(paths.draft);
  return { accepted: true, recovered: Boolean(draft), fact };
}

module.exports = { recordSimulatedOperation };
