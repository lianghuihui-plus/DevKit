'use strict';

const fs = require('fs');
const path = require('path');
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

function buildCounts(events = []) {
  return {
    actions: events.filter((event) => event.type === 'actionResult').length,
    observations: events.filter((event) => event.type === 'observation').length,
    preparationActions: events.filter((event) => event.type === 'actionResult' && event.scope === 'case-prepare').length,
    knowledgeQueries: events.filter((event) => event.type === 'knowledgeQuery').length,
    knowledgeAssessments: events.filter((event) => event.type === 'knowledgeAssessment').length,
    planRevisions: events.filter((event) => event.type === 'planRevised').length,
    reflections: events.filter((event) => event.type === 'reflection').length,
  };
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function durationMs(start, end) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readAgentAttempts(execDir, endedAt = new Date().toISOString()) {
  if (!execDir) return [];
  const completed = readJsonl(path.join(execDir, 'agent', 'attempts.jsonl'));
  const currentFile = path.join(execDir, 'agent', 'attempt.current.json');
  let current = null;
  try { current = fs.existsSync(currentFile) ? JSON.parse(fs.readFileSync(currentFile, 'utf8')) : null; } catch { current = null; }
  if (!current || completed.some((attempt) => attempt.attemptId && attempt.attemptId === current.attemptId)) return completed;
  return [...completed, {
    ...current,
    endedAt,
    durationMs: durationMs(current.startedAt, endedAt),
    ok: null,
    inProgress: true,
  }];
}

function inputEffectMetrics(operationRecords = []) {
  const effects = operationRecords.map((record) => record.deviceResult?.inputEffect).filter(Boolean);
  const statuses = { VERIFIED: 0, MASKED: 0, UNVERIFIABLE: 0, MISMATCH: 0 };
  let attempts = 0;
  let settledMs = 0;
  for (const effect of effects) {
    if (Object.prototype.hasOwnProperty.call(statuses, effect.status)) statuses[effect.status] += 1;
    attempts += Number.isFinite(effect.attempts) ? effect.attempts : 0;
    settledMs += Number.isFinite(effect.settledMs) ? effect.settledMs : 0;
  }
  return { total: effects.length, statuses, attempts, settledMs };
}

function timingMetrics(execution, events, endedAt, execDir) {
  const attempts = readAgentAttempts(execDir, endedAt);
  const operationRecords = !execDir || !fs.existsSync(path.join(execDir, 'agent')) ? [] : fs.readdirSync(path.join(execDir, 'agent'))
    .filter((name) => /^operation-.+\.json$/.test(name) && !name.endsWith('.draft.json'))
    .flatMap((name) => {
      try { return [JSON.parse(fs.readFileSync(path.join(execDir, 'agent', name), 'utf8'))]; } catch { return []; }
    });
  const adapterActiveMs = operationRecords.reduce((sum, record) => sum + durationMs(record.timing?.adapterStartedAt, record.timing?.adapterCompletedAt), 0);
  const protocolActiveMs = attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.durationMs) ? attempt.durationMs : 0), 0);
  const totalMs = elapsedMs(execution.startedAt, endedAt);
  const agentOrchestrationGapMs = Math.max(totalMs - protocolActiveMs, 0);
  const firstReady = events.find((event) => event.type === 'planRevised'
    && events.some((candidate) => candidate.type === 'caseUnderstood' && candidate.time <= event.time && candidate.sourceRefs?.length));
  const boundaries = [{ phase: 'UNDERSTAND', time: execution.startedAt }, ...events
    .filter((event) => event.type === 'phaseChanged')
    .map((event) => ({ phase: event.to, time: event.time })), { phase: 'END', time: endedAt }];
  const phaseDurationsMs = {};
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const current = boundaries[index];
    phaseDurationsMs[current.phase] = (phaseDurationsMs[current.phase] || 0) + durationMs(current.time, boundaries[index + 1].time);
  }
  return {
    firstExecutableTurnMs: firstReady ? durationMs(execution.startedAt, firstReady.time) : null,
    adapterActiveMs,
    protocolActiveMs,
    agentDecisionGapMs: agentOrchestrationGapMs,
    agentOrchestrationGapMs,
    phaseDurationsMs,
    protocolAttempts: attempts.length,
    statusReads: attempts.filter((attempt) => attempt.entrypoint === 'status').length,
    contractRejections: attempts.filter((attempt) => attempt.ok === false).length,
    facadeSteps: !execDir || !fs.existsSync(path.join(execDir, 'agent', 'steps')) ? 0
      : fs.readdirSync(path.join(execDir, 'agent', 'steps')).filter((name) => /^step-.+\.json$/.test(name) && !name.endsWith('.draft.json')).length,
    inputEffects: inputEffectMetrics(operationRecords),
  };
}

function buildMetrics(execution, result, events = [], now = new Date(), options = {}) {
  return {
    schemaVersion: 2,
    executionId: execution.executionId,
    verdict: result.verdict,
    executionStatus: result.executionStatus,
    elapsedMs: elapsedMs(execution.startedAt, result.endedAt || now),
    warmSessionGeneration: execution.warmSessionGeneration || 0,
    warmSessionReused: execution.warmSessionReused === true,
    recoveryCount: execution.recoveryCount || 0,
    timeLimitStopped: result.executionStatus === 'STOPPED_BY_BUDGET',
    counts: buildCounts(events),
    timing: timingMetrics(execution, events, result.endedAt || now, options.execDir),
  };
}

module.exports = {
  CASE_TIME_LIMIT_MS,
  POST_ACTION_OBSERVATION_RESERVE_MS,
  DEVICE_OPERATION_TYPES,
  assertActionBudget,
  assertOperationAllowed,
  buildCounts,
  buildMetrics,
  elapsedMs,
  declaredActionDurationMs,
  inputEffectMetrics,
  readAgentAttempts,
  timeLimitState,
  requiredActionBudgetMs,
  timingMetrics,
};
