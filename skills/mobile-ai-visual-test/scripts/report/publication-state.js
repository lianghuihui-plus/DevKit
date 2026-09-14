'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');

const TRANSIENT_CODES = new Set([
  'EXECUTION_LOCKED',
  'EXECUTION_LOCK_OWNERSHIP_LOST',
  'REPORT_PUBLICATION_BUSY',
  'REPORT_PUBLICATION_INCOMPLETE',
  'EAGAIN',
  'EBUSY',
  'EEXIST',
  'ENOTEMPTY',
  'EPERM',
]);
const PUBLICATION_RETRY_LIMIT = 3;

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

function classifyPublicationFailure(result = {}) {
  const errorCode = result.errorCode || 'REPORT_PUBLICATION_FAILED';
  if (errorCode === 'FORMAT_UNSUPPORTED') return { classification: 'DISPLAYABLE', errorCode };
  if (TRANSIENT_CODES.has(errorCode)) return { classification: 'TRANSIENT', errorCode };
  return { classification: 'PERMANENT', errorCode };
}

function failureFingerprint(scope, result, classified) {
  return JSON.stringify({
    scope,
    errorCode: classified.errorCode,
    reason: String(result?.reason || ''),
  });
}

function recordPublicationAttempt(workspaceRoot, batchId, scope, result, options = {}) {
  const current = readPublicationState(workspaceRoot, batchId);
  current.attempts = Array.isArray(current.attempts) ? current.attempts : [];
  const published = result?.status === 'UPDATED' || result?.status === 'PUBLISHED';
  const classified = published ? null : classifyPublicationFailure(result);
  const fingerprint = classified ? failureFingerprint(scope, result, classified) : null;
  const retryCount = classified?.classification === 'TRANSIENT'
    ? current.attempts.filter((entry) => entry.fingerprint === fingerprint).length + 1
    : null;
  const attempt = {
    sequence: current.attempts.length + 1,
    scope,
    at: options.now || new Date().toISOString(),
    status: published ? 'PUBLISHED' : classified?.classification === 'DISPLAYABLE' ? 'DISPLAYABLE' : 'FAILED',
    ...(result?.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result?.reason ? { reason: result.reason } : {}),
    ...(Number.isFinite(result?.durationMs) ? { durationMs: result.durationMs } : {}),
    ...(classified ? { classification: classified.classification, fingerprint } : {}),
    ...(retryCount !== null ? { retryCount, retryLimit: PUBLICATION_RETRY_LIMIT } : {}),
  };
  const failedStatus = classified?.classification === 'TRANSIENT' && retryCount < PUBLICATION_RETRY_LIMIT
    ? 'RETRY_REQUIRED'
    : classified?.classification === 'DISPLAYABLE' ? current.status : 'DEGRADED';
  const status = attempt.status === 'PUBLISHED' && scope === 'batch'
    ? 'PUBLISHED'
    : attempt.status === 'FAILED' ? failedStatus : current.status;
  const next = {
    schemaVersion: 1,
    batchId,
    status,
    attempts: [...current.attempts, attempt],
    updatedAt: attempt.at,
    ...(current.caseTimings ? { caseTimings: current.caseTimings } : {}),
    ...(current.publications ? { publications: current.publications } : {}),
    ...(classified && status !== 'PUBLISHED' && classified.classification !== 'DISPLAYABLE' ? {
      errorCode: classified.errorCode,
      reason: result?.reason || '报告发布失败',
      classification: classified.classification,
      fingerprint,
    } : {}),
  };
  fs.mkdirSync(path.dirname(statePath(workspaceRoot, batchId)), { recursive: true });
  writeJsonAtomic(statePath(workspaceRoot, batchId), next);
  return next;
}

function recoverRetryRequiredPublications(workspaceRoot, options = {}) {
  const runsRoot = path.join(workspaceRoot, 'runs');
  if (!fs.existsSync(runsRoot)) return [];
  const recovered = [];
  for (const name of fs.readdirSync(runsRoot).sort()) {
    const file = statePath(workspaceRoot, name);
    if (!fs.existsSync(file)) continue;
    let current;
    try {
      current = readPublicationState(workspaceRoot, name);
    } catch {
      continue;
    }
    if (current.status !== 'RETRY_REQUIRED') continue;
    try {
      recordPublicationAttempt(workspaceRoot, name, 'batch', { status: 'PUBLISHED' }, options);
      recovered.push(name);
    } catch {
      continue;
    }
  }
  return recovered;
}

module.exports = {
  PUBLICATION_RETRY_LIMIT,
  classifyPublicationFailure,
  readPublicationState,
  recoverRetryRequiredPublications,
  recordPublicationAttempt,
  statePath,
};
