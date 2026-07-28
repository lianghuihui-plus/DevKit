'use strict';

const fs = require('fs');
const path = require('path');
const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./verification-store');
const { runBudget, activeLimitMinutes, maxDeviceActions, maxColdStarts, graphProtocolVersion } = require('./run-protocol');
const { budgetUsage, exhausted } = require('./budget');
const { deriveBlockedDependencies } = require('./dependency-blocking');
const { applicableSuggestions, candidateReviewNeed } = require('./frontier-candidate-service');
const { loadFrontierSuggestions } = require('./frontier-suggestions-store');
const { backfillRequiredFromCoverage, backfillRequiredFromCurrentRun } = require('./candidate-coverage');
const { readJson } = require('./common');
const { modeForScan } = require('./modes');

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

function applySuggestionCommand(scanDir, contextId, suggestionId) {
  return {
    command: 'frontier-candidates.js',
    args: ['apply', '--scan-dir', scanDir, '--context', contextId, '--suggestion-id', suggestionId]
  };
}

function workProgress({ scan, contextId, graph, frontier, metrics }) {
  const budget = runBudget(scan, contextId);
  const usage = budgetUsage(scan, graph, frontier, metrics);
  const activeLimit = activeLimitMinutes(budget);
  return {
    activeDurationMs: Math.round(usage.durationMinutes * 60000),
    activeLimitMinutes: activeLimit,
    remainingActiveMs: Math.max(0, Math.round((activeLimit - usage.durationMinutes) * 60000)),
    remainingActiveMinutes: Math.max(0, activeLimit - usage.durationMinutes),
    actions: usage.actions,
    maxDeviceActions: maxDeviceActions(budget),
    remainingDeviceActions: Math.max(0, maxDeviceActions(budget) - usage.actions),
    coldStarts: usage.coldStarts,
    maxColdStarts: maxColdStarts(budget),
    remainingColdStarts: Math.max(0, maxColdStarts(budget) - usage.coldStarts),
    states: usage.states,
    totalStates: usage.totalStates,
    baselineStates: usage.baselineStates
  };
}

function openWorkSummary({ scanDir, scan, contextId, graph, frontier, dependencyBlocking = null }) {
  const mode = modeForScan(scan);
  const guidance = mode.loadGuidance({ scanDir, scan, contextId, graph, frontier });
  const queue = loadVerificationQueue(scanDir, contextId);
  const blocking = dependencyBlocking || deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS });
  const frontierItems = frontier.items || [];
  const runnableFrontiers = frontierItems.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status) && !blocking.isFrontierBlocked(item));
  const blockedFrontiers = frontierItems.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status) && blocking.isFrontierBlocked(item));
  const suggestions = mode.usesSuggestions ? loadFrontierSuggestions(scanDir, contextId) : { items: [] };
  const pendingSuggestions = mode.filterSuggestions({ items: (suggestions.items || []).filter(item => item.status === 'PENDING'), scanDir, scan, contextId, graph, frontier, guidance });
  const applicable = mode.usesSuggestions ? applicableSuggestions({ scanDir, scan, contextId, graph, frontier, dependencyBlocking: blocking, acceptSafe: true }) : { items: [], skipped: [], totalPending: 0 };
  const scopedApplicable = { ...applicable, items: mode.filterSuggestions({ items: applicable.items, scanDir, scan, contextId, graph, frontier, guidance }) };
  const currentBackfillRequiredStateIds = mode.usesSuggestions ? mode.filterBackfillStateIds({ stateIds: backfillRequiredFromCurrentRun({ scanDir, contextId, graph, frontier, dependencyBlocking: blocking }), scanDir, scan, contextId, graph, frontier, guidance }) : [];
  const inheritedBackfillRequiredStateIds = mode.usesSuggestions ? mode.filterBackfillStateIds({ stateIds: backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking: blocking }), scanDir, scan, contextId, graph, frontier, guidance }) : [];
  const scopedRunnableFrontiers = mode.filterFrontiers({ items: runnableFrontiers, scanDir, scan, contextId, graph, frontier, guidance });
  const scopedBlockedFrontiers = mode.filterFrontiers({ items: blockedFrontiers, scanDir, scan, contextId, graph, frontier, guidance });
  const scopedQueueItems = typeof mode.filterVerifications === 'function' ? mode.filterVerifications({ items: queue.items, scanDir, scan, contextId, graph, frontier, guidance }) : queue.items;
  return {
    pendingFrontiers: frontierItems.filter(item => ['PENDING', 'RETRYABLE'].includes(item.status)).length,
    runnableFrontiers: scopedRunnableFrontiers.length,
    blockedFrontiers: scopedBlockedFrontiers.length,
    pendingVerifications: scopedQueueItems.filter(item => item.status === 'PENDING').length,
    runningVerifications: scopedQueueItems.filter(item => item.status === 'RUNNING').length,
    failedVerifications: scopedQueueItems.filter(item => item.status === 'FAILED').length,
    retryableFailedVerifications: scopedQueueItems.filter(item => item.status === 'FAILED' && Number(item.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS).length,
    terminalFailedVerifications: scopedQueueItems.filter(item => item.status === 'FAILED' && Number(item.attemptCount || 0) >= MAX_VERIFICATION_ATTEMPTS).length,
    pendingSuggestions: pendingSuggestions.length,
    applicableSuggestions: scopedApplicable.items.length,
    skippedSuggestions: scopedApplicable.skipped.length,
    currentBackfillRequiredStates: currentBackfillRequiredStateIds.length,
    inheritedBackfillRequiredStates: inheritedBackfillRequiredStateIds.length,
    backfillRequiredStates: new Set([...currentBackfillRequiredStateIds, ...inheritedBackfillRequiredStateIds]).size
  };
}

