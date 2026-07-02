#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  appendJsonl,
  caseContractSha,
  caseRuntimeDir,
  ensureDir,
  nowIso,
  normalizePlatform,
  readJson,
  readJsonl,
  refreshIndexForCase,
  writeCaseReports,
  writeJson,
} = require('../common');

const VALID_STATUS = new Set(['PASS', 'FAIL', 'BLOCKED', 'UNKNOWN']);
const VALID_EVENT_TYPES = new Set([
  'executionStart',
  'environmentProbe',
  'precondition',
  'observation',
  'perception',
  'decision',
  'rule',
  'flowScan',
  'flow',
  'actionResult',
  'assertion',
  'popup',
  'appForeground',
  'budgetExceeded',
  'result',
]);
const VALID_DECISIONS = new Set(['act', 'assert_pass', 'assert_fail', 'wait', 'blocked']);
const VALID_ACTIONS = new Set(['launchApp', 'tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait']);
const VALID_RULE_STATUSES = new Set(['MATCHED', 'SKIPPED', 'FAILED', 'BLOCKED', 'UNKNOWN']);
const VALID_RULE_TYPES = new Set(['guard']);
const VALID_RULE_FAILURES = new Set(['BLOCKED', 'UNKNOWN', 'FAIL']);
const VALID_FLOW_SCAN_STATUSES = new Set(['COMPLETED', 'EMPTY', 'FAILED']);
const VALID_FLOW_STATUSES = new Set(['STARTED', 'STEP_STARTED', 'STEP_COMPLETED', 'COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED']);
const TERMINAL_FLOW_STATUSES = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED']);
const VALID_COORDINATE_SOURCES = new Set(['layout', 'visual', 'pixel', 'manual', 'flow']);
const FLOW_GATED_FAILURES = new Set(['PAGE_LOAD_BLOCKED', 'ACTION_TARGET_NOT_FOUND', 'APP_CONTEXT_LOST']);
const DEFAULT_BUDGET = {
  maxDurationMs: 20 * 60 * 1000,
  maxObservations: 80,
  maxActions: 60,
  maxStepEvents: 24,
  maxStepWaits: 8,
  maxKnownPopups: 5,
  maxNoChangeObservations: 5,
};

function usage() {
  console.error([
    'Usage:',
    '  run-case.js <case-dir> --platform <platform> --start',
    '  run-case.js <case-dir> --platform <platform> --check-budget --event-type <type> [--action <action>] [--step-id <step-id>] [--execution-id <id>]',
    '  run-case.js <case-dir> --platform <platform> --record-json <json> [--execution-id <id>]',
    '  run-case.js <case-dir> --platform <platform> --finalize --status <PASS|FAIL|BLOCKED|UNKNOWN> [--reason <text>] [--failure-code <code>] [--failed-step <step-id>] [--execution-id <id>]',
    '  run-case.js <case-dir> --platform <platform> --status <PASS|FAIL|BLOCKED|UNKNOWN> [--reason <text>] [--failure-code <code>] [--failed-step <step-id>]',
    '  run-case.js <case-dir> --legacy-runtime ...',
  ].join('\n'));
  process.exit(2);
}

function executionIdFromDate(date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
    '-',
    String(date.getMilliseconds()).padStart(3, '0'),
  ].join('');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function allocateExecutionId(caseDir) {
  for (let i = 0; i < 20; i++) {
    const executionId = executionIdFromDate();
    if (!fs.existsSync(path.join(caseDir, 'executions', executionId))) return executionId;
  }
  throw new Error('Failed to allocate unique execution id');
}

function createExecution(caseDir, executionId = executionIdFromDate()) {
  const execDir = path.join(caseDir, 'executions', executionId);
  ensureDir(path.join(execDir, 'screenshots'));
  ensureDir(path.join(execDir, 'layouts'));
  ensureDir(path.join(execDir, 'logs'));
  return { executionId, execDir };
}

function executionExists(caseDir, executionId) {
  return fs.existsSync(path.join(caseDir, 'executions', executionId));
}

function executionStatePath(execDir) {
  return path.join(execDir, 'execution.json');
}

function readExecutionState(execDir) {
  return readJson(executionStatePath(execDir), null);
}

function writeExecutionState(execDir, state) {
  writeJson(executionStatePath(execDir), state);
}

function latestExecutionId(caseDir) {
  const execRoot = path.join(caseDir, 'executions');
  if (!fs.existsSync(execRoot)) return null;
  const names = fs.readdirSync(execRoot).filter((name) => fs.statSync(path.join(execRoot, name)).isDirectory()).sort();
  return names.length ? names[names.length - 1] : null;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('record-json must be a JSON object');
  }
  const normalized = {
    time: event.time || nowIso(),
    ...event,
  };
  validateEvent(normalized);
  return normalized;
}

function actionType(event) {
  return event.action?.type || event.action;
}

function isSafeRelativeArtifact(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]+/).includes('..');
}

