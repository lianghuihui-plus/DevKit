'use strict';

const fs = require('fs');
const path = require('path');
const { acquireFileLock, releaseFileLock } = require('../lib/execution-lifecycle');

const heldLocks = new Set();
const pause = new Int32Array(new SharedArrayBuffer(4));

function reportPublicationLockPath(workspaceRoot) {
  const root = fs.realpathSync.native(path.resolve(workspaceRoot));
  return path.join(root, '.report-publication.lock');
}

function withWorkspaceReportPublication(workspaceRoot, callback, options = {}) {
  if (typeof callback !== 'function') throw new TypeError('report publication callback must be a function');
  const lockPath = reportPublicationLockPath(workspaceRoot);
  if (heldLocks.has(lockPath)) {
    const error = new Error(`report publication lock is already held by this process: ${lockPath}`);
    error.code = 'REPORT_PUBLICATION_REENTRANT';
    throw error;
  }
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? options.pollIntervalMs : 20;
  let lock = null;
  let unreadableAttempts = 0;
  while (!lock) {
    try {
      lock = acquireFileLock(lockPath, { now: options.now });
    } catch (error) {
      if (error?.code !== 'EXECUTION_LOCKED') throw error;
      try {
        JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        unreadableAttempts = 0;
      } catch (readError) {
        if (readError?.code === 'ENOENT') continue;
        unreadableAttempts += 1;
        if (unreadableAttempts >= 3) {
          const invalid = new Error(`report publication lock is invalid: ${lockPath}`);
          invalid.code = 'REPORT_PUBLICATION_LOCK_INVALID';
          throw invalid;
        }
      }
      Atomics.wait(pause, 0, 0, pollIntervalMs);
    }
  }
  heldLocks.add(lockPath);
  try {
    return callback();
  } finally {
    heldLocks.delete(lockPath);
    releaseFileLock(lock);
  }
}

module.exports = { reportPublicationLockPath, withWorkspaceReportPublication };
