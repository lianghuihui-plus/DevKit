'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureDir, readJson, writeJsonAtomic, appendJsonl, hashObject, now, compactLocalTimestamp,
  emptyGraph, fail, safeSegment
} = require('./common');
const {
  mapsRoot, mapContextDir, ensureCanonicalContext, loadCanonicalContext, recomputeDepths
} = require('./canonical-map-store');
const { actionKey } = require('./graph-store');

const CONTEXTS = new Set(['guest', 'authenticated']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertContext(contextId) {
  if (!CONTEXTS.has(contextId)) fail('contextId must be guest or authenticated', 'CONTEXT_INVALID');
  return contextId;
}

function editsDir(appRoot, contextId) {
  return path.join(mapContextDir(appRoot, contextId), 'edits');
}

function editFile(appRoot, contextId, editId, suffix = 'preview') {
  return path.join(editsDir(appRoot, contextId), `${editId}.${suffix}.json`);
}

function canonicalRootIds(graph) {
  return new Set((graph.reachableStates || []).filter(state => Number(state.depth?.pathDepth || 0) === 0).map(state => state.id));
}

function reachableAfter(graph, removedEdgeIds = new Set(), removedStateIds = new Set()) {
  const states = new Set((graph.reachableStates || []).map(state => state.id).filter(id => !removedStateIds.has(id)));
  const roots = (graph.reachableStates || []).filter(state => states.has(state.id) && Number(state.depth?.pathDepth || 0) === 0).map(state => state.id);
  const visited = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const from = queue.shift();
    for (const edge of graph.edges || []) {
      if (removedEdgeIds.has(edge.id) || edge.fromReachableStateId !== from || !states.has(edge.toReachableStateId)) continue;
      if (!visited.has(edge.toReachableStateId)) {
        visited.add(edge.toReachableStateId);
        queue.push(edge.toReachableStateId);
      }
    }
  }
  return visited;
}

function compactGraph(graph, deletedStateIds, deletedEdgeIds) {
  const next = clone(graph);
  next.reachableStates = (next.reachableStates || []).filter(state => !deletedStateIds.has(state.id));
  next.edges = (next.edges || []).filter(edge => !deletedEdgeIds.has(edge.id) && !deletedStateIds.has(edge.fromReachableStateId) && !deletedStateIds.has(edge.toReachableStateId));
  const stateIds = new Set(next.reachableStates.map(state => state.id));
  for (const state of next.reachableStates) {
    state.incomingEdgeIds = next.edges.filter(edge => edge.toReachableStateId === state.id).map(edge => edge.id);
    state.replayPathEdgeIds = (state.replayPathEdgeIds || []).filter(edgeId => next.edges.some(edge => edge.id === edgeId));
    if (state.arrivalSignature?.expectedBackReachableStateId && !stateIds.has(state.arrivalSignature.expectedBackReachableStateId)) state.arrivalSignature.expectedBackReachableStateId = null;
  }
  const usedVisualIds = new Set(next.reachableStates.map(state => state.visualStateId));
  const deletedVisualIds = new Set((next.visualStates || []).filter(visual => !usedVisualIds.has(visual.id)).map(visual => visual.id));
  next.visualStates = (next.visualStates || []).filter(visual => usedVisualIds.has(visual.id));
  const usedLogicalIds = new Set(next.visualStates.map(visual => visual.logicalScreenKey));
  const deletedLogicalIds = new Set((next.logicalScreens || []).filter(logical => !usedLogicalIds.has(logical.id)).map(logical => logical.id));
  next.logicalScreens = (next.logicalScreens || []).filter(logical => usedLogicalIds.has(logical.id));
  for (const logical of next.logicalScreens) {
    logical.visualStateIds = next.visualStates.filter(visual => visual.logicalScreenKey === logical.id).map(visual => visual.id);
  }
  recomputeDepths(next);
  return { graph: next, deletedVisualIds, deletedLogicalIds };
}

function edgeActionIdentity(edge) {
  if (!edge.fromReachableStateId || !edge.action) return null;
  return `${edge.fromReachableStateId}::${actionKey(edge.action)}`;
}

