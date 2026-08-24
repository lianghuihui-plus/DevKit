'use strict';

const crypto = require('crypto');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contractError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.failureCode = code;
  error.exitCode = 2;
  Object.assign(error, details);
  return error;
}

function ensureArray(value, label, code) {
  if (!Array.isArray(value)) throw contractError(code, `${label} must be an array`, { fieldPath: label, expected: 'array' });
  return value;
}

function ensureBoolean(value, label, code) {
  if (typeof value !== 'boolean') throw contractError(code, `${label} must be boolean`, { fieldPath: label, expected: 'boolean' });
  return value;
}

function ensureId(value, label, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw contractError(code, `${label} must be a stable identifier`, { fieldPath: label, expected: 'stable identifier' });
  }
  return value;
}

function ensureInteger(value, label, code, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw contractError(code, `${label} must be an integer >= ${minimum}`, { fieldPath: label, expected: `integer >= ${minimum}` });
  return value;
}

function ensureObject(value, label, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError(code, `${label} must be an object`, { fieldPath: label, expected: 'object' });
  return value;
}

function ensureString(value, label, code, options = {}) {
  if (typeof value !== 'string' || (!options.allowEmpty && !value.trim())) {
    throw contractError(code, `${label} must be a${options.allowEmpty ? '' : ' non-empty'} string`, { fieldPath: label, expected: options.allowEmpty ? 'string' : 'non-empty string' });
  }
  return value;
}

function ensureUniqueIds(values, label, code) {
  const ids = new Set();
  for (const [index, value] of values.entries()) {
    const id = ensureId(value?.id, `${label}[${index}].id`, code);
    if (ids.has(id)) throw contractError(code, `${label} contains duplicate id: ${id}`);
    ids.add(id);
  }
  return ids;
}

function sha256(value, prefix, length = 64) {
  return `${prefix}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, length)}`;
}

module.exports = {
  canonicalJson,
  contractError,
  ensureArray,
  ensureBoolean,
  ensureId,
  ensureInteger,
  ensureObject,
  ensureString,
  ensureUniqueIds,
  sha256,
};
