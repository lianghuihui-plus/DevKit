'use strict';

const { fail, hashObject, slug } = require('./common');
const { compareFingerprint } = require('./fingerprint');
const { canonicalIntentIdentity, intentKey } = require('./action-intent');
const { isReplayableEdge, locatorReplayabilityReason } = require('./replayability');

const LOCATOR_QUALITIES = new Set(['SEMANTIC_PORTABLE', 'SEMANTIC_WITH_FALLBACK', 'DEVICE_BOUND', 'UNRESOLVED']);

function byId(items, id, label) {
  const item = items.find(x => x.id === id);
  if (!item) fail(`${label || 'item'} not found: ${id}`, 'GRAPH_REFERENCE_MISSING');
  return item;
}

function upsertLogicalScreen(graph, key, name, description, runId) {
  let screen = graph.logicalScreens.find(x => x.id === key);
  if (!screen) {
    screen = { id: key, name, description: description || '', visualStateIds: [], evidenceRunIds: [] };
    graph.logicalScreens.push(screen);
  }
  if (runId && !screen.evidenceRunIds.includes(runId)) screen.evidenceRunIds.push(runId);
  return screen;
}

function findVisualMatch(graph, fingerprint) {
  const exact = graph.visualStates.find(x => compareFingerprint(x.fingerprint, fingerprint) === 'EXACT');
  if (exact) return { status: 'EXACT', visualState: exact };
  const probable = graph.visualStates.find(x => compareFingerprint(x.fingerprint, fingerprint) === 'PROBABLE');
  return probable ? { status: 'PROBABLE', visualState: probable } : { status: 'UNCERTAIN', visualState: null };
}

function upsertVisualState(graph, input) {
  const match = findVisualMatch(graph, input.fingerprint); const exact = match.status === 'EXACT' ? match.visualState : null;
  if (exact) {
    if (exact.logicalScreenKey !== input.logicalScreenKey) fail(`VisualState ${exact.id} already belongs to LogicalScreen ${exact.logicalScreenKey}; requested ${input.logicalScreenKey}`, 'LOGICAL_SCREEN_CONFLICT');
    if (!exact.evidenceObservationIds.includes(input.observationId)) exact.evidenceObservationIds.push(input.observationId);
    exact.visualReviewIds ||= [];
    if (input.visualReviewId && !exact.visualReviewIds.includes(input.visualReviewId)) exact.visualReviewIds.push(input.visualReviewId);
    exact.dedupe = { status: 'EXACT', duplicateGroupId: null, reviewStatus: 'NOT_REQUIRED' };
    const screen = byId(graph.logicalScreens, input.logicalScreenKey, 'LogicalScreen');
    if (!screen.visualStateIds.includes(exact.id)) screen.visualStateIds.push(exact.id);
    return { visualState: exact, created: false, dedupeStatus: 'EXACT' };
  }
  const probable = match.status === 'PROBABLE' ? match.visualState : null;
  const base = slug(`${input.logicalScreenKey}-ui`, 'visual');
  const id = input.id || `${base}-${String(graph.visualStates.length + 1).padStart(3, '0')}`;
  const visualState = {
    id, logicalScreenKey: input.logicalScreenKey, name: input.name, kind: input.kind || 'full-screen',
    availableIn: [graph.contextId], fingerprint: input.fingerprint,
    dedupe: probable ? { status: 'PROBABLE', duplicateGroupId: `dup-${hashObject([probable.id, id]).slice(-12)}`, reviewStatus: 'REQUIRED' }
      : { status: 'UNCERTAIN', duplicateGroupId: null, reviewStatus: 'NOT_REQUIRED' },
    evidenceObservationIds: [input.observationId],
    visualReviewIds: input.visualReviewId ? [input.visualReviewId] : []
  };
  graph.visualStates.push(visualState);
  const screen = byId(graph.logicalScreens, input.logicalScreenKey, 'LogicalScreen');
  screen.visualStateIds.push(id);
  return { visualState, created: true, dedupeStatus: visualState.dedupe.status };
}

function upsertReachableState(graph, input) {
  byId(graph.visualStates, input.visualStateId, 'VisualState');
  const signatureHash = hashObject(input.arrivalSignature || {});
  let state = graph.reachableStates.find(x => x.visualStateId === input.visualStateId && hashObject(x.arrivalSignature || {}) === signatureHash);
  if (state) return { reachableState: state, created: false };
  const id = input.id || `${input.visualStateId}@${graph.contextId}#${String(graph.reachableStates.length + 1).padStart(3, '0')}`;
  state = {
    id, visualStateId: input.visualStateId, contextId: graph.contextId,
    arrivalSignature: input.arrivalSignature || { expectedBackReachableStateId: null, backBehaviorKey: 'unknown', stateInvariantHash: signatureHash },
    depth: input.depth || { pathDepth: 0, routeDepth: 0, modalDepth: 0 }, incomingEdgeIds: [], replayPathEdgeIds: input.replayPathEdgeIds || []
  };
  graph.reachableStates.push(state);
  return { reachableState: state, created: true };
}

