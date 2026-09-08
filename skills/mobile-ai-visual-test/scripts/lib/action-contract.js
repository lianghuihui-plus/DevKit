#!/usr/bin/env node
'use strict';

const SWIPE_DEFAULT_VELOCITY = 600;
const SWIPE_MIN_VELOCITY = 200;
const SWIPE_MAX_VELOCITY = 40000;
const INPUT_TEXT_DEFAULT_MODE = 'replace';
const INPUT_TEXT_MODES = Object.freeze(['replace', 'append']);
const INPUT_TEXT_MODE_ALIASES = Object.freeze({
  addition: 'append',
  overwrite: 'replace',
  set: 'replace',
});

const ACTION_FIELDS = Object.freeze({
  launchApp: ['reason'],
  restartApp: ['reason'],
  tap: ['target', 'x', 'y', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'coordinateArtifactRef', 'reason'],
  doubleTap: ['target', 'x', 'y', 'intervalMs', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'coordinateArtifactRef', 'reason'],
  toggle: ['target', 'x', 'y', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'coordinateArtifactRef', 'reason'],
  longPress: ['target', 'x', 'y', 'durationMs', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'coordinateArtifactRef', 'reason'],
  inputText: ['target', 'x', 'y', 'text', 'mode', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'coordinateArtifactRef', 'reason'],
  swipe: ['fromX', 'fromY', 'toX', 'toY', 'velocity', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'coordinateArtifactRef', 'reason'],
  back: ['reason'],
  home: ['reason'],
  dismissKeyboard: ['reason'],
  wait: ['ms', 'reason'],
});

const SCOPE_ACTION_TYPES = Object.freeze({
  'case-business': Object.freeze(['tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard', 'wait']),
  'case-prepare': Object.freeze(['tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard', 'wait']),
  'formal-execution': Object.freeze(Object.keys(ACTION_FIELDS)),
});

const COORDINATE_SOURCES = Object.freeze(['layout', 'visual', 'pixel']);
const COORDINATE_SOURCE_ALIASES = Object.freeze({
  screenshot: 'visual',
  image: 'visual',
  uitree: 'layout',
});
const SCOPE_COORDINATE_SOURCES = Object.freeze({
  'case-business': Object.freeze(['layout', 'visual', 'pixel']),
  'case-prepare': Object.freeze(['layout', 'visual', 'pixel']),
  'formal-execution': Object.freeze(['layout', 'visual', 'pixel']),
});
const COORDINATE_ACTIONS = new Set(['tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe']);
const BOUNDS_REQUIRED_SOURCES = new Set(['visual', 'pixel']);

function fail(context, message, details = {}) {
  const error = new Error(`ACTION_CONTRACT_INVALID: ${context}: ${message}`);
  error.code = 'ACTION_CONTRACT_INVALID';
  error.exitCode = 2;
  Object.assign(error, details);
  throw error;
}

function finiteNumber(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function executionScope(value) {
  const scope = String(value || 'formal-execution').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SCOPE_COORDINATE_SOURCES, scope)) {
    fail('action execution', `unsupported scope: ${scope || 'unknown'}`, {
      field: 'scope', received: scope, allowed: Object.keys(SCOPE_COORDINATE_SOURCES),
    });
  }
  return scope;
}

function canonicalCoordinateSource(value) {
  if (value === undefined || value === null || value === '') return value;
  const raw = String(value).trim();
  const lower = raw.toLowerCase();
  if (COORDINATE_SOURCE_ALIASES[lower]) return COORDINATE_SOURCE_ALIASES[lower];
  const canonical = COORDINATE_SOURCES.find((item) => item.toLowerCase() === lower);
  return canonical || raw;
}

function platformActionTypes(platform, scope) {
  const values = SCOPE_ACTION_TYPES[scope];
  return String(platform || '').trim().toLowerCase() === 'ios'
    ? [...values]
    : values.filter((type) => type !== 'dismissKeyboard');
}

function normalizeActionProposal(action, options = {}) {
  const context = options.context || 'action proposal';
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail(context, 'must be an object');
  const normalized = { ...action };
  const normalizations = [];
  if (normalized.coordinateSource !== undefined) {
    const canonical = canonicalCoordinateSource(normalized.coordinateSource);
    if (canonical !== normalized.coordinateSource) {
      normalizations.push({ field: 'coordinateSource', from: normalized.coordinateSource, to: canonical });
      normalized.coordinateSource = canonical;
    }
  }
  if (normalized.type === 'inputText') {
    const rawMode = normalized.mode === undefined || normalized.mode === null || normalized.mode === ''
      ? INPUT_TEXT_DEFAULT_MODE
      : String(normalized.mode).trim().toLowerCase();
    const canonicalMode = INPUT_TEXT_MODE_ALIASES[rawMode] || rawMode;
    if (canonicalMode !== normalized.mode) {
      normalizations.push({ field: 'mode', from: normalized.mode, to: canonicalMode });
      normalized.mode = canonicalMode;
    }
  }
  return { action: normalized, normalizations };
}

