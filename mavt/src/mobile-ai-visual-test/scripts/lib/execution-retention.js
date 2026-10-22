'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, withFileLock } = require('./execution-lifecycle');

const DEFAULT_COMPLETED_EXECUTION_LIMIT = 3;

function completedExecution(execDir, executionId) {
  try {
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    const completion = readJson(path.join(execDir, 'completion.json'), null);
    const endedAtMs = Date.parse(execution?.endedAt || '');
    if (execution?.schemaVersion !== 14
      || execution.runtime !== 'case-runtime'
      || execution.executionId !== executionId
      || execution.finalized !== true
      || !Number.isFinite(endedAtMs)
      || completion?.executionId !== executionId
      || completion.platform !== execution.platform
      || completion.runtimeCompleted !== true) return null;
    return { execDir, executionId, endedAt: execution.endedAt, endedAtMs };
  } catch {
    return null;
  }
}

function listCompletedExecutions(executionsRoot) {
  if (!fs.existsSync(executionsRoot)) return [];
  return fs.readdirSync(executionsRoot, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.isDirectory())
    .flatMap((entry) => {
      const completed = completedExecution(path.join(executionsRoot, entry.name), entry.name);
      return completed ? [completed] : [];
    })
    .sort((left, right) => right.endedAtMs - left.endedAtMs
      || right.executionId.localeCompare(left.executionId));
}

function trashDestination(workspaceRoot, executionsRoot, executionId) {
  const scope = crypto.createHash('sha256').update(path.resolve(executionsRoot)).digest('hex').slice(0, 16);
  const trashRoot = path.join(workspaceRoot, '.mavt', 'retention-trash', scope);
  fs.mkdirSync(trashRoot, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = `${Date.now()}-${process.pid}-${attempt}`;
    const destination = path.join(trashRoot, `${executionId}-${suffix}`);
    if (!fs.existsSync(destination)) return destination;
  }
  throw new Error(`failed to allocate retention trash path for ${executionId}`);
}

function pruneLocked(options) {
  const limit = options.limit ?? DEFAULT_COMPLETED_EXECUTION_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('completed execution retention limit must be a positive integer');
  const completed = listCompletedExecutions(options.executionsRoot);
  const victims = completed.slice(limit);
  if (!victims.length) {
    return {
      status: 'UNCHANGED',
      limit,
      completedCount: completed.length,
      removedExecutionIds: [],
    };
  }
  const removedExecutionIds = [];
  const cleanupErrors = [];
  for (const victim of victims) {
    const current = completedExecution(victim.execDir, victim.executionId);
    if (!current || current.endedAt !== victim.endedAt) continue;
    const destination = trashDestination(options.workspaceRoot, options.executionsRoot, victim.executionId);
    fs.renameSync(victim.execDir, destination);
    removedExecutionIds.push(victim.executionId);
    try {
      fs.rmSync(destination, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push({ executionId: victim.executionId, code: error.code || 'RETENTION_TRASH_REMOVE_FAILED' });
    }
  }
  return {
    status: cleanupErrors.length ? 'FAILED' : (removedExecutionIds.length ? 'PRUNED' : 'UNCHANGED'),
    limit,
    completedCount: completed.length,
    removedExecutionIds,
    ...(cleanupErrors.length ? { cleanupErrors } : {}),
  };
}

function pruneCompletedExecutions(options = {}) {
  try {
    if (!path.isAbsolute(options.workspaceRoot || '') || !path.isAbsolute(options.executionsRoot || '')) {
      throw new Error('execution retention requires absolute workspaceRoot and executionsRoot paths');
    }
    const realWorkspaceRoot = fs.realpathSync(options.workspaceRoot);
    const realExecutionsRoot = fs.realpathSync(options.executionsRoot);
    const relativeRoot = path.relative(realWorkspaceRoot, realExecutionsRoot);
    if (!relativeRoot || relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
      throw new Error('execution retention root must be inside the workspace');
    }
    return withFileLock(path.join(options.executionsRoot, '.retention.lock'), () => pruneLocked(options), {
      now: options.now,
    });
  } catch (error) {
    return {
      status: 'FAILED',
      limit: options.limit ?? DEFAULT_COMPLETED_EXECUTION_LIMIT,
      removedExecutionIds: [],
      error: { code: error.code || 'EXECUTION_RETENTION_FAILED', message: error.message || String(error) },
    };
  }
}

module.exports = {
  DEFAULT_COMPLETED_EXECUTION_LIMIT,
  pruneCompletedExecutions,
};
