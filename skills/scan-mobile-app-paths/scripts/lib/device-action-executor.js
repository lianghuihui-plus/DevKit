'use strict';

const path = require('path');
const { nextId, writeJsonAtomic, now, event } = require('./common');
const { bridge } = require('./runtime-client');
const { assessAction } = require('./safety');
const { resolveSyntheticAction } = require('./synthetic-data');
const { recordDeviceAction } = require('./action-metrics');
const { startDeviceOperation, finishDeviceOperation } = require('./operation-journal');

function center(bounds) {
  return bounds && bounds.length === 4
    ? { x: Math.round((Number(bounds[0]) + Number(bounds[2])) / 2), y: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2) }
    : {};
}

function actionEvidenceRef(actionId) {
  return `evidence/actions/${actionId}.json`;
}

function writeActionEvidence(scanDir, actionResult) {
  writeJsonAtomic(path.join(scanDir, actionEvidenceRef(actionResult.actionId)), actionResult);
}

function executeDeviceAction(scanDir, {
  scan,
  contextId,
  attemptId,
  frontierId,
  beforeObservationId,
  candidateHash,
  action,
  safety: suppliedSafety = null,
  owner = null,
  role = 'CANDIDATE_ACTION',
  category = 'exploration',
  locatorResolution = 'COORDINATE_ONLY',
  idempotency = null,
  actionResultExtra = {},
  failureReasonCode = 'BRIDGE_ACTION_FAILED',
  emitActionResultEvents = true,
  writeUnknownEvidence = true,
  writeSuccessEvidence = true,
  includeSafetyInResult = true,
  syntheticSeed = null
}) {
  const safety = suppliedSafety || assessAction(action, scan.target);
  const actionId = nextId(scanDir, 'action', 'act');
  const executedAction = safety.replayPolicy === 'REGENERATE_SYNTHETIC' ? resolveSyntheticAction(action, syntheticSeed || actionId) : action;
  const startedAt = now();
  const base = { schemaVersion: 1, actionId, contextId, attemptId, frontierId, beforeObservationId, candidateHash, action: executedAction, locatorResolution, startedAt, ...actionResultExtra };
  if (includeSafetyInResult) base.safety = safety;

  if (!safety.allowed) {
    const blocked = { ...base, finishedAt: now(), status: 'BLOCKED', reasonCode: safety.reasonCode };
    writeActionEvidence(scanDir, blocked);
    if (emitActionResultEvents) event(scanDir, 'actionResult', { contextId, actionId, status: blocked.status, reasonCode: blocked.reasonCode });
    return { actionResult: blocked, safety, operation: null };
  }

  const operationOwner = owner || { type: 'ATTEMPT', id: attemptId };
  const operation = startDeviceOperation(scanDir, contextId, {
    kind: role,
    owner: operationOwner,
    idempotency: idempotency || (safety.sideEffect === 'NONE' ? 'SAFE_RETRY_AFTER_OBSERVATION' : 'NON_IDEMPOTENT')
  });
  recordDeviceAction(scanDir, contextId, category);

  try {
    const point = center(executedAction.fallbackBounds);
    const deviceResult = bridge('action', {
      device: scan.target.deviceId,
      actionType: executedAction.type,
      x: executedAction.x ?? point.x,
      y: executedAction.y ?? point.y,
      fromX: executedAction.fromX,
      fromY: executedAction.fromY,
      toX: executedAction.toX,
      toY: executedAction.toY,
      velocity: executedAction.velocity,
      durationMs: executedAction.durationMs,
      value: executedAction.value,
      key: executedAction.key
    });
    const actionResult = { ...base, operationId: operation.operationId, finishedAt: now(), status: 'SUCCEEDED', deviceResult };
    if (writeSuccessEvidence) writeActionEvidence(scanDir, actionResult);
    return { actionResult, safety, operation };
  } catch (error) {
    const failed = { ...base, operationId: operation.operationId, finishedAt: now(), status: 'UNKNOWN_OUTCOME', reasonCode: error.code || failureReasonCode };
    const failedRef = actionEvidenceRef(actionId);
    if (writeUnknownEvidence) writeActionEvidence(scanDir, failed);
    finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { ...(writeUnknownEvidence ? { evidenceRef: failedRef } : {}), reasonCode: failed.reasonCode });
    if (emitActionResultEvents) event(scanDir, 'actionResult', { contextId, actionId, operationId: operation.operationId, status: failed.status, reasonCode: failed.reasonCode });
    error.code = 'OPERATION_OUTCOME_UNKNOWN';
    throw error;
  }
}

function completeDeviceActionSuccess(scanDir, operation, actionResult, options = {}) {
  const eventType = options.eventType === undefined ? 'actionResult' : options.eventType;
  if (options.writeEvidence) writeActionEvidence(scanDir, actionResult);
  finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: options.evidenceRef || actionEvidenceRef(actionResult.actionId) });
  if (eventType) event(scanDir, eventType, options.eventPayload || { contextId: actionResult.contextId, actionId: actionResult.actionId, operationId: operation.operationId, status: 'SUCCEEDED' });
}

function completeDeviceActionUnknownOutcome(scanDir, operation, actionResult, options = {}) {
  if (!operation) return null;
  const reasonCode = options.reasonCode || 'POST_ACTION_EVIDENCE_FAILED';
  const unknown = {
    ...actionResult,
    status: 'UNKNOWN_OUTCOME',
    reasonCode,
    finishedAt: now()
  };
  const evidenceRef = options.evidenceRef || actionEvidenceRef(unknown.actionId);
  if (options.writeEvidence !== false) writeActionEvidence(scanDir, unknown);
  return finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { evidenceRef, reasonCode });
}

module.exports = {
  executeDeviceAction,
  completeDeviceActionSuccess,
  completeDeviceActionUnknownOutcome
};
