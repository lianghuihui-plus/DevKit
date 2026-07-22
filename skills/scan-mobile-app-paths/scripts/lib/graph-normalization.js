'use strict';

const { updateCanonicalPaths } = require('./graph-store');

const NON_GRAPH_ACTION_TYPES = new Set(['wait']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeGraphForConsumption(input, { runId = null, contextId = input?.contextId || null } = {}) {
  if (Number(input?.schemaVersion || 1) !== 2) {
    throw Object.assign(new Error(`Graph ${contextId || '<unknown>'} uses unsupported legacy schema`), { code: 'GRAPH_SCHEMA_UNSUPPORTED', runId });
  }
  const graph = clone(input); const issues = [];
  const forbidden = graph.edges.find(edge => NON_GRAPH_ACTION_TYPES.has(edge.intent?.type));
  if (forbidden) throw Object.assign(new Error(`Graph ${contextId || '<unknown>'} contains non-graph intent edge ${forbidden.id}: ${forbidden.intent.type}`), { code: 'NON_GRAPH_ACTION', runId });
  updateCanonicalPaths(graph);
  return { graph, issues, changed: false };
}

function assertConsumableGraph(graph, fail) {
  if (Number(graph?.schemaVersion || 1) !== 2) fail('Dashboard requires graph schemaVersion 2; rebuild the app map with the current skill', 'CONSUMER_GRAPH_INVALID');
  const legacy = graph.edges.find(edge => edge.action !== undefined);
  if (legacy) fail(`Graph contains legacy action edge ${legacy.id}; rebuild the app map with the current skill`, 'CONSUMER_GRAPH_INVALID');
  const forbidden = graph.edges.find(edge => NON_GRAPH_ACTION_TYPES.has(edge.intent?.type));
  if (forbidden) fail(`Graph contains non-graph intent edge ${forbidden.id}: ${forbidden.intent.type}`, 'CONSUMER_GRAPH_INVALID');
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