function describeActionConstraints(platform, scope = 'case-business') {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const normalizedScope = executionScope(scope);
  return {
    schemaVersion: 1,
    scope: normalizedScope,
    platform: normalizedPlatform,
    actionTypes: platformActionTypes(normalizedPlatform, normalizedScope),
    coordinateSources: [...SCOPE_COORDINATE_SOURCES[normalizedScope]],
    coordinateSourceAliases: { screenshot: 'visual', image: 'visual', uiTree: 'layout' },
    coordinateActions: [...COORDINATE_ACTIONS],
    coordinateRequirements: {
      coordinatesMustBePaired: true,
      sourceAndEvidenceRequiredWithCoordinates: true,
      targetBoundsRequiredFor: [...BOUNDS_REQUIRED_SOURCES],
      manualAllowed: false,
    },
    inputText: {
      modes: [...INPUT_TEXT_MODES],
      defaultMode: INPUT_TEXT_DEFAULT_MODE,
      ...(normalizedPlatform === 'harmony'
        ? { coordinates: 'required' }
        : { coordinates: 'forbidden', focusedFieldRequired: true }),
    },
    longPress: {
      durationMs: 'required-positive-integer',
    },
  };
}

function validateAction(action, options = {}) {
  const context = options.context || 'action';
  if (!action || typeof action !== 'object' || Array.isArray(action)) fail(context, 'must be an object');
  if (!Object.prototype.hasOwnProperty.call(ACTION_FIELDS, action.type)) {
    fail(context, `unsupported type: ${action.type || 'unknown'}`, {
      field: 'type', received: action.type, allowed: Object.keys(ACTION_FIELDS),
    });
  }

  const allowed = new Set(['type', ...ACTION_FIELDS[action.type]]);
  for (const field of Object.keys(action)) {
    if (!allowed.has(field)) fail(context, `${field} is not allowed for ${action.type}`, { field, received: action[field], allowed: [...allowed] });
  }

  for (const field of ['x', 'y', 'fromX', 'fromY', 'toX', 'toY']) {
    if (action[field] !== undefined && !finiteNumber(action[field])) fail(context, `${field} must be a finite number`, { field, received: action[field] });
  }
  if ((action.x === undefined) !== (action.y === undefined)) fail(context, 'x and y must be provided together', { field: 'x,y' });
  if (action.targetBounds !== undefined &&
    (!Array.isArray(action.targetBounds) || action.targetBounds.length !== 4 || !action.targetBounds.every(finiteNumber))) {
    fail(context, 'targetBounds must contain four finite numbers', { field: 'targetBounds', received: action.targetBounds });
  }
  if (action.durationMs !== undefined && (!Number.isInteger(Number(action.durationMs)) || Number(action.durationMs) <= 0)) {
    fail(context, 'durationMs must be a positive integer', { field: 'durationMs', received: action.durationMs });
  }
  if (action.type === 'longPress' && action.durationMs === undefined) {
    fail(context, 'durationMs is required for longPress', { field: 'durationMs', received: action.durationMs });
  }
  if (action.intervalMs !== undefined && (!Number.isInteger(Number(action.intervalMs)) || Number(action.intervalMs) < 20 || Number(action.intervalMs) > 1000)) {
    fail(context, 'intervalMs must be an integer from 20 to 1000', { field: 'intervalMs', received: action.intervalMs, allowed: ['20-1000'] });
  }
  if (action.ms !== undefined && (!Number.isInteger(Number(action.ms)) || Number(action.ms) < 0)) {
    fail(context, 'ms must be a non-negative integer', { field: 'ms', received: action.ms });
  }
  if (action.type === 'inputText' && (typeof action.text !== 'string' || action.text.length === 0)) {
    fail(context, 'text is required for inputText', { field: 'text', received: action.text });
  }
  if (action.type === 'inputText' && action.mode !== undefined && !INPUT_TEXT_MODES.includes(action.mode)) {
    fail(context, `mode must be one of ${INPUT_TEXT_MODES.join(', ')} for inputText`, {
      field: 'mode', received: action.mode, allowed: [...INPUT_TEXT_MODES],
      suggestion: `use ${INPUT_TEXT_DEFAULT_MODE} unless the step explicitly requires appending`,
    });
  }
  if (action.type === 'swipe') {
    for (const field of ['fromX', 'fromY', 'toX', 'toY']) {
      if (!finiteNumber(action[field])) fail(context, `${field} is required for swipe`, { field, received: action[field] });
    }
    if (action.velocity !== undefined) {
      const velocity = Number(action.velocity);
      if (!Number.isInteger(velocity) || velocity < SWIPE_MIN_VELOCITY || velocity > SWIPE_MAX_VELOCITY) {
        fail(context, `velocity must be an integer from ${SWIPE_MIN_VELOCITY} to ${SWIPE_MAX_VELOCITY} px/s`, {
          field: 'velocity', received: action.velocity, allowed: [`${SWIPE_MIN_VELOCITY}-${SWIPE_MAX_VELOCITY}`],
        });
      }
    }
  }
  return action;
}

