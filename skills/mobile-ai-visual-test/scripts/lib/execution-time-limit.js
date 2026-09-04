'use strict';

const { contractError } = require('./contract-utils');
const { swipeDurationMs } = require('./action-contract');

const CASE_TIME_LIMIT_MS = 30 * 60 * 1000;
const POST_ACTION_OBSERVATION_RESERVE_MS = 5000;
const DEVICE_OPERATION_TYPES = new Set(['observe', 'action']);

function elapsedMs(startedAt, now = new Date()) {
  const start = new Date(startedAt).getTime();
  const end = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw contractError('EXECUTION_TIME_INVALID', 'execution time is invalid');
  return Math.max(end - start, 0);
}

function timeLimitState(execution, now = new Date()) {
  const elapsed = elapsedMs(execution.startedAt, now);
  return {
    limitMs: CASE_TIME_LIMIT_MS,
    elapsedMs: elapsed,
    remainingMs: Math.max(CASE_TIME_LIMIT_MS - elapsed, 0),
    reached: elapsed >= CASE_TIME_LIMIT_MS,
  };
}

function assertOperationAllowed(execution, operationType, now = new Date()) {
  const state = timeLimitState(execution, now);
  if (DEVICE_OPERATION_TYPES.has(operationType) && state.reached) {
    throw contractError('CASE_TIME_LIMIT_REACHED', 'new device operations are not allowed after the case time limit');
  }
  return state;
}

function declaredActionDurationMs(action = {}) {
  if (action.type === 'wait') return Math.max(0, action.ms === undefined ? 1000 : Number(action.ms) || 0);
  if (action.type === 'longPress') return Math.max(0, action.durationMs === undefined ? 800 : Number(action.durationMs) || 0);
  if (action.type === 'doubleTap') return Math.max(20, action.intervalMs === undefined ? 100 : Number(action.intervalMs) || 0);
  if (action.type === 'swipe') return swipeDurationMs(action);
  return 0;
}

function requiredActionBudgetMs(action, postActionSettleMs = 0) {
  return declaredActionDurationMs(action)
    + Math.max(0, Number(postActionSettleMs) || 0)
    + POST_ACTION_OBSERVATION_RESERVE_MS;
}

function assertActionBudget(execution, action, postActionSettleMs = 0, now = new Date()) {
  const state = assertOperationAllowed(execution, 'action', now);
  const requiredMs = requiredActionBudgetMs(action, postActionSettleMs);
  if (state.remainingMs < requiredMs) {
    throw contractError('CASE_TIME_LIMIT_INSUFFICIENT', 'remaining case time cannot complete the action and its post-action observation', {
      remainingMs: state.remainingMs,
      requiredMs,
      actionType: action?.type || null,
    });
  }
  return { ...state, requiredMs };
}

module.exports = {
  CASE_TIME_LIMIT_MS,
  POST_ACTION_OBSERVATION_RESERVE_MS,
  DEVICE_OPERATION_TYPES,
  assertActionBudget,
  assertOperationAllowed,
  declaredActionDurationMs,
  elapsedMs,
  requiredActionBudgetMs,
  timeLimitState,
};
