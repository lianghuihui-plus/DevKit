#!/usr/bin/env node
'use strict';

const path = require('path');
const { validateActionExecution } = require('./action-contract');
const { evaluateFrameworkPrecondition } = require('./framework-preconditions');
const { operationClass, validateNextWork } = require('./next-work-contract');
const { actionAuthorization, buildStepIntent, validateActionAuthorization } = require('./step-intent');
const { ruleAuthorization } = require('./rule-intent');

function lastIndex(events, predicate) {
  for (let i = events.length - 1; i >= 0; i--) if (predicate(events[i])) return i;
  return -1;
}

function eventStepId(event) {
  return event?.stepId || event?.step?.id || '';
}

function observationSummary(event, execDir) {
  if (!event) return null;
  const artifacts = event.artifacts || event.observation?.artifacts || {};
  const absolute = (value) => value ? path.resolve(execDir, value) : null;
  return {
    label: event.label || event.observation?.label || '',
    stepId: eventStepId(event) || null,
    scope: event.scope || null,
    phase: event.phase || null,
    screenshot: artifacts.screenshot || null,
    screenshotPath: absolute(artifacts.screenshot),
    evidenceRef: artifacts.screenshot || null,
    layout: artifacts.layout || null,
    layoutPath: absolute(artifacts.layout),
    screenshotMetadata: event.artifactMetadata?.screenshot || null,
  };
}

function visualRetryContext(events, stepId, observation) {
  const screenshot = observation?.artifacts?.screenshot || observation?.observation?.artifacts?.screenshot || null;
  const attemptEvents = events
    .filter((event) => event.type === 'perception' && eventStepId(event) === stepId && event.qualityClaim)
    .filter((event) => !screenshot || (Array.isArray(event.evidence) ? event.evidence : [event.evidence]).filter(Boolean).includes(screenshot));
  const attempts = attemptEvents.map((event) => ({
      attemptId: event.attemptId,
      retryOf: event.retryOf || null,
      presentationMode: event.presentationMode,
      status: event.status,
      evidenceCheckId: event.evidenceCheckId || null,
    }));
  const latestAttemptEvent = attemptEvents.at(-1) || null;
  const latestAttempt = attempts.at(-1) || null;
  const latestAttemptIndex = latestAttemptEvent ? events.lastIndexOf(latestAttemptEvent) : -1;
  const retried = latestAttempt && events.slice(latestAttemptIndex + 1).some((event) =>
    event.type === 'decision'
      && eventStepId(event) === stepId
      && event.decision === 'retry_visual_input',
  );
  return {
    maxAttempts: 2,
    attemptCount: attempts.length,
    retryAllowed: attempts.length === 0 || (attempts.length === 1 && !retried),
    requiredRetryOf: attempts.length === 1 && retried ? latestAttempt.attemptId : null,
    attempts,
  };
}

function decorate(nextWork) {
  validateNextWork(nextWork);
  return { ...nextWork, operationClass: operationClass(nextWork) };
}

function applicableRules(caseJson, step) {
  return (caseJson.globalRules || [])
    .filter((rule) => rule.appliesTo === 'any_step' || (Array.isArray(rule.appliesTo) && rule.appliesTo.includes(step.id)))
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || left.id.localeCompare(right.id));
}

