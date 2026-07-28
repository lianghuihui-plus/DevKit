'use strict';

const fs = require('fs');
const path = require('path');
const { contextDir, readJson, fail, hashObject, exists } = require('./common');
const { maxDepth } = require('./run-protocol');
const { normalizeText } = require('./semantic-fingerprint');

const START_SCHEMA_VERSION = 1;

function isExplorationStartEnabled(scan = {}) {
  return scan.scanMode === 'exploration';
}

function normalizeTextArray(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(item => String(item || '').trim()).filter(Boolean);
}

function normalizeStartSpec(input = null) {
  if (!input) return { schemaVersion: START_SCHEMA_VERSION, kind: 'app-root', depthBasis: 'START_PAGE' };
  const kind = input.kind || input.type || 'app-root';
  if (!['app-root', 'specified-page'].includes(kind)) fail('explorationStart.kind must be app-root or specified-page', 'EXPLORATION_START_INVALID');
  if (kind === 'app-root') return { schemaVersion: START_SCHEMA_VERSION, kind, depthBasis: 'START_PAGE' };
  const pageName = String(input.pageName || input.name || input.description || '').trim();
  const routeHints = normalizeTextArray(input.routeHints || input.route || input.pathHint);
  const rawEvidence = input.matchEvidence || input.evidence || {};
  const matchEvidence = {
    requiredTexts: normalizeTextArray(rawEvidence.requiredTexts),
    optionalTexts: normalizeTextArray(rawEvidence.optionalTexts),
    forbiddenTexts: normalizeTextArray(rawEvidence.forbiddenTexts)
  };
  if (!pageName && !routeHints.length && !matchEvidence.requiredTexts.length && !matchEvidence.optionalTexts.length) {
    fail('specified-page explorationStart requires pageName, routeHints, or matchEvidence', 'EXPLORATION_START_INVALID');
  }
  return {
    schemaVersion: START_SCHEMA_VERSION,
    kind,
    pageName: pageName || null,
    routeHints,
    matchEvidence,
    depthBasis: 'START_PAGE'
  };
}

function startFile(scanDir, contextId) {
  return path.join(contextDir(scanDir, contextId), 'exploration-start.json');
}

function initialStartProjection(contextId, spec) {
  const normalized = normalizeStartSpec(spec);
  return {
    schemaVersion: START_SCHEMA_VERSION,
    contextId,
    kind: normalized.kind,
    depthBasis: normalized.depthBasis,
    status: normalized.kind === 'app-root' ? 'PENDING_ROOT' : 'PENDING',
    spec: normalized,
    startReachableStateId: null,
    startVisualStateId: null,
    pathEdgeIdsFromAppRoot: [],
    candidates: [],
    resolvedBy: null,
    resolvedAt: null,
    reasonCode: null
  };
}

function loadExplorationStart(scanDir, contextId) {
  return readJson(startFile(scanDir, contextId), initialStartProjection(contextId, null));
}

function rootState(graph = {}) {
  return (graph.reachableStates || []).find(state => Number(state.depth?.pathDepth || 0) === 0) || null;
}

function resolvedStartStateId(scanDir, scan, contextId, graph) {
  if (!isExplorationStartEnabled(scan)) return rootState(graph)?.id || null;
  const start = loadExplorationStart(scanDir, contextId);
  if (start.status === 'RESOLVED' && start.startReachableStateId) return start.startReachableStateId;
  if ((start.kind || start.spec?.kind) === 'app-root') return rootState(graph)?.id || null;
  return null;
}

function resolveAppRootStartValue(scanDir, contextId, graph, { at = null, resolvedBy = 'ROOT_STATE' } = {}) {
  const current = loadExplorationStart(scanDir, contextId);
  if ((current.kind || current.spec?.kind) !== 'app-root') return null;
  const root = rootState(graph);
  if (!root) return null;
  if (current.status === 'RESOLVED' && current.startReachableStateId === root.id) return null;
  return {
    ...current,
    status: 'RESOLVED',
    startReachableStateId: root.id,
    startVisualStateId: root.visualStateId || null,
    pathEdgeIdsFromAppRoot: [],
    candidates: [],
    resolvedBy,
    resolvedAt: at,
    reasonCode: null
  };
}

