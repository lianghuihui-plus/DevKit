'use strict';

const path = require('path');
const { fail, loadScan, readJson, safeSegment, versionKey } = require('./common');
const { normalizeGraphForConsumption } = require('./graph-normalization');
const { runContextIds } = require('./run-protocol');

function buildContinuationPlan({ root, parentScanId, scanMode, contextId, target, validateParent = false }) {
  if (!parentScanId) return { parent: null, parentDir: null, normalizedParentGraphs: {}, continuationPlan: null };
  const safeParentScanId = safeSegment(parentScanId, 'parentScanId');
  const parentDir = path.join(root, 'runs', safeParentScanId);
  const parent = loadScan(parentDir);
  if (parent.status !== 'PARTIAL') fail('Continuation parent must be a finalized PARTIAL Run', 'PARENT_RUN_INVALID');
  if (validateParent) require('../validate-run').validate(parentDir, 'PARTIAL');
  const parentContexts = runContextIds(parent);
  if (parent.scanMode !== scanMode || parentContexts.length !== 1 || parentContexts[0] !== contextId) fail('Continuation parent must have the same scanMode and single contextId', 'PARENT_RUN_INVALID');
  const parentTarget = readJson(path.join(parentDir, 'target.json'));
  if (parentTarget.bundleName !== target.bundleName || parentTarget.environment !== target.environment) fail('Parent Run App identity differs', 'PARENT_RUN_INVALID');
  if (versionKey(parentTarget) !== versionKey(target)) fail('Continuation parent must have the same versionKey', 'PARENT_VERSION_MISMATCH');

  const importedFrontiers = [];
  const skippedImportedFrontiers = [];
  const normalizedParentGraphs = {};
  const sourceGraph = readJson(path.join(parentDir, 'contexts', contextId, 'graph.json'), { schemaVersion: 1, contextId, logicalScreens: [], visualStates: [], reachableStates: [], edges: [], paths: [] });
  const normalized = normalizeGraphForConsumption(sourceGraph, { runId: safeParentScanId, contextId });
  normalizedParentGraphs[contextId] = normalized.graph;
  const retainedStateIds = new Set(normalized.graph.reachableStates.map(state => state.id));
  const parentFrontier = readJson(path.join(parentDir, 'contexts', contextId, 'frontier.json'), { items: [] });
  for (const item of parentFrontier.items.filter(entry => ['PENDING', 'RETRYABLE'].includes(entry.status))) {
    const reasonCode = item.candidate?.type === 'wait' ? 'NON_GRAPH_ACTION' : !retainedStateIds.has(item.fromReachableStateId) ? 'SOURCE_STATE_PRUNED' : null;
    if (reasonCode) skippedImportedFrontiers.push({ contextId, sourceFrontierId: item.id, sourceReachableStateId: item.fromReachableStateId, reasonCode });
    else importedFrontiers.push({ contextId, sourceFrontierId: item.id, sourceReachableStateId: item.fromReachableStateId, candidateGroupKey: item.candidateGroupKey, candidate: item.candidate, priority: item.priority, status: 'AWAITING_REBIND' });
  }
  return { parent, parentDir, normalizedParentGraphs, continuationPlan: { parentScanId: parent.scanId, importedFrontiers, skippedImportedFrontiers } };
}

module.exports = { buildContinuationPlan };
