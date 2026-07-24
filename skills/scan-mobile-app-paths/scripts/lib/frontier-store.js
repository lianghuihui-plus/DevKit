'use strict';

const { assessAction } = require('./safety');
const { validateGraphCandidate } = require('./schema');
const { runBudget, maxDepth, maxTotalCandidatesPerState, maxScrollsPerState } = require('./run-protocol');
const { hashObject, nextId, now } = require('./common');

function makeFrontierItem({ scanDir, scan, contextId, graph, frontier, fromReachableStateId, candidate, candidateGroupKey = null, priority = {}, sourceFrontierId = null }) {
  const from = fromReachableStateId;
  if (!graph.reachableStates.some(x => x.id === from)) return { ok: false, reasonCode: 'GRAPH_REFERENCE_MISSING' };
  const validated = validateGraphCandidate(candidate);
  const safety = assessAction(validated, scan.target);
  if (!safety.allowed) return { ok: false, reasonCode: safety.reasonCode, safety, blocked: true };
  const group = candidateGroupKey || hashObject(validated);
  const duplicate = frontier.items.find(x => x.fromReachableStateId === from && x.candidateGroupKey === group);
  if (duplicate) return { ok: true, created: false, item: duplicate, reasonCode: 'DUPLICATE_FRONTIER' };
  const fromState = graph.reachableStates.find(x => x.id === from);
  const fromItems = frontier.items.filter(x => x.fromReachableStateId === from);
  const budget = runBudget(scan, contextId);
  if (fromItems.length >= maxTotalCandidatesPerState(budget)) return { ok: false, created: false, reasonCode: 'MAX_TOTAL_CANDIDATES_PER_STATE' };
  if ((fromState.depth?.pathDepth || 0) + 1 > maxDepth(budget)) return { ok: false, created: false, reasonCode: 'MAX_DEPTH' };
  const routeIncrement = validated.routeTransition === true || ['navigate', 'openRoute'].includes(validated.type) ? 1 : 0;
  if (validated.type === 'swipe') {
    const scrollGroups = new Set(fromItems.filter(x => x.candidate?.type === 'swipe').map(x => x.candidateGroupKey));
    if (!scrollGroups.has(group) && scrollGroups.size >= maxScrollsPerState(budget)) return { ok: false, created: false, reasonCode: 'MAX_SCROLLS_PER_STATE' };
  }
  const riskRank = safety.risk === 'SAFE' ? 0 : safety.risk === 'LOW_RISK_FORM' ? 1 : 2;
  const defaultPriority = {
    strategy: scan.strategy,
    riskRank,
    nextPathDepth: (fromState.depth?.pathDepth || 0) + 1,
    nextRouteDepth: (fromState.depth?.routeDepth || 0) + routeIncrement,
    entryRank: 0,
    selectorRank: 0,
    restoreCost: (fromState.runnablePathEdgeIds || fromState.replayPathEdgeIds || []).length,
    goalRelevance: null
  };
  const item = {
    id: nextId(scanDir, 'frontier', 'frontier'),
    contextId,
    fromReachableStateId: from,
    candidateGroupKey: group,
    candidate: validated,
    priority: { ...defaultPriority, ...priority, riskRank },
    status: 'PENDING',
    attempts: 0,
    sourceFrontierId,
    createdAt: now()
  };
  return { ok: true, created: true, item, safety };
}

function frontierUpsertOp(contextId, item) {
  return {
    path: `contexts/${contextId}/frontier.json`,
    op: 'UPSERT',
    collection: 'items',
    keyFields: ['id'],
    value: item,
    fallback: { schemaVersion: 1, contextId, items: [] }
  };
}

module.exports = { makeFrontierItem, frontierUpsertOp };