function validateArtifacts(event) {
  const artifacts = (event.observation || event).artifacts;
  if (!artifacts) return;
  const paths = [];
  if (artifacts.screenshot) paths.push(artifacts.screenshot);
  if (artifacts.layout) paths.push(artifacts.layout);
  if (Array.isArray(artifacts.logs)) paths.push(...artifacts.logs);
  for (const item of paths) {
    if (!isSafeRelativeArtifact(item)) {
      throw new Error(`Invalid artifact path: ${item}`);
    }
  }
}

function validateEvent(event) {
  if (!event.type || typeof event.type !== 'string') throw new Error('record-json missing required field: type');
  if (!VALID_EVENT_TYPES.has(event.type)) throw new Error(`Unsupported event type: ${event.type}`);
  if (event.time && Number.isNaN(new Date(event.time).getTime())) throw new Error(`Invalid event time: ${event.time}`);
  if (event.stepId && typeof event.stepId !== 'string') throw new Error('stepId must be a string');
  if (event.type === 'observation') {
    if (!event.label || typeof event.label !== 'string') throw new Error('observation missing required field: label');
    if (!event.artifacts || typeof event.artifacts !== 'object' || Array.isArray(event.artifacts)) throw new Error('observation missing required field: artifacts');
    validateArtifacts(event);
  }
  if (event.type === 'actionResult') {
    const action = actionType(event);
    if (!action || typeof action !== 'string') throw new Error('actionResult missing required field: action');
    if (!VALID_ACTIONS.has(action)) throw new Error(`Unsupported actionResult action: ${action}`);
    if (typeof event.ok !== 'boolean') throw new Error('actionResult missing required boolean field: ok');
    validateCoordinateMetadata(event, action);
  }
  if (event.type === 'decision') {
    if (!event.decision || !VALID_DECISIONS.has(event.decision)) throw new Error(`Unsupported decision: ${event.decision}`);
  }
  if (event.type === 'rule') {
    if (!event.ruleId || typeof event.ruleId !== 'string') throw new Error('rule event missing required field: ruleId');
    if (!event.status || !VALID_RULE_STATUSES.has(event.status)) throw new Error(`Unsupported rule status: ${event.status}`);
  }
  if (event.type === 'flowScan') {
    if (!event.status || !VALID_FLOW_SCAN_STATUSES.has(event.status)) throw new Error(`Unsupported flowScan status: ${event.status}`);
    if (event.source !== 'list-flows') throw new Error('flowScan source must be list-flows');
    if (!event.flowsRoot || typeof event.flowsRoot !== 'string') throw new Error('flowScan missing flowsRoot');
    if (!Array.isArray(event.scannedFlowIds) || !event.scannedFlowIds.every((item) => typeof item === 'string')) {
      throw new Error('flowScan scannedFlowIds must be a string array');
    }
    if (event.candidateCount !== undefined && (!Number.isInteger(event.candidateCount) || event.candidateCount < 0)) throw new Error('flowScan candidateCount must be a non-negative integer');
    if (event.candidateCount !== undefined && event.candidateCount !== event.scannedFlowIds.length) {
      throw new Error('flowScan candidateCount must match scannedFlowIds length');
    }
    if (event.matchedFlowIds !== undefined && (!Array.isArray(event.matchedFlowIds) || !event.matchedFlowIds.every((item) => typeof item === 'string'))) {
      throw new Error('flowScan matchedFlowIds must be a string array');
    }
    if (Array.isArray(event.matchedFlowIds)) {
      const scanned = new Set(event.scannedFlowIds);
      const unknown = event.matchedFlowIds.filter((flowId) => !scanned.has(flowId));
      if (unknown.length) throw new Error(`flowScan matchedFlowIds not found in scannedFlowIds: ${unknown.join(', ')}`);
    }
  }
  if (event.type === 'flow') {
    if (!event.flowId || typeof event.flowId !== 'string') throw new Error('flow event missing required field: flowId');
    if (!event.status || !VALID_FLOW_STATUSES.has(event.status)) throw new Error(`Unsupported flow status: ${event.status}`);
    if (event.flowStepId !== undefined && typeof event.flowStepId !== 'string') throw new Error('flowStepId must be a string');
  }
  if (event.type === 'assertion' && !['PASS', 'FAIL', 'UNKNOWN'].includes(event.status)) {
    throw new Error('assertion status must be PASS, FAIL, or UNKNOWN');
  }
  if (event.type === 'precondition' && !['PASS', 'PREPARED', 'FAIL', 'UNKNOWN', 'BLOCKED'].includes(event.status)) {
    throw new Error('precondition status must be PASS, PREPARED, FAIL, UNKNOWN, or BLOCKED');
  }
  validateArtifacts(event);
}

