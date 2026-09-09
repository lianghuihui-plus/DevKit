'use strict';

const RECONCILE_RETRY_LIMIT = 3;
const RETRYABLE_CODES = new Set(['EXECUTION_LOCKED']);
const FATAL_BATCH_CODES = new Set([
  'EXECUTION_EVENT_LOG_CORRUPTED',
  'EXECUTION_LOCK_OWNERSHIP_LOST',
  'BATCH_BINDING_MISMATCH',
  'BATCH_STATE_CORRUPTED',
]);

function classifyReconcileError(error) {
  const code = error?.code || 'CASE_RUNTIME_RECONCILE_FAILED';
  if (RETRYABLE_CODES.has(code)) return { classification: 'RETRYABLE', code };
  if (FATAL_BATCH_CODES.has(code) || code.startsWith('BATCH_') || error instanceof SyntaxError) {
    return { classification: 'FATAL_BATCH', code };
  }
  return { classification: 'FATAL_EXECUTION', code };
}

module.exports = { RECONCILE_RETRY_LIMIT, classifyReconcileError };