function canonicalActionIdentity(action = {}) {
  return canonicalIntentIdentity(action.intent || action);
}

function actionKey(action) {
  return intentKey(action.intent || action);
}

function recordEdge(graph, edge) {
  const from = byId(graph.reachableStates, edge.fromReachableStateId, 'from ReachableState');
  const to = byId(graph.reachableStates, edge.toReachableStateId, 'to ReachableState');
  const duplicate = graph.edges.find(x => x.fromReachableStateId === from.id && x.toReachableStateId === to.id && actionKey(x) === actionKey(edge));
  if (duplicate) return { edge: duplicate, created: false };
  graph.edges.push(edge);
  if (!to.incomingEdgeIds.includes(edge.id)) to.incomingEdgeIds.push(edge.id);
  updateCanonicalPaths(graph);
  return { edge, created: true };
}

function transitionFingerprint(graph, edge) {
  const from = byId(graph.reachableStates, edge.fromReachableStateId, 'from ReachableState'); const to = byId(graph.reachableStates, edge.toReachableStateId, 'to ReachableState'); const fromVisual = byId(graph.visualStates, from.visualStateId, 'from VisualState'); const toVisual = byId(graph.visualStates, to.visualStateId, 'to VisualState');
  return hashObject({ contextId: graph.contextId, fromLogicalScreenKey: fromVisual.logicalScreenKey, fromArrivalSignature: from.arrivalSignature || {}, intent: canonicalActionIdentity(edge), toLogicalScreenKey: toVisual.logicalScreenKey, toArrivalSignature: to.arrivalSignature || {} });
}

function edgeReplayRank(edge) {
  if (!isReplayableEdge(edge)) return 1000;
  const status = edge.verification?.replayStatus;
  if (status === 'COLD_REPLAY_VERIFIED') return 0;
  return edge.replayability === 'STABLE' ? 5 : edge.replayability === 'CONDITIONAL' ? 20 : 100;
}

function updateCanonicalPaths(graph) {
  const roots = graph.reachableStates.filter(x => (x.depth?.pathDepth || 0) === 0);
  const best = new Map();
  const queue = roots.map(root => ({ id: root.id, edges: [], cost: 0 }));
  roots.forEach(root => best.set(root.id, { edges: [], cost: 0 }));
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.edges.length - b.edges.length);
    const current = queue.shift();
    for (const edge of graph.edges.filter(x => x.fromReachableStateId === current.id)) {
      const rank = edgeReplayRank(edge);
      if (rank >= 1000) continue;
      const candidate = { edges: [...current.edges, edge.id], cost: current.cost + rank + 1 };
      const old = best.get(edge.toReachableStateId);
      if (!old || candidate.cost < old.cost || candidate.cost === old.cost && candidate.edges.length < old.edges.length) {
        best.set(edge.toReachableStateId, candidate);
        queue.push({ id: edge.toReachableStateId, ...candidate });
      }
    }
  }
  for (const state of graph.reachableStates) state.replayPathEdgeIds = best.get(state.id)?.edges || [];
  graph.paths = [...best.entries()].map(([terminalReachableStateId, value]) => ({
    id: `path-${slug(terminalReachableStateId)}-${hashObject(value.edges).slice(-8)}`,
    contextId: graph.contextId, edgeIds: value.edges, terminalReachableStateId, canonical: true
  }));
}

