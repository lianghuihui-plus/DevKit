'use strict';

function contextMetrics(graph, frontier, runtime = {}) {
  const counts = Object.fromEntries(['PENDING', 'CLAIMED', 'RETRYABLE', 'EXPLORED', 'COVERED_BY_GROUP', 'SKIPPED', 'BLOCKED', 'FAILED'].map(status => [status, frontier.items.filter(x => x.status === status).length]));
  const safe = frontier.items.filter(x => (x.priority?.riskRank ?? 0) === 0);
  const covered = safe.filter(x => ['EXPLORED', 'COVERED_BY_GROUP'].includes(x.status));
  const observations = runtime.observations || 0; const observationSamples = runtime.observationSamples || 0; const observationStabilityWaitMs = runtime.observationStabilityWaitMs || 0;
  return {
    schemaVersion: 1, contextId: graph.contextId, logicalScreenCount: graph.logicalScreens.length,
    visualStateCount: graph.visualStates.length, reachableStateCount: graph.reachableStates.length,
    edgeCount: graph.edges.length, pathCount: graph.paths.length,
    maxPathDepth: Math.max(0, ...graph.reachableStates.map(x => x.depth?.pathDepth || 0)),
    maxRouteDepth: Math.max(0, ...graph.reachableStates.map(x => x.depth?.routeDepth || 0)),
    frontierCounts: counts, safeCandidateCoverage: safe.length ? covered.length / safe.length : null,
    coverageSemantics: 'discovered-safe-candidate-groups', actions: runtime.actions || 0,
    explorationActions: runtime.explorationActions || 0, navigationActions: runtime.navigationActions || 0, recoveryActions: runtime.recoveryActions || 0, verificationActions: runtime.verificationActions || 0, interruptionActions: runtime.interruptionActions || 0,
    coldStarts: runtime.coldStarts || 0, cursorReuseHits: runtime.cursorReuseHits || 0, cursorInvalidations: runtime.cursorInvalidations || 0, backtrackNavigations: runtime.backtrackNavigations || 0, graphPathNavigations: runtime.graphPathNavigations || 0, coldReplayNavigations: runtime.coldReplayNavigations || 0, deviceMutationSeq: runtime.deviceMutationSeq || 0, observations,
    observationSamples, observationStabilityWaitMs, visualVarianceObservations: runtime.visualVarianceObservations || 0,
    averageSamplesPerObservation: observations ? observationSamples / observations : null,
    averageStabilityWaitMs: observations ? observationStabilityWaitMs / observations : null,
    restoreAttempts: runtime.restoreAttempts || 0, noStateChangeActions: runtime.noStateChangeActions || 0,
    activeStartedAt: runtime.activeStartedAt || null, activeDurationMs: runtime.activeDurationMs || 0
  };
}

function authDiff(map) {
  const keys = contextId => new Set((map.contexts?.[contextId]?.logicalScreens || []).map(x => x.id));
  const guest = keys('guest'); const authenticated = keys('authenticated');
  if (!map.contexts?.guest || !map.contexts?.authenticated) return { schemaVersion: 1, status: 'NOT_COVERED', missingContexts: ['guest', 'authenticated'].filter(x => !map.contexts?.[x]) };
  return { schemaVersion: 1, status: 'READY', commonLogicalScreens: [...guest].filter(x => authenticated.has(x)).sort(), guestOnlyLogicalScreens: [...guest].filter(x => !authenticated.has(x)).sort(), authenticatedOnlyLogicalScreens: [...authenticated].filter(x => !guest.has(x)).sort() };
}

module.exports = { contextMetrics, authDiff };