function validateCoordinateMetadata(event, action) {
  const hasCoordinates = event.x !== undefined || event.y !== undefined;
  if (!hasCoordinates) return;
  if (!['tap', 'toggle', 'longPress', 'inputText'].includes(action)) return;
  if (event.x === undefined || event.y === undefined) throw new Error('coordinate action requires both x and y');
  if (!event.coordinateSource || !VALID_COORDINATE_SOURCES.has(event.coordinateSource)) {
    throw new Error('coordinate action missing valid coordinateSource');
  }
  if (event.coordinateSource === 'manual') {
    throw new Error('manual coordinateSource is not allowed in case execution; use layout, visual, pixel, or flow');
  }
  if (!event.coordinateEvidence || typeof event.coordinateEvidence !== 'string') {
    throw new Error('coordinate action missing coordinateEvidence');
  }
  if ((event.coordinateSource === 'visual' || event.coordinateSource === 'pixel' || event.coordinateSource === 'flow') &&
    (!Array.isArray(event.targetBounds) || event.targetBounds.length !== 4 || !event.targetBounds.every((item) => Number.isFinite(Number(item))))) {
    throw new Error(`${event.coordinateSource} coordinate action requires targetBounds [x1,y1,x2,y2]`);
  }
}

function validateGlobalRules(caseJson) {
  const rules = caseJson.globalRules || [];
  if (!Array.isArray(rules)) throw new Error('case.json globalRules must be an array');
  const ids = new Set();
  for (const [index, rule] of rules.entries()) {
    const label = `globalRules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${label} must be an object`);
    if (!rule.id || typeof rule.id !== 'string') throw new Error(`${label}.id must be a string`);
    if (ids.has(rule.id)) throw new Error(`Duplicate globalRules id: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.type || !VALID_RULE_TYPES.has(rule.type)) throw new Error(`${label}.type must be guard`);
    if (!rule.scope || typeof rule.scope !== 'string') throw new Error(`${label}.scope must be a string`);
    if (rule.appliesTo !== undefined && rule.appliesTo !== 'any_step' && !(Array.isArray(rule.appliesTo) && rule.appliesTo.every((item) => typeof item === 'string'))) {
      throw new Error(`${label}.appliesTo must be "any_step" or a string array`);
    }
    if (rule.priority !== undefined && typeof rule.priority !== 'number') throw new Error(`${label}.priority must be a number`);
    if (rule.when === undefined || rule.when === null || rule.when === '') throw new Error(`${label}.when is required`);
    if (rule.then !== undefined) validateRuleThen(rule.then, label);
    if (rule.maxAttempts !== undefined && (!Number.isInteger(rule.maxAttempts) || rule.maxAttempts < 1)) throw new Error(`${label}.maxAttempts must be a positive integer`);
    if (rule.onFailure !== undefined && !VALID_RULE_FAILURES.has(rule.onFailure)) throw new Error(`${label}.onFailure must be BLOCKED, UNKNOWN, or FAIL`);
  }
}

function validateRuleThen(value, label) {
  if (typeof value === 'string') return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.then must be a string or object`);
  if (value.decision && !VALID_DECISIONS.has(value.decision)) throw new Error(`${label}.then.decision is unsupported: ${value.decision}`);
  if (value.action !== undefined) {
    if (!value.action || typeof value.action !== 'object' || Array.isArray(value.action)) throw new Error(`${label}.then.action must be an object`);
    if (!value.action.type || !VALID_ACTIONS.has(value.action.type)) throw new Error(`${label}.then.action.type is unsupported: ${value.action.type}`);
  }
}

function validateRuleEventAgainstCase(event, caseJson) {
  if (event.type !== 'rule') return;
  const rules = caseJson.globalRules || [];
  const known = rules.some((rule) => rule.id === event.ruleId);
  if (!known) throw new Error(`rule event references unknown globalRule: ${event.ruleId}`);
}

function budgetViolation(events, nextEvent, budget, startedAt) {
  const nextEvents = nextEvent ? [...events, nextEvent] : events;
  const now = new Date(nextEvent?.time || nowIso()).getTime();
  const started = new Date(startedAt || events[0]?.time || nowIso()).getTime();
  if (Number.isFinite(now) && Number.isFinite(started) && now - started > budget.maxDurationMs) {
    return { failureCode: 'CASE_TIMEOUT', reason: `case duration exceeded: ${now - started}ms > ${budget.maxDurationMs}ms` };
  }
  const observations = nextEvents.filter((event) => event.type === 'observation');
  if (observations.length > budget.maxObservations) {
    return { failureCode: 'EXECUTION_BUDGET_EXCEEDED', reason: `observation count exceeded: ${observations.length} > ${budget.maxObservations}` };
  }
  const actions = nextEvents.filter((event) => event.type === 'actionResult');
  if (actions.length > budget.maxActions) {
    return { failureCode: 'EXECUTION_BUDGET_EXCEEDED', reason: `action count exceeded: ${actions.length} > ${budget.maxActions}` };
  }
  const noChange = observations.filter((event) => event.noChange === true);
  if (noChange.length > budget.maxNoChangeObservations) {
    return { failureCode: 'EXECUTION_BUDGET_EXCEEDED', reason: `no-change observation count exceeded: ${noChange.length} > ${budget.maxNoChangeObservations}` };
  }
  const knownPopups = nextEvents.filter((event) => event.type === 'popup' && event.status === 'HANDLED');
  if (knownPopups.length > budget.maxKnownPopups) {
    return { failureCode: 'EXECUTION_BUDGET_EXCEEDED', reason: `known popup count exceeded: ${knownPopups.length} > ${budget.maxKnownPopups}` };
  }
  const byStep = new Map();
  for (const event of nextEvents) {
    const stepId = event.stepId || event.step?.id;
    if (!stepId) continue;
    const item = byStep.get(stepId) || { total: 0, waits: 0 };
    if (['observation', 'decision', 'rule', 'flowScan', 'flow', 'actionResult', 'assertion', 'perception'].includes(event.type)) item.total += 1;
    if (event.type === 'actionResult' && actionType(event) === 'wait') item.waits += 1;
    byStep.set(stepId, item);
  }
  for (const [stepId, item] of byStep.entries()) {
    if (item.total > budget.maxStepEvents) {
      return { failureCode: 'EXECUTION_BUDGET_EXCEEDED', reason: `step event count exceeded for ${stepId}: ${item.total} > ${budget.maxStepEvents}` };
    }
    if (item.waits > budget.maxStepWaits) {
      return { failureCode: 'EXECUTION_BUDGET_EXCEEDED', reason: `step wait count exceeded for ${stepId}: ${item.waits} > ${budget.maxStepWaits}` };
    }
  }
  return null;
}

