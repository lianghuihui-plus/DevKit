'use strict';

function score(item) {
  const p = item.priority || {};
  return [p.riskRank ?? 9, p.nextPathDepth ?? 999, p.entryRank ?? 9, p.selectorRank ?? 9, p.restoreCost ?? 999, item.id];
}

function compare(a, b) {
  const left = score(a); const right = score(b);
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

function decideNext({ frontier, budgetState }) {
  if (budgetState?.exhausted) return { decision: 'STOP', reasonCode: budgetState.reasonCode };
  const item = frontier.filter(x => ['PENDING', 'RETRYABLE'].includes(x.status)).sort(compare)[0];
  return item ? { decision: 'CONTINUE', frontierId: item.id } : { decision: 'STOP', reasonCode: 'FRONTIER_EMPTY' };
}

module.exports = { name: 'exploration', compare, decideNext };
