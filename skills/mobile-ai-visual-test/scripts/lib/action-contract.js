#!/usr/bin/env node
'use strict';

const SWIPE_DEFAULT_VELOCITY = 600;
const SWIPE_MIN_VELOCITY = 200;
const SWIPE_MAX_VELOCITY = 40000;

const ACTION_FIELDS = Object.freeze({
  launchApp: ['reason'],
  restartApp: ['reason'],
  tap: ['target', 'x', 'y', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'reason'],
  toggle: ['target', 'x', 'y', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'reason'],
  longPress: ['target', 'x', 'y', 'durationMs', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'reason'],
  inputText: ['target', 'x', 'y', 'text', 'coordinateSource', 'targetBounds', 'coordinateEvidence', 'reason'],
  swipe: ['fromX', 'fromY', 'toX', 'toY', 'velocity', 'reason'],
  back: ['reason'],
  home: ['reason'],
  wait: ['ms', 'reason'],
});

function fail(context, message) {
  const error = new Error(`${context}: ${message}`);
  error.exitCode = 2;
  throw error;
}

function finiteNumber(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function validateAction(action, options = {}) {
  const context = options.context || 'action';
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    fail(context, 'must be an object');
  }
  if (!Object.prototype.hasOwnProperty.call(ACTION_FIELDS, action.type)) {
    fail(context, `unsupported type: ${action.type || 'unknown'}`);
  }

  const allowed = new Set(['type', ...ACTION_FIELDS[action.type]]);
  for (const field of Object.keys(action)) {
    if (!allowed.has(field)) fail(context, `${field} is not allowed for ${action.type}`);
  }

  for (const field of ['x', 'y', 'fromX', 'fromY', 'toX', 'toY']) {
    if (action[field] !== undefined && !finiteNumber(action[field])) {
      fail(context, `${field} must be a finite number`);
    }
  }
  if ((action.x === undefined) !== (action.y === undefined)) {
    fail(context, 'x and y must be provided together');
  }
  if (action.targetBounds !== undefined &&
    (!Array.isArray(action.targetBounds) || action.targetBounds.length !== 4 || !action.targetBounds.every(finiteNumber))) {
    fail(context, 'targetBounds must contain four finite numbers');
  }
  if (action.durationMs !== undefined &&
    (!Number.isInteger(Number(action.durationMs)) || Number(action.durationMs) <= 0)) {
    fail(context, 'durationMs must be a positive integer');
  }
  if (action.ms !== undefined &&
    (!Number.isInteger(Number(action.ms)) || Number(action.ms) < 0)) {
    fail(context, 'ms must be a non-negative integer');
  }
  if (action.type === 'inputText' && (typeof action.text !== 'string' || action.text.length === 0)) {
    fail(context, 'text is required for inputText');
  }
  if (action.type === 'swipe') {
    for (const field of ['fromX', 'fromY', 'toX', 'toY']) {
      if (!finiteNumber(action[field])) fail(context, `${field} is required for swipe`);
    }
    if (action.velocity !== undefined) {
      const velocity = Number(action.velocity);
      if (!Number.isInteger(velocity) || velocity < SWIPE_MIN_VELOCITY || velocity > SWIPE_MAX_VELOCITY) {
        fail(context, `velocity must be an integer from ${SWIPE_MIN_VELOCITY} to ${SWIPE_MAX_VELOCITY} px/s`);
      }
    }
  }
  return action;
}

function resolveSwipeVelocity(action) {
  validateAction(action, { context: 'swipe' });
  return action.velocity === undefined ? SWIPE_DEFAULT_VELOCITY : Number(action.velocity);
}

function swipeDurationMs(action) {
  const velocity = resolveSwipeVelocity(action);
  const distance = Math.hypot(
    Number(action.toX) - Number(action.fromX),
    Number(action.toY) - Number(action.fromY),
  );
  return Math.max(1, Math.round((distance / velocity) * 1000));
}

module.exports = {
  ACTION_FIELDS,
  SWIPE_DEFAULT_VELOCITY,
  SWIPE_MAX_VELOCITY,
  SWIPE_MIN_VELOCITY,
  resolveSwipeVelocity,
  swipeDurationMs,
  validateAction,
};
