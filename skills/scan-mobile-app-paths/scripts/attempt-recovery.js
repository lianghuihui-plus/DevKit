#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  parseArgs, required, requiredId, resolveScanDir, loadScan, loadFrontier,
  readJson, now, safeSegment, commitEvent, output, main, fail
} = require('./lib/common');
const { activeContextId } = require('./lib/run-protocol');

main(() => {
  const args = parseArgs();
  const command = args._[0] || 'close-restore-review';
  if (command !== 'close-restore-review') fail(`Unknown attempt recovery command: ${command}`, 'COMMAND_INVALID');

  const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: true });
  if (!['PAUSED', 'SCANNING'].includes(scan.status)) fail('Restore review recovery requires an active paused or scanning Run', 'RUN_STATE_INVALID');

  const contextId = args.context || activeContextId(scan);
  if (contextId !== activeContextId(scan)) fail('Attempt recovery context must be active', 'CONTEXT_INVALID');

  const attemptId = safeSegment(requiredId(args, 'attemptId'), 'attemptId');
  const reasonCode = String(args.reasonCode || 'RESTORE_REVIEW_ABANDONED').toUpperCase();
  const attemptFile = path.join(scanDir, 'attempts', `${attemptId}.json`);
  const attempt = readJson(attemptFile);
  if (attempt.contextId !== contextId) fail('Attempt belongs to another context', 'ATTEMPT_CAUSALITY_INVALID');
  if (!['AWAITING_RESTORE_REVIEW', 'FAILED'].includes(attempt.status)) fail('Attempt is not awaiting restore review or failed from restore review', 'ATTEMPT_STATE_INVALID');

  const restoreId = safeSegment(attempt.activeRestoreId || (attempt.restoreResults || []).at(-1)?.restoreId, 'restoreId');
  const restoreFile = path.join(scanDir, 'evidence', 'restores', `${restoreId}.json`);
  const restore = readJson(restoreFile);
  if (restore.contextId !== contextId || restore.reachableStateId !== attempt.fromReachableStateId) fail('Restore does not belong to the attempt source state', 'RESTORE_CHECKPOINT_INVALID');
  if (restore.status !== 'REVIEW_REQUIRED') fail('Restore is not awaiting review', 'RESTORE_CHECKPOINT_INVALID');

  const closedAt = now();
  restore.status = 'FAILED';
  restore.reasonCode = reasonCode;
  restore.finishedAt = closedAt;
  restore.updatedAt = closedAt;

  const restoreResults = (attempt.restoreResults || []).map(item => item.restoreId === restoreId ? restore : item);
  if (!restoreResults.some(item => item.restoreId === restoreId)) restoreResults.push(restore);
  attempt.restoreResults = restoreResults;
  attempt.status = 'FAILED';
  attempt.reasonCode = reasonCode;
  attempt.activeRestoreId = null;
  attempt.updatedAt = closedAt;

  const ops = [
    { path: `evidence/restores/${restoreId}.json`, op: 'REPLACE', value: restore },
    { path: `attempts/${attemptId}.json`, op: 'REPLACE', value: attempt }
  ];

  const frontier = loadFrontier(scanDir, contextId);
  const item = frontier.items.find(entry => entry.id === attempt.frontierId);
  if (item?.status === 'CLAIMED' && item.claimedAttemptId === attemptId) {
    item.status = Number(item.attempts || 0) < 3 ? 'RETRYABLE' : 'FAILED';
    item.reasonCode = reasonCode;
    item.claimToken = null;
    item.claimedAttemptId = null;
    item.lastAttemptId = attemptId;
    item.resolvedAt = closedAt;
    ops.push({ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item });
  }

  let navigationExecution = null;
  if (attempt.navigationExecutionId) {
    const navigationFile = path.join(scanDir, 'evidence', 'navigations', `${attempt.navigationExecutionId}.json`);
    navigationExecution = readJson(navigationFile, null);
    if (navigationExecution && ['PLANNED', 'IN_PROGRESS'].includes(navigationExecution.status)) {
      navigationExecution.status = 'CANCELLED';
      navigationExecution.reasonCode = reasonCode;
      navigationExecution.finishedAt = closedAt;
      ops.push({ path: `evidence/navigations/${attempt.navigationExecutionId}.json`, op: 'REPLACE', value: navigationExecution });
    }
  }

  commitEvent(scanDir, 'restoreReviewClosedAsFailed', {
    contextId,
    attemptId,
    restoreId,
    reasonCode,
    attempt,
    frontierItem: item || null,
    navigationExecution
  }, ops);

  output({ schemaVersion: 1, ok: true, attempt, restore, frontier: item || null, runStatus: scan.status });
});