function validateActionAsset(action, options = {}) {
  return validateAction(action, options);
}

function validateActionExecution(action, options = {}) {
  const context = options.context || 'action execution';
  const platform = String(options.platform || '').trim().toLowerCase();
  const scope = executionScope(options.scope);
  validateAction(action, { context });
  if (!['harmony', 'android', 'ios'].includes(platform)) {
    fail(context, `unsupported platform: ${platform || 'unknown'}`, { field: 'platform', received: platform, allowed: ['harmony', 'android', 'ios'] });
  }
  const allowedActionTypes = platformActionTypes(platform, scope);
  if (!allowedActionTypes.includes(action.type)) {
    fail(context, `${action.type} is not allowed for ${scope}`, {
      field: 'type', received: action.type, allowed: [...allowedActionTypes],
      suggestion: `use one of: ${allowedActionTypes.join(', ')}`,
    });
  }
  if (['tap', 'doubleTap', 'toggle', 'longPress'].includes(action.type) && (!finiteNumber(action.x) || !finiteNumber(action.y))) {
    fail(context, `${action.type} requires executable x and y coordinates on ${platform}`, { field: 'x,y' });
  }
  if (action.type === 'inputText') {
    if (platform === 'harmony' && (!finiteNumber(action.x) || !finiteNumber(action.y))) {
      fail(context, 'HarmonyOS inputText requires executable x and y coordinates', { field: 'x,y' });
    }
    if (['android', 'ios'].includes(platform) && (action.x !== undefined || action.y !== undefined)) {
      fail(context, `${platform} inputText targets the focused field and does not accept x or y`, { field: 'x,y', received: [action.x, action.y] });
    }
  }
  const hasCoordinates = action.type === 'swipe'
    ? ['fromX', 'fromY', 'toX', 'toY'].every((field) => finiteNumber(action[field]))
    : finiteNumber(action.x) || finiteNumber(action.y);
  if (COORDINATE_ACTIONS.has(action.type) && hasCoordinates) {
    const allowed = SCOPE_COORDINATE_SOURCES[scope];
    if (!action.coordinateSource || !allowed.includes(action.coordinateSource)) {
      fail(context, `coordinateSource must be one of ${allowed.join(', ') || '<none>'} for ${scope}`, {
        field: 'coordinateSource', received: action.coordinateSource, allowed,
        suggestion: action.coordinateSource === 'screenshot' ? 'use visual' : `use one of: ${allowed.join(', ')}`,
      });
    }
    if (typeof action.coordinateEvidence !== 'string' || !action.coordinateEvidence.trim()) {
      fail(context, 'coordinateEvidence is required with x/y', { field: 'coordinateEvidence', received: action.coordinateEvidence });
    }
    if (typeof action.coordinateArtifactRef !== 'string' || !action.coordinateArtifactRef.trim()) {
      fail(context, 'coordinateArtifactRef is required with x/y', { field: 'coordinateArtifactRef', received: action.coordinateArtifactRef });
    }
    if (BOUNDS_REQUIRED_SOURCES.has(action.coordinateSource) && !Array.isArray(action.targetBounds)) {
      fail(context, `${action.coordinateSource} coordinate action requires targetBounds`, {
        field: 'targetBounds', received: action.targetBounds, allowed: ['[x1,y1,x2,y2]'],
      });
    }
  } else if (action.coordinateSource !== undefined || action.coordinateEvidence !== undefined || action.coordinateArtifactRef !== undefined || action.targetBounds !== undefined) {
    fail(context, 'coordinate metadata is only valid when the action has x/y coordinates', { field: 'coordinateSource' });
  }
  return action;
}

function resolveSwipeVelocity(action) {
  validateAction(action, { context: 'swipe' });
  return action.velocity === undefined ? SWIPE_DEFAULT_VELOCITY : Number(action.velocity);
}

function swipeDurationMs(action) {
  const velocity = resolveSwipeVelocity(action);
  const distance = Math.hypot(Number(action.toX) - Number(action.fromX), Number(action.toY) - Number(action.fromY));
  return Math.max(1, Math.round((distance / velocity) * 1000));
}

module.exports = {
  ACTION_FIELDS,
  SCOPE_ACTION_TYPES,
  COORDINATE_SOURCES,
  COORDINATE_SOURCE_ALIASES,
  INPUT_TEXT_DEFAULT_MODE,
  INPUT_TEXT_MODES,
  SCOPE_COORDINATE_SOURCES,
  SWIPE_DEFAULT_VELOCITY,
  SWIPE_MAX_VELOCITY,
  SWIPE_MIN_VELOCITY,
  describeActionConstraints,
  normalizeActionProposal,
  resolveSwipeVelocity,
  swipeDurationMs,
  validateAction,
  validateActionAsset,
  validateActionExecution,
};