function validateGraph(graph) {
  if (Number(graph.schemaVersion || 1) !== 2) fail('Graph schemaVersion must be 2; legacy graph data is not supported by this skill version', 'GRAPH_SCHEMA_UNSUPPORTED');
  const logical = new Set(graph.logicalScreens.map(x => x.id));
  const visual = new Set(graph.visualStates.map(x => x.id));
  const reachable = new Set(graph.reachableStates.map(x => x.id));
  const edges = new Map(graph.edges.map(x => [x.id, x]));
  const observations = new Set();
  for (const state of graph.visualStates) if (!logical.has(state.logicalScreenKey)) fail(`VisualState ${state.id} references missing LogicalScreen`, 'GRAPH_INVALID');
  for (const state of graph.reachableStates) if (!visual.has(state.visualStateId)) fail(`ReachableState ${state.id} references missing VisualState`, 'GRAPH_INVALID');
  for (const edge of graph.edges) {
    if (!reachable.has(edge.fromReachableStateId) || !reachable.has(edge.toReachableStateId)) fail(`Edge ${edge.id} has invalid endpoint`, 'GRAPH_INVALID');
    if (edge.action !== undefined) fail(`Edge ${edge.id} uses legacy action storage; use intent plus locatorEvidence`, 'GRAPH_SCHEMA_UNSUPPORTED');
    if (!edge.intent || typeof edge.intent !== 'object') fail(`Edge ${edge.id} is missing action intent`, 'GRAPH_INVALID');
    if (edge.intent.type === 'wait') fail(`Edge ${edge.id} contains non-graph wait intent`, 'NON_GRAPH_ACTION');
    if (!LOCATOR_QUALITIES.has(edge.locatorQuality)) fail(`Edge ${edge.id} has invalid locatorQuality`, 'GRAPH_INVALID');
    const locatorShapeReason = locatorReplayabilityReason(edge);
    if (['EDGE_LOCATOR_UNRESOLVED', 'EDGE_LOCATOR_NOT_RESOLVED'].includes(locatorShapeReason)) fail(`Edge ${edge.id} has inconsistent portable locator evidence: ${locatorShapeReason}`, 'GRAPH_INVALID');
    if (edge.evidence?.beforeObservationId) observations.add(edge.evidence.beforeObservationId);
    if (edge.evidence?.afterObservationId) observations.add(edge.evidence.afterObservationId);
  }
  if (graph.reachableStates.length) {
    const roots = graph.reachableStates.filter(x => (x.depth?.pathDepth || 0) === 0);
    if (roots.length !== 1 || (roots[0].depth?.routeDepth || 0) !== 0 || (roots[0].depth?.modalDepth || 0) !== 0) fail('Graph must contain exactly one depth-zero non-modal root', 'GRAPH_INVALID');
    const visited = new Set([roots[0].id]); const queue = [roots[0].id];
    while (queue.length) { const from = queue.shift(); for (const edge of graph.edges.filter(x => x.fromReachableStateId === from)) if (!visited.has(edge.toReachableStateId)) { visited.add(edge.toReachableStateId); queue.push(edge.toReachableStateId); } }
    const orphan = graph.reachableStates.find(x => !visited.has(x.id)); if (orphan) fail(`ReachableState ${orphan.id} is not reachable from the root`, 'GRAPH_INVALID');
  }
  for (const item of graph.logicalScreens) {
    const expected = graph.visualStates.filter(x => x.logicalScreenKey === item.id).map(x => x.id).sort(); const actual = [...(item.visualStateIds || [])].sort();
    if (!expected.length || hashObject(expected) !== hashObject(actual)) fail(`LogicalScreen ${item.id} has inconsistent VisualState references`, 'GRAPH_INVALID');
  }
  for (const item of graph.visualStates) if (!graph.reachableStates.some(x => x.visualStateId === item.id)) fail(`VisualState ${item.id} is orphaned`, 'GRAPH_INVALID');
  for (const state of graph.reachableStates) {
    const incoming = graph.edges.filter(x => x.toReachableStateId === state.id).map(x => x.id).sort(); const actual = [...(state.incomingEdgeIds || [])].sort();
    if (hashObject(incoming) !== hashObject(actual)) fail(`ReachableState ${state.id} has inconsistent incomingEdgeIds`, 'GRAPH_INVALID');
    let cursor = graph.reachableStates.find(x => (x.depth?.pathDepth || 0) === 0)?.id || null;
    for (const edgeId of state.replayPathEdgeIds || []) { const edge = edges.get(edgeId); if (!edge || edge.fromReachableStateId !== cursor) fail(`ReachableState ${state.id} has a broken replay path`, 'GRAPH_INVALID'); if (!isReplayableEdge(edge)) fail(`ReachableState ${state.id} replay path contains non-replayable edge ${edge.id}`, 'GRAPH_INVALID'); cursor = edge.toReachableStateId; }
    if ((state.replayPathEdgeIds || []).length && cursor !== state.id) fail(`ReachableState ${state.id} replay path does not terminate at the state`, 'GRAPH_INVALID');
  }
  for (const item of graph.paths || []) {
    let cursor = graph.reachableStates.find(x => (x.depth?.pathDepth || 0) === 0)?.id || null;
    for (const edgeId of item.edgeIds || []) { const edge = edges.get(edgeId); if (!edge || edge.fromReachableStateId !== cursor) fail(`Path ${item.id} is not contiguous`, 'GRAPH_INVALID'); if (!isReplayableEdge(edge)) fail(`Path ${item.id} contains non-replayable edge ${edge.id}`, 'GRAPH_INVALID'); cursor = edge.toReachableStateId; }
    if (cursor !== item.terminalReachableStateId) fail(`Path ${item.id} has an invalid terminal state`, 'GRAPH_INVALID');
  }
  return { ok: true, observationIds: [...observations] };
}

module.exports = { byId, upsertLogicalScreen, findVisualMatch, upsertVisualState, upsertReachableState, canonicalActionIdentity, actionKey, recordEdge, transitionFingerprint, updateCanonicalPaths, validateGraph };