function frontierActionIdentity(item) {
  if (!item.fromReachableStateId || !item.candidate) return null;
  return `${item.fromReachableStateId}::${actionKey(item.candidate)}`;
}

function frontierRemoved(item, deletedStateIds, deletedEdgeIds, deletedAttemptIds, deletedActionIdentities) {
  if (deletedStateIds.has(item.fromReachableStateId)) return true;
  if (item.attemptId && deletedAttemptIds.has(item.attemptId)) return true;
  if (item.edgeId && deletedEdgeIds.has(item.edgeId)) return true;
  const identity = frontierActionIdentity(item);
  if (identity && deletedActionIdentities.has(identity)) return true;
  return false;
}

function cleanFrontier(frontier, deletedStateIds, deletedEdgeIds, deletedAttemptIds, deletedActionIdentities) {
  const removed = [];
  const items = [];
  for (const item of frontier.items || []) {
    if (frontierRemoved(item, deletedStateIds, deletedEdgeIds, deletedAttemptIds, deletedActionIdentities)) removed.push(item);
    else items.push(item);
  }
  return { frontier: { ...frontier, items }, removed };
}

function cleanQueue(queue, deletedStateIds, deletedEdgeIds) {
  const superseded = [];
  const items = (queue.items || []).map(item => {
    const affected = deletedStateIds.has(item.terminalReachableStateId) || (item.edgeIds || []).some(edgeId => deletedEdgeIds.has(edgeId));
    if (!affected || item.status === 'SUPERSEDED') return item;
    const next = { ...item, status: 'SUPERSEDED', supersededAt: now(), supersededByEdit: true, activeExecutionId: null };
    superseded.push(next);
    return next;
  });
  return { queue: { ...queue, schemaVersion: 2, items }, superseded };
}

function cleanBackCapabilities(backCapabilities, deletedStateIds) {
  const removed = [];
  const items = [];
  for (const item of backCapabilities.items || []) {
    if (deletedStateIds.has(item.fromReachableStateId) || deletedStateIds.has(item.toReachableStateId)) removed.push(item);
    else items.push(item);
  }
  return { backCapabilities: { ...backCapabilities, items }, removed };
}

function cleanEquivalence(equivalence, deletedStateIds, deletedVisualIds, deletedLogicalIds) {
  const removed = [];
  const rules = [];
  for (const rule of equivalence.rules || []) {
    if (deletedStateIds.has(rule.reachableStateId) || deletedVisualIds.has(rule.visualStateId) || deletedLogicalIds.has(rule.logicalScreenKey)) removed.push(rule);
    else rules.push(rule);
  }
  return { equivalence: { ...equivalence, rules }, removed };
}

function entityLabels(graph, stateIds, edgeIds) {
  const visualById = new Map((graph.visualStates || []).map(visual => [visual.id, visual]));
  const logicalById = new Map((graph.logicalScreens || []).map(logical => [logical.id, logical]));
  const stateLabels = [...stateIds].map(id => {
    const state = (graph.reachableStates || []).find(item => item.id === id);
    const visual = state && visualById.get(state.visualStateId);
    const logical = visual && logicalById.get(visual.logicalScreenKey);
    return { id, name: logical?.name || visual?.name || id, logicalScreenKey: visual?.logicalScreenKey || null };
  });
  const edgeLabels = [...edgeIds].map(id => {
    const edge = (graph.edges || []).find(item => item.id === id);
    return { id, action: edge?.action || null, fromReachableStateId: edge?.fromReachableStateId || null, toReachableStateId: edge?.toReachableStateId || null };
  });
  return { states: stateLabels, edges: edgeLabels };
}

