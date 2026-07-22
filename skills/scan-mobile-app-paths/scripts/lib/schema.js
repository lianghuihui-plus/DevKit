'use strict';

const { fail, safeSegment } = require('./common');

const CONTEXTS = ['guest', 'authenticated'];
const SCAN_MODES = ['exploration', 'goal-directed'];
const SCAN_SCOPES = ['full', 'targeted'];
const FRONTIER_STATUSES = ['PENDING', 'CLAIMED', 'RETRYABLE', 'EXPLORED', 'COVERED_BY_GROUP', 'SKIPPED', 'BLOCKED', 'FAILED'];

function oneOf(value, choices, name) {
  if (!choices.includes(value)) fail(`${name} must be one of: ${choices.join(', ')}`, 'SCHEMA_INVALID');
  return value;
}

function validateTarget(target) {
  if (!target || target.platform !== 'harmony') fail('target.platform must be harmony', 'TARGET_INVALID');
  for (const key of ['bundleName', 'entryAbility', 'environment']) {
    if (!target[key] || typeof target[key] !== 'string') fail(`target.${key} is required`, 'TARGET_INVALID');
  }
  return target;
}

function validateAction(action) {
  if (!action || typeof action !== 'object') fail('action must be an object', 'ACTION_INVALID');
  oneOf(action.type, ['tap', 'longPress', 'swipe', 'inputText', 'keyEvent', 'wait'], 'action.type');
  const finite = value => Number.isFinite(Number(value)); const hasPoint = finite(action.x) && finite(action.y);
  const bounds = action.fallbackBounds; const hasBounds = Array.isArray(bounds) && bounds.length === 4 && bounds.every(finite) && Number(bounds[2]) > Number(bounds[0]) && Number(bounds[3]) > Number(bounds[1]);
  if (bounds !== undefined && bounds !== null && !hasBounds) fail('action.fallbackBounds must be [left,top,right,bottom]', 'ACTION_INVALID');
  if (['tap', 'longPress', 'inputText'].includes(action.type) && !hasPoint && !hasBounds) fail(`${action.type} requires coordinates or fallbackBounds`, 'ACTION_INVALID');
  if (action.type === 'swipe' && !['fromX', 'fromY', 'toX', 'toY'].every(key => finite(action[key]))) fail('swipe requires fromX/fromY/toX/toY', 'ACTION_INVALID');
  if (action.type === 'inputText' && typeof action.value !== 'string') fail('inputText requires a string value', 'ACTION_INVALID');
  if (action.type === 'keyEvent' && !action.key) fail('keyEvent requires key', 'ACTION_INVALID');
  if (action.type === 'wait' && action.durationMs !== undefined && (!finite(action.durationMs) || Number(action.durationMs) < 0 || Number(action.durationMs) > 10000)) fail('wait durationMs must be between 0 and 10000', 'ACTION_INVALID');
  return action;
}

function validateGraphCandidate(action) {
  const validated = validateAction(action);
  if (validated.type === 'wait') fail('wait is an observation control and cannot be a graph candidate', 'NON_GRAPH_ACTION');
  return validated;
}

function validateRun(scan) {
  if (!scan || ![1, 2, 3].includes(Number(scan.schemaVersion)) || !scan.scanId) fail('Invalid scan.json', 'SCAN_INVALID');
  oneOf(scan.scanMode, SCAN_MODES, 'scanMode');
  oneOf(scan.scanScope, SCAN_SCOPES, 'scanScope');
  if (scan.scanMode === 'goal-directed' && scan.scanScope !== 'targeted') fail('goal-directed mode requires targeted scope', 'SCAN_INVALID');
  if (scan.scanMode === 'exploration' && scan.scanScope !== 'full') fail('exploration mode requires full scope', 'SCAN_INVALID');
  const protocol = Number(scan.graphProtocolVersion || 1); const currentRun = Number(scan.schemaVersion) >= 3 || protocol >= 3;
  if (currentRun) {
    oneOf(scan.contextId, CONTEXTS, 'contextId');
    if (scan.plannedContextIds !== undefined || scan.activeContextId !== undefined || scan.budgetsByContext !== undefined) fail('Run must use contextId and budget only', 'SCAN_INVALID');
    if (!scan.budget || typeof scan.budget !== 'object') fail('Run budget is required', 'SCAN_INVALID');
    for (const key of ['maxActiveMinutes', 'maxDepth', 'maxDeviceActions', 'maxStates', 'maxColdStarts']) if (!Number.isFinite(Number(scan.budget[key])) || Number(scan.budget[key]) < 0) fail(`budget.${key} is invalid`, 'SCAN_INVALID');
    oneOf(scan.navigationPolicy || 'adaptive', ['adaptive', 'always-replay'], 'navigationPolicy');
    oneOf(scan.verificationRule, ['CANONICAL_SCREEN_PATH', 'CONFIRMED_TARGET_PATH'], 'verificationRule');
    if (scan.scanMode === 'exploration' && scan.verificationRule !== 'CANONICAL_SCREEN_PATH') fail('exploration requires CANONICAL_SCREEN_PATH', 'SCAN_INVALID');
    if (scan.scanMode === 'goal-directed' && scan.verificationRule !== 'CONFIRMED_TARGET_PATH') fail('goal-directed requires CONFIRMED_TARGET_PATH', 'SCAN_INVALID');
    for (const key of ['eventProtocolVersion', 'projectionProtocolVersion', 'navigationProtocolVersion', 'verificationProtocolVersion']) if (scan[key] !== undefined && ![1, 2].includes(Number(scan[key]))) fail(`${key} must be 1 or 2`, 'SCAN_INVALID');
  } else if (!Array.isArray(scan.plannedContextIds) || scan.plannedContextIds.some(c => !CONTEXTS.includes(c))) fail('Invalid plannedContextIds', 'SCAN_INVALID');
  if (scan.mapRevisionId !== undefined) safeSegment(scan.mapRevisionId, 'mapRevisionId');
  if (scan.graphProtocolVersion !== undefined && ![1, 2, 3, 4].includes(Number(scan.graphProtocolVersion))) fail('graphProtocolVersion must be 1, 2, 3 or 4', 'SCAN_INVALID');
  if (scan.attemptProtocolVersion !== undefined && ![1, 2, 3, 4].includes(Number(scan.attemptProtocolVersion))) fail('attemptProtocolVersion must be 1, 2, 3 or 4', 'SCAN_INVALID');
  return scan;
}

module.exports = { CONTEXTS, SCAN_MODES, SCAN_SCOPES, FRONTIER_STATUSES, oneOf, validateTarget, validateAction, validateGraphCandidate, validateRun };
