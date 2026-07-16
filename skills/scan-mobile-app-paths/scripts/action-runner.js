#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, nextId, jsonArg, writeJsonAtomic, readJson, contextDir, now, event, commitEvent, output, main, fail, safeSegment, hashObject } = require('./lib/common');
const { validateGraphCandidate } = require('./lib/schema');
const { assessAction } = require('./lib/safety');
const { bridge } = require('./lib/runtime-client');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { resolveSyntheticAction } = require('./lib/synthetic-data');
const { activeContextId } = require('./lib/run-protocol');
const { recordDeviceAction } = require('./lib/action-metrics');
const { assertCursorEpoch } = require('./lib/live-cursor');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');

function center(bounds) { return bounds && bounds.length === 4 ? { x: Math.round((Number(bounds[0]) + Number(bounds[2])) / 2), y: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2) } : {}; }

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.status !== 'SCANNING') fail('Actions require a SCANNING Run', 'RUN_STATE_INVALID');
  const contextId = args.context || activeContextId(scan); if (!contextId) fail('No active context', 'CONTEXT_REQUIRED');
  if (activeContextId(scan) !== contextId) fail('Action context must be active', 'CONTEXT_INVALID');
  const attemptId = safeSegment(required(args, 'attemptId'), 'attemptId'); const attemptFile = path.join(scanDir, 'attempts', `${attemptId}.json`); const attempt = readJson(attemptFile);
  if (attempt.contextId !== contextId || attempt.status !== 'READY_FOR_ACTION') fail('Attempt is not ready for action', 'ATTEMPT_STATE_INVALID');
  if (attempt.cursorEpoch !== undefined) assertCursorEpoch(scanDir, contextId, attempt.cursorEpoch);
  const frontier = loadFrontier(scanDir, contextId); const item = frontier.items.find(x => x.id === attempt.frontierId);
  if (!item || item.status !== 'CLAIMED' || item.claimedAttemptId !== attemptId || item.claimToken !== attempt.claimToken || hashObject(item.candidate) !== attempt.candidateHash) fail('Attempt no longer owns the claimed frontier candidate', 'ATTEMPT_CAUSALITY_INVALID');
  const supplied = args.action ? jsonArg(args.action, null, 'action JSON') : null;
  if (supplied && hashObject(supplied) !== attempt.candidateHash) fail('Supplied action differs from the claimed candidate', 'ATTEMPT_CAUSALITY_INVALID');
  const action = validateGraphCandidate(item.candidate);
  const metricsFile = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(metricsFile);
  assertExecutionWindow(scan, contextId, loadGraph(scanDir, contextId), frontier, metrics);
  assertCapacity(scan, contextId, loadGraph(scanDir, contextId), frontier, metrics, 'actions');
  const safety = assessAction(action, scan.target); const actionId = nextId(scanDir, 'action', 'act'); const executedAction = safety.replayPolicy === 'REGENERATE_SYNTHETIC' ? resolveSyntheticAction(action, actionId) : action; const startedAt = now();
  if (!safety.allowed) {
    const blocked = { schemaVersion: 1, actionId, contextId, attemptId, frontierId: item.id, beforeObservationId: attempt.beforeObservationId, candidateHash: attempt.candidateHash, action: executedAction, safety, locatorResolution: 'COORDINATE_ONLY', startedAt, finishedAt: now(), status: 'BLOCKED', reasonCode: safety.reasonCode };
    writeJsonAtomic(path.join(scanDir, 'evidence', 'actions', `${actionId}.json`), blocked); event(scanDir, 'actionResult', { contextId, actionId, status: blocked.status, reasonCode: blocked.reasonCode });
    return output({ schemaVersion: 1, ok: false, actionResult: blocked });
  }
  const point = center(executedAction.fallbackBounds); let result; const operation = startDeviceOperation(scanDir, contextId, { kind: 'CANDIDATE_ACTION', owner: { type: 'ATTEMPT', id: attemptId }, idempotency: safety.sideEffect === 'NONE' ? 'SAFE_RETRY_AFTER_OBSERVATION' : 'NON_IDEMPOTENT' }); recordDeviceAction(scanDir, contextId, 'exploration');
  try { result = bridge('action', { device: scan.target.deviceId, actionType: executedAction.type, x: executedAction.x ?? point.x, y: executedAction.y ?? point.y, fromX: executedAction.fromX, fromY: executedAction.fromY, toX: executedAction.toX, toY: executedAction.toY, velocity: executedAction.velocity, durationMs: executedAction.durationMs, value: executedAction.value, key: executedAction.key }); }
  catch (error) {
    const failed = { schemaVersion: 1, actionId, operationId: operation.operationId, contextId, attemptId, frontierId: item.id, beforeObservationId: attempt.beforeObservationId, candidateHash: attempt.candidateHash, action: executedAction, safety, locatorResolution: 'COORDINATE_ONLY', startedAt, finishedAt: now(), status: 'UNKNOWN_OUTCOME', reasonCode: error.code || 'BRIDGE_ACTION_FAILED' };
    const failedRef = `evidence/actions/${actionId}.json`; writeJsonAtomic(path.join(scanDir, failedRef), failed); finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { evidenceRef: failedRef, reasonCode: failed.reasonCode }); event(scanDir, 'actionResult', { contextId, actionId, operationId: operation.operationId, status: failed.status, reasonCode: failed.reasonCode }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error;
  }
  const actionResult = { schemaVersion: 1, actionId, operationId: operation.operationId, contextId, attemptId, frontierId: item.id, beforeObservationId: attempt.beforeObservationId, candidateHash: attempt.candidateHash, action: executedAction, safety, locatorResolution: 'COORDINATE_ONLY', startedAt, finishedAt: now(), status: 'SUCCEEDED', deviceResult: result };
  writeJsonAtomic(path.join(scanDir, 'evidence', 'actions', `${actionId}.json`), actionResult);
  attempt.actionResultId = actionId; attempt.status = 'ACTION_SUCCEEDED'; attempt.updatedAt = now(); commitEvent(scanDir, 'candidateActionSucceeded', { contextId, attemptId, actionId, operationId: operation.operationId, attempt }, [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }]);
  finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: `evidence/actions/${actionId}.json` }); event(scanDir, 'actionResult', { contextId, actionId, operationId: operation.operationId, status: 'SUCCEEDED' }); output({ schemaVersion: 1, ok: true, actionResult });
});
