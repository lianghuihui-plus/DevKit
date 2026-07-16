'use strict';

function compare(a, b) {
  const ap = a.priority || {}; const bp = b.priority || {};
  const av = [-(ap.goalRelevance ?? -1), ap.riskRank ?? 9, ap.nextPathDepth ?? 999, ap.restoreCost ?? 999, a.id];
  const bv = [-(bp.goalRelevance ?? -1), bp.riskRank ?? 9, bp.nextPathDepth ?? 999, bp.restoreCost ?? 999, b.id];
  for (let i = 0; i < av.length; i += 1) if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  return 0;
}

function decideNext({ frontier, budgetState, candidate }) {
  if (candidate && ['CANDIDATE_STRONG', 'CANDIDATE_UNCERTAIN'].includes(candidate.status)) return { decision: 'PAUSE', reasonCode: 'GOAL_CANDIDATE_REVIEW' };
  if (budgetState?.exhausted) return { decision: 'STOP', reasonCode: budgetState.reasonCode };
  const item = frontier.filter(x => ['PENDING', 'RETRYABLE'].includes(x.status)).sort(compare)[0];
  return item ? { decision: 'CONTINUE', frontierId: item.id } : { decision: 'STOP', reasonCode: 'FRONTIER_EMPTY' };
}

module.exports = { name: 'goal-directed', compare, decideNext };
