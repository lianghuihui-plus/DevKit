'use strict';

const { hashObject } = require('./common');
const { cursorLease } = require('./live-cursor');
const { loadBackCapabilities } = require('./back-capability-store');
const { isReplayableEdge } = require('./replayability');

function replayable(edge) {
  return isReplayableEdge(edge);
}

function validReplayPath(graph, edgeIds = [], fromId, toId) {
  if (!fromId || !toId) return null;
  let cursor = fromId;
  const edges = new Map((graph.edges || []).map(edge => [edge.id, edge]));
  for (const edgeId of edgeIds) {
    const edge = edges.get(edgeId);
    if (!edge || edge.fromReachableStateId !== cursor || !replayable(edge)) return null;
    cursor = edge.toReachableStateId;
  }
  return cursor === toId ? edgeIds : null;
}

function shortestPath(graph, fromId, toId) {
  if (!fromId || !toId) return null; if (fromId === toId) return [];
  const queue = [{ stateId: fromId, edges: [], cost: 0 }]; const best = new Map([[fromId, 0]]);
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.stateId.localeCompare(b.stateId)); const current = queue.shift();
    for (const edge of graph.edges.filter(item => item.fromReachableStateId === current.stateId && replayable(item)).sort((a, b) => a.id.localeCompare(b.id))) {
      const locatorPenalty = edge.locatorQuality === 'SEMANTIC_WITH_FALLBACK' ? 2 : 1; const nextCost = current.cost + locatorPenalty;
      if ((best.get(edge.toReachableStateId) ?? Infinity) <= nextCost) continue;
      const edges = [...current.edges, edge.id]; if (edge.toReachableStateId === toId) return { edgeIds: edges, cost: nextCost };
      best.set(edge.toReachableStateId, nextCost); queue.push({ stateId: edge.toReachableStateId, edges, cost: nextCost });
    }
  }
  return null;
}

function planNavigation({ scanDir, scan, contextId, graph, targetReachableStateId }) {
  const lease = cursorLease(scanDir, contextId, scan, targetReachableStateId); const cursor = lease.cursor;
  if (lease.usable && lease.stateMatches && lease.mutationMatches) return make(contextId, 'LIVE_CURSOR', cursor.reachableStateId, targetReachableStateId, [], lease.requiresRecheck ? 1 : 0, cursor.epoch);
  const back = loadBackCapabilities(scanDir, contextId).items.find(item => item.status === 'ACTIVE' && item.fromReachableStateId === cursor.reachableStateId && item.toReachableStateId === targetReachableStateId && item.verificationStatus === 'EXACT');
  if (lease.usable && lease.mutationMatches && back) return make(contextId, 'BACKTRACK', cursor.reachableStateId, targetReachableStateId, [{ kind: 'BACK', backCapabilityId: back.backCapabilityId, expectedReachableStateId: targetReachableStateId }], 1, cursor.epoch);
  const path = lease.usable && lease.mutationMatches ? shortestPath(graph, cursor.reachableStateId, targetReachableStateId) : null;
  if (path) return make(contextId, 'GRAPH_PATH', cursor.reachableStateId, targetReachableStateId, path.edgeIds.map(edgeId => ({ kind: 'EDGE', edgeId })), path.cost, cursor.epoch);
  const root = graph.reachableStates.find(item => (item.depth?.pathDepth || 0) === 0);
  const target = graph.reachableStates.find(item => item.id === targetReachableStateId);
  const cached = validReplayPath(graph, target?.replayPathEdgeIds || [], root?.id, targetReachableStateId);
  const fallback = cached ? null : shortestPath(graph, root?.id, targetReachableStateId);
  const edgeIds = cached || fallback?.edgeIds || [];
  return make(contextId, 'COLD_REPLAY', cursor.reachableStateId, targetReachableStateId, edgeIds.map(edgeId => ({ kind: 'EDGE', edgeId })), edgeIds.length + 20, cursor.epoch);
}

function make(contextId, mode, fromReachableStateId, toReachableStateId, steps, estimatedActions, cursorEpoch) {
  const identity = { mode, fromReachableStateId, toReachableStateId, steps, cursorEpoch };
  const planFingerprint = hashObject(identity); return { schemaVersion: 2, navigationPlanId: `nav-${planFingerprint.slice(-16)}`, planFingerprint, contextId, ...identity, estimatedActions, fallbackMode: mode === 'COLD_REPLAY' ? null : 'COLD_REPLAY', status: 'PLANNED' };
}

module.exports = { replayable, shortestPath, planNavigation };