function stepRequiresAssertion(step) {
  return step?.kind === 'assertion' || (Array.isArray(step?.assertions) && step.assertions.length > 0);
}

function stepEvidence(events, step) {
  const stepId = step.id;
  return events.some((event) => {
    const eventStepId = event.stepId || event.step?.id;
    if (eventStepId !== stepId) return false;
    if (event.type === 'assertion') return event.status === 'PASS';
    if (stepRequiresAssertion(step)) return false;
    if (event.type === 'actionResult') return event.ok === true;
    return false;
  });
}

function passReadiness(caseJson, events) {
  const missing = caseJson.steps
    .filter((step) => !stepEvidence(events, step))
    .map((step) => step.id);
  if (missing.length) {
    return {
      ok: false,
      failureCode: 'ASSERTION_UNKNOWN',
      reason: `PASS 缺少步骤证据: ${missing.join(', ')}`,
      failedStep: missing[0],
    };
  }
  return { ok: true };
}

function statusFromEvents(caseJson, events, fallbackStatus) {
  if (fallbackStatus !== 'PASS') return fallbackStatus;
  const failedAssertion = events.find((event) => event.type === 'assertion' && event.status === 'FAIL');
  if (failedAssertion) return 'FAIL';
  return passReadiness(caseJson, events).ok ? fallbackStatus : 'UNKNOWN';
}

function countArtifacts(events) {
  const artifacts = { screenshots: 0, layouts: 0, logs: 0 };
  for (const event of events) {
    if (event.type !== 'observation') continue;
    const data = event.observation || event;
    const eventArtifacts = data.artifacts || {};
    if (eventArtifacts.screenshot) artifacts.screenshots += 1;
    if (eventArtifacts.layout) artifacts.layouts += 1;
    if (Array.isArray(eventArtifacts.logs)) artifacts.logs += eventArtifacts.logs.length;
  }
  return artifacts;
}

