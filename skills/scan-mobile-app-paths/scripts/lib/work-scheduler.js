'use strict';

const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./verification-store');
const { runBudget, activeLimitMinutes, maxDeviceActions, maxColdStarts, graphProtocolVersion } = require('./run-protocol');
const { budgetUsage, exhausted } = require('./budget');
const { deriveBlockedDependencies } = require('./dependency-blocking');
const { applicableSuggestions, candidateReviewNeed } = require('./frontier-candidate-service');
const { loadFrontierSuggestions } = require('./frontier-suggestions-store');
const { backfillRequiredFromCoverage, backfillRequiredFromCurrentRun } = require('./candidate-coverage');

function priorityRank(value = {}) {
  return Number(value.entryRank ?? value.riskRank ?? 9) * 100 + Number(value.selectorRank ?? value.nextPathDepth ?? 9);
}

function groupedReviewNeeds({ scanDir, scan, contextId, graph, frontier, pendingSuggestions }) {
  const grouped = new Map();
  for (const suggestion of pendingSuggestions.items || []) {
    if (!grouped.has(suggestion.reachableStateId)) grouped.set(suggestion.reachableStateId, []);
    grouped.get(suggestion.reachableStateId).push(suggestion);
  }
  const needs = [];
  for (const [reachableStateId, suggestions] of grouped.entries()) {
    const reviewNeed = candidateReviewNeed({ scanDir, scan, contextId, graph, frontier, reachableStateId, pendingSuggestions: suggestions });
    if (!reviewNeed) continue;
    const state = (graph.reachableStates || []).find(item => item.id === reachableStateId);
    needs.push({
      ...reviewNeed,
      stateDepth: Number(state?.depth?.pathDepth || 0),
      suggestionPriorityRank: Math.min(...suggestions.map(item => priorityRank(item.priority))),
      statePendingSuggestionCount: suggestions.length,
      stateSuggestions: suggestions
    });
  }
  return needs.sort((a, b) => a.stateDepth - b.stateDepth || a.suggestionPriorityRank - b.suggestionPriorityRank || String(a.reachableStateId).localeCompare(String(b.reachableStateId)));
}

function backfillCommand(scanDir, contextId, stateIds) {
  return {
    command: 'frontier-candidates.js',
    args: ['backfill', '--scan-dir', scanDir, '--context', contextId, '--reachable-state-ids', stateIds.slice(0, 50).join(',')]
  };
}

