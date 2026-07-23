'use strict';

const path = require('path');
const { emptyGraph, readJson } = require('./common');
const { mapContextDir, validateCanonicalSeed } = require('./canonical-map-store');

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

function readCanonicalPlanSeed({ appRoot, contextId }) {
  const dir = mapContextDir(appRoot, contextId);
  const seed = {
    hasMap: false,
    mapRevisionId: null,
    graph: readJson(path.join(dir, 'graph.json'), emptyGraph(contextId)),
    frontier: readJson(path.join(dir, 'frontier.json'), emptyFrontier(contextId)),
    verificationQueue: readJson(path.join(dir, 'verification-queue.json'), emptyQueue(contextId)),
    backCapabilities: readJson(path.join(dir, 'back-capabilities.json'), emptyBackCapabilities(contextId)),
    visualEquivalence: readJson(path.join(dir, 'visual-equivalence.json'), emptyEquivalence(contextId)),
    stateEquivalence: readJson(path.join(dir, 'state-equivalence.json'), emptyEquivalence(contextId)),
    meta: readJson(path.join(dir, 'meta.json'), { schemaVersion: 1, contextId, mapRevisionId: null, sourceSessionIds: [] })
  };
  seed.hasMap = Boolean((seed.graph.reachableStates || []).length || (seed.graph.edges || []).length || (seed.graph.visualStates || []).length);
  seed.mapRevisionId = seed.meta.mapRevisionId || null;
  validateCanonicalSeed({ contextId, ...seed });
  return seed;
}

function budgetBaselineFromSeed(contextId, seed = {}) {
  const graph = seed.graph || {};
  return {
    schemaVersion: 1,
    contextId,
    source: 'CANONICAL_SEED',
    mapBaseRevisionId: seed.mapRevisionId || null,
    baselineReachableStates: (graph.reachableStates || []).length,
    baselineVisualStates: (graph.visualStates || []).length,
    baselineEdges: (graph.edges || []).length
  };
}

function loadCanonicalPlanBaseline({ appRoot, contextId }) {
  const seed = readCanonicalPlanSeed({ appRoot, contextId });
  return {
    seed,
    budgetBaseline: budgetBaselineFromSeed(contextId, seed)
  };
}

module.exports = {
  budgetBaselineFromSeed,
  readCanonicalPlanSeed,
  loadCanonicalPlanBaseline
};