function buildMetrics(caseJson, state, events, result, executionState = {}) {
  const actionTypes = ['tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'launchApp', 'wait', 'home'];
  const actions = { total: 0, tap: 0, toggle: 0, longPress: 0, inputText: 0, swipe: 0, back: 0, launchApp: 0, wait: 0, home: 0 };
  for (const event of events) {
    if (event.type !== 'actionResult') continue;
    const action = actionType(event);
    actions.total += 1;
    if (actionTypes.includes(action)) actions[action] += 1;
  }

  const preconditions = {
    total: caseJson.preconditions.length,
    passed: 0,
    prepared: 0,
    failed: 0,
    unknown: 0,
  };
  for (const event of events) {
    if (event.type !== 'precondition') continue;
    if (event.status === 'PASS') preconditions.passed += 1;
    else if (event.status === 'PREPARED') preconditions.prepared += 1;
    else if (event.status === 'FAIL') preconditions.failed += 1;
    else preconditions.unknown += 1;
  }

  const stepStatus = new Map();
  const stepById = new Map(caseJson.steps.map((step) => [step.id, step]));
  for (const event of events) {
    const stepId = event.stepId || event.step?.id;
    if (!stepId) continue;
    if (event.type === 'assertion') {
      if (event.status === 'PASS') stepStatus.set(stepId, 'passed');
      else if (event.status === 'FAIL') stepStatus.set(stepId, 'failed');
      else if (event.status === 'UNKNOWN') stepStatus.set(stepId, 'unknown');
    } else if (event.type === 'decision' && event.decision === 'blocked') {
      stepStatus.set(stepId, 'blocked');
    } else if (event.type === 'actionResult' && event.ok !== false && !stepRequiresAssertion(stepById.get(stepId))) {
      stepStatus.set(stepId, 'passed');
    }
  }
  const failedStepKnown = result.failedStep && stepStatus.has(result.failedStep);
  const steps = {
    total: caseJson.steps.length,
    passed: Array.from(stepStatus.values()).filter((value) => value === 'passed').length,
    failed: Array.from(stepStatus.values()).filter((value) => value === 'failed').length + (result.failedStep && !failedStepKnown ? 1 : 0),
    blocked: Array.from(stepStatus.values()).filter((value) => value === 'blocked').length + (result.status === 'BLOCKED' && !failedStepKnown ? 1 : 0),
    unknown: Array.from(stepStatus.values()).filter((value) => value === 'unknown').length + (result.status === 'UNKNOWN' && !failedStepKnown ? 1 : 0),
    skipped: 0,
    failedStepId: result.failedStep || null,
  };
  if (result.status === 'PASS') steps.passed = caseJson.steps.length;
  const completed = Math.min(steps.passed + steps.failed + steps.blocked + steps.unknown, caseJson.steps.length);
  steps.skipped = result.status === 'PASS' ? 0 : Math.max(caseJson.steps.length - completed, 0);

  const stability = {
    appForegroundLossCount: events.filter((event) => event.type === 'appForeground' && event.status === 'LEFT_TARGET').length,
    appRelaunchCount: actions.launchApp,
    noChangeObservationCount: events.filter((event) => event.type === 'observation' && event.noChange === true).length,
    knownPopupHandledCount: events.filter((event) => event.type === 'popup' && event.status === 'HANDLED').length,
    unknownPopupCount: events.filter((event) => event.type === 'popup' && event.status !== 'HANDLED').length,
  };
  const flowEvents = events.filter((event) => event.type === 'flow');
  const flowScanEvents = events.filter((event) => event.type === 'flowScan');
  const flows = {
    totalEvents: flowEvents.length,
    scans: flowScanEvents.length,
    matched: flowScanEvents.filter((event) => Array.isArray(event.matchedFlowIds) && event.matchedFlowIds.length > 0).length,
    started: flowEvents.filter((event) => event.status === 'STARTED').length,
    completed: flowEvents.filter((event) => event.status === 'COMPLETED').length,
    failed: flowEvents.filter((event) => event.status === 'FAILED').length,
    blocked: flowEvents.filter((event) => event.status === 'BLOCKED').length,
  };

  return {
    schemaVersion: 1,
    caseKey: caseJson.identity.caseKey,
    executionId: result.executionId,
    sourceSha1: caseJson.identity.sourceSha1,
    caseContractSha: caseContractSha(caseJson),
    status: result.status,
    failureCode: result.failureCode,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: Math.max(new Date(result.endedAt).getTime() - new Date(result.startedAt).getTime(), 0),
    environment: state.environment || {},
    preconditions,
    steps,
    actions,
    flows,
    stability,
    artifacts: countArtifacts(events),
    budget: executionState.budget || DEFAULT_BUDGET,
    eventCounts: events.reduce((acc, event) => {
      acc[event.type || 'unknown'] = (acc[event.type || 'unknown'] || 0) + 1;
      return acc;
    }, {}),
  };
}

function finalize(caseDir, options) {
  const runtimeDir = caseRuntimeDir(caseDir, options.platform);
  const caseJson = readJson(path.join(caseDir, 'case.json'));
  if (!caseJson) throw new Error(`Missing case.json in ${caseDir}`);
  validateGlobalRules(caseJson);
  const statePath = path.join(runtimeDir, 'state.json');
  const state = readJson(statePath, { schemaVersion: 1, executionCount: 0, statusCounts: { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 }, environment: {} });
  let executionId = options.executionId || latestExecutionId(runtimeDir);
  if (!executionId) {
    if (!options.legacyRuntime) {
      throw new Error('No started execution exists. Run --start first or pass --execution-id.');
    }
    executionId = allocateExecutionId(runtimeDir);
  }
  if (options.executionId && !executionExists(runtimeDir, options.executionId) && !options.legacyRuntime) {
    throw new Error(`Execution was not started: ${options.executionId}`);
  }
  const { execDir } = createExecution(runtimeDir, executionId);
  const executionState = readExecutionState(execDir) || {};
  if (!options.legacyRuntime && !executionState.schemaVersion) {
    throw new Error(`Execution was not started: ${executionId}`);
  }
  const timelinePath = path.join(execDir, 'timeline.jsonl');
  const existingEvents = readJsonl(timelinePath);
  const existingResult = readJson(path.join(execDir, 'result.json'), null);
  const hasResultEvent = existingEvents.some((event) => event.type === 'result');
  const startedAt = options.startedAt || existingEvents[0]?.time || nowIso();
  const endedAt = nowIso();
  let status = options.status || 'BLOCKED';
  if (!VALID_STATUS.has(status)) throw new Error(`Invalid status: ${status}`);
  if ((executionState.finalized || existingResult || hasResultEvent) && !options.allowAlreadyFinalized) {
    return { executionId, execDir, result: path.join(execDir, 'result.json'), metrics: path.join(execDir, 'metrics.json'), timeline: timelinePath, alreadyFinalized: true };
  }
  const eventsBeforeResult = existingEvents.filter((event) => event.type !== 'result');
  const requestedStatus = status;
  const flowReadiness = flowFailureReadiness(eventsBeforeResult, options.failureCode, options.failedStep);
  if (!flowReadiness.ok) {
    status = 'UNKNOWN';
    options.failureCode = flowReadiness.failureCode;
    options.reason = flowReadiness.reason;
  }
  status = statusFromEvents(caseJson, eventsBeforeResult, status);
  const readiness = requestedStatus === 'PASS' ? passReadiness(caseJson, eventsBeforeResult) : { ok: true };
  const result = {
    schemaVersion: 1,
    executionId,
    caseKey: caseJson.identity.caseKey,
    platform: options.platform || state.environment?.platform || null,
    sourceSha1: caseJson.identity.sourceSha1,
    caseContractSha: caseContractSha(caseJson),
    status,
    failureCode: readiness.ok ? (options.failureCode || null) : readiness.failureCode,
    startedAt,
    endedAt,
    failedStep: readiness.ok ? (options.failedStep || null) : readiness.failedStep,
    reason: readiness.ok ? (options.reason || (status === 'PASS' ? '执行通过。' : 'Execution finalized by agent.')) : readiness.reason,
    environment: state.environment || {},
    evidence: options.evidence || [],
  };
  const resultEvent = { time: endedAt, type: 'result', status, reason: result.reason, failedStep: result.failedStep, failureCode: result.failureCode };
  appendJsonl(timelinePath, resultEvent);
  const events = [...eventsBeforeResult, resultEvent];
  const metrics = buildMetrics(caseJson, state, events, result, executionState);

  writeJson(path.join(execDir, 'result.json'), result);
  writeJson(path.join(execDir, 'metrics.json'), metrics);

  state.executionCount = (state.executionCount || 0) + 1;
  state.latestStatus = status;
  state.latestExecutionId = executionId;
  state.latestFailedStep = result.failedStep;
  state.latestFailureCode = result.failureCode;
  state.statusCounts = state.statusCounts || { PASS: 0, FAIL: 0, BLOCKED: 0, UNKNOWN: 0 };
  state.statusCounts[status] = (state.statusCounts[status] || 0) + 1;
  if (status === 'PASS') state.lastPassedAt = endedAt;
  if (status !== 'PASS') state.lastFailedAt = endedAt;
  writeJson(statePath, state);
  writeExecutionState(execDir, {
    schemaVersion: 1,
    executionId,
    startedAt,
    endedAt,
    finalized: true,
    status,
    failureCode: result.failureCode,
    budget: executionState.budget || DEFAULT_BUDGET,
  });

  const notes = readJsonl(path.join(caseDir, 'notes.jsonl'));
  writeCaseReports(caseDir, caseJson, state, notes, { result, metrics, events }, { platform: options.platform });
  refreshIndexForCase(caseDir);
  return { executionId, execDir, result: path.join(execDir, 'result.json'), metrics: path.join(execDir, 'metrics.json'), timeline: timelinePath };
}

function flowFailureReadiness(events, failureCode, failedStep) {
  if (!FLOW_GATED_FAILURES.has(failureCode)) return { ok: true };
  if (!failedStep) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_MISSING',
      reason: `缺少失败步骤和 Flow 扫描事实，不能直接判定 ${failureCode}。`,
    };
  }
  const scans = events.filter((event) => event.type === 'flowScan' && event.stepId === failedStep);
  if (!scans.length) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_MISSING',
      reason: `缺少 Flow 扫描事实，不能直接判定 ${failureCode}。`,
    };
  }
  const matchedFlowIds = Array.from(new Set(scans.flatMap((event) => Array.isArray(event.matchedFlowIds) ? event.matchedFlowIds : [])));
  if (!matchedFlowIds.length) return { ok: true };
  const unresolved = matchedFlowIds.filter((flowId) => !events.some((event) => {
    return event.type === 'flow' &&
      event.stepId === failedStep &&
      event.flowId === flowId &&
      TERMINAL_FLOW_STATUSES.has(event.status);
  }));
  if (!unresolved.length) return { ok: true };
  return {
    ok: false,
    failureCode: 'FLOW_MATCH_UNRESOLVED',
    reason: `命中的 Flow 缺少完成、跳过、失败或阻塞事实，不能直接判定 ${failureCode}: ${unresolved.join(', ')}。`,
  };
}