function resolveSpecifiedStartValue(scanDir, contextId, graph, reachableStateId, { resolvedBy = 'USER_CONFIRMED', at = null, candidate = null } = {}) {
  const current = loadExplorationStart(scanDir, contextId);
  if ((current.kind || current.spec?.kind) !== 'specified-page') fail('Only specified-page explorationStart can be confirmed manually', 'EXPLORATION_START_INVALID');
  const state = (graph.reachableStates || []).find(item => item.id === reachableStateId);
  if (!state) fail(`ReachableState not found: ${reachableStateId}`, 'GRAPH_REFERENCE_MISSING');
  return {
    ...current,
    status: 'RESOLVED',
    startReachableStateId: state.id,
    startVisualStateId: state.visualStateId || null,
    pathEdgeIdsFromAppRoot: state.runnablePathEdgeIds || state.replayPathEdgeIds || [],
    resolvedBy,
    resolvedAt: at,
    reasonCode: null,
    confirmedCandidate: candidate || null
  };
}

function runnableEdges(graph = {}) {
  return (graph.edges || []).filter(edge => !['NONREPEATABLE', 'INVALIDATED'].includes(edge.verification?.replayStatus));
}

function depthMapFromStart(graph = {}, startReachableStateId = null) {
  const startId = startReachableStateId || rootState(graph)?.id || null;
  const result = new Map();
  if (!startId) return result;
  const byFrom = new Map();
  for (const edge of runnableEdges(graph)) {
    if (!byFrom.has(edge.fromReachableStateId)) byFrom.set(edge.fromReachableStateId, []);
    byFrom.get(edge.fromReachableStateId).push(edge.toReachableStateId);
  }
  const queue = [startId];
  result.set(startId, 0);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const depth = result.get(current);
    for (const next of byFrom.get(current) || []) {
      if (result.has(next)) continue;
      result.set(next, depth + 1);
      queue.push(next);
    }
  }
  return result;
}

function startDepthMap({ scanDir, scan, contextId, graph }) {
  const startId = resolvedStartStateId(scanDir, scan, contextId, graph);
  if (!startId) return new Map();
  const result = depthMapFromStart(graph, startId);
  const start = (graph.reachableStates || []).find(state => state.id === startId);
  const startPath = start?.runnablePathEdgeIds || start?.replayPathEdgeIds || [];
  const appRoot = rootState(graph);
  for (const state of graph.reachableStates || []) {
    if (result.has(state.id)) continue;
    if (appRoot?.id === startId) {
      result.set(state.id, Number(state.depth?.pathDepth || 0));
      continue;
    }
    const pathEdges = state.runnablePathEdgeIds || state.replayPathEdgeIds || [];
    const sharesPrefix = startPath.every((edgeId, index) => pathEdges[index] === edgeId);
    if (sharesPrefix && pathEdges.length >= startPath.length) result.set(state.id, pathEdges.length - startPath.length);
  }
  return result;
}

function observedRunDepthFromStart({ scanDir, scan, contextId, graph }) {
  if (!isExplorationStartEnabled(scan) || !exists(startFile(scanDir, contextId))) {
    return Math.max(0, ...(graph.reachableStates || []).map(item => Number(item.depth?.pathDepth || 0)));
  }
  const attemptsDir = path.join(scanDir, 'attempts');
  if (!fs.existsSync(attemptsDir)) return 0;
  const map = startDepthMap({ scanDir, scan, contextId, graph });
  let observed = 0;
  for (const name of fs.readdirSync(attemptsDir).filter(item => item.endsWith('.json'))) {
    const attempt = readJson(path.join(attemptsDir, name), null);
    if (!attempt || attempt.contextId !== contextId) continue;
    if (!['COMMITTED', 'COVERED_BY_EXISTING_EDGE'].includes(attempt.status)) continue;
    const depth = map.get(attempt.toReachableStateId);
    if (Number.isFinite(depth)) observed = Math.max(observed, depth);
  }
  return observed;
}

function stateDepthFromStart({ scanDir, scan, contextId, graph, reachableStateId, depthMap = null }) {
  if (!isExplorationStartEnabled(scan) || !exists(startFile(scanDir, contextId))) return Number((graph.reachableStates || []).find(item => item.id === reachableStateId)?.depth?.pathDepth ?? 999);
  const map = depthMap || startDepthMap({ scanDir, scan, contextId, graph });
  return map.has(reachableStateId) ? map.get(reachableStateId) : null;
}

