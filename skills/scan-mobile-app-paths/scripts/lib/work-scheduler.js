'use strict';

const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./verification-store');
const { runBudget, activeLimitMinutes, maxDeviceActions, maxColdStarts, graphProtocolVersion } = require('./run-protocol');
const { budgetUsage, exhausted } = require('./budget');
const { deriveBlockedDependencies } = require('./dependency-blocking');
const { applicableSuggestions } = require('./frontier-candidate-service');
const { backfillRequiredFromCoverage } = require('./candidate-coverage');

function nextWork({ scanDir, scan, contextId, graph, frontier, metrics }) {
  const queue = loadVerificationQueue(scanDir, contextId); const failed = queue.items.filter(item => item.status === 'FAILED'); const retryableFailed = failed.filter(item => Number(item.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS); const terminalFailed = failed.filter(item => Number(item.attemptCount || 0) >= MAX_VERIFICATION_ATTEMPTS); const running = queue.items.filter(item => item.status === 'RUNNING'); const pendingAll = [...queue.items.filter(item => item.status === 'PENDING'), ...retryableFailed]; const dependencyBlocking = deriveBlockedDependencies({ scanDir, contextId, graph, queue, maxAttempts: MAX_VERIFICATION_ATTEMPTS }); const pending = pendingAll.filter(item => !dependencyBlocking.isVerificationBlocked(item)); const frontierRunnable = (frontier.items || []).filter(item => ['PENDING', 'RETRYABLE'].includes(item.status) && !dependencyBlocking.isFrontierBlocked(item)); const pendingSuggestions = scan.scanMode === 'exploration' ? applicableSuggestions({ scanDir, scan, contextId, graph, frontier, dependencyBlocking, acceptSafe: true }) : { items: [], skipped: [], totalPending: 0 };
  if (running.length) return { decision: 'STOP', reasonCode: 'VERIFICATION_IN_PROGRESS', verification: running[0] };
  if (dependencyBlocking.hasUnknownTerminalFailure) return { decision: 'STOP', reasonCode: 'REQUIRED_VERIFICATION_FAILED', verification: terminalFailed[0], suggestedTerminalStatus: 'PARTIAL', dependencyBlocking };
  const budget = runBudget(scan, contextId); const usage = budgetUsage(scan, graph, frontier, metrics); const requiredActions = pending.reduce((sum, item) => sum + item.edgeIds.length, 0); const requiredColdStarts = pending.length; const averageObservationMs = Number(metrics.averageStabilityWaitMs || 1500); const requiredMinutes = pending.reduce((sum, item) => sum + 0.05 + item.edgeIds.length * Math.max(0.02, averageObservationMs / 60000), 0);
  const budgetState = exhausted(budget, usage, graphProtocolVersion(scan));
  if (budgetState.exhausted) return { decision: 'STOP', reasonCode: budgetState.reasonCode, suggestedTerminalStatus: 'PARTIAL', budgetState };
  const target = pending.find(item => item.reason === 'CONFIRMED_TARGET_PATH'); if (target) return { decision: 'VERIFY', reasonCode: target.status === 'FAILED' ? 'VERIFICATION_RETRY_REQUIRED' : target.reason, verification: target };
  const remainingActions = maxDeviceActions(budget) - usage.actions; const remainingColdStarts = maxColdStarts(budget) - usage.coldStarts; const remainingMinutes = activeLimitMinutes(budget) - usage.durationMinutes; const frontierPending = frontierRunnable.length > 0;
  if (!frontierPending && pendingSuggestions.items.length) return { decision: 'SUGGEST_FRONTIER', reasonCode: 'FRONTIER_EMPTY_WITH_APPLICABLE_SUGGESTIONS', reachableStateId: pendingSuggestions.items[0].reachableStateId, pendingSuggestionCount: pendingSuggestions.items.length, totalPendingSuggestionCount: pendingSuggestions.totalPending, skippedSuggestions: pendingSuggestions.skipped.slice(0, 20), suggestions: pendingSuggestions.items.slice(0, 20) };
  const backfillRequiredStateIds = !frontierPending && scan.scanMode === 'exploration' ? backfillRequiredFromCoverage({ scanDir, contextId, graph, frontier, dependencyBlocking }) : [];
  if (!frontierPending && !pendingSuggestions.items.length && backfillRequiredStateIds.length) return { decision: 'BACKFILL_FRONTIER_SUGGESTIONS', reasonCode: 'CANDIDATE_COVERAGE_BACKFILL_REQUIRED', reachableStateIds: backfillRequiredStateIds.slice(0, 50), pendingBackfillStateCount: backfillRequiredStateIds.length };
  if (pending.length && (!frontierPending || remainingActions <= requiredActions + 1 || remainingColdStarts <= requiredColdStarts || remainingMinutes <= requiredMinutes)) return { decision: 'VERIFY', reasonCode: 'REQUIRED_VERIFICATION_RESERVE', verification: pending[0], estimate: { requiredActions, requiredColdStarts, requiredMinutes } };
  if (frontierPending) return { decision: 'DISCOVER' };
  if (pending.length) return { decision: 'VERIFY', reasonCode: 'FRONTIER_EMPTY', verification: pending[0] };
  if (pendingSuggestions.totalPending) return { decision: 'STOP', reasonCode: 'FRONTIER_SUGGESTIONS_NOT_APPLICABLE', suggestedTerminalStatus: 'PARTIAL', pendingSuggestionCount: pendingSuggestions.totalPending, skippedSuggestions: pendingSuggestions.skipped.slice(0, 20) };
  if (terminalFailed.length || pendingAll.length !== pending.length || (frontier.items || []).some(item => ['PENDING', 'RETRYABLE'].includes(item.status))) return { decision: 'STOP', reasonCode: 'WORK_BLOCKED_BY_FAILED_DEPENDENCIES', suggestedTerminalStatus: 'PARTIAL', dependencyBlocking };
  return { decision: 'STOP', reasonCode: 'WORK_EMPTY' };
}

module.exports = { nextWork, backfillRequiredFromCoverage };
