'use strict';

const { updateCanonicalPaths } = require('./graph-store');

const NON_GRAPH_ACTION_TYPES = new Set(['wait']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeGraphForConsumption(input, { runId = null, contextId = input?.contextId || null } = {}) {
  const graph = clone(input); const issues = [];
  const roots = graph.reachableStates.filter(state => (state.depth?.pathDepth || 0) === 0);
  const forbiddenEdges = graph.edges.filter(edge => NON_GRAPH_ACTION_TYPES.has(edge.action?.type));
  const allowedEdges = graph.edges.filter(edge => !NON_GRAPH_ACTION_TYPES.has(edge.action?.type));
  const reachable = new Set(roots.map(state => state.id)); const queue = [...reachable];
  while (queue.length) {
    const from = queue.shift();
    for (const edge of allowedEdges.filter(item => item.fromReachableStateId === from)) {
      if (!reachable.has(edge.toReachableStateId)) { reachable.add(edge.toReachableStateId); queue.push(edge.toReachableStateId); }
    }
  }
  const retainedEdges = allowedEdges.filter(edge => reachable.has(edge.fromReachableStateId) && reachable.has(edge.toReachableStateId));
  const retainedEdgeIds = new Set(retainedEdges.map(edge => edge.id)); const retainedStates = graph.reachableStates.filter(state => reachable.has(state.id)); const retainedStateIds = new Set(retainedStates.map(state => state.id));
  const retainedVisualIds = new Set(retainedStates.map(state => state.visualStateId)); const retainedVisuals = graph.visualStates.filter(visual => retainedVisualIds.has(visual.id));
  const retainedLogicalIds = new Set(retainedVisuals.map(visual => visual.logicalScreenKey)); const retainedLogicals = graph.logicalScreens.filter(logical => retainedLogicalIds.has(logical.id));
  const droppedEdges = graph.edges.filter(edge => !retainedEdgeIds.has(edge.id)); const droppedStates = graph.reachableStates.filter(state => !retainedStateIds.has(state.id));
  if (forbiddenEdges.length) issues.push({ type: 'LEGACY_NON_GRAPH_ACTION_DROPPED', actionType: 'wait', contextId, sourceRunId: runId, sourceEdgeIds: forbiddenEdges.map(edge => edge.id), count: forbiddenEdges.length });
  if (droppedStates.length || droppedEdges.length > forbiddenEdges.length) issues.push({ type: 'LEGACY_REACHABILITY_PRUNED', contextId, sourceRunId: runId, droppedReachableStateIds: droppedStates.map(state => state.id), droppedEdgeIds: droppedEdges.map(edge => edge.id), reasonCode: forbiddenEdges.length ? 'DEPENDENT_ON_NON_GRAPH_ACTION' : 'UNREACHABLE_FROM_ROOT' });
  graph.logicalScreens = retainedLogicals; graph.visualStates = retainedVisuals; graph.reachableStates = retainedStates; graph.edges = retainedEdges;
  for (const logical of graph.logicalScreens) logical.visualStateIds = graph.visualStates.filter(visual => visual.logicalScreenKey === logical.id).map(visual => visual.id);
  for (const state of graph.reachableStates) state.incomingEdgeIds = graph.edges.filter(edge => edge.toReachableStateId === state.id).map(edge => edge.id);
  updateCanonicalPaths(graph);
  return { graph, issues, changed: forbiddenEdges.length > 0 || droppedStates.length > 0 || droppedEdges.length > 0 };
}

function assertConsumableGraph(graph, fail) {
  const forbidden = graph.edges.find(edge => NON_GRAPH_ACTION_TYPES.has(edge.action?.type));
  if (forbidden) fail(`Graph contains non-graph action edge ${forbidden.id}: ${forbidden.action.type}`, 'CONSUMER_GRAPH_INVALID');
  const logicalIds = new Set(graph.logicalScreens.map(logical => logical.id)); const visualIds = new Set(graph.visualStates.map(visual => visual.id)); const stateIds = new Set(graph.reachableStates.map(state => state.id)); const edgeIds = new Set(graph.edges.map(edge => edge.id));
  const invalidState = graph.reachableStates.find(state => !visualIds.has(state.visualStateId)); if (invalidState) fail(`Graph state ${invalidState.id} references a missing VisualState`, 'CONSUMER_GRAPH_INVALID');
  const invalidVisual = graph.visualStates.find(visual => !logicalIds.has(visual.logicalScreenKey)); if (invalidVisual) fail(`Graph VisualState ${invalidVisual.id} references a missing LogicalScreen`, 'CONSUMER_GRAPH_INVALID');
  const orphanVisual = graph.visualStates.find(visual => !graph.reachableStates.some(state => state.visualStateId === visual.id)); if (orphanVisual) fail(`Graph contains orphan VisualState ${orphanVisual.id}`, 'CONSUMER_GRAPH_INVALID');
  const orphanLogical = graph.logicalScreens.find(logical => !graph.visualStates.some(visual => visual.logicalScreenKey === logical.id)); if (orphanLogical) fail(`Graph contains orphan LogicalScreen ${orphanLogical.id}`, 'CONSUMER_GRAPH_INVALID');
  const invalidEdge = graph.edges.find(edge => !stateIds.has(edge.fromReachableStateId) || !stateIds.has(edge.toReachableStateId)); if (invalidEdge) fail(`Graph edge ${invalidEdge.id} has an invalid endpoint`, 'CONSUMER_GRAPH_INVALID');
  const invalidPath = (graph.paths || []).find(item => !stateIds.has(item.terminalReachableStateId) || (item.edgeIds || []).some(id => !edgeIds.has(id))); if (invalidPath) fail(`Graph path ${invalidPath.id} references missing graph entities`, 'CONSUMER_GRAPH_INVALID');
  const reachable = new Set(graph.reachableStates.filter(state => (state.depth?.pathDepth || 0) === 0).map(state => state.id)); const queue = [...reachable];
  while (queue.length) {
    const from = queue.shift();
    for (const edge of graph.edges.filter(item => item.fromReachableStateId === from)) if (!reachable.has(edge.toReachableStateId)) { reachable.add(edge.toReachableStateId); queue.push(edge.toReachableStateId); }
  }
  const orphan = graph.reachableStates.find(state => !reachable.has(state.id)); if (orphan) fail(`Graph contains unreachable state ${orphan.id}`, 'CONSUMER_GRAPH_INVALID');
  return true;
}

module.exports = { NON_GRAPH_ACTION_TYPES, normalizeGraphForConsumption, assertConsumableGraph };
