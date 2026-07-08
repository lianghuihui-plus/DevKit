#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
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
const PRECONDITION_PASSING_STATUSES = new Set(['PASS', 'PREPARED']);
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
const VALID_ACTIONS = new Set(['launchApp', 'restartApp', 'tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'wait']);
const STEP_EVIDENCE_ACTIONS = new Set(['tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back']);
const VALID_RULE_STATUSES = new Set(['MATCHED', 'SKIPPED', 'FAILED', 'BLOCKED', 'UNKNOWN']);
const VALID_RULE_TYPES = new Set(['guard']);
const VALID_RULE_FAILURES = new Set(['BLOCKED', 'UNKNOWN', 'FAIL']);
const VALID_FLOW_SCAN_STATUSES = new Set(['COMPLETED', 'EMPTY', 'FAILED']);
const VALID_FLOW_STATUSES = new Set(['STARTED', 'STEP_STARTED', 'STEP_COMPLETED', 'COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED']);
const TERMINAL_FLOW_STATUSES = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED']);
const VALID_COORDINATE_SOURCES = new Set(['layout', 'visual', 'pixel', 'manual', 'flow']);
const FLOW_GATED_FAILURES = new Set(['PAGE_LOAD_BLOCKED', 'ACTION_TARGET_NOT_FOUND', 'APP_CONTEXT_LOST']);
const RESTART_SENSITIVE_PATTERN = /(首次|初次|第一次|新用户|无年级|重启|重新进入|再次进入|冷启动|启动后|同一次\s*App\s*启动|同一次app启动|默认开启|默认关闭|默认初始化|初始化|缓存|会话态|启动态|first\s*(launch|open|entry|start)|restart|cold\s*start|relaunch|initial|default)/i;
const STEP_ORDER_GUARDED_EVENT_TYPES = new Set([
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
]);
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
    '  run-case.js <case-dir> --platform <platform> --check-budget --event-type <type> [--action <action>] [--step-id <step-id>] [--scope global] [--execution-id <id>]',
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

function eventStepId(event) {
  return event?.stepId || event?.step?.id || '';
}

function eventArtifacts(event) {
  return (event?.observation || event || {}).artifacts || {};
}

function normalizeEvidenceValue(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function assertionEvidenceRefs(event) {
  const refs = [];
  if (Array.isArray(event.evidence)) refs.push(...event.evidence);
  if (typeof event.evidence === 'string') refs.push(event.evidence);
  if (event.evidenceObservation) refs.push(event.evidenceObservation);
  if (Array.isArray(event.evidenceObservations)) refs.push(...event.evidenceObservations);
  return refs.map(normalizeEvidenceValue).filter(Boolean);
}

function observationEvidenceValues(event) {
  const observation = event.observation || event;
  const artifacts = eventArtifacts(event);
  const values = [
    observation.label,
    artifacts.screenshot,
    artifacts.layout,
    ...(Array.isArray(artifacts.logs) ? artifacts.logs : []),
  ];
  return new Set(values.map(normalizeEvidenceValue).filter(Boolean));
}

function observationMatchesEvidenceRef(observation, ref) {
  return observationEvidenceValues(observation).has(normalizeEvidenceValue(ref));
}

function observationArtifactRefs(observation) {
  return new Set(artifactPaths(observation).map(normalizeEvidenceValue).filter(Boolean));
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

function artifactPaths(event) {
  const artifacts = (event.observation || event).artifacts || {};
  const paths = [];
  if (artifacts.screenshot) paths.push(artifacts.screenshot);
  if (artifacts.layout) paths.push(artifacts.layout);
  if (Array.isArray(artifacts.logs)) paths.push(...artifacts.logs);
  return paths;
}

function validateArtifactFilesExist(execDir, event) {
  if (!event || event.type !== 'observation') return;
  for (const item of artifactPaths(event)) {
    const file = path.join(execDir, item);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`OBSERVATION_ARTIFACT_MISSING: observation artifact does not exist: ${item}`);
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
    validateObservationScope(event);
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
  if (event.type === 'precondition' && (!event.id || typeof event.id !== 'string')) {
    throw new Error('precondition event missing required field: id');
  }
  validateArtifacts(event);
}

function validateObservationScope(event) {
  if (eventStepId(event)) return;
  if (event.scope === 'global' || event.global === true || event.observation?.scope === 'global') return;
  if (/\bstep-\d{3}\b/i.test(event.label || '')) {
    throw new Error('STEP_OBSERVATION_REQUIRES_STEP_ID: observation label looks step-scoped; pass --step-id for step evidence.');
  }
  throw new Error('OBSERVATION_SCOPE_REQUIRED: observation without stepId must explicitly set scope=global.');
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

function validatePreconditionEventAgainstCase(event, caseJson) {
  if (event.type !== 'precondition') return;
  const preconditions = Array.isArray(caseJson.preconditions) ? caseJson.preconditions : [];
  const known = preconditions.some((item) => item.id === event.id);
  if (!known) {
    throw new Error(`PRECONDITION_REQUIRED: precondition event references unknown case precondition id: ${event.id}`);
  }
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

function paceHint(events, nextEvent) {
  const stepId = eventStepId(nextEvent);
  if (!stepId) return null;
  const stepEvents = events.filter((event) => eventStepId(event) === stepId);
  const observations = stepEvents.filter((event) => event.type === 'observation');
  const agentFacts = stepEvents.filter((event) => ['perception', 'decision', 'rule', 'flow'].includes(event.type));
  const hint = {
    level: 'INFO',
    stepId,
    suggestedNextAction: 'continue',
    message: '',
  };
  if (nextEvent?.type === 'observation' && observations.length >= 1) {
    hint.level = 'WARN';
    hint.suggestedNextAction = 'assert_or_act';
    hint.message = `当前步骤 ${stepId} 已有 observation；如果页面状态已明确，请立即写带证据引用的 assertion，避免重复观察。`;
    return hint;
  }
  if (['perception', 'decision'].includes(nextEvent?.type) && observations.length >= 1 && agentFacts.length >= 2) {
    hint.level = 'WARN';
    hint.suggestedNextAction = 'assert_or_act';
    hint.message = `当前步骤 ${stepId} 已有 observation 和多条 agent 事实；若不会改变下一步动作，请停止补充解释性事实并尽快断言或执行动作。`;
    return hint;
  }
  if (nextEvent?.type === 'actionResult' && actionType(nextEvent) === 'wait') {
    const waits = stepEvents.filter((event) => event.type === 'actionResult' && actionType(event) === 'wait').length;
    if (waits >= 1) {
      hint.level = 'WARN';
      hint.suggestedNextAction = 'observe_then_assert_or_fail';
      hint.message = `当前步骤 ${stepId} 已等待过；再次等待后应立即 observe 并判断 PASS/FAIL/BLOCKED。`;
      return hint;
    }
  }
  return null;
}

function stepRequiresAssertion(step) {
  return step?.kind === 'assertion' || (Array.isArray(step?.assertions) && step.assertions.length > 0);
}

function stepEvidence(events, step) {
  const stepId = step.id;
  return events.some((event, index) => {
    if (eventStepId(event) !== stepId) return false;
    if (event.type === 'assertion') return event.status === 'PASS';
    if (stepRequiresAssertion(step)) return false;
    if (event.type === 'actionResult' && event.ok === true && STEP_EVIDENCE_ACTIONS.has(actionType(event))) {
      return events.slice(index + 1).some((next) => next.type === 'observation' && eventStepId(next) === stepId);
    }
    return false;
  });
}

function preconditionFailureCode(status) {
  if (status === 'FAIL') return 'PRECONDITION_FAILED';
  if (status === 'UNKNOWN') return 'PRECONDITION_UNKNOWN';
  if (status === 'BLOCKED') return 'PRECONDITION_UNSUPPORTED';
  return 'PRECONDITION_REQUIRED';
}

function preconditionReadiness(caseJson, events, nextEvent) {
  if (!nextEvent || !STEP_ORDER_GUARDED_EVENT_TYPES.has(nextEvent.type)) return { ok: true };
  if (!eventStepId(nextEvent)) return { ok: true };
  const preconditions = Array.isArray(caseJson.preconditions) ? caseJson.preconditions : [];
  if (!preconditions.length) return { ok: true };

  const latestById = new Map();
  for (const event of events) {
    if (event.type === 'precondition' && event.id) latestById.set(event.id, event);
  }
  const missing = preconditions.filter((item) => !latestById.has(item.id));
  if (missing.length) {
    return {
      ok: false,
      failureCode: 'PRECONDITION_REQUIRED',
      reason: `进入步骤前必须先处理所有前置条件，缺少: ${missing.map((item) => item.id).join(', ')}。`,
    };
  }
  const blocking = preconditions
    .map((item) => ({ item, event: latestById.get(item.id) }))
    .filter(({ event }) => !PRECONDITION_PASSING_STATUSES.has(event.status));
  if (blocking.length) {
    const first = blocking[0];
    return {
      ok: false,
      failureCode: preconditionFailureCode(first.event.status),
      reason: `前置条件未满足，不能进入步骤: ${first.item.id} ${first.item.text || ''} (${first.event.status})${first.event.reason ? `；${first.event.reason}` : ''}`,
    };
  }
  return { ok: true };
}

function preconditionTerminalOptions(event) {
  if (event.type !== 'precondition') return null;
  if (event.status === 'FAIL') {
    return {
      status: 'BLOCKED',
      failureCode: 'PRECONDITION_FAILED',
      reason: event.reason || `前置条件不满足: ${event.id}`,
    };
  }
  if (event.status === 'UNKNOWN') {
    return {
      status: 'UNKNOWN',
      failureCode: 'PRECONDITION_UNKNOWN',
      reason: event.reason || `前置条件无法确认: ${event.id}`,
    };
  }
  if (event.status === 'BLOCKED') {
    return {
      status: 'BLOCKED',
      failureCode: 'PRECONDITION_UNSUPPORTED',
      reason: event.reason || `前置条件不支持自动处理: ${event.id}`,
    };
  }
  return null;
}

function globalFlowScanReadiness(events, nextEvent) {
  if (!nextEvent || !STEP_ORDER_GUARDED_EVENT_TYPES.has(nextEvent.type)) return { ok: true };
  if (!eventStepId(nextEvent)) return { ok: true };
  if (nextEvent.type === 'actionResult' && nextEvent.failureCode === 'FLOW_SCAN_REQUIRED') return { ok: true };
  const hasGlobalFlowScan = events.some((event) => isUsableFlowScan(event, null));
  if (hasGlobalFlowScan) return { ok: true };
  return {
    ok: false,
    failureCode: 'FLOW_SCAN_REQUIRED',
    reason: '开始步骤事实前必须先写入可用的 execution 级全局 flowScan 事实；FAILED 扫描不能作为步骤前置。',
  };
}

function assertionEvidenceReadiness(events, nextEvent, execDir = '') {
  if (!nextEvent || nextEvent.type !== 'assertion' || nextEvent.status !== 'PASS') return { ok: true };
  const stepId = eventStepId(nextEvent);
  if (!stepId) {
    return {
      ok: false,
      failureCode: 'ASSERTION_EVIDENCE_REQUIRED',
      reason: 'assertion PASS 必须绑定 stepId，并引用当前步骤的观察证据。',
    };
  }
  const refs = assertionEvidenceRefs(nextEvent);
  if (!refs.length) {
    return {
      ok: false,
      failureCode: 'ASSERTION_EVIDENCE_REQUIRED',
      reason: `assertion PASS 必须通过 evidence 或 evidenceObservation 引用 ${stepId} 的 observation 证据。`,
    };
  }
  const observations = events.filter((event) => event.type === 'observation' && eventStepId(event) === stepId && event.source === 'observe.sh');
  if (!observations.length) {
    return {
      ok: false,
      failureCode: 'ASSERTION_EVIDENCE_REQUIRED',
      reason: `assertion PASS 前必须已有 ${stepId} 由 scripts/observe.sh 写入的 observation 证据。`,
    };
  }
  const missing = refs.filter((ref) => !observations.some((observation) => observationMatchesEvidenceRef(observation, ref)));
  if (missing.length) {
    return {
      ok: false,
      failureCode: 'ASSERTION_EVIDENCE_REQUIRED',
      reason: `assertion PASS 引用的证据不属于当前步骤 observation: ${missing.join(', ')}。`,
    };
  }
  const missingArtifacts = [];
  for (const ref of refs) {
    for (const observation of observations) {
      if (!observationMatchesEvidenceRef(observation, ref)) continue;
      if (!observationArtifactRefs(observation).has(normalizeEvidenceValue(ref))) continue;
      const file = path.join(execDir, ref);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) missingArtifacts.push(ref);
    }
  }
  if (missingArtifacts.length) {
    return {
      ok: false,
      failureCode: 'ASSERTION_EVIDENCE_REQUIRED',
      reason: `assertion PASS 引用的 observation 产物不存在: ${[...new Set(missingArtifacts)].join(', ')}。`,
    };
  }
  return { ok: true };
}

function stepOrderReadiness(caseJson, events, nextEvent) {
  if (!nextEvent || !STEP_ORDER_GUARDED_EVENT_TYPES.has(nextEvent.type)) return { ok: true };
  const stepId = eventStepId(nextEvent);
  if (stepId && nextEvent.type === 'actionResult' && actionType(nextEvent) === 'restartApp') {
    return {
      ok: false,
      failureCode: 'STEP_ORDER_VIOLATION',
      reason: 'restartApp 是 execution 级隔离动作，不能绑定步骤 stepId 或作为步骤证据。',
    };
  }
  if (!stepId) {
    if (nextEvent.type === 'actionResult' && actionRequiresStepId(actionType(nextEvent))) {
      return {
        ok: false,
        failureCode: 'STEP_ORDER_VIOLATION',
        reason: `业务动作必须绑定当前步骤 stepId: ${actionType(nextEvent)}。`,
      };
    }
    return { ok: true };
  }

  const steps = Array.isArray(caseJson.steps) ? caseJson.steps : [];
  const stepIndex = steps.findIndex((step) => step.id === stepId);
  if (stepIndex === -1) {
    return {
      ok: false,
      failureCode: 'STEP_ORDER_VIOLATION',
      reason: `事件引用了不存在的步骤: ${stepId}。`,
    };
  }

  const startedIndexes = events
    .filter((event) => STEP_ORDER_GUARDED_EVENT_TYPES.has(event.type))
    .map((event) => steps.findIndex((step) => step.id === eventStepId(event)))
    .filter((index) => index >= 0);
  const highestStartedIndex = startedIndexes.length ? Math.max(...startedIndexes) : -1;

  if (highestStartedIndex === -1) {
    if (stepIndex === 0) return { ok: true };
    return {
      ok: false,
      failureCode: 'STEP_ORDER_VIOLATION',
      reason: `必须从 ${steps[0]?.id || '第一个步骤'} 开始执行，不能先记录 ${stepId}。`,
    };
  }

  if (stepIndex < highestStartedIndex) {
    return {
      ok: false,
      failureCode: 'STEP_ORDER_VIOLATION',
      reason: `已开始 ${steps[highestStartedIndex].id}，不能回头补写 ${stepId}。`,
    };
  }
  if (stepIndex === highestStartedIndex) return { ok: true };
  if (stepIndex === highestStartedIndex + 1) {
    const previousStep = steps[highestStartedIndex];
    if (stepEvidence(events, previousStep)) return { ok: true };
    return {
      ok: false,
      failureCode: 'STEP_ORDER_VIOLATION',
      reason: `进入 ${stepId} 前，必须先为 ${previousStep.id} 写入通过证据。`,
    };
  }

  return {
    ok: false,
    failureCode: 'STEP_ORDER_VIOLATION',
    reason: `必须按顺序执行；当前只能进入 ${steps[highestStartedIndex + 1]?.id || steps[highestStartedIndex].id}，不能先记录 ${stepId}。`,
  };
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

function firstAssertion(events, status) {
  return events.find((event) => event.type === 'assertion' && event.status === status) || null;
}

function statusForFailureCode(failureCode, fallbackStatus) {
  if (!failureCode) return fallbackStatus;
  if (['ASSERTION_FAILED', 'ASSERTION_UNKNOWN'].includes(failureCode)) return 'FAIL';
  if (['ACTION_TARGET_NOT_FOUND', 'PAGE_LOAD_BLOCKED'].includes(failureCode)) return fallbackStatus === 'BLOCKED' ? 'BLOCKED' : 'FAIL';
  if ([
    'ENV_UNCONFIRMED',
    'ENV_UNAVAILABLE',
    'ENV_AMBIGUOUS',
    'PLATFORM_UNIMPLEMENTED',
    'PRECONDITION_FAILED',
    'PRECONDITION_REQUIRED',
    'PRECONDITION_UNKNOWN',
    'PRECONDITION_UNSUPPORTED',
    'FLOW_NOT_FOUND',
    'FLOW_SCAN_REQUIRED',
    'FLOW_STEP_UNMATCHED',
    'FLOW_ACTION_FAILED',
    'FLOW_UNSAFE',
    'FLOW_SCAN_MISSING',
    'FLOW_MATCH_UNRESOLVED',
    'APP_CONTEXT_LOST',
    'APP_LEFT_FOREGROUND',
    'UNKNOWN_POPUP',
    'CASE_TIMEOUT',
    'CASE_RESTART_FAILED',
    'EXECUTION_BUDGET_EXCEEDED',
    'TOOL_ERROR',
    'ACTION_RESULT_SOURCE_REQUIRED',
    'ASSERTION_EVIDENCE_REQUIRED',
  ].includes(failureCode)) return 'BLOCKED';
  return fallbackStatus;
}

function failureCodeForcesBlocked(failureCode, fallbackStatus) {
  return failureCode && statusForFailureCode(failureCode, fallbackStatus) === 'BLOCKED';
}

function normalizeResultStatus(caseJson, events, requested) {
  const next = {
    status: requested.status,
    failureCode: requested.failureCode || null,
    failedStep: requested.failedStep || null,
    reason: requested.reason || '',
  };
  if (failureCodeForcesBlocked(next.failureCode, next.status)) {
    next.status = 'BLOCKED';
    return next;
  }

  const failedAssertion = firstAssertion(events, 'FAIL');
  if (failedAssertion) {
    next.status = 'FAIL';
    next.failureCode = next.failureCode || 'ASSERTION_FAILED';
    next.failedStep = next.failedStep || eventStepId(failedAssertion) || null;
    next.reason = next.reason || failedAssertion.reason || '断言不通过。';
    return next;
  }

  const unknownAssertion = firstAssertion(events, 'UNKNOWN');
  if (unknownAssertion) {
    next.status = 'FAIL';
    next.failureCode = 'ASSERTION_UNKNOWN';
    next.failedStep = next.failedStep || eventStepId(unknownAssertion) || null;
    next.reason = next.reason || unknownAssertion.reason || '断言证据不足。';
    return next;
  }

  if (next.status === 'PASS') {
    const passEvidenceReadiness = passReadiness(caseJson, events);
    if (!passEvidenceReadiness.ok) {
      next.status = 'FAIL';
      next.failureCode = passEvidenceReadiness.failureCode;
      next.failedStep = next.failedStep || passEvidenceReadiness.failedStep || null;
      next.reason = next.reason || passEvidenceReadiness.reason;
      return next;
    }
  }

  next.status = statusForFailureCode(next.failureCode, next.status);
  if (next.status === 'UNKNOWN' && next.failureCode === 'ASSERTION_UNKNOWN') next.status = 'FAIL';
  return next;
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
  const actionTypes = ['tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'launchApp', 'restartApp', 'wait', 'home'];
  const actions = { total: 0, tap: 0, toggle: 0, longPress: 0, inputText: 0, swipe: 0, back: 0, launchApp: 0, restartApp: 0, wait: 0, home: 0 };
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
  const knownPreconditionIds = new Set(caseJson.preconditions.map((item) => item.id).filter(Boolean));
  const latestPreconditionById = new Map();
  for (const event of events) {
    if (event.type !== 'precondition') continue;
    if (!knownPreconditionIds.has(event.id)) continue;
    latestPreconditionById.set(event.id, event);
  }
  for (const item of caseJson.preconditions) {
    const event = latestPreconditionById.get(item.id);
    if (!event) continue;
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

  const relaunchEvents = events.filter((event) => event.type === 'actionResult' && ['launchApp', 'restartApp'].includes(actionType(event)));
  const relaunchSuccessCount = relaunchEvents.filter((event) => event.ok === true).length;
  const stability = {
    appForegroundLossCount: events.filter((event) => event.type === 'appForeground' && event.status === 'LEFT_TARGET').length,
    appRelaunchCount: relaunchSuccessCount,
    appRelaunchAttemptCount: relaunchEvents.length,
    appRelaunchSuccessCount: relaunchSuccessCount,
    restartFailureCount: events.filter((event) => event.type === 'actionResult' && actionType(event) === 'restartApp' && event.ok === false).length,
    isolationClean: executionState.isolation?.clean !== false,
    isolationCompromised: executionState.isolation?.clean === false,
    isolationRequired: executionState.isolation?.required === true,
    isolationReason: executionState.isolation?.reason || '',
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
    requestedStatus: result.requestedStatus || result.status,
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
    status = 'BLOCKED';
    options.failureCode = flowReadiness.failureCode;
    options.reason = flowReadiness.reason;
  }
  const normalized = normalizeResultStatus(caseJson, eventsBeforeResult, {
    status,
    failureCode: options.failureCode || null,
    failedStep: options.failedStep || null,
    reason: options.reason || '',
  });
  status = normalized.status;
  options.failureCode = normalized.failureCode;
  options.failedStep = normalized.failedStep;
  options.reason = normalized.reason;
  const readiness = { ok: true };
  const result = {
    schemaVersion: 1,
    executionId,
    caseKey: caseJson.identity.caseKey,
    platform: options.platform || state.environment?.platform || null,
    sourceSha1: caseJson.identity.sourceSha1,
    caseContractSha: caseContractSha(caseJson),
    status,
    requestedStatus,
    failureCode: readiness.ok ? (options.failureCode || null) : readiness.failureCode,
    startedAt,
    endedAt,
    failedStep: readiness.ok ? (options.failedStep || null) : readiness.failedStep,
    reason: readiness.ok ? (options.reason || (status === 'PASS' ? '执行通过。' : 'Execution finalized by agent.')) : readiness.reason,
    environment: state.environment || {},
    evidence: options.evidence || [],
  };
  const resultEvent = { time: endedAt, type: 'result', status, requestedStatus, reason: result.reason, failedStep: result.failedStep, failureCode: result.failureCode };
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
    requestedStatus,
    failureCode: result.failureCode,
    isolation: executionState.isolation,
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
  const scans = events.filter((event) => event.type === 'flowScan' && event.stepId === failedStep && event.status !== 'FAILED');
  if (!scans.length) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_MISSING',
      reason: `缺少可用 Flow 扫描事实，不能直接判定 ${failureCode}。`,
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
  return action && !['launchApp', 'restartApp', 'wait'].includes(action);
}

function actionRequiresStepId(action) {
  return action && !['launchApp', 'restartApp', 'wait'].includes(action);
}

function isUsableFlowScan(event, stepId = null) {
  if (!event || event.type !== 'flowScan') return false;
  if (event.source !== 'list-flows') return false;
  if (event.status === 'FAILED') return false;
  if (stepId !== null && event.stepId !== stepId) return false;
  if (stepId === null && eventStepId(event)) return false;
  return true;
}

function flowScanActionReadiness(events, action, stepId) {
  if (!actionRequiresFlowScan(action)) return { ok: true };
  if (!events.some((event) => isUsableFlowScan(event, null))) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_REQUIRED',
      reason: '业务动作前必须先写入可用的 execution 级 flowScan 事实。',
    };
  }
  if (stepId && !events.some((event) => isUsableFlowScan(event, stepId))) {
    return {
      ok: false,
      failureCode: 'FLOW_SCAN_REQUIRED',
      reason: `业务动作前缺少当前步骤的可用 flowScan 事实: ${stepId}。全局扫描只用于建立候选库，不能替代步骤级扫描；FAILED 扫描不能作为动作前置。`,
    };
  }
  return { ok: true };
}

function actionResultSourceReadiness(event, allowActionResult = false) {
  if (!event || event.type !== 'actionResult') return { ok: true };
  if (!allowActionResult) {
    return {
      ok: false,
      failureCode: 'ACTION_RESULT_SOURCE_REQUIRED',
      reason: '公开 record-json 不接受 actionResult；正式动作结果必须由顶层 scripts/action.sh 内部写入。',
    };
  }
  if (process.env.MAVT_ACTION_WRITER !== '1') {
    return {
      ok: false,
      failureCode: 'ACTION_RESULT_SOURCE_REQUIRED',
      reason: 'actionResult 只能由顶层 scripts/action.sh 的内部写入通道记录。',
    };
  }
  if (event.source === 'action.sh') return { ok: true };
  return {
    ok: false,
    failureCode: 'ACTION_RESULT_SOURCE_REQUIRED',
    reason: 'actionResult 必须由顶层 scripts/action.sh 写入；agent 事实请使用 perception/decision/flow/assertion。',
  };
}

function observationSourceReadiness(event, allowObservation = false) {
  if (!event || event.type !== 'observation') return { ok: true };
  if (!allowObservation) {
    return {
      ok: false,
      failureCode: 'OBSERVATION_SOURCE_REQUIRED',
      reason: '公开 record-json 不接受 observation；正式观察必须由顶层 scripts/observe.sh 内部写入。',
    };
  }
  if (process.env.MAVT_OBSERVATION_WRITER !== '1') {
    return {
      ok: false,
      failureCode: 'OBSERVATION_SOURCE_REQUIRED',
      reason: 'observation 只能由顶层 scripts/observe.sh 的内部写入通道记录。',
    };
  }
  if (event.source === 'observe.sh') return { ok: true };
  return {
    ok: false,
    failureCode: 'OBSERVATION_SOURCE_REQUIRED',
    reason: 'observation 必须由顶层 scripts/observe.sh 写入；agent 事实请使用 perception/decision/flow/assertion。',
  };
}

function actionResultFlowScanReadiness(events, event) {
  if (!event || event.type !== 'actionResult') return { ok: true };
  if (event.ok === false && event.failureCode === 'FLOW_SCAN_REQUIRED') return { ok: true };
  return flowScanActionReadiness(events, actionType(event), eventStepId(event));
}

function requiredEnvironmentDependencies(platform) {
  if (platform === 'android') return ['mavtInputIme'];
  if (platform === 'ios') return ['iosAutomation'];
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

function caseRestartDisabled(options) {
  return process.env.MAVT_SELF_TEST === '1' && process.env.MAVT_SELF_TEST_SKIP_CASE_RESTART === '1';
}

function summarizeCommandError(error) {
  const stdout = error.stdout ? String(error.stdout).trim() : '';
  const stderr = error.stderr ? String(error.stderr).trim() : '';
  return [stderr, stdout].filter(Boolean).join('\n') || error.message || String(error);
}

function restartAppForExecution(caseDir, platform, executionId) {
  const actionScript = path.join(__dirname, '..', 'action.sh');
  const args = [
    '--case-dir', caseDir,
    '--platform', platform,
    '--execution-id', executionId,
    '--type', 'restartApp',
    '--settle-ms', '1000',
  ];
  try {
    const output = childProcess.execFileSync(actionScript, args, {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MAVT_RESTART_FAILURE_NON_TERMINAL: '1' },
    });
    return JSON.parse(output);
  } catch (error) {
    const reason = summarizeCommandError(error);
    const wrapped = new Error(`CASE_RESTART_FAILED: 每个用例开始前必须尝试冷启动目标 App；当前 restartApp 入口异常，无法记录可降级的动作事实。\n${reason}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function caseRequiresCleanRestart(caseJson = {}) {
  const explicit = caseJson.isolation?.requireCleanRestart;
  if (explicit === true || explicit === 'true' || explicit === 'required') return true;
  if (explicit === false || explicit === 'false' || explicit === 'optional') return false;
  const parts = [
    caseJson.identity?.title,
    ...(Array.isArray(caseJson.preconditions) ? caseJson.preconditions.map((item) => item.text) : []),
    ...(Array.isArray(caseJson.steps) ? caseJson.steps.map((step) => step.sourceText) : []),
  ].filter(Boolean);
  return parts.some((text) => RESTART_SENSITIVE_PATTERN.test(String(text)));
}

function restartFailureReason(appRestart = {}) {
  if (appRestart?.coldStartVerified === false) {
    return appRestart.reason || 'restartApp 命令成功返回，但平台未能确认真实冷启动。';
  }
  return appRestart.error || appRestart.reason || appRestart.failureCode || '用例开始前未能完成 App 冷启动隔离。';
}

function buildIsolationState(caseJson, appRestart) {
  if (appRestart?.skipped) {
    return {
      clean: true,
      required: false,
      skipped: true,
      reason: appRestart.reason || 'restart skipped',
    };
  }
  const required = caseRequiresCleanRestart(caseJson);
  const ok = appRestart?.ok === true && appRestart?.coldStartVerified === true;
  const explicit = caseJson.isolation?.requireCleanRestart;
  const requirementSource = explicit === true || explicit === false || explicit === 'true' || explicit === 'false' || explicit === 'required' || explicit === 'optional'
    ? 'case-contract'
    : 'auto';
  return {
    clean: ok,
    required,
    requirementSource,
    compromised: !ok,
    failureCode: ok ? null : 'CASE_RESTART_FAILED',
    reason: ok ? 'App cold restart verified by adapter.' : restartFailureReason(appRestart),
  };
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
    case '--scope': options.scope = args[++i]; break;
    case '--record-json': command = 'record'; options.recordJson = args[++i]; break;
    case '--record-action-json': command = 'recordAction'; options.recordJson = args[++i]; break;
    case '--record-observation-json': command = 'recordObservation'; options.recordJson = args[++i]; break;
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
    const appRestart = caseRestartDisabled(options)
      ? { skipped: true, reason: 'MAVT_SELF_TEST_SKIP_CASE_RESTART=1' }
      : restartAppForExecution(caseDir, options.platform, executionId);
    const isolation = buildIsolationState(caseJson, appRestart);
    writeExecutionState(execDir, {
      schemaVersion: 1,
      executionId,
      startedAt: readExecutionState(execDir)?.startedAt || nowIso(),
      finalized: false,
      isolation,
      budget: DEFAULT_BUDGET,
    });
    let finalized = null;
    if (isolation.compromised && isolation.required) {
      finalized = finalize(caseDir, {
        platform: options.platform,
        executionId,
        status: 'BLOCKED',
        failureCode: 'CASE_RESTART_FAILED',
        reason: `用例依赖冷启动隔离，但 App 重启失败，不能继续执行：${isolation.reason}`,
        allowAlreadyFinalized: true,
      });
    }
    const blockedOnStart = !!finalized;
    console.log(JSON.stringify({
      executionId,
      execDir,
      timeline: path.join(execDir, 'timeline.jsonl'),
      appRestart,
      isolation,
      blockedOnStart,
      nextAction: blockedOnStart ? 'stop-current-case' : 'continue-current-case',
      finalized,
    }, null, 2));
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
      scope: options.eventType === 'observation' ? options.scope : undefined,
      action: options.eventType === 'actionResult' ? options.action : undefined,
      ok: options.eventType === 'actionResult' ? true : undefined,
    });
    const timelinePath = path.join(execDir, 'timeline.jsonl');
    const events = readJsonl(timelinePath);
    const caseJson = readJson(path.join(caseDir, 'case.json'));
    if (!caseJson) throw new Error(`Missing case.json in ${caseDir}`);
    const preconditionReady = preconditionReadiness(caseJson, events, event);
    if (!preconditionReady.ok) {
      throw new Error(`${preconditionReady.failureCode}: ${preconditionReady.reason}`);
    }
    const globalFlowScanReady = globalFlowScanReadiness(events, event);
    if (!globalFlowScanReady.ok) {
      throw new Error(`${globalFlowScanReady.failureCode}: ${globalFlowScanReady.reason}`);
    }
    const stepOrderReady = stepOrderReadiness(caseJson, events, event);
    if (!stepOrderReady.ok) {
      throw new Error(`${stepOrderReady.failureCode}: ${stepOrderReady.reason}`);
    }
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
    console.log(JSON.stringify({ executionId, budgetOk: true, eventType: options.eventType, paceHint: paceHint(events, event) }, null, 2));
  } else if (command === 'record' || command === 'recordAction' || command === 'recordObservation') {
    const allowActionResult = command === 'recordAction';
    const allowObservation = command === 'recordObservation';
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
    validatePreconditionEventAgainstCase(event, caseJson);
    const timelinePath = path.join(execDir, 'timeline.jsonl');
    const events = readJsonl(timelinePath);
    const preconditionReady = preconditionReadiness(caseJson, events, event);
    if (!preconditionReady.ok) {
      throw new Error(`${preconditionReady.failureCode}: ${preconditionReady.reason}`);
    }
    const globalFlowScanReady = globalFlowScanReadiness(events, event);
    if (!globalFlowScanReady.ok) {
      throw new Error(`${globalFlowScanReady.failureCode}: ${globalFlowScanReady.reason}`);
    }
    const stepOrderReady = stepOrderReadiness(caseJson, events, event);
    if (!stepOrderReady.ok) {
      throw new Error(`${stepOrderReady.failureCode}: ${stepOrderReady.reason}`);
    }
    const assertionEvidenceReady = assertionEvidenceReadiness(events, event, execDir);
    if (!assertionEvidenceReady.ok) {
      throw new Error(`${assertionEvidenceReady.failureCode}: ${assertionEvidenceReady.reason}`);
    }
    if (allowActionResult && event.type !== 'actionResult') {
      throw new Error('ACTION_RESULT_SOURCE_REQUIRED: --record-action-json 只接受 actionResult。');
    }
    if (allowObservation && event.type !== 'observation') {
      throw new Error('OBSERVATION_SOURCE_REQUIRED: --record-observation-json 只接受 observation。');
    }
    const actionSourceReady = actionResultSourceReadiness(event, allowActionResult);
    if (!actionSourceReady.ok) {
      throw new Error(`${actionSourceReady.failureCode}: ${actionSourceReady.reason}`);
    }
    const observationSourceReady = observationSourceReadiness(event, allowObservation);
    if (!observationSourceReady.ok) {
      throw new Error(`${observationSourceReady.failureCode}: ${observationSourceReady.reason}`);
    }
    validateArtifactFilesExist(execDir, event);
    const actionFlowScanReady = actionResultFlowScanReadiness(events, event);
    if (!actionFlowScanReady.ok) {
      throw new Error(`${actionFlowScanReady.failureCode}: ${actionFlowScanReady.reason}`);
    }
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
    const terminalPrecondition = preconditionTerminalOptions(event);
    if (terminalPrecondition) {
      const finalized = finalize(caseDir, {
        platform: options.platform,
        executionId,
        ...terminalPrecondition,
      });
      console.log(JSON.stringify({ executionId, eventType: event.type || 'unknown', timeline: path.join(execDir, 'timeline.jsonl'), paceHint: paceHint(events, event), finalized }, null, 2));
    } else {
      console.log(JSON.stringify({ executionId, eventType: event.type || 'unknown', timeline: path.join(execDir, 'timeline.jsonl'), paceHint: paceHint(events, event) }, null, 2));
    }
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
  const platform = normalizePlatform(state?.environment?.platform);
  if (platform === 'ios') return ['platform', 'device', 'appId'];
  return ['platform', 'device', 'appId', 'entry'];
}