function deletionSetsForTarget(graph, target) {
  const roots = canonicalRootIds(graph);
  let deletedStateIds = new Set();
  let deletedEdgeIds = new Set();
  if (target.edgeId) {
    const edge = (graph.edges || []).find(item => item.id === target.edgeId);
    if (!edge) fail(`Edge not found: ${target.edgeId}`, 'MAP_EDIT_TARGET_NOT_FOUND');
    deletedEdgeIds.add(edge.id);
    const reachable = reachableAfter(graph, deletedEdgeIds, deletedStateIds);
    deletedStateIds = new Set((graph.reachableStates || []).map(state => state.id).filter(id => !reachable.has(id)));
  } else if (target.reachableStateId) {
    const state = (graph.reachableStates || []).find(item => item.id === target.reachableStateId);
    if (!state) fail(`ReachableState not found: ${target.reachableStateId}`, 'MAP_EDIT_TARGET_NOT_FOUND');
    if (roots.has(state.id)) fail('Root ReachableState cannot be deleted; use reset-context', 'MAP_EDIT_ROOT_DELETE_REQUIRES_RESET');
    const initiallyRemoved = new Set([state.id]);
    const incidentEdges = new Set((graph.edges || []).filter(edge => initiallyRemoved.has(edge.fromReachableStateId) || initiallyRemoved.has(edge.toReachableStateId)).map(edge => edge.id));
    const reachable = reachableAfter(graph, incidentEdges, initiallyRemoved);
    deletedStateIds = new Set((graph.reachableStates || []).map(item => item.id).filter(id => initiallyRemoved.has(id) || !reachable.has(id)));
    deletedEdgeIds = new Set((graph.edges || []).filter(edge => incidentEdges.has(edge.id) || deletedStateIds.has(edge.fromReachableStateId) || deletedStateIds.has(edge.toReachableStateId)).map(edge => edge.id));
  } else {
    fail('Delete target requires edgeId or reachableStateId', 'MAP_EDIT_TARGET_REQUIRED');
  }
  return { deletedStateIds, deletedEdgeIds };
}

function buildDeletePlan({ appRoot, contextId, target, reason = null, editId = null }) {
  assertContext(contextId);
  const canonical = loadCanonicalContext(appRoot, contextId);
  const beforeMapRevisionId = canonical.meta.mapRevisionId || null;
  const { deletedStateIds, deletedEdgeIds } = deletionSetsForTarget(canonical.graph, target);
  const deletedEdges = (canonical.graph.edges || []).filter(edge => deletedEdgeIds.has(edge.id));
  const deletedAttemptIds = new Set(deletedEdges.map(edge => edge.attemptId).filter(Boolean));
  const deletedActionIdentities = new Set(deletedEdges.map(edgeActionIdentity).filter(Boolean));
  const compacted = compactGraph(canonical.graph, deletedStateIds, deletedEdgeIds);
  const frontier = cleanFrontier(canonical.frontier, deletedStateIds, deletedEdgeIds, deletedAttemptIds, deletedActionIdentities);
  const queue = cleanQueue(canonical.verificationQueue, deletedStateIds, deletedEdgeIds);
  const back = cleanBackCapabilities(canonical.backCapabilities, deletedStateIds);
  const visualEq = cleanEquivalence(canonical.visualEquivalence, deletedStateIds, compacted.deletedVisualIds, compacted.deletedLogicalIds);
  const stateEq = cleanEquivalence(canonical.stateEquivalence, deletedStateIds, compacted.deletedVisualIds, compacted.deletedLogicalIds);
  const operation = target.edgeId ? 'DELETE_EDGE' : 'DELETE_REACHABLE_STATE';
  const id = editId || `edit-${compactLocalTimestamp(new Date(), { milliseconds: true })}-${hashObject({ contextId, operation, target, beforeMapRevisionId }).slice(-8)}`;
  const labels = entityLabels(canonical.graph, deletedStateIds, deletedEdgeIds);
  const impact = {
    reachableStateIds: [...deletedStateIds].sort(),
    visualStateIds: [...compacted.deletedVisualIds].sort(),
    logicalScreenIds: [...compacted.deletedLogicalIds].sort(),
    edgeIds: [...deletedEdgeIds].sort(),
    frontierIds: frontier.removed.map(item => item.id).filter(Boolean).sort(),
    verificationIds: queue.superseded.map(item => item.verificationId).filter(Boolean).sort(),
    backCapabilityIds: back.removed.map(item => item.backCapabilityId || item.id).filter(Boolean).sort(),
    visualEquivalenceRuleIds: visualEq.removed.map(item => item.ruleId).filter(Boolean).sort(),
    stateEquivalenceRuleIds: stateEq.removed.map(item => item.ruleId).filter(Boolean).sort(),
    labels
  };
  const planBase = { schemaVersion: 1, editId: id, operation, contextId, target, reason, beforeMapRevisionId, impact };
  const confirmHash = hashObject(planBase);
  return {
    ...planBase,
    confirmHash,
    createdAt: now(),
    status: 'PREVIEWED',
    artifacts: {
      graph: compacted.graph,
      frontier: frontier.frontier,
      verificationQueue: queue.queue,
      backCapabilities: back.backCapabilities,
      visualEquivalence: visualEq.equivalence,
      stateEquivalence: stateEq.equivalence
    }
  };
}

