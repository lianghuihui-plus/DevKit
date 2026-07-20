'use strict';

const fs = require('fs');
const path = require('path');
const {
  contextDir, ensureDir, readJson, writeJsonAtomic, appendJsonl, hashObject, now, emptyGraph,
  withFileLock, fail
} = require('./common');
const { updateCanonicalPaths } = require('./graph-store');

function appRootFromScanDir(scanDir) {
  return path.dirname(path.dirname(scanDir));
}

function mapsRoot(appRoot) {
  return path.join(appRoot, 'maps');
}

function mapContextDir(appRoot, contextId) {
  return path.join(mapsRoot(appRoot), contextId);
}

function mapGraphFile(appRoot, contextId) {
  return path.join(mapContextDir(appRoot, contextId), 'graph.json');
}

function emptyFrontier(contextId) {
  return { schemaVersion: 1, contextId, items: [] };
}

function emptyQueue(contextId) {
  return { schemaVersion: 2, contextId, items: [] };
}

function emptyBackCapabilities(contextId) {
  return { schemaVersion: 1, contextId, items: [] };
}

function emptyEquivalence(contextId) {
  return { schemaVersion: 1, contextId, rules: [] };
}

function defaultFiles(contextId) {
  return {
    graph: emptyGraph(contextId),
    frontier: emptyFrontier(contextId),
    verificationQueue: emptyQueue(contextId),
    backCapabilities: emptyBackCapabilities(contextId),
    visualEquivalence: emptyEquivalence(contextId),
    stateEquivalence: emptyEquivalence(contextId)
  };
}

function ensureCanonicalContext(appRoot, contextId) {
  const dir = mapContextDir(appRoot, contextId);
  ensureDir(dir);
  const defaults = defaultFiles(contextId);
  const files = {
    graph: 'graph.json',
    frontier: 'frontier.json',
    verificationQueue: 'verification-queue.json',
    backCapabilities: 'back-capabilities.json',
    visualEquivalence: 'visual-equivalence.json',
    stateEquivalence: 'state-equivalence.json'
  };
  for (const [key, name] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) writeJsonAtomic(file, defaults[key]);
  }
  const metaFile = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaFile)) writeJsonAtomic(metaFile, { schemaVersion: 1, contextId, mapRevisionId: null, sourceSessionIds: [], updatedAt: now() });
  return dir;
}

function loadCanonicalContext(appRoot, contextId) {
  ensureCanonicalContext(appRoot, contextId);
  const dir = mapContextDir(appRoot, contextId);
  return {
    contextId,
    dir,
    meta: readJson(path.join(dir, 'meta.json')),
    graph: readJson(path.join(dir, 'graph.json'), emptyGraph(contextId)),
    frontier: readJson(path.join(dir, 'frontier.json'), emptyFrontier(contextId)),
    verificationQueue: readJson(path.join(dir, 'verification-queue.json'), emptyQueue(contextId)),
    backCapabilities: readJson(path.join(dir, 'back-capabilities.json'), emptyBackCapabilities(contextId)),
    visualEquivalence: readJson(path.join(dir, 'visual-equivalence.json'), emptyEquivalence(contextId)),
    stateEquivalence: readJson(path.join(dir, 'state-equivalence.json'), emptyEquivalence(contextId))
  };
}

