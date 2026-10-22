'use strict';

const TECHNICAL_FACT_TYPES = new Set([
  'technicalIssue',
  'timeBudgetExhausted',
  'actionOutcomeUnknown',
  'recoveryOutcomeUnknown',
]);

const TECHNICAL_FACT_DEFAULTS = Object.freeze({
  technicalIssue: { code: 'CASE_RUNTIME_ERROR', message: 'Case Runtime encountered a technical error', operation: null },
  timeBudgetExhausted: { code: 'TIME_BUDGET_EXHAUSTED', message: 'Case execution time budget was exhausted', operation: null },
  actionOutcomeUnknown: { code: 'ACTION_OUTCOME_UNKNOWN', message: 'Device action outcome is unknown', operation: 'act' },
  recoveryOutcomeUnknown: { code: 'RECOVERY_OUTCOME_UNKNOWN', message: 'App recovery outcome is unknown', operation: 'recover' },
});

function isTechnicalFact(event) {
  return Boolean(event && TECHNICAL_FACT_TYPES.has(event.type));
}

function technicalFactRef(sequence) {
  return `technical-fact-${String(sequence).padStart(4, '0')}`;
}

function technicalFacts(events = []) {
  return events.filter(isTechnicalFact);
}

function bindTechnicalFact(event, context = {}) {
  if (!isTechnicalFact(event)) return event;
  const events = context.events || [];
  const decision = event.decisionId
    ? events.find((item) => item.type === 'agentDecisionRecorded' && item.decisionId === event.decisionId)
    : null;
  const defaults = TECHNICAL_FACT_DEFAULTS[event.type] || {};
  return {
    ...defaults,
    ...event,
    decisionId: event.decisionId || null,
    expectationRefs: Array.isArray(event.expectationRefs)
      ? [...new Set(event.expectationRefs)]
      : [...new Set(decision?.decision?.expectationRefs || [])],
    sceneId: event.sceneId || context.currentScene?.sceneId || null,
    generation: Number.isInteger(event.generation) ? event.generation : context.execution?.warmSessionGeneration ?? null,
    operationId: event.operationId || null,
  };
}

function technicalFactState(fact, events = [], execution = null, expectationRef = null) {
  if (!isTechnicalFact(fact)) return { state: 'INVALID', reason: '事件类型不能支撑技术阻塞' };
  if (!fact.technicalFactRef) return { state: 'INVALID', reason: '技术事实缺少稳定引用' };
  if (execution?.executionId && fact.executionId !== execution.executionId) {
    return { state: 'INVALID', reason: '技术事实不属于当前 execution' };
  }
  if (expectationRef && !(fact.expectationRefs || []).includes(expectationRef)) {
    return { state: 'INVALID', reason: `技术事实未关联验证点 ${expectationRef}` };
  }
  if (!Number.isInteger(fact.generation)
    || (Number.isInteger(execution?.warmSessionGeneration) && fact.generation !== execution.warmSessionGeneration)) {
    return { state: 'INVALID', reason: '技术事实不属于当前 generation' };
  }
  const later = events.filter((event) => Number(event.sequence || 0) > Number(fact.sequence || 0));
  const successfulFollowUp = later.some((event) => (event.type === 'sceneObserved' && event.screenshotRef)
    || event.type === 'appRecovered');
  let recovered = false;
  if (fact.type === 'technicalIssue') {
    recovered = successfulFollowUp;
  } else if (fact.type === 'actionOutcomeUnknown') {
    recovered = successfulFollowUp
      || later.some((event) => event.type === 'actionCompleted' && event.operationId === fact.operationId);
  } else if (fact.type === 'recoveryOutcomeUnknown') {
    recovered = successfulFollowUp || later.some((event) => event.operationId === fact.operationId
      && ['appRecovered', 'recoveryFailed'].includes(event.type));
  }
  return recovered
    ? { state: 'INVALID', reason: '技术事实已被后续成功执行、明确结果或有效现场消除' }
    : { state: 'VALID', reason: '当前技术事实仍直接阻止该验证点' };
}

function technicalFactView(fact, events = [], execution = null, expectationRef = null) {
  const status = technicalFactState(fact, events, execution, expectationRef);
  return {
    ref: fact.technicalFactRef,
    type: fact.type,
    code: fact.code || TECHNICAL_FACT_DEFAULTS[fact.type]?.code || 'TECHNICAL_FACT',
    message: fact.message || TECHNICAL_FACT_DEFAULTS[fact.type]?.message || 'Technical fact recorded',
    time: fact.time || null,
    operation: fact.operation || TECHNICAL_FACT_DEFAULTS[fact.type]?.operation || null,
    operationId: fact.operationId || null,
    decisionId: fact.decisionId || null,
    sceneId: fact.sceneId || null,
    generation: fact.generation ?? null,
    state: status.state,
    stateReason: status.reason,
  };
}

function referencedTechnicalFacts(result, events = [], execution = null) {
  const requested = new Set((result?.checks || []).flatMap((check) => check.technicalRefs || []));
  const expectationByRef = new Map((result?.checks || []).flatMap((check) =>
    (check.technicalRefs || []).map((ref) => [ref, check.checkNodeRef || check.expectationRef])));
  return technicalFacts(events).filter((event) => requested.has(event.technicalFactRef)
    && technicalFactState(event, events, execution, expectationByRef.get(event.technicalFactRef)).state === 'VALID');
}

module.exports = {
  TECHNICAL_FACT_TYPES,
  bindTechnicalFact,
  isTechnicalFact,
  referencedTechnicalFacts,
  technicalFactRef,
  technicalFactState,
  technicalFactView,
  technicalFacts,
};
