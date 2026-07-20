#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, requiredId, resolveScanDir, loadScan, loadGraph, loadFrontier, jsonArg, readJson, contextDir, now, commitEvent, output, main, fail, safeSegment, hashObject } = require('./lib/common');
const { validateGraphCandidate } = require('./lib/schema');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { activeContextId } = require('./lib/run-protocol');
const { assertCursorEpoch } = require('./lib/live-cursor');
const { executeDeviceAction, completeDeviceActionSuccess } = require('./lib/device-action-executor');

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.status !== 'SCANNING') fail('Actions require a SCANNING Run', 'RUN_STATE_INVALID');
  const contextId = args.context || activeContextId(scan); if (!contextId) fail('No active context', 'CONTEXT_REQUIRED');
  if (activeContextId(scan) !== contextId) fail('Action context must be active', 'CONTEXT_INVALID');
  const attemptId = safeSegment(requiredId(args, 'attemptId'), 'attemptId'); const attemptFile = path.join(scanDir, 'attempts', `${attemptId}.json`); const attempt = readJson(attemptFile);
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
  const { actionResult, operation } = executeDeviceAction(scanDir, { scan, contextId, attemptId, frontierId: item.id, beforeObservationId: attempt.beforeObservationId, candidateHash: attempt.candidateHash, action });
  if (actionResult.status !== 'SUCCEEDED') return output({ schemaVersion: 1, ok: false, actionResult });
  const actionId = actionResult.actionId;
  attempt.actionResultId = actionId; attempt.status = 'ACTION_SUCCEEDED'; attempt.updatedAt = now(); commitEvent(scanDir, 'candidateActionSucceeded', { contextId, attemptId, actionId, operationId: operation.operationId, attempt }, [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }]);
  completeDeviceActionSuccess(scanDir, operation, actionResult); output({ schemaVersion: 1, ok: true, actionResult });
});
