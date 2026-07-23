'use strict';

const { planNavigation } = require('./navigation-planner');
const { loadDependencyBlocking } = require('./dependency-blocking');
const { MAX_VERIFICATION_ATTEMPTS } = require('./verification-store');

function compareTuple(left, right) { for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1; return 0; }

function schedule({ scanDir, scan, contextId, graph, frontier }) {
  const dependencyBlocking = loadDependencyBlocking(scanDir, contextId, graph, MAX_VERIFICATION_ATTEMPTS);
  const pending = frontier.items.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status) && !dependencyBlocking.isFrontierBlocked(item)); if (!pending.length) return { decision: 'STOP', reasonCode: dependencyBlocking.blockedEdgeIds.length ? 'FRONTIER_BLOCKED_BY_FAILED_DEPENDENCIES' : 'FRONTIER_EMPTY', dependencyBlocking };
  const depths = pending.map(item => Number(item.priority?.nextPathDepth ?? 999)); const minDepth = Math.min(...depths); const slack = scan.scanMode === 'goal-directed' ? Number.MAX_SAFE_INTEGER : Number(scan.budget?.depthSlack || 0);
  const ranked = pending.filter(item => Number(item.priority?.nextPathDepth ?? 999) <= minDepth + slack).map(item => {
    const navigationPlan = planNavigation({ scanDir, scan, contextId, graph, targetReachableStateId: item.fromReachableStateId }); const p = item.priority || {};
    const tuple = [p.riskRank ?? 9, scan.scanMode === 'goal-directed' ? -(p.goalRelevance ?? -1) : 0, navigationPlan.mode === 'LIVE_CURSOR' ? 0 : 1, navigationPlan.estimatedActions, p.nextPathDepth ?? 999, -(p.unvisitedDescendantPotential ?? 0), item.attempts || 0, item.id];
    return { item, navigationPlan, tuple };
  }).sort((a, b) => compareTuple(a.tuple, b.tuple));
  const selected = ranked[0]; return { decision: 'CONTINUE', frontierId: selected.item.id, navigationPlan: selected.navigationPlan };
}

module.exports = { schedule };
