'use strict';

const { resolveAction } = require('./capability-catalog');
const { validateLongPressTiming } = require('./contract');

function resolveActionRequest(scene, request, platform) {
  const resolved = resolveAction(scene, request, platform);
  if (resolved.stale) return resolved;
  if (request.observationPolicy && resolved.action.type !== 'longPress') {
    const error = new Error('observationPolicy.duringActionAtMs is only supported for longPress');
    error.code = 'CASE_RUNTIME_REQUEST_INVALID';
    throw error;
  }
  if (resolved.action.type === 'longPress') validateLongPressTiming(resolved.action.durationMs, request.observationPolicy);
  return resolved;
}

module.exports = { resolveActionRequest };