function buildResetPlan({ appRoot, contextId, reason = null, editId = null }) {
  assertContext(contextId);
  const canonical = loadCanonicalContext(appRoot, contextId);
  const beforeMapRevisionId = canonical.meta.mapRevisionId || null;
  const target = { contextId };
  const operation = 'RESET_CONTEXT';
  const id = editId || `edit-${compactLocalTimestamp(new Date(), { milliseconds: true })}-${hashObject({ contextId, operation, beforeMapRevisionId }).slice(-8)}`;
  const allStateIds = new Set((canonical.graph.reachableStates || []).map(item => item.id));
  const allEdgeIds = new Set((canonical.graph.edges || []).map(item => item.id));
  const labels = entityLabels(canonical.graph, allStateIds, allEdgeIds);
  const impact = {
    reachableStateIds: [...allStateIds].sort(),
    visualStateIds: (canonical.graph.visualStates || []).map(item => item.id).sort(),
    logicalScreenIds: (canonical.graph.logicalScreens || []).map(item => item.id).sort(),
    edgeIds: [...allEdgeIds].sort(),
    frontierIds: (canonical.frontier.items || []).map(item => item.id).filter(Boolean).sort(),
    verificationIds: (canonical.verificationQueue.items || []).map(item => item.verificationId).filter(Boolean).sort(),
    backCapabilityIds: (canonical.backCapabilities.items || []).map(item => item.backCapabilityId || item.id).filter(Boolean).sort(),
    visualEquivalenceRuleIds: (canonical.visualEquivalence.rules || []).map(item => item.ruleId).filter(Boolean).sort(),
    stateEquivalenceRuleIds: (canonical.stateEquivalence.rules || []).map(item => item.ruleId).filter(Boolean).sort(),
    labels
  };
  const planBase = { schemaVersion: 1, editId: id, operation, contextId, target, reason, beforeMapRevisionId, impact };
  const confirmHash = hashObject(planBase);
  return {
    ...planBase,
    confirmHash,
    createdAt: now(),
    status: 'PREVIEWED',
    artifacts: {
      graph: emptyGraph(contextId),
      frontier: { schemaVersion: 1, contextId, items: [] },
      verificationQueue: { schemaVersion: 2, contextId, items: [] },
      backCapabilities: { schemaVersion: 1, contextId, items: [] },
      visualEquivalence: { schemaVersion: 1, contextId, rules: [] },
      stateEquivalence: { schemaVersion: 1, contextId, rules: [] }
    }
  };
}

function previewEdit(appRoot, plan) {
  ensureCanonicalContext(appRoot, plan.contextId);
  ensureDir(editsDir(appRoot, plan.contextId));
  const { artifacts: ignored, ...preview } = plan;
  void ignored;
  writeJsonAtomic(editFile(appRoot, plan.contextId, plan.editId, 'preview'), preview);
  return preview;
}

function locatePreview(appRoot, editId) {
  const id = safeSegment(editId, 'editId');
  for (const contextId of CONTEXTS) {
    const file = editFile(appRoot, contextId, id, 'preview');
    if (fs.existsSync(file)) return { contextId, file, preview: readJson(file) };
  }
  fail(`Edit preview not found: ${editId}`, 'MAP_EDIT_NOT_FOUND');
}