function actionRequiresFlowScan(action) {
  return action && !['launchApp', 'wait'].includes(action);
}

function flowScanActionReadiness(events, action, stepId) {
  if (!actionRequiresFlowScan(action)) return { ok: true };
  if (!events.some((event) => event.type === 'flowScan')) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_REQUIRED',
      reason: '业务动作前必须先写入 flowScan 事实。',
    };
  }
  if (stepId && !events.some((event) => event.type === 'flowScan' && event.stepId === stepId)) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_REQUIRED',
      reason: `业务动作前缺少当前步骤的 flowScan 事实: ${stepId}。全局扫描只用于建立候选库，不能替代步骤级扫描。`,
    };
  }
  return { ok: true };
}

function requiredEnvironmentDependencies(platform) {
  if (platform === 'android') return ['mavtInputIme'];
  return [];
}

function missingEnvironmentDependencies(state, platform) {
  const dependencies = state?.dependencies || {};
  return requiredEnvironmentDependencies(platform).filter((id) => !dependencies[id]?.ok);
}

function findUnfinalizedExecution(caseDir) {
  const casesDir = path.dirname(caseDir);
  if (!fs.existsSync(casesDir)) return null;
  for (const caseName of fs.readdirSync(casesDir).sort()) {
    const currentCaseDir = path.join(casesDir, caseName);
    if (!fs.statSync(currentCaseDir).isDirectory()) continue;
    for (const runtime of caseRuntimeDirs(currentCaseDir)) {
      const execRoot = path.join(runtime.runtimeDir, 'executions');
      if (!fs.existsSync(execRoot)) continue;
      for (const executionId of fs.readdirSync(execRoot).sort()) {
        const execDir = path.join(execRoot, executionId);
        if (!fs.statSync(execDir).isDirectory()) continue;
        const executionState = readExecutionState(execDir);
        if (executionState && executionState.finalized === false) {
          return { caseDir: currentCaseDir, platform: runtime.platform, executionId, execDir };
        }
      }
    }
  }
  return null;
}