function hasCanonicalMap(appRoot, contextId) {
  const graph = readJson(mapGraphFile(appRoot, contextId), emptyGraph(contextId));
  return Boolean((graph.reachableStates || []).length || (graph.edges || []).length || (graph.visualStates || []).length);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seededVerificationQueue(queue, contextId) {
  const items = [];
  for (const item of queue.items || []) {
    if (item.status === 'SUPERSEDED') continue;
    const inherited = {
      ...clone(item),
      contextId,
      activeExecutionId: null,
      executionIds: [],
      executions: [],
      attemptCount: 0,
      evidenceRef: null,
      inheritedFromCanonicalMap: true
    };
    if (['RUNNING', 'FAILED', 'PENDING'].includes(inherited.status)) {
      inherited.status = 'PENDING';
      inherited.reasonCode = null;
      inherited.startedAt = null;
      inherited.finishedAt = null;
    } else if (inherited.status === 'COMPLETED') {
      inherited.status = 'SUCCEEDED';
    }
    items.push(inherited);
  }
  return { schemaVersion: 2, contextId, items };
}

function seededGraphForSession(graph, contextId) {
  const seeded = clone(graph);
  seeded.contextId = contextId;
  for (const visual of seeded.visualStates || []) {
    visual.evidenceObservationIds = [];
    visual.visualReviewIds = [];
    visual.inheritedFromCanonicalMap = true;
  }
  for (const edge of seeded.edges || []) {
    edge.inheritedFromCanonicalMap = true;
  }
  return seeded;
}

function maxNumericSuffix(items, pattern) {
  let max = 0;
  for (const value of items) {
    const match = String(value || '').match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function counterSeedFromCanonical(canonical) {
  const graph = canonical.graph || emptyGraph(canonical.contextId);
  const frontier = canonical.frontier || emptyFrontier(canonical.contextId);
  const queue = canonical.verificationQueue || emptyQueue(canonical.contextId);
  const back = canonical.backCapabilities || emptyBackCapabilities(canonical.contextId);
  return {
    edge: maxNumericSuffix((graph.edges || []).map(item => item.id), /^edge-(\d+)$/),
    frontier: maxNumericSuffix((frontier.items || []).map(item => item.id), /^frontier-(\d+)$/),
    verification: Math.max(
      maxNumericSuffix((queue.items || []).map(item => item.verificationId), /^verify-(\d+)$/),
      0
    ),
    backCapability: maxNumericSuffix((back.items || []).map(item => item.backCapabilityId || item.id), /^backcap-(\d+)$/)
  };
}

function seedFilesForContext(appRoot, contextId) {
  const canonical = loadCanonicalContext(appRoot, contextId);
  return {
    hasMap: hasCanonicalMap(appRoot, contextId),
    mapRevisionId: canonical.meta.mapRevisionId || null,
    graph: seededGraphForSession(canonical.graph, contextId),
    frontier: clone(canonical.frontier),
    verificationQueue: seededVerificationQueue(canonical.verificationQueue, contextId),
    backCapabilities: clone(canonical.backCapabilities),
    visualEquivalence: clone(canonical.visualEquivalence),
    stateEquivalence: clone(canonical.stateEquivalence),
    counters: counterSeedFromCanonical(canonical)
  };
}

function addEvidenceRefs(graph, sessionId) {
  for (const visual of graph.visualStates || []) {
    visual.evidenceObservationRefs ||= [];
    for (const observationId of visual.evidenceObservationIds || []) {
      if (!visual.evidenceObservationRefs.some(ref => ref.runId === sessionId && ref.observationId === observationId)) {
        visual.evidenceObservationRefs.push({ runId: sessionId, observationId });
      }
    }
    visual.provenance ||= [];
    if (!visual.provenance.some(item => item.runId === sessionId && item.sourceId === visual.id)) {
      visual.provenance.push({ runId: sessionId, sourceId: visual.id, evidencePath: `runs/${sessionId}/contexts/${graph.contextId}/graph.json` });
    }
  }
  for (const edge of graph.edges || []) {
    edge.evidence ||= {};
    edge.evidence.sourceRunId ||= sessionId;
    edge.provenance ||= [];
    if (!edge.provenance.some(item => item.runId === sessionId && item.sourceId === edge.id)) {
      edge.provenance.push({ runId: sessionId, sourceId: edge.id, evidencePath: `runs/${sessionId}/contexts/${graph.contextId}/graph.json` });
    }
    if (edge.verification) edge.verification.sourceRunId ||= sessionId;
  }
  for (const logical of graph.logicalScreens || []) {
    logical.evidenceRunIds ||= [];
    if (!logical.evidenceRunIds.includes(sessionId)) logical.evidenceRunIds.push(sessionId);
    logical.provenance ||= [];
    if (!logical.provenance.some(item => item.runId === sessionId && item.sourceId === logical.id)) {
      logical.provenance.push({ runId: sessionId, sourceId: logical.id, evidencePath: `runs/${sessionId}/contexts/${graph.contextId}/graph.json` });
    }
  }
}

function recomputeDepths(graph) {
  const states = new Map((graph.reachableStates || []).map(state => [state.id, state]));
  const roots = (graph.reachableStates || []).filter(state => Number(state.depth?.pathDepth || 0) === 0);
  for (const state of graph.reachableStates || []) {
    state.depth ||= {};
    if (!roots.includes(state)) {
      state.depth.pathDepth = Number.POSITIVE_INFINITY;
      state.depth.routeDepth = Number.POSITIVE_INFINITY;
    } else {
      state.depth.pathDepth = 0;
      state.depth.routeDepth = 0;
      state.depth.modalDepth = Number(state.depth.modalDepth || 0);
      state.replayPathEdgeIds = [];
    }
  }
  const queue = roots.map(state => state.id);
  while (queue.length) {
    const fromId = queue.shift();
    const from = states.get(fromId);
    for (const edge of (graph.edges || []).filter(item => item.fromReachableStateId === fromId)) {
      const to = states.get(edge.toReachableStateId);
      if (!to) continue;
      const nextPath = Number(from.depth.pathDepth || 0) + 1;
      const nextRoute = Number(from.depth.routeDepth || 0) + (edge.action?.routeTransition === true ? 1 : 0);
      const currentPath = Number.isFinite(to.depth.pathDepth) ? to.depth.pathDepth : Number.POSITIVE_INFINITY;
      const currentRoute = Number.isFinite(to.depth.routeDepth) ? to.depth.routeDepth : Number.POSITIVE_INFINITY;
      if (nextPath < currentPath || nextPath === currentPath && nextRoute < currentRoute) {
        to.depth.pathDepth = nextPath;
        to.depth.routeDepth = nextRoute;
        to.depth.modalDepth = Number(to.depth.modalDepth || 0);
        to.replayPathEdgeIds = [...(from.replayPathEdgeIds || []), edge.id];
        queue.push(to.id);
      }
    }
  }
  for (const state of graph.reachableStates || []) {
    if (!Number.isFinite(state.depth.pathDepth)) state.depth.pathDepth = 9999;
    if (!Number.isFinite(state.depth.routeDepth)) state.depth.routeDepth = state.depth.pathDepth;
  }
  updateCanonicalPaths(graph);
  return graph;
}

function syncCanonicalFromRun(scanDir, contextId, { force = false } = {}) {
  const appRoot = appRootFromScanDir(scanDir);
  const scan = readJson(path.join(scanDir, 'scan.json'));
  const lock = path.join(mapsRoot(appRoot), '.canonical-map.lock');
  ensureDir(mapsRoot(appRoot));
  return withFileLock(lock, () => {
    ensureCanonicalContext(appRoot, contextId);
    const canonical = loadCanonicalContext(appRoot, contextId);
    const hasMap = hasCanonicalMap(appRoot, contextId);
    const baseRevision = scan.mapBaseRevisionId || null;
    if (hasMap && canonical.meta.mapRevisionId !== baseRevision && !force) {
      return { synced: false, reasonCode: 'MAP_BASE_REVISION_MISMATCH', expectedMapRevisionId: canonical.meta.mapRevisionId, sessionBaseRevisionId: baseRevision };
    }
    const graph = clone(readJson(path.join(contextDir(scanDir, contextId), 'graph.json'), emptyGraph(contextId)));
    graph.contextId = contextId;
    addEvidenceRefs(graph, scan.scanId);
    recomputeDepths(graph);
    const dir = mapContextDir(appRoot, contextId);
    const revision = `maprev-${hashObject({ contextId, previous: canonical.meta.mapRevisionId || null, sessionId: scan.scanId, graph }).slice(-16)}`;
    const sourceSessionIds = [...new Set([...(canonical.meta.sourceSessionIds || []), scan.scanId])];
    const meta = { schemaVersion: 1, contextId, mapRevisionId: revision, previousMapRevisionId: canonical.meta.mapRevisionId || null, sourceSessionIds, updatedBySessionId: scan.scanId, updatedAt: now() };
    writeJsonAtomic(path.join(dir, 'graph.json'), graph);
    for (const [source, target] of [
      ['frontier.json', 'frontier.json'],
      ['verification-queue.json', 'verification-queue.json'],
      ['back-capabilities.json', 'back-capabilities.json'],
      ['visual-equivalence.json', 'visual-equivalence.json'],
      ['state-equivalence.json', 'state-equivalence.json']
    ]) {
      const fallback = source === 'frontier.json' ? emptyFrontier(contextId) : source === 'verification-queue.json' ? emptyQueue(contextId) : source === 'back-capabilities.json' ? emptyBackCapabilities(contextId) : emptyEquivalence(contextId);
      writeJsonAtomic(path.join(dir, target), readJson(path.join(contextDir(scanDir, contextId), source), fallback));
    }
    writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    appendJsonl(path.join(dir, 'map-events.jsonl'), { schemaVersion: 1, type: 'canonicalMapSyncedFromSession', at: meta.updatedAt, contextId, sessionId: scan.scanId, mapRevisionId: revision, previousMapRevisionId: meta.previousMapRevisionId });
    return { synced: true, contextId, mapRevisionId: revision, previousMapRevisionId: meta.previousMapRevisionId, graph };
  });
}

function canonicalContexts(appRoot) {
  const root = mapsRoot(appRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).filter(name => ['guest', 'authenticated'].includes(name)).sort();
}

module.exports = {
  appRootFromScanDir,
  mapsRoot,
  mapContextDir,
  ensureCanonicalContext,
  loadCanonicalContext,
  hasCanonicalMap,
  seedFilesForContext,
  syncCanonicalFromRun,
  canonicalContexts,
  recomputeDepths
};