function rebuildPlanFromPreview(appRoot, preview) {
  if (preview.operation === 'DELETE_EDGE' || preview.operation === 'DELETE_REACHABLE_STATE') {
    return buildDeletePlan({ appRoot, contextId: preview.contextId, target: preview.target, reason: preview.reason || null, editId: preview.editId });
  }
  if (preview.operation === 'RESET_CONTEXT') {
    return buildResetPlan({ appRoot, contextId: preview.contextId, reason: preview.reason || null, editId: preview.editId });
  }
  fail(`Unsupported map edit operation: ${preview.operation}`, 'MAP_EDIT_OPERATION_INVALID');
}

function writeArtifacts(appRoot, plan, canonical) {
  const dir = mapContextDir(appRoot, plan.contextId);
  const revision = `maprev-${hashObject({ contextId: plan.contextId, previous: canonical.meta.mapRevisionId || null, editId: plan.editId, operation: plan.operation, graph: plan.artifacts.graph }).slice(-16)}`;
  const updatedAt = now();
  const meta = {
    ...canonical.meta,
    schemaVersion: 1,
    contextId: plan.contextId,
    mapRevisionId: revision,
    previousMapRevisionId: canonical.meta.mapRevisionId || null,
    updatedByEditId: plan.editId,
    updatedAt
  };
  writeJsonAtomic(path.join(dir, 'graph.json'), plan.artifacts.graph);
  writeJsonAtomic(path.join(dir, 'frontier.json'), plan.artifacts.frontier);
  writeJsonAtomic(path.join(dir, 'verification-queue.json'), plan.artifacts.verificationQueue);
  writeJsonAtomic(path.join(dir, 'back-capabilities.json'), plan.artifacts.backCapabilities);
  writeJsonAtomic(path.join(dir, 'visual-equivalence.json'), plan.artifacts.visualEquivalence);
  writeJsonAtomic(path.join(dir, 'state-equivalence.json'), plan.artifacts.stateEquivalence);
  writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  const applied = { ...plan, status: 'APPLIED', appliedAt: updatedAt, mapRevisionId: revision, previousMapRevisionId: meta.previousMapRevisionId };
  const { artifacts: ignored, ...appliedRecord } = applied;
  void ignored;
  writeJsonAtomic(editFile(appRoot, plan.contextId, plan.editId, 'applied'), appliedRecord);
  appendJsonl(path.join(dir, 'map-events.jsonl'), { schemaVersion: 1, type: 'canonicalMapEdited', at: updatedAt, contextId: plan.contextId, editId: plan.editId, operation: plan.operation, previousMapRevisionId: meta.previousMapRevisionId, mapRevisionId: revision, impact: plan.impact });
  return { applied: appliedRecord, meta };
}

function applyPreview(appRoot, { editId, confirmHash }) {
  const located = locatePreview(appRoot, editId);
  const preview = located.preview;
  if (preview.confirmHash !== confirmHash) fail('Confirm hash does not match the previewed map edit', 'MAP_EDIT_CONFIRM_HASH_MISMATCH');
  const canonical = loadCanonicalContext(appRoot, preview.contextId);
  if ((canonical.meta.mapRevisionId || null) !== (preview.beforeMapRevisionId || null)) {
    fail('Canonical map changed after preview; rerun preview-delete', 'MAP_EDIT_REVISION_MISMATCH', 2, { expectedMapRevisionId: preview.beforeMapRevisionId || null, actualMapRevisionId: canonical.meta.mapRevisionId || null });
  }
  const plan = rebuildPlanFromPreview(appRoot, preview);
  if (plan.confirmHash !== confirmHash) fail('Recomputed edit plan differs from preview', 'MAP_EDIT_PLAN_CHANGED');
  return writeArtifacts(appRoot, plan, canonical);
}

module.exports = {
  buildDeletePlan,
  buildResetPlan,
  previewEdit,
  applyPreview,
  locatePreview
};