function reduceRules(caseJson, step, events, execDir, observation, observationIndex) {
  const rules = applicableRules(caseJson, step);
  if (!rules.length) return null;
  const evidence = observation.artifacts?.screenshot || observation.observation?.artifacts?.screenshot || null;
  const globalActions = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'actionResult' && event.scope === 'global-rule' && eventStepId(event) === step.id);
  const latestGlobalAction = globalActions.at(-1) || null;
  if (latestGlobalAction && latestGlobalAction.index > observationIndex) {
    const rule = rules.find((item) => item.id === latestGlobalAction.event.ruleId);
    if (rule) return decorate({ type: 'OBSERVE_AFTER_RULE', step, rule, latestAction: latestGlobalAction.event });
  }
  if (latestGlobalAction && latestGlobalAction.index < observationIndex) {
    const handled = events.slice(latestGlobalAction.index + 1).some((event) => event.type === 'rule'
      && event.ruleId === latestGlobalAction.event.ruleId
      && event.status === 'HANDLED');
    if (!handled) {
      const rule = rules.find((item) => item.id === latestGlobalAction.event.ruleId);
      if (rule) return decorate({ type: 'RECORD_RULE_HANDLED', step, rule, latestAction: latestGlobalAction.event, latestObservation: observationSummary(observation, execDir) });
    }
  }
  for (const rule of rules) {
    const facts = events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => index > observationIndex
        && event.type === 'rule'
        && event.ruleId === rule.id
        && eventStepId(event) === step.id
        && (!event.observation || !evidence || event.observation === evidence));
    const matched = facts.findLast(({ event }) => event.status === 'MATCHED');
    if (matched) {
      const action = globalActions.find(({ event, index }) => index > matched.index && event.ruleId === rule.id);
      if (!action) return decorate({
        type: 'EXECUTE_RULE_ACTION',
        step,
        rule,
        requestedAction: matched.event.action,
        authorization: ruleAuthorization(rule, step.id),
        latestObservation: observationSummary(observation, execDir),
      });
      continue;
    }
    if (facts.some(({ event }) => event.status === 'SKIPPED')) continue;
    const lastSkippedIndex = lastIndex(events, (event) => event.type === 'rule'
      && event.ruleId === rule.id
      && eventStepId(event) === step.id
      && event.status === 'SKIPPED');
    const attempts = events.slice(lastSkippedIndex + 1).filter((event) => event.type === 'rule'
      && event.ruleId === rule.id
      && eventStepId(event) === step.id
      && event.status === 'MATCHED').length;
    return decorate({ type: 'DECIDE_RULE', step, rule, attempts, remainingAttempts: Math.max(0, rule.maxAttempts - attempts), latestObservation: observationSummary(observation, execDir) });
  }
  return null;
}

function reduceFlow(casePrecondition, planEntry, events, execDir, platform) {
  const preconditionId = casePrecondition.id;
  const flowId = planEntry.flowId;
  const related = events.filter((event) => event.preconditionId === preconditionId && event.flowId === flowId);
  const entryObservation = related.filter((event) => event.type === 'observation' && event.phase === 'entry-check').at(-1);
  const terminal = related.filter((event) => event.type === 'flow' && ['COMPLETED', 'FAILED', 'BLOCKED'].includes(event.status)).at(-1);
  if (terminal) return decorate({
    type: 'RECORD_FLOW_PRECONDITION_TERMINAL',
    preconditionId,
    flowId,
    flowStatus: terminal.status,
    failureCode: terminal.failureCode || null,
    reason: terminal.reason || '',
    evidenceObservation: terminal.evidenceObservation || null,
  });
  const started = related.some((event) => event.type === 'flow' && event.status === 'STARTED');
  if (!entryObservation) return decorate({ type: 'OBSERVE_FLOW_ENTRY', preconditionId, flowId, phase: 'entry-check' });
  if (!started) return decorate({ type: 'DECIDE_FLOW_ENTRY', preconditionId, flowId, startCondition: planEntry.flow?.startCondition || null, endCondition: planEntry.flow?.endCondition || null, latestObservation: observationSummary(entryObservation, execDir) });
  for (const step of planEntry.flow?.steps || []) {
    const stepEvents = related.filter((event) => event.flowStepId === step.id);
    if (stepEvents.some((event) => event.type === 'flow' && event.status === 'STEP_COMPLETED')) continue;
    const before = stepEvents.filter((event) => event.type === 'observation' && event.phase === 'before').at(-1);
    if (!before) return decorate({ type: 'OBSERVE_FLOW_BEFORE', preconditionId, flowId, flowStepId: step.id, phase: 'before' });
    const action = stepEvents.filter((event) => event.type === 'actionResult').at(-1);
    if (!action) {
      const next = { preconditionId, flowId, flowStepId: step.id, instruction: step.instruction || '', requestedAction: step.action, latestObservation: observationSummary(before, execDir) };
      const actionRejections = stepEvents.filter((event) => event.type === 'actionRejected');
      const latestRejection = actionRejections.at(-1) || null;
      if (actionRejections.length >= 2) {
        return decorate({
          type: 'RECORD_FLOW_ACTION_REJECTION_TERMINAL',
          ...next,
          failureCode: latestRejection.failureCode || 'ACTION_CONTRACT_INVALID',
          reason: `Flow 动作参数连续 ${actionRejections.length} 次不符合执行契约，已停止当前前置条件。`,
        });
      }
      if (latestRejection) {
        next.lastActionRejection = {
          count: actionRejections.length,
          phase: latestRejection.phase,
          failureCode: latestRejection.failureCode,
          reason: latestRejection.reason,
          field: latestRejection.field || null,
          received: latestRejection.received,
          allowed: latestRejection.allowed || [],
          suggestion: latestRejection.suggestion || null,
          attemptedAction: latestRejection.attemptedAction,
        };
        return decorate({ type: 'DECIDE_FLOW_ACTION', ...next });
      }
      try {
        validateActionExecution(step.action, { platform, scope: 'precondition-flow', context: 'frozen Flow action' });
        return decorate({ type: 'EXECUTE_FLOW_ACTION', ...next });
      } catch (_) {
        return decorate({ type: 'DECIDE_FLOW_ACTION', ...next });
      }
    }
    const after = stepEvents.filter((event) => event.type === 'observation' && event.phase === 'after').at(-1);
    if (!after) return decorate({ type: 'OBSERVE_FLOW_AFTER', preconditionId, flowId, flowStepId: step.id, phase: 'after' });
    return decorate({ type: 'RECORD_FLOW_STEP_COMPLETED', preconditionId, flowId, flowStepId: step.id, latestObservation: observationSummary(after, execDir) });
  }
  const endObservation = related.filter((event) => event.type === 'observation' && event.phase === 'end-check').at(-1);
  if (!endObservation) return decorate({ type: 'OBSERVE_FLOW_END', preconditionId, flowId, phase: 'end-check' });
  return decorate({ type: 'DECIDE_FLOW_END', preconditionId, flowId, endCondition: planEntry.flow?.endCondition || null, latestObservation: observationSummary(endObservation, execDir) });
}

