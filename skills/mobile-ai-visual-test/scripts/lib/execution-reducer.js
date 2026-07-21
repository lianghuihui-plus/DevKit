#!/usr/bin/env node
'use strict';

const path = require('path');
const { operationClass, validateNextWork } = require('./next-work-contract');

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

function reduceFlow(casePrecondition, planEntry, events, execDir) {
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
    if (!action) return decorate({ type: 'EXECUTE_FLOW_ACTION', preconditionId, flowId, flowStepId: step.id, instruction: step.instruction || '', requestedAction: step.action, latestObservation: observationSummary(before, execDir) });
    const after = stepEvents.filter((event) => event.type === 'observation' && event.phase === 'after').at(-1);
    if (!after) return decorate({ type: 'OBSERVE_FLOW_AFTER', preconditionId, flowId, flowStepId: step.id, phase: 'after' });
    return decorate({ type: 'RECORD_FLOW_STEP_COMPLETED', preconditionId, flowId, flowStepId: step.id, latestObservation: observationSummary(after, execDir) });
  }
  const endObservation = related.filter((event) => event.type === 'observation' && event.phase === 'end-check').at(-1);
  if (!endObservation) return decorate({ type: 'OBSERVE_FLOW_END', preconditionId, flowId, phase: 'end-check' });
  return decorate({ type: 'DECIDE_FLOW_END', preconditionId, flowId, endCondition: planEntry.flow?.endCondition || null, latestObservation: observationSummary(endObservation, execDir) });
}

function deriveNextWork({ caseJson, execution, events, execDir, confirmedPreconditions = [] }) {
  if (execution.finalized) return decorate({ type: 'STOP_FINALIZED', status: execution.status || null, resultPath: path.join(execDir, 'result.json'), metricsPath: path.join(execDir, 'metrics.json') });
  const planEntries = new Map((execution.preconditionPlan?.preconditions || []).map((item) => [item.id, item]));
  for (const item of caseJson.preconditions || []) {
    const fact = events.filter((event) => event.type === 'precondition' && event.id === item.id).at(-1);
    if (fact) {
      if (!['PASS', 'PREPARED'].includes(fact.status)) return decorate({ type: 'FINALIZE_PRECONDITION_BLOCKED', preconditionId: item.id, status: fact.status, failureCode: fact.failureCode || null });
      continue;
    }
    const planEntry = planEntries.get(item.id) || { id: item.id, resolution: item.checkMode || 'unknown' };
    if (planEntry.resolution === 'flow') return reduceFlow(item, planEntry, events, execDir);
    const confirmed = confirmedPreconditions.find((entry) => entry.id === item.id) || null;
    if (confirmed) return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: planEntry.resolution, status: confirmed.status, reason: confirmed.reason });
    if (planEntry.resolution === 'unsupported') return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: planEntry.resolution, status: 'BLOCKED', failureCode: 'PRECONDITION_UNSUPPORTED', reason: '当前前置条件不支持无人值守处理。' });
    return decorate({ type: 'RECORD_PRECONDITION', preconditionId: item.id, text: item.text, resolution: planEntry.resolution, status: 'BLOCKED', failureCode: 'PRECONDITION_REQUIRED', reason: '前置条件未在无人值守开始前确认。' });
  }
  for (const step of caseJson.steps) {
    const assertionIndex = lastIndex(events, (event) => event.type === 'assertion' && eventStepId(event) === step.id);
    const assertion = assertionIndex >= 0 ? events[assertionIndex] : null;
    if (assertion?.status === 'PASS') continue;
    if (assertion && ['FAIL', 'UNKNOWN'].includes(assertion.status)) return decorate({ type: 'FINALIZE_STEP_FAILURE', stepId: step.id, status: assertion.status, reason: assertion.reason || '' });
    const observationIndex = lastIndex(events, (event) => event.type === 'observation' && eventStepId(event) === step.id);
    const observation = observationIndex >= 0 ? events[observationIndex] : null;
    const actionIndex = lastIndex(events, (event) => event.type === 'actionResult' && eventStepId(event) === step.id);
    const decisionIndex = lastIndex(events, (event) => event.type === 'decision' && eventStepId(event) === step.id);
    const decision = decisionIndex >= 0 ? events[decisionIndex] : null;
    if (!observation) return decorate({ type: 'OBSERVE_STEP', step, phase: 'before' });
    if (actionIndex > observationIndex) return decorate({ type: 'OBSERVE_AFTER_ACTION', step, latestAction: events[actionIndex] });
    if (decision?.decision === 'act' && decisionIndex > observationIndex && actionIndex < decisionIndex) {
      return decorate({ type: 'EXECUTE_STEP_ACTION', step, requestedAction: decision.action, latestObservation: observationSummary(observation, execDir) });
    }
    return decorate({
      type: 'DECIDE_STEP',
      step,
      latestObservation: observationSummary(observation, execDir),
      visualRetryContext: visualRetryContext(events, step.id, observation),
    });
  }
  return decorate({ type: 'FINALIZE_PASS', reason: '所有业务步骤均已有 assertion PASS。' });
}

module.exports = { deriveNextWork, eventStepId, observationSummary };