function frontierNextDepthFromStart({ scanDir, scan, contextId, graph, frontier, depthMap = null }) {
  const sourceDepth = stateDepthFromStart({ scanDir, scan, contextId, graph, reachableStateId: frontier.fromReachableStateId, depthMap });
  return sourceDepth === null ? null : sourceDepth + 1;
}

function filterFrontiersInStartScope({ items = [], scanDir, scan, contextId, graph }) {
  if (!isExplorationStartEnabled(scan)) return items;
  if (!exists(startFile(scanDir, contextId))) return items;
  const map = startDepthMap({ scanDir, scan, contextId, graph });
  const limit = maxDepth(scan.budget || {});
  return items.filter(item => {
    const nextDepth = frontierNextDepthFromStart({ scanDir, scan, contextId, graph, frontier: item, depthMap: map });
    return nextDepth !== null && nextDepth <= limit;
  }).map(item => ({
    ...item,
    priority: { ...(item.priority || {}), depthFromStart: stateDepthFromStart({ scanDir, scan, contextId, graph, reachableStateId: item.fromReachableStateId, depthMap: map }), nextDepthFromStart: frontierNextDepthFromStart({ scanDir, scan, contextId, graph, frontier: item, depthMap: map }) }
  }));
}

function filterSuggestionsInStartScope({ items = [], scanDir, scan, contextId, graph }) {
  if (!isExplorationStartEnabled(scan)) return items;
  if (!exists(startFile(scanDir, contextId))) return items;
  const map = startDepthMap({ scanDir, scan, contextId, graph });
  const limit = maxDepth(scan.budget || {});
  return items.filter(item => {
    const sourceDepth = stateDepthFromStart({ scanDir, scan, contextId, graph, reachableStateId: item.reachableStateId, depthMap: map });
    return sourceDepth !== null && sourceDepth + 1 <= limit;
  }).map(item => ({ ...item, priority: { ...(item.priority || {}), depthFromStart: stateDepthFromStart({ scanDir, scan, contextId, graph, reachableStateId: item.reachableStateId, depthMap: map }), nextDepthFromStart: stateDepthFromStart({ scanDir, scan, contextId, graph, reachableStateId: item.reachableStateId, depthMap: map }) + 1 } }));
}

function filterStateIdsInStartScope({ stateIds = [], scanDir, scan, contextId, graph, includeStart = true }) {
  if (!isExplorationStartEnabled(scan)) return stateIds;
  if (!exists(startFile(scanDir, contextId))) return stateIds;
  const map = startDepthMap({ scanDir, scan, contextId, graph });
  const limit = maxDepth(scan.budget || {});
  return stateIds.filter(id => map.has(id) && map.get(id) <= limit && (includeStart || map.get(id) > 0))
    .sort((a, b) => map.get(a) - map.get(b) || String(a).localeCompare(String(b)));
}

function verificationInStartScope({ verification, scanDir, scan, contextId, graph }) {
  if (!isExplorationStartEnabled(scan)) return true;
  if (!exists(startFile(scanDir, contextId))) return true;
  const terminalId = verification.terminalReachableStateId;
  if (!terminalId) return true;
  return filterStateIdsInStartScope({ stateIds: [terminalId], scanDir, scan, contextId, graph }).length === 1;
}

function textHaystackForState(graph, state) {
  const visual = (graph.visualStates || []).find(item => item.id === state.visualStateId) || {};
  const logical = (graph.logicalScreens || []).find(item => item.id === visual.logicalScreenKey || item.id === visual.logicalScreenId) || {};
  const semantic = visual.fingerprint?.semantic || {};
  return [
    state.id,
    visual.id,
    visual.name,
    visual.logicalScreenKey,
    logical.name,
    logical.description,
    ...(semantic.stableTexts || []),
    ...(semantic.primaryActions || [])
  ].map(normalizeText).filter(Boolean);
}

function matchesTerm(haystack, term) {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  return haystack.some(value => value === normalized || value.includes(normalized) || normalized.includes(value));
}