function deriveNextWork({ caseJson, execution, events, execDir, preconditionInputs = [] }) {
  if (execution.finalized) return decorate({ type: 'STOP_FINALIZED', status: execution.status || null, resultPath: path.join(execDir, 'result.json'), metricsPath: path.join(execDir, 'metrics.json') });
  const planEntries = new Map((execution.preconditionPlan?.preconditions || []).map((item) => [item.id, item]));
  for (const item of caseJson.preconditions || []) {
    const fact = events.filter((event) => event.type === 'precondition' && event.id === item.id).at(-1);
    if (fact) {
      if (!['PASS', 'PREPARED'].includes(fact.status)) return decorate({ type: 'FINALIZE_PRECONDITION_BLOCKED', preconditionId: item.id, status: fact.status, failureCode: fact.failureCode || null });
      continue;
    }
    const planEntry = planEntries.get(item.id) || { id: item.id, resolution: item.checkMode || 'unknown' };
    if (planEntry.resolution === 'flow') return reduceFlow(item, planEntry, events, execDir, execution.environmentSnapshot?.binding?.platform);
    if (planEntry.resolution === 'framework') {
      const checked = evaluateFrameworkPrecondition(planEntry.checkerId, execution, events);
      return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: 'framework', checkerId: planEntry.checkerId, ...checked });
    }
    const input = preconditionInputs.find((entry) => entry.id === item.id) || null;
    if (input) return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: planEntry.resolution, status: input.status, reason: input.reason });
    if (planEntry.resolution === 'unsupported') return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: planEntry.resolution, status: 'BLOCKED', failureCode: 'PRECONDITION_UNSUPPORTED', reason: '当前前置条件不支持无人值守处理。' });
    const reason = planEntry.resolution === 'external_setup' ? '外部业务状态未在 execution 开始前准备完成。' : '前置条件未在无人值守开始前确认。';
    return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: planEntry.resolution, status: 'BLOCKED', failureCode: 'PRECONDITION_REQUIRED', reason });
  }
  for (const step of caseJson.steps) {
    const assertionIndex = lastIndex(events, (event) => event.type === 'assertion' && eventStepId(event) === step.id);
    const assertion = assertionIndex >= 0 ? events[assertionIndex] : null;
    if (assertion?.status === 'PASS') continue;
    if (assertion && ['FAIL', 'UNKNOWN'].includes(assertion.status)) return decorate({ type: 'FINALIZE_STEP_FAILURE', stepId: step.id, status: assertion.status, reason: assertion.reason || '' });
    const observationIndex = lastIndex(events, (event) => event.type === 'observation' && eventStepId(event) === step.id);
    const observation = observationIndex >= 0 ? events[observationIndex] : null;
    const actionIndex = lastIndex(events, (event) => event.type === 'actionResult' && event.scope !== 'global-rule' && eventStepId(event) === step.id);
    const decisionIndex = lastIndex(events, (event) => event.type === 'decision' && event.scope !== 'global-rule' && eventStepId(event) === step.id);
    const decision = decisionIndex >= 0 ? events[decisionIndex] : null;
    if (!observation) return decorate({ type: 'OBSERVE_STEP', step, phase: 'before' });
    if (actionIndex > observationIndex) return decorate({ type: 'OBSERVE_AFTER_ACTION', step, latestAction: events[actionIndex] });
    const ruleWork = reduceRules(caseJson, step, events, execDir, observation, observationIndex);
    if (ruleWork) return ruleWork;
    const observationEvidence = observation.artifacts?.screenshot || observation.observation?.artifacts?.screenshot || null;
    const actionRejections = events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => event.type === 'actionRejected'
        && eventStepId(event) === step.id
        && index > observationIndex
        && (!event.observation || !observationEvidence || event.observation === observationEvidence));
    const latestRejectionEntry = actionRejections.at(-1) || null;
    const lastActionRejection = latestRejectionEntry ? {
      count: actionRejections.length,
      phase: latestRejectionEntry.event.phase,
      failureCode: latestRejectionEntry.event.failureCode,
      reason: latestRejectionEntry.event.reason,
      field: latestRejectionEntry.event.field || null,
      received: latestRejectionEntry.event.received,
      allowed: latestRejectionEntry.event.allowed || [],
      suggestion: latestRejectionEntry.event.suggestion || null,
      attemptedAction: latestRejectionEntry.event.attemptedAction,
    } : null;
    if (actionRejections.length >= 2 && latestRejectionEntry.index > decisionIndex) {
      return decorate({
        type: 'FINALIZE_STEP_FAILURE',
        stepId: step.id,
        status: 'BLOCKED',
        failureCode: 'ACTION_CONTRACT_INVALID',
        reason: `动作参数连续 ${actionRejections.length} 次不符合执行契约，已停止当前用例。`,
      });
    }
    if (latestRejectionEntry && latestRejectionEntry.index > decisionIndex) {
      return decorate({
        type: 'DECIDE_STEP',
        step,
        stepIntent: buildStepIntent(step),
        latestObservation: observationSummary(observation, execDir),
        visualRetryContext: visualRetryContext(events, step.id, observation),
        lastActionRejection,
      });
    }
    if (decision?.decision === 'act' && decisionIndex > observationIndex && actionIndex < decisionIndex) {
      validateActionAuthorization(step, decision.authorization);
      return decorate({
        type: 'EXECUTE_STEP_ACTION',
        step,
        stepIntent: buildStepIntent(step),
        authorization: actionAuthorization(step),
        requestedAction: decision.action,
        decisionTurnId: decision.turnId || null,
        latestObservation: observationSummary(observation, execDir),
      });
    }
    return decorate({
      type: 'DECIDE_STEP',
      step,
      stepIntent: buildStepIntent(step),
      latestObservation: observationSummary(observation, execDir),
      visualRetryContext: visualRetryContext(events, step.id, observation),
      lastActionRejection,
    });
  }
  return decorate({ type: 'FINALIZE_PASS', reason: '所有业务步骤均已有 assertion PASS。' });
}

module.exports = { deriveNextWork, eventStepId, observationSummary };