function nextWork({ scanDir, scan, contextId, graph, frontier, metrics }) {
  const queue = loadVerificationQueue(scanDir, contextId); const failed = queue.items.filter(item => item.status === 'FAILED'); const retryableFailed = failed.filter(item => Number(item.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS); const terminalFailed = failed.filter(item => Number(item.attemptCount || 0) >= MAX_VERIFICATION_ATTEMPTS); const running = queue.items.filter(item => item.status === 'RUNNING'); const pendingAll = [...queue.items.filter(item => item.status === 'PENDING'), ...retryableFailed]; const dependencyBlocking = deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS }); const pending = pendingAll.filter(item => !dependencyBlocking.isVerificationBlocked(item)); const frontierRunnable = (frontier.items || []).filter(item => ['PENDING', 'RETRYABLE'].includes(item.status) && !dependencyBlocking.isFrontierBlocked(item)); const allSuggestionStore = scan.scanMode === 'exploration' ? loadFrontierSuggestions(scanDir, contextId) : { items: [] }; const allPendingSuggestions = { items: (allSuggestionStore.items || []).filter(item => item.status === 'PENDING'), totalPending: (allSuggestionStore.items || []).filter(item => item.status === 'PENDING').length }; const pendingSuggestions = scan.scanMode === 'exploration' ? applicableSuggestions({ scanDir, scan, contextId, graph, frontier, dependencyBlocking, acceptSafe: true }) : { items: [], skipped: [], totalPending: 0 };
  if (running.length) return { decision: 'STOP', reasonCode: 'VERIFICATION_IN_PROGRESS', verification: running[0] };
  if (dependencyBlocking.hasUnknownTerminalFailure) return { decision: 'STOP', reasonCode: 'REQUIRED_VERIFICATION_FAILED', verification: terminalFailed[0], suggestedTerminalStatus: 'PARTIAL', dependencyBlocking };
  const budget = runBudget(scan, contextId); const usage = budgetUsage(scan, graph, frontier, metrics); const requiredActions = pending.reduce((sum, item) => sum + item.edgeIds.length, 0); const requiredColdStarts = pending.length; const averageObservationMs = Number(metrics.averageStabilityWaitMs || 1500); const requiredMinutes = pending.reduce((sum, item) => sum + 0.05 + item.edgeIds.length * Math.max(0.02, averageObservationMs / 60000), 0);
  const budgetState = exhausted(budget, usage, graphProtocolVersion(scan));
  if (budgetState.exhausted) return { decision: 'STOP', reasonCode: budgetState.reasonCode, suggestedTerminalStatus: 'PARTIAL', budgetState };
  const target = pending.find(item => item.reason === 'CONFIRMED_TARGET_PATH'); if (target) return { decision: 'VERIFY', reasonCode: target.status === 'FAILED' ? 'VERIFICATION_RETRY_REQUIRED' : target.reason, verification: target };
  const remainingActions = maxDeviceActions(budget) - usage.actions; const remainingColdStarts = maxColdStarts(budget) - usage.coldStarts; const remainingMinutes = activeLimitMinutes(budget) - usage.durationMinutes; const frontierPending = frontierRunnable.length > 0;
  if (!frontierPending && allPendingSuggestions.items.length) {
    const reviewNeed = groupedReviewNeeds({ scanDir, scan, contextId, graph, frontier, pendingSuggestions: allPendingSuggestions })[0];
    if (reviewNeed) return { decision: 'REVIEW_FRONTIER_CANDIDATES', reasonCode: 'CANDIDATE_VISUAL_REVIEW_REQUIRED', ...reviewNeed, pendingSuggestionCount: pendingSuggestions.items.length, totalPendingSuggestionCount: allPendingSuggestions.totalPending, suggestedCommand: { command: 'frontier-candidates.js', args: ['prepare-review', '--scan-dir', scanDir, '--context', contextId, '--reachable-state-id', reviewNeed.reachableStateId, '--observation-id', reviewNeed.observationId] }, suggestions: reviewNeed.stateSuggestions.slice(0, 20) };
  }
  if (!frontierPending && pendingSuggestions.items.length) return { decision: 'SUGGEST_FRONTIER', reasonCode: 'FRONTIER_EMPTY_WITH_APPLICABLE_SUGGESTIONS', reachableStateId: pendingSuggestions.items[0].reachableStateId, pendingSuggestionCount: pendingSuggestions.items.length, totalPendingSuggestionCount: pendingSuggestions.totalPending, skippedSuggestions: pendingSuggestions.skipped.slice(0, 20), suggestions: pendingSuggestions.items.slice(0, 20) };
  const currentBackfillRequiredStateIds = !frontierPending && scan.scanMode === 'exploration' ? backfillRequiredFromCurrentRun({ scanDir, contextId, graph, frontier, dependencyBlocking }) : [];
  if (!frontierPending && !pendingSuggestions.items.length && currentBackfillRequiredStateIds.length) return { decision: 'BACKFILL_FRONTIER_SUGGESTIONS', reasonCode: 'CURRENT_RUN_CANDIDATE_COVERAGE_BACKFILL_REQUIRED', coverageSource: 'CURRENT_RUN', reachableStateIds: currentBackfillRequiredStateIds.slice(0, 50), pendingBackfillStateCount: currentBackfillRequiredStateIds.length, suggestedCommand: backfillCommand(scanDir, contextId, currentBackfillRequiredStateIds) };
  const backfillRequiredStateIds = !frontierPending && scan.scanMode === 'exploration' ? backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking }) : [];
  if (!frontierPending && !pendingSuggestions.items.length && backfillRequiredStateIds.length) return { decision: 'BACKFILL_FRONTIER_SUGGESTIONS', reasonCode: 'CANDIDATE_COVERAGE_BACKFILL_REQUIRED', coverageSource: 'INHERITED_CANONICAL', reachableStateIds: backfillRequiredStateIds.slice(0, 50), pendingBackfillStateCount: backfillRequiredStateIds.length, suggestedCommand: backfillCommand(scanDir, contextId, backfillRequiredStateIds) };
  if (pending.length && (!frontierPending || remainingActions <= requiredActions + 1 || remainingColdStarts <= requiredColdStarts || remainingMinutes <= requiredMinutes)) return { decision: 'VERIFY', reasonCode: 'REQUIRED_VERIFICATION_RESERVE', verification: pending[0], estimate: { requiredActions, requiredColdStarts, requiredMinutes } };
  if (frontierPending) return { decision: 'DISCOVER' };
  if (pending.length) return { decision: 'VERIFY', reasonCode: 'FRONTIER_EMPTY', verification: pending[0] };
  if (pendingSuggestions.totalPending) return { decision: 'STOP', reasonCode: 'FRONTIER_SUGGESTIONS_NOT_APPLICABLE', suggestedTerminalStatus: 'PARTIAL', pendingSuggestionCount: pendingSuggestions.totalPending, skippedSuggestions: pendingSuggestions.skipped.slice(0, 20) };
  if (terminalFailed.length || pendingAll.length !== pending.length || (frontier.items || []).some(item => ['PENDING', 'RETRYABLE'].includes(item.status))) return { decision: 'STOP', reasonCode: 'WORK_BLOCKED_BY_FAILED_DEPENDENCIES', suggestedTerminalStatus: 'PARTIAL', dependencyBlocking };
  return { decision: 'STOP', reasonCode: 'WORK_EMPTY' };
}

module.exports = { nextWork, backfillRequiredFromCoverage, backfillRequiredFromCurrentRun, groupedReviewNeeds };