function candidateForState(graph, spec, state) {
  const evidence = spec.matchEvidence || {};
  const haystack = textHaystackForState(graph, state);
  const requiredTexts = evidence.requiredTexts || [];
  const optionalTexts = evidence.optionalTexts || [];
  const forbiddenTexts = evidence.forbiddenTexts || [];
  if (forbiddenTexts.some(text => matchesTerm(haystack, text))) return null;
  const requiredHits = requiredTexts.filter(text => matchesTerm(haystack, text));
  if (requiredHits.length !== requiredTexts.length) return null;
  const optionalHits = optionalTexts.filter(text => matchesTerm(haystack, text));
  const pageNameHit = spec.pageName ? matchesTerm(haystack, spec.pageName) : false;
  const routeHits = (spec.routeHints || []).map((text, index) => ({ text, index })).filter(item => matchesTerm(haystack, item.text));
  const score = requiredHits.length * 10 + optionalHits.length * 3 + (pageNameHit ? 6 : 0) + routeHits.length;
  if (score <= 0) return null;
  const strength = requiredTexts.length && requiredHits.length === requiredTexts.length || pageNameHit ? 'STRONG' : 'UNCERTAIN';
  const visual = (graph.visualStates || []).find(item => item.id === state.visualStateId) || {};
  const logical = (graph.logicalScreens || []).find(item => item.id === visual.logicalScreenKey || item.id === visual.logicalScreenId) || {};
  return {
    candidateId: `start-cand-${hashObject({ stateId: state.id, spec }).slice(-12)}`,
    reachableStateId: state.id,
    visualStateId: state.visualStateId,
    logicalScreenKey: visual.logicalScreenKey || null,
    label: logical.name || visual.name || state.id,
    matchStrength: strength,
    score,
    requiredHits,
    optionalHits,
    pageNameHit,
    routeHintHits: routeHits,
    pathDepth: Number(state.depth?.pathDepth || 0),
    pathEdgeIdsFromAppRoot: state.runnablePathEdgeIds || state.replayPathEdgeIds || []
  };
}

function evaluateKnownStartCandidates(graph, spec) {
  const normalized = normalizeStartSpec(spec);
  if (normalized.kind !== 'specified-page') return [];
  return (graph.reachableStates || [])
    .map(state => candidateForState(graph, normalized, state))
    .filter(Boolean)
    .sort((a, b) => (a.matchStrength === 'STRONG' ? 0 : 1) - (b.matchStrength === 'STRONG' ? 0 : 1) || b.score - a.score || a.pathDepth - b.pathDepth || String(a.reachableStateId).localeCompare(String(b.reachableStateId)));
}

function startResolutionWork({ scanDir, scan, contextId, graph }) {
  if (!isExplorationStartEnabled(scan)) return null;
  if (!exists(startFile(scanDir, contextId))) return null;
  const start = loadExplorationStart(scanDir, contextId);
  if (start.status === 'RESOLVED') return null;
  if ((start.kind || start.spec?.kind) === 'app-root') {
    if (rootState(graph)) {
      return {
        decision: 'RESOLVE_EXPLORATION_START',
        reasonCode: 'APP_ROOT_START_PENDING',
        explorationStart: start,
        suggestedCommand: { command: 'exploration-start.js', args: ['resolve-root', '--scan-dir', scanDir, '--context', contextId] }
      };
    }
    return null;
  }
  if (start.status === 'NOT_FOUND') {
    return {
      decision: 'STOP',
      reasonCode: 'EXPLORATION_START_NOT_FOUND',
      suggestedTerminalStatus: 'PARTIAL',
      explorationStart: start
    };
  }
  return {
    decision: 'RESOLVE_EXPLORATION_START',
    reasonCode: start.status === 'CANDIDATE_REVIEW' ? 'EXPLORATION_START_CONFIRMATION_REQUIRED' : 'SPECIFIED_START_PENDING',
    explorationStart: start,
    suggestedCommand: start.status === 'CANDIDATE_REVIEW'
      ? null
      : { command: 'exploration-start.js', args: ['evaluate-known', '--scan-dir', scanDir, '--context', contextId] }
  };
}

module.exports = {
  START_SCHEMA_VERSION,
  isExplorationStartEnabled,
  normalizeStartSpec,
  initialStartProjection,
  loadExplorationStart,
  startFile,
  rootState,
  resolvedStartStateId,
  resolveAppRootStartValue,
  resolveSpecifiedStartValue,
  depthMapFromStart,
  startDepthMap,
  observedRunDepthFromStart,
  stateDepthFromStart,
  frontierNextDepthFromStart,
  filterFrontiersInStartScope,
  filterSuggestionsInStartScope,
  filterStateIdsInStartScope,
  verificationInStartScope,
  evaluateKnownStartCandidates,
  startResolutionWork
};