function caseRuntimeDirs(caseDir) {
  const items = [{ platform: '', runtimeDir: caseDir }];
  const platformsDir = path.join(caseDir, 'platforms');
  if (fs.existsSync(platformsDir)) {
    for (const name of fs.readdirSync(platformsDir).sort()) {
      const platform = normalizePlatform(name);
      const runtimeDir = path.join(platformsDir, name);
      if (platform && fs.statSync(runtimeDir).isDirectory()) items.push({ platform, runtimeDir });
    }
  }
  return items;
}

const args = process.argv.slice(2);
if (!args.length) usage();
const caseDir = path.resolve(args[0]);
const options = { evidence: [] };
let command = null;

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case '--start': command = 'start'; break;
    case '--platform': options.platform = normalizePlatform(args[++i]); if (!options.platform) usage(); break;
    case '--check-budget': command = 'checkBudget'; break;
    case '--event-type': options.eventType = args[++i]; break;
    case '--action': options.action = args[++i]; break;
    case '--step-id': options.stepId = args[++i]; break;
    case '--record-json': command = 'record'; options.recordJson = args[++i]; break;
    case '--finalize': command = 'finalize'; break;
    case '--legacy-runtime': options.legacyRuntime = true; break;
    case '--execution-id': options.executionId = args[++i]; break;
    case '--status': options.status = args[++i]; if (!command) command = 'finalize'; break;
    case '--reason': options.reason = args[++i]; break;
    case '--failure-code': options.failureCode = args[++i]; break;
    case '--failed-step': options.failedStep = args[++i]; break;
    case '--evidence': options.evidence.push(args[++i]); break;
    default: usage();
  }
}

