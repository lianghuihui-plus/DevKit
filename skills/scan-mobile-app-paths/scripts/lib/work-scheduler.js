'use strict';

const { loadVerificationQueue, MAX_VERIFICATION_ATTEMPTS } = require('./verification-store');
const { runBudget, activeLimitMinutes, maxDeviceActions, maxColdStarts } = require('./run-protocol');
const { budgetUsage } = require('./budget');

function nextWork({ scanDir, scan, contextId, graph, frontier, metrics }) {
  const queue = loadVerificationQueue(scanDir, contextId); const failed = queue.items.filter(item => item.status === 'FAILED'); const retryableFailed = failed.filter(item => Number(item.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS); const terminalFailed = failed.filter(item => Number(item.attemptCount || 0) >= MAX_VERIFICATION_ATTEMPTS); const running = queue.items.filter(item => item.status === 'RUNNING'); const pending = [...queue.items.filter(item => item.status === 'PENDING'), ...retryableFailed]; const target = pending.find(item => item.reason === 'CONFIRMED_TARGET_PATH'); if (target) return { decision: 'VERIFY', reasonCode: target.status === 'FAILED' ? 'VERIFICATION_RETRY_REQUIRED' : target.reason, verification: target };
  if (running.length) return { decision: 'STOP', reasonCode: 'VERIFICATION_IN_PROGRESS', verification: running[0] };
  if (terminalFailed.length) return { decision: 'STOP', reasonCode: 'REQUIRED_VERIFICATION_FAILED', verification: terminalFailed[0], suggestedTerminalStatus: 'PARTIAL' };
  const budget = runBudget(scan, contextId); const usage = budgetUsage(scan, graph, frontier, metrics); const requiredActions = pending.reduce((sum, item) => sum + item.edgeIds.length, 0); const requiredColdStarts = pending.length; const averageObservationMs = Number(metrics.averageStabilityWaitMs || 1500); const requiredMinutes = pending.reduce((sum, item) => sum + 0.05 + item.edgeIds.length * Math.max(0.02, averageObservationMs / 60000), 0);
  const remainingActions = maxDeviceActions(budget) - usage.actions; const remainingColdStarts = maxColdStarts(budget) - usage.coldStarts; const remainingMinutes = activeLimitMinutes(budget) - usage.durationMinutes; const frontierPending = frontier.items.some(item => ['PENDING', 'RETRYABLE'].includes(item.status));
  if (pending.length && (!frontierPending || remainingActions <= requiredActions + 1 || remainingColdStarts <= requiredColdStarts || remainingMinutes <= requiredMinutes)) return { decision: 'VERIFY', reasonCode: 'REQUIRED_VERIFICATION_RESERVE', verification: pending[0], estimate: { requiredActions, requiredColdStarts, requiredMinutes } };
  if (frontierPending) return { decision: 'DISCOVER' };
  if (pending.length) return { decision: 'VERIFY', reasonCode: 'FRONTIER_EMPTY', verification: pending[0] };
  return { decision: 'STOP', reasonCode: 'WORK_EMPTY' };
}

module.exports = { nextWork };
