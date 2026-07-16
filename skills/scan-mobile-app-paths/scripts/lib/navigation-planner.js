'use strict';

const { hashObject } = require('./common');
const { cursorLease } = require('./live-cursor');
const { loadBackCapabilities } = require('./back-capability-store');

function replayable(edge) {
  const replay = edge.verification?.replayStatus || edge.replayability || 'UNVERIFIED';
  const bounds = edge.action?.fallbackBounds; const coordinateValid = edge.locatorResolution === 'SEMANTIC_VERIFIED' || Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > bounds[0] && bounds[3] > bounds[1];
  return edge.action?.type !== 'wait' && edge.replayPolicy !== 'NONREPEATABLE' && edge.safety?.allowed !== false && !['NONREPEATABLE', 'INVALIDATED', 'REPLAY_UNSTABLE'].includes(replay) && coordinateValid;
}

function shortestPath(graph, fromId, toId) {
  if (!fromId || !toId) return null; if (fromId === toId) return [];
  const queue = [{ stateId: fromId, edges: [], cost: 0 }]; const best = new Map([[fromId, 0]]);
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.stateId.localeCompare(b.stateId)); const current = queue.shift();
    for (const edge of graph.edges.filter(item => item.fromReachableStateId === current.stateId && replayable(item)).sort((a, b) => a.id.localeCompare(b.id))) {
      const coordinatePenalty = edge.locatorResolution === 'COORDINATE_ONLY' || !edge.locatorResolution ? 10 : 1; const nextCost = current.cost + coordinatePenalty;
      if ((best.get(edge.toReachableStateId) ?? Infinity) <= nextCost) continue;
      const edges = [...current.edges, edge.id]; if (edge.toReachableStateId === toId) return { edgeIds: edges, cost: nextCost };
      best.set(edge.toReachableStateId, nextCost); queue.push({ stateId: edge.toReachableStateId, edges, cost: nextCost });
    }
  }
  return null;
}

function planNavigation({ scanDir, scan, contextId, graph, targetReachableStateId }) {
  const lease = cursorLease(scanDir, contextId, scan, targetReachableStateId); const cursor = lease.cursor;
  if (cursor.status === 'EXACT' && lease.stateMatches && lease.mutationMatches) return make(contextId, 'LIVE_CURSOR', cursor.reachableStateId, targetReachableStateId, [], lease.requiresRecheck ? 1 : 0, cursor.epoch);
  const back = loadBackCapabilities(scanDir, contextId).items.find(item => item.status === 'ACTIVE' && item.fromReachableStateId === cursor.reachableStateId && item.toReachableStateId === targetReachableStateId && item.verificationStatus === 'EXACT');
  if (cursor.status === 'EXACT' && lease.mutationMatches && back) return make(contextId, 'BACKTRACK', cursor.reachableStateId, targetReachableStateId, [{ kind: 'BACK', backCapabilityId: back.backCapabilityId, expectedReachableStateId: targetReachableStateId }], 1, cursor.epoch);
  const path = cursor.status === 'EXACT' && lease.mutationMatches ? shortestPath(graph, cursor.reachableStateId, targetReachableStateId) : null;
  if (path) return make(contextId, 'GRAPH_PATH', cursor.reachableStateId, targetReachableStateId, path.edgeIds.map(edgeId => ({ kind: 'EDGE', edgeId })), path.cost, cursor.epoch);
  const target = graph.reachableStates.find(item => item.id === targetReachableStateId); const edgeIds = target?.replayPathEdgeIds || [];
  return make(contextId, 'COLD_REPLAY', cursor.reachableStateId, targetReachableStateId, edgeIds.map(edgeId => ({ kind: 'EDGE', edgeId })), edgeIds.length + 20, cursor.epoch);
}

function make(contextId, mode, fromReachableStateId, toReachableStateId, steps, estimatedActions, cursorEpoch) {
  const identity = { mode, fromReachableStateId, toReachableStateId, steps, cursorEpoch };
  const planFingerprint = hashObject(identity); return { schemaVersion: 2, navigationPlanId: `nav-${planFingerprint.slice(-16)}`, planFingerprint, contextId, ...identity, estimatedActions, fallbackMode: mode === 'COLD_REPLAY' ? null : 'COLD_REPLAY', status: 'PLANNED' };
}

module.exports = { replayable, shortestPath, planNavigation };