try {
  if (!options.platform && !options.legacyRuntime) {
    throw new Error('Missing --platform. 正式执行必须写入 cases/<case>/platforms/<platform>/；旧根运行态请显式传 --legacy-runtime。');
  }
  if (command === 'start') {
    const runtimeDir = caseRuntimeDir(caseDir, options.platform);
    const caseJson = readJson(path.join(caseDir, 'case.json'));
    if (!caseJson) throw new Error(`Missing case.json in ${caseDir}`);
    validateGlobalRules(caseJson);
    const state = readJson(path.join(runtimeDir, 'state.json'), null);
    const missingEnv = requiredEnvironmentFields(state).filter((field) => !state?.environment?.[field]);
    if (!state?.environmentConfirmedAt || missingEnv.length) {
      throw new Error(`Environment is not confirmed. Run update-env.js first. Missing: ${missingEnv.join(', ') || 'environmentConfirmedAt'}`);
    }
    const missingDependencies = missingEnvironmentDependencies(state, options.platform);
    if (missingDependencies.length) {
      throw new Error(`Environment dependencies are not prepared. Run scripts/prepare-env.sh --case-dir <case-dir> --platform ${options.platform} before --start. Missing: ${missingDependencies.join(', ')}`);
    }
    const active = findUnfinalizedExecution(caseDir);
    if (active) {
      throw new Error(`Unfinalized execution exists: ${active.executionId} in ${active.caseDir}. Finalize it before starting another execution.`);
    }
    if (options.executionId && executionExists(runtimeDir, options.executionId)) {
      throw new Error(`Execution already exists: ${options.executionId}`);
    }
    const { executionId, execDir } = createExecution(runtimeDir, options.executionId || allocateExecutionId(runtimeDir));
    writeExecutionState(execDir, {
      schemaVersion: 1,
      executionId,
      startedAt: nowIso(),
      finalized: false,
      budget: DEFAULT_BUDGET,
    });
    appendJsonl(path.join(execDir, 'timeline.jsonl'), {
      time: nowIso(),
      type: 'executionStart',
      executionId,
      platform: options.platform || state.environment?.platform || null,
      caseKey: caseJson.identity.caseKey,
      sourceSha1: caseJson.identity.sourceSha1,
      caseContractSha: caseContractSha(caseJson),
    });
    console.log(JSON.stringify({ executionId, execDir, timeline: path.join(execDir, 'timeline.jsonl') }, null, 2));
  } else if (command === 'checkBudget') {
    const runtimeDir = caseRuntimeDir(caseDir, options.platform);
    const executionId = options.executionId || latestExecutionId(runtimeDir);
    if (!executionId) throw new Error('No execution exists. Run --start first or pass --execution-id.');
    const { execDir } = createExecution(runtimeDir, executionId);
    const executionState = readExecutionState(execDir);
    if (!executionState) throw new Error(`Execution was not started: ${executionId}`);
    if (executionState?.finalized) throw new Error(`Execution already finalized: ${executionId}`);
    if (!options.eventType) throw new Error('Missing --event-type');
    const event = normalizeEvent({
      type: options.eventType,
      stepId: options.stepId,
      label: options.eventType === 'observation' ? 'budget-precheck' : undefined,
      artifacts: options.eventType === 'observation' ? {} : undefined,
      action: options.eventType === 'actionResult' ? options.action : undefined,
      ok: options.eventType === 'actionResult' ? true : undefined,
    });
    const timelinePath = path.join(execDir, 'timeline.jsonl');
    const events = readJsonl(timelinePath);
    const flowScanReady = flowScanActionReadiness(events, options.action, options.stepId);
    if (!flowScanReady.ok) {
      throw new Error(`${flowScanReady.failureCode}: ${flowScanReady.reason}`);
    }
    const violation = budgetViolation(events, event, executionState?.budget || DEFAULT_BUDGET, executionState?.startedAt);
    if (violation) {
      const budgetEvent = {
        time: nowIso(),
        type: 'budgetExceeded',
        status: 'BLOCKED',
        failureCode: violation.failureCode,
        reason: violation.reason,
      };
      appendJsonl(timelinePath, budgetEvent);
      const finalized = finalize(caseDir, {
        platform: options.platform,
        executionId,
        status: 'BLOCKED',
        failureCode: violation.failureCode,
        reason: violation.reason,
        allowAlreadyFinalized: true,
      });
      console.error(JSON.stringify({ executionId, budgetExceeded: true, ...violation, finalized }, null, 2));
      process.exit(3);
    }
    console.log(JSON.stringify({ executionId, budgetOk: true, eventType: options.eventType }, null, 2));
  } else if (command === 'record') {
    const runtimeDir = caseRuntimeDir(caseDir, options.platform);
    const executionId = options.executionId || latestExecutionId(runtimeDir);
    if (!executionId) throw new Error('No execution exists. Run --start first or pass --execution-id.');
    const { execDir } = createExecution(runtimeDir, executionId);
    const executionState = readExecutionState(execDir);
    if (!executionState) throw new Error(`Execution was not started: ${executionId}`);
    if (executionState?.finalized) throw new Error(`Execution already finalized: ${executionId}`);
    const caseJson = readJson(path.join(caseDir, 'case.json'));
    if (!caseJson) throw new Error(`Missing case.json in ${caseDir}`);
    validateGlobalRules(caseJson);
    const event = normalizeEvent(JSON.parse(options.recordJson));
    validateRuleEventAgainstCase(event, caseJson);
    const timelinePath = path.join(execDir, 'timeline.jsonl');
    const events = readJsonl(timelinePath);
    const budget = executionState?.budget || DEFAULT_BUDGET;
    const violation = budgetViolation(events, event, budget, executionState?.startedAt);
    if (violation) {
      const budgetEvent = {
        time: nowIso(),
        type: 'budgetExceeded',
        status: 'BLOCKED',
        failureCode: violation.failureCode,
        reason: violation.reason,
      };
      appendJsonl(timelinePath, budgetEvent);
      const finalized = finalize(caseDir, {
        platform: options.platform,
        executionId,
        status: 'BLOCKED',
        failureCode: violation.failureCode,
        reason: violation.reason,
        allowAlreadyFinalized: true,
      });
      console.error(JSON.stringify({ executionId, budgetExceeded: true, ...violation, finalized }, null, 2));
      process.exit(3);
    }
    appendJsonl(timelinePath, event);
    console.log(JSON.stringify({ executionId, eventType: event.type || 'unknown', timeline: path.join(execDir, 'timeline.jsonl') }, null, 2));
  } else if (command === 'finalize') {
    console.log(JSON.stringify(finalize(caseDir, options), null, 2));
  } else {
    usage();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function requiredEnvironmentFields(state) {
  if (!state?.environment) return ['platform', 'device', 'appId', 'entry'];
  return ['platform', 'device', 'appId', 'entry'];
}
