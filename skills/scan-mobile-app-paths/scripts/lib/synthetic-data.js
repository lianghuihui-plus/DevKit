'use strict';

const { hashObject } = require('./common');

function hasSyntheticSpec(action = {}) {
  const spec = action.syntheticSpec;
  return action.type === 'inputText' && spec && ['text', 'email', 'numeric'].includes(spec.type || 'text');
}

function resolveSyntheticAction(action, nonce) {
  if (!hasSyntheticSpec(action)) return { ...action };
  const spec = action.syntheticSpec; const suffix = hashObject([spec.seed || 'smap', nonce]).replace(/^sha256:/, '').slice(0, Math.max(4, Math.min(16, Number(spec.suffixLength) || 8)));
  const prefix = String(spec.prefix || 'smap').slice(0, 32); let value;
  if ((spec.type || 'text') === 'email') value = `${prefix}-${suffix}@example.test`;
  else if (spec.type === 'numeric') value = suffix.replace(/[a-f]/g, digit => String(digit.charCodeAt(0) % 10));
  else value = `${prefix}-${suffix}`;
  return { ...action, value };
}

module.exports = { hasSyntheticSpec, resolveSyntheticAction };
