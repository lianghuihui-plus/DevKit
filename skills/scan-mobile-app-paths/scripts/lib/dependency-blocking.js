'use strict';

const fs = require('fs');
const path = require('path');
const { contextDir, readJson } = require('./common');
const { restoreStepVerified } = require('./verification-result');

function edgeIdsOf(task = {}) {
  return Array.isArray(task.edgeIds) ? task.edgeIds.filter(Boolean) : [];
}

function readRestore(scanDir, restoreId) {
  if (!restoreId) return null;
  const file = path.join(scanDir, 'evidence', 'restores', `${restoreId}.json`);
  return fs.existsSync(file) ? readJson(file, null) : null;
}

function restoreFromEvidenceRef(scanDir, evidenceRef) {
  if (!evidenceRef) return null;
  const file = path.join(scanDir, evidenceRef);
  if (!fs.existsSync(file)) return null;
  const evidence = readJson(file, null);
  return readRestore(scanDir, evidence?.restoreId);
}

function latestRestoreForTask(scanDir, task = {}) {
  const executions = Array.isArray(task.executions) ? task.executions : [];
  const execution = [...executions].reverse().find(item => item.restoreId);
  return readRestore(scanDir, execution?.restoreId) || restoreFromEvidenceRef(scanDir, task.evidenceRef);
}

function inferFailedEdgeIds(task = {}, restored = null, { fallbackToAll = false } = {}) {
  const ids = edgeIdsOf(task);
  if (!ids.length) return [];
  const explicit = task.failure?.blockingEdgeIds || task.failure?.failedEdgeIds || (task.failure?.failedEdgeId ? [task.failure.failedEdgeId] : null);
  if (Array.isArray(explicit) && explicit.some(Boolean)) return explicit.filter(id => ids.includes(id));
  if (!restored) return fallbackToAll ? ids : null;

  const checkpointEdgeId = restored.checkpoint?.edgeId || restored.mismatch?.edgeId;
  if (checkpointEdgeId && ids.includes(checkpointEdgeId)) return [checkpointEdgeId];

  const unverified = (restored.steps || []).find(step => step?.edgeId && !restoreStepVerified(step, restored.equivalenceReviews || []));
  if (unverified?.edgeId && ids.includes(unverified.edgeId)) return [unverified.edgeId];

  const replayed = Number(restored.actionsReplayed || 0);
  if (Number.isFinite(replayed) && replayed >= 0 && ids[replayed]) return [ids[replayed]];
  if (Number.isFinite(replayed) && replayed >= ids.length && ids.length) return [ids[ids.length - 1]];
  return fallbackToAll ? ids : null;
}

function dependencyEdgeIdsForState(graph = {}, reachableStateId) {
  const state = (graph.reachableStates || []).find(item => item.id === reachableStateId);
  if (!state) return null;
  if (Array.isArray(state.dependencyEdgeIds)) return state.dependencyEdgeIds;
  return state.runnablePathEdgeIds || state.replayPathEdgeIds || [];
}

function dependencyEdgeIdsForFrontier(graph = {}, item = {}) {
  if (Array.isArray(item.dependencyEdgeIds)) return item.dependencyEdgeIds;
  return dependencyEdgeIdsForState(graph, item.fromReachableStateId);
}

function dependencyEdgeIdsForVerification(item = {}) {
  return Array.isArray(item.dependencyEdgeIds) ? item.dependencyEdgeIds : edgeIdsOf(item);
}

function intersects(left = [], rightSet = new Set()) {
  return (left || []).some(id => rightSet.has(id));
}

function terminalFailures(queue = {}, maxAttempts = 3) {
  return (queue.items || [])
    .filter(item => item.status === 'FAILED' && Number(item.attemptCount || 0) >= maxAttempts);
}

function deriveBlockedDependencies({ scanDir, contextId, graph = {}, queue = {}, maxAttempts = 3 } = {}) {
  const blockedEdgeIds = new Set();
  const failures = [];
  const unknownFailures = [];
  for (const task of terminalFailures(queue, maxAttempts)) {
    const restored = latestRestoreForTask(scanDir, task);
    const failedEdgeIds = inferFailedEdgeIds(task, restored, { fallbackToAll: false });
    const blockingEdgeIds = Array.isArray(failedEdgeIds) ? failedEdgeIds.filter(id => edgeIdsOf(task).includes(id)) : null;
    const firstIndex = blockingEdgeIds?.length ? edgeIdsOf(task).indexOf(blockingEdgeIds[0]) : -1;
    const failure = {
      verificationId: task.verificationId,
      reasonCode: task.reasonCode || restored?.reasonCode || null,
      restoreId: restored?.restoreId || null,
      failedEdgeIds: blockingEdgeIds || [],
      blockingEdgeIds: blockingEdgeIds || [],
      scope: blockingEdgeIds?.length ? (firstIndex <= 0 ? 'PREFIX_EDGE_BLOCKED' : 'BRANCH_EDGE_BLOCKED') : 'UNKNOWN'
    };
    failures.push(failure);
    if (!blockingEdgeIds?.length) unknownFailures.push({ task, failure });
    else for (const edgeId of blockingEdgeIds) blockedEdgeIds.add(edgeId);
  }
  return {
    contextId,
    blockedEdgeIds: [...blockedEdgeIds].sort(),
    failures,
    unknownFailures: unknownFailures.map(item => item.failure),
    hasUnknownTerminalFailure: unknownFailures.length > 0,
    isFrontierBlocked(item) {
      const deps = dependencyEdgeIdsForFrontier(graph, item);
      return deps === null || intersects(deps, blockedEdgeIds);
    },
    isVerificationBlocked(item) {
      return intersects(dependencyEdgeIdsForVerification(item), blockedEdgeIds);
    }
  };
}

function loadDependencyBlocking(scanDir, contextId, graph, maxAttempts) {
  const queue = readJson(path.join(contextDir(scanDir, contextId), 'verification-queue.json'), { schemaVersion: 2, contextId, items: [] });
  return deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts });
}

module.exports = {
  latestRestoreForTask,
  inferFailedEdgeIds,
  dependencyEdgeIdsForState,
  dependencyEdgeIdsForFrontier,
  dependencyEdgeIdsForVerification,
  deriveBlockedDependencies,
  loadDependencyBlocking
};
