'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

function statePath(workspaceRoot, batchId) {
  return path.join(workspaceRoot, 'runs', batchId, 'report-publication.json');
}

function readPublicationState(workspaceRoot, batchId) {
  return readJson(statePath(workspaceRoot, batchId), {
    schemaVersion: 1,
    batchId,
    status: 'PENDING',
    attempts: [],
  });
}

function recordPublicationAttempt(workspaceRoot, batchId, scope, result, options = {}) {
  const current = readPublicationState(workspaceRoot, batchId);
  const attempt = {
    sequence: current.attempts.length + 1,
    scope,
    at: options.now || new Date().toISOString(),
    status: result?.status === 'UPDATED' || result?.status === 'PUBLISHED' ? 'PUBLISHED' : 'FAILED',
    ...(result?.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result?.reason ? { reason: result.reason } : {}),
    ...(Number.isFinite(result?.durationMs) ? { durationMs: result.durationMs } : {}),
  };
  const next = {
    schemaVersion: 1,
    batchId,
    status: attempt.status === 'PUBLISHED' && scope === 'batch' ? 'PUBLISHED' : attempt.status === 'FAILED' ? 'RETRY_REQUIRED' : current.status,
    attempts: [...current.attempts, attempt],
    updatedAt: attempt.at,
    ...(current.caseTimings ? { caseTimings: current.caseTimings } : {}),
    ...(current.publications ? { publications: current.publications } : {}),
  };
  fs.mkdirSync(path.dirname(statePath(workspaceRoot, batchId)), { recursive: true });
  writeJsonAtomic(statePath(workspaceRoot, batchId), next);
  return next;
}

module.exports = { readPublicationState, recordPublicationAttempt, statePath };
