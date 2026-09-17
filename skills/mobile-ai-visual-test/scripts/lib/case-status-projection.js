'use strict';

function projectCaseStatus(input = {}) {
  const execution = input.execution || null;
  if (!execution) return 'PENDING';
  if (input.readability === 'FORMAT_UNSUPPORTED') return 'NEEDS_RERUN';
  if (input.readability === 'DATA_INVALID') return 'REPORT_DATA_INVALID';
  if (input.sourceCurrent === false) return 'NEEDS_RERUN';
  if (execution.status === 'CANCELLED' || execution.lifecycle === 'CANCELLED') return 'CANCELLED';
  if (input.result?.verdict) return input.result.verdict;
  if (input.finalizationPending) return 'FINALIZATION_RECOVERY_REQUIRED';
  if (input.pendingCompletion) return 'PENDING_PUBLICATION';
  if (!input.closure) return 'RUNNING';
  return execution.handoffConsumedAt ? 'BLOCKED' : 'NOT_RUN';
}

module.exports = { projectCaseStatus };