function withExecutionHints(decision, summary, progress) {
  const continuable = ['DISCOVER', 'VERIFY', 'GOAL_KNOWN_TARGET_PRECHECK', 'RESOLVE_EXPLORATION_START', 'SUGGEST_FRONTIER', 'BACKFILL_FRONTIER_SUGGESTIONS', 'REVIEW_FRONTIER_CANDIDATES'].includes(decision.decision);
  return {
    ...decision,
    openWorkSummary: summary,
    executionProgress: progress,
    recommendedAction: continuable ? 'CONTINUE_SCAN' : decision.suggestedTerminalStatus ? `FINALIZE_${decision.suggestedTerminalStatus}` : decision.decision === 'STOP' ? 'FINALIZE_COMPLETED' : 'CONTINUE_SCAN'
  };
}

function goalFoundVerified(scanDir, scan) {
  if (scan.scanMode !== 'goal-directed') return false;
  const file = path.join(scanDir, 'goal', 'match-result.json');
  if (!fs.existsSync(file)) return false;
  return readJson(file).status === 'FOUND_VERIFIED';
}

function nextWork({ scanDir, scan, contextId, graph, frontier, metrics }) {
  const mode = modeForScan(scan);
  const guidance = mode.loadGuidance({ scanDir, scan, contextId, graph, frontier });
  const queue = loadVerificationQueue(scanDir, contextId); const scopedQueueItems = typeof mode.filterVerifications === 'function' ? mode.filterVerifications({ items: queue.items, scanDir, scan, contextId, graph, frontier, guidance }) : queue.items; const failed = scopedQueueItems.filter(item => item.status === 'FAILED'); const retryableFailed = failed.filter(item => Number(item.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS); const terminalFailed = failed.filter(item => Number(item.attemptCount || 0) >= MAX_VERIFICATION_ATTEMPTS); const running = scopedQueueItems.filter(item => item.status === 'RUNNING'); const pendingAll = [...scopedQueueItems.filter(item => item.status === 'PENDING'), ...retryableFailed]; const dependencyBlocking = deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS }); const pending = pendingAll.filter(item => !dependencyBlocking.isVerificationBlocked(item)); const rawFrontierRunnable = (frontier.items || []).filter(item => ['PENDING', 'RETRYABLE'].includes(item.status) && !dependencyBlocking.isFrontierBlocked(item)); const frontierRunnable = mode.filterFrontiers({ items: rawFrontierRunnable, scanDir, scan, contextId, graph, frontier, guidance }); const usesSuggestions = mode.usesSuggestions; const allSuggestionStore = usesSuggestions ? loadFrontierSuggestions(scanDir, contextId) : { items: [] }; const rawAllPendingSuggestionItems = (allSuggestionStore.items || []).filter(item => item.status === 'PENDING'); const allPendingSuggestions = { items: mode.filterSuggestions({ items: rawAllPendingSuggestionItems, scanDir, scan, contextId, graph, frontier, guidance }), totalPending: rawAllPendingSuggestionItems.length }; const rawPendingSuggestions = usesSuggestions ? applicableSuggestions({ scanDir, scan, contextId, graph, frontier, dependencyBlocking, acceptSafe: true }) : { items: [], skipped: [], totalPending: 0 }; const pendingSuggestions = { ...rawPendingSuggestions, items: mode.filterSuggestions({ items: rawPendingSuggestions.items, scanDir, scan, contextId, graph, frontier, guidance }) };
  const summary = openWorkSummary({ scanDir, scan, contextId, graph, frontier, dependencyBlocking });
  const progress = workProgress({ scan, contextId, graph, frontier, metrics });
  if (running.length) return withExecutionHints({ decision: 'STOP', reasonCode: 'VERIFICATION_IN_PROGRESS', verification: running[0] }, summary, progress);
  if (dependencyBlocking.hasUnknownTerminalFailure) return withExecutionHints({ decision: 'STOP', reasonCode: 'REQUIRED_VERIFICATION_FAILED', verification: terminalFailed[0], suggestedTerminalStatus: 'PARTIAL', dependencyBlocking }, summary, progress);
  const budget = runBudget(scan, contextId); const usage = budgetUsage(scan, graph, frontier, metrics); const requiredActions = pending.reduce((sum, item) => sum + item.edgeIds.length, 0); const requiredColdStarts = pending.length; const averageObservationMs = Number(metrics.averageStabilityWaitMs || 1500); const requiredMinutes = pending.reduce((sum, item) => sum + 0.05 + item.edgeIds.length * Math.max(0.02, averageObservationMs / 60000), 0);
  const budgetState = exhausted(budget, usage, graphProtocolVersion(scan));
  if (budgetState.exhausted) return withExecutionHints({ decision: 'STOP', reasonCode: budgetState.reasonCode, suggestedTerminalStatus: 'PARTIAL', budgetState }, summary, progress);
  const target = pending.find(item => item.reason === 'CONFIRMED_TARGET_PATH'); if (target) return withExecutionHints({ decision: 'VERIFY', reasonCode: target.status === 'FAILED' ? 'VERIFICATION_RETRY_REQUIRED' : target.reason, verification: target }, summary, progress);
  if (goalFoundVerified(scanDir, scan)) return withExecutionHints({ decision: 'STOP', reasonCode: 'GOAL_FOUND_VERIFIED' }, summary, progress);
  const modeWork = mode.preNextWork({ scanDir, scan, contextId, graph, frontier, metrics, queue, dependencyBlocking, summary, progress });
  if (modeWork) return withExecutionHints(modeWork, summary, progress);
  const remainingActions = maxDeviceActions(budget) - usage.actions; const remainingColdStarts = maxColdStarts(budget) - usage.coldStarts; const remainingMinutes = activeLimitMinutes(budget) - usage.durationMinutes; const frontierPending = frontierRunnable.length > 0; const relevantFrontierPending = rawFrontierRunnable.some(item => mode.isGoalRelevant(item)); const relevantSuggestionPending = pendingSuggestions.items.some(item => mode.isGoalRelevant(item));
  if ((!frontierPending || relevantSuggestionPending && !relevantFrontierPending) && allPendingSuggestions.items.length) {
    const reviewNeed = groupedReviewNeeds({ scanDir, scan, contextId, graph, frontier, pendingSuggestions: allPendingSuggestions })[0];
    if (reviewNeed) return withExecutionHints({ decision: 'REVIEW_FRONTIER_CANDIDATES', reasonCode: 'CANDIDATE_VISUAL_REVIEW_REQUIRED', ...reviewNeed, pendingSuggestionCount: pendingSuggestions.items.length, totalPendingSuggestionCount: allPendingSuggestions.totalPending, suggestedCommand: { command: 'frontier-candidates.js', args: ['prepare-review', '--scan-dir', scanDir, '--context', contextId, '--reachable-state-id', reviewNeed.reachableStateId, '--observation-id', reviewNeed.observationId] }, suggestions: reviewNeed.stateSuggestions.slice(0, 20) }, summary, progress);
  }
  if ((!frontierPending || relevantSuggestionPending && !relevantFrontierPending) && pendingSuggestions.items.length) return withExecutionHints({ decision: 'SUGGEST_FRONTIER', reasonCode: frontierPending ? 'GOAL_RELATED_SUGGESTION_BEFORE_UNRELATED_FRONTIER' : 'FRONTIER_EMPTY_WITH_APPLICABLE_SUGGESTIONS', reachableStateId: pendingSuggestions.items[0].reachableStateId, pendingSuggestionId: pendingSuggestions.items[0].suggestionId || null, pendingSuggestionCount: pendingSuggestions.items.length, totalPendingSuggestionCount: pendingSuggestions.totalPending, skippedSuggestions: pendingSuggestions.skipped.slice(0, 20), suggestions: pendingSuggestions.items.slice(0, 20), suggestedCommand: pendingSuggestions.items[0].suggestionId ? applySuggestionCommand(scanDir, contextId, pendingSuggestions.items[0].suggestionId) : null }, summary, progress);
  const currentBackfillRequiredStateIds = !frontierPending && usesSuggestions ? mode.filterBackfillStateIds({ stateIds: backfillRequiredFromCurrentRun({ scanDir, contextId, graph, frontier, dependencyBlocking }), scanDir, scan, contextId, graph, frontier, guidance }) : [];
  if (!frontierPending && !pendingSuggestions.items.length && currentBackfillRequiredStateIds.length) return withExecutionHints({ decision: 'BACKFILL_FRONTIER_SUGGESTIONS', reasonCode: 'CURRENT_RUN_CANDIDATE_COVERAGE_BACKFILL_REQUIRED', coverageSource: 'CURRENT_RUN', reachableStateIds: currentBackfillRequiredStateIds.slice(0, 50), pendingBackfillStateCount: currentBackfillRequiredStateIds.length, suggestedCommand: backfillCommand(scanDir, contextId, currentBackfillRequiredStateIds) }, summary, progress);
  const backfillRequiredStateIds = !frontierPending && usesSuggestions ? mode.filterBackfillStateIds({ stateIds: backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking }), scanDir, scan, contextId, graph, frontier, guidance }) : [];
  if (!frontierPending && !pendingSuggestions.items.length && backfillRequiredStateIds.length) return withExecutionHints({ decision: 'BACKFILL_FRONTIER_SUGGESTIONS', reasonCode: 'CANDIDATE_COVERAGE_BACKFILL_REQUIRED', coverageSource: 'INHERITED_CANONICAL', reachableStateIds: backfillRequiredStateIds.slice(0, 50), pendingBackfillStateCount: backfillRequiredStateIds.length, suggestedCommand: backfillCommand(scanDir, contextId, backfillRequiredStateIds) }, summary, progress);
  if (pending.length && (!frontierPending || remainingActions <= requiredActions + 1 || remainingColdStarts <= requiredColdStarts || remainingMinutes <= requiredMinutes)) return withExecutionHints({ decision: 'VERIFY', reasonCode: 'REQUIRED_VERIFICATION_RESERVE', verification: pending[0], estimate: { requiredActions, requiredColdStarts, requiredMinutes } }, summary, progress);
  if (frontierPending) return withExecutionHints({ decision: 'DISCOVER' }, summary, progress);
  if (pending.length) return withExecutionHints({ decision: 'VERIFY', reasonCode: 'FRONTIER_EMPTY', verification: pending[0] }, summary, progress);
  if (pendingSuggestions.totalPending) return withExecutionHints({ decision: 'STOP', reasonCode: 'FRONTIER_SUGGESTIONS_NOT_APPLICABLE', suggestedTerminalStatus: 'PARTIAL', pendingSuggestionCount: pendingSuggestions.totalPending, skippedSuggestions: pendingSuggestions.skipped.slice(0, 20) }, summary, progress);
  if (terminalFailed.length || pendingAll.length !== pending.length || (frontier.items || []).some(item => ['PENDING', 'RETRYABLE'].includes(item.status))) return withExecutionHints({ decision: 'STOP', reasonCode: 'WORK_BLOCKED_BY_FAILED_DEPENDENCIES', suggestedTerminalStatus: 'PARTIAL', dependencyBlocking }, summary, progress);
  return withExecutionHints({ decision: 'STOP', reasonCode: 'WORK_EMPTY' }, summary, progress);
}

module.exports = { nextWork, openWorkSummary, workProgress, backfillRequiredFromCoverage, backfillRequiredFromCurrentRun, groupedReviewNeeds };
