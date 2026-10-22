'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../lib/execution-lifecycle');
const resources = require('../agent-resource-store');
const store = require('../store');

const SECRET_KEY = /^(?:authorization|token|access_token|refresh_token|password|cookie|set-cookie|secret)$/i;
const SECRET_TEXT = /\b(authorization|token|access_token|refresh_token|password|cookie|set-cookie|secret)(\s*[:=]\s*)([^\s,;]+)/gi;
const SENSITIVE_ARG_OPTION = /authorization|token|password|cookie|secret|phone|mobile|credential|api[-_]?key/i;
const PHONE_ARGUMENT = /^(?:(?:\+?86)?1\d{10})(?:[,，](?:(?:\+?86)?1\d{10}))*$/;
const MAX_PERSISTED_BYTES = 4 * 1024 * 1024;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectScalars(value, result, depth = 0) {
  if (depth > 32 || value === null || value === undefined || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const item of value) collectScalars(item, result, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) collectScalars(item, result, depth + 1);
  } else if (String(value)) result.add(String(value));
}

function argvOption(value) {
  return typeof value === 'string' && /^--?[A-Za-z][A-Za-z0-9-]*(?:=|$)/.test(value);
}

function sensitiveArgOption(value) {
  const separator = value.indexOf('=');
  const option = separator >= 0 ? value.slice(0, separator) : value;
  return SENSITIVE_ARG_OPTION.test(option);
}

function collectSensitiveArgValue(value, result) {
  if (!result || !String(value)) return;
  result.add(String(value));
  for (const item of String(value).split(/[,，]/)) {
    if (item) result.add(item);
  }
}

function redactArgv(args, sensitiveLiterals = null) {
  const safe = [];
  let sensitiveValueExpected = false;
  for (const arg of args) {
    if (sensitiveValueExpected && !argvOption(arg)) {
      collectSensitiveArgValue(arg, sensitiveLiterals);
      safe.push('[REDACTED]');
      sensitiveValueExpected = false;
      continue;
    }
    sensitiveValueExpected = false;
    if (!argvOption(arg)) {
      if (typeof arg === 'string' && PHONE_ARGUMENT.test(arg)) {
        collectSensitiveArgValue(arg, sensitiveLiterals);
        safe.push('[REDACTED]');
      } else safe.push(arg);
      continue;
    }
    const separator = arg.indexOf('=');
    if (separator >= 0) {
      const value = arg.slice(separator + 1);
      if (sensitiveArgOption(arg)) {
        collectSensitiveArgValue(value, sensitiveLiterals);
        safe.push(`${arg.slice(0, separator + 1)}[REDACTED]`);
      } else safe.push(arg);
      continue;
    }
    safe.push(arg);
    sensitiveValueExpected = sensitiveArgOption(arg);
  }
  return safe;
}

function sensitiveValues(value, sensitiveKeys, key = '', result = new Set(), depth = 0) {
  if (depth > 32 || !value || typeof value !== 'object') return result;
  for (const [name, item] of Object.entries(value)) {
    if (sensitiveKeys.has(name) && name === 'args' && Array.isArray(item)) redactArgv(item, result);
    else if (sensitiveKeys.has(name)) collectScalars(item, result, depth + 1);
    else if (item && typeof item === 'object') sensitiveValues(item, sensitiveKeys, name, result, depth + 1);
  }
  return result;
}

function redactText(value, sensitiveKeys, sensitiveLiterals) {
  let safe = value.replace(SECRET_TEXT, '$1$2[REDACTED]');
  for (const name of sensitiveKeys) {
    const pattern = new RegExp(`\\b(${escapeRegExp(name)})(["']?\\s*[:=]\\s*["']?)([^\\s,;"'}]+)`, 'gi');
    safe = safe.replace(pattern, '$1$2[REDACTED]');
  }
  for (const literal of [...sensitiveLiterals].sort((left, right) => right.length - left.length)) {
    safe = safe.replaceAll(literal, '[REDACTED]');
  }
  return safe;
}

function boundedText(value, sensitiveKeys, sensitiveLiterals) {
  if (value === null || value === undefined) return value;
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  const safe = redactText(source === undefined ? String(value) : source, sensitiveKeys, sensitiveLiterals);
  const bytes = Buffer.byteLength(safe);
  return bytes <= MAX_PERSISTED_BYTES ? safe : `[TRUNCATED: originalBytes=${bytes}]`;
}

function redact(value, key = '', depth = 0, sensitiveKeys = new Set(), sensitiveLiterals = new Set()) {
  if (key === 'args' && sensitiveKeys.has(key) && Array.isArray(value)) return redactArgv(value);
  if (SECRET_KEY.test(key) || sensitiveKeys.has(key)) return '[REDACTED]';
  if (depth > 32) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return redactText(value, sensitiveKeys, sensitiveLiterals);
  if (Array.isArray(value)) return value.map((item) => redact(item, '', depth + 1, sensitiveKeys, sensitiveLiterals));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([name, item]) => [name, redact(item, name, depth + 1, sensitiveKeys, sensitiveLiterals)]));
}

function bounded(value, sensitiveFields = [], sensitiveLiterals = new Set()) {
  try {
    const safe = redact(value, '', 0, new Set(sensitiveFields), sensitiveLiterals);
    const encoded = JSON.stringify(safe);
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable');
    const bytes = Buffer.byteLength(encoded);
    return bytes <= MAX_PERSISTED_BYTES ? safe : { truncated: true, originalBytes: bytes };
  } catch (_error) {
    return { truncated: true, invalid: true, reason: 'value is not JSON-serializable' };
  }
}

function beginInvocation(execDir, definition, definitionSha, request, options = {}) {
  const operationId = store.nextId(execDir, 'capabilityInvocation');
  const startedAt = options.now || new Date().toISOString();
  const startedMs = typeof options.capabilityClock === 'function' ? options.capabilityClock() : Date.now();
  store.appendEvent(execDir, 'capabilityInvocationRequested', {
    capabilityInvocationId: operationId,
    capabilityName: definition.name,
    definitionDigest: definitionSha,
    purpose: request.purpose,
    ...(request.flowContext ? { flowContext: request.flowContext } : {}),
    input: bounded(request.input, definition.sensitiveFields?.input),
  }, options);
  return { operationId, startedAt, startedMs };
}

function completeInvocation(execDir, state, definition, definitionSha, request, outcome, options = {}) {
  const endedAt = options.now || new Date().toISOString();
  const endedMs = typeof options.capabilityClock === 'function' ? options.capabilityClock() : Date.now();
  const inputSensitiveFields = definition.sensitiveFields?.input || [];
  const outputSensitiveFields = [...new Set([
    ...inputSensitiveFields,
    ...(definition.sensitiveFields?.output || []),
  ])];
  const sensitiveKeys = new Set(outputSensitiveFields);
  const literals = sensitiveValues(request.input, new Set(inputSensitiveFields));
  const safeSummary = boundedText(outcome.summary || '', sensitiveKeys, literals);
  const safeDiagnostic = boundedText(outcome.diagnostic, sensitiveKeys, literals);
  let technical = null;
  if (outcome.status !== 'SUCCEEDED') {
    const code = outcome.status === 'UNKNOWN' ? 'CAPABILITY_OUTCOME_UNKNOWN' : 'CAPABILITY_EXECUTION_FAILED';
    const fact = store.appendEvent(execDir, 'technicalIssue', {
      code,
      message: safeDiagnostic || safeSummary || code,
      operation: 'useCapability',
      decisionId: state.operationId,
      expectationRefs: [],
    }, options);
    technical = resources.publishEvent(execDir, 'technicalFact', fact);
  }
  const record = {
    schemaVersion: 1,
    type: 'capabilityInvocation',
    operationId: state.operationId,
    capabilityName: definition.name,
    definitionDigest: definitionSha,
    purpose: request.purpose,
    ...(request.flowContext ? { flowContext: request.flowContext } : {}),
    input: bounded(request.input, inputSensitiveFields),
    startedAt: state.startedAt,
    endedAt,
    elapsedMs: Math.max(0, endedMs - state.startedMs),
    status: outcome.status,
    summary: safeSummary,
    output: bounded(outcome.output, outputSensitiveFields, literals),
    diagnostic: safeDiagnostic,
    ...(technical ? { technicalFactRef: technical.data.ref } : {}),
  };
  const relative = `capabilities/invocations/${state.operationId}.json`;
  fs.mkdirSync(path.dirname(path.join(execDir, relative)), { recursive: true });
  writeJsonAtomic(path.join(execDir, relative), record);
  const publication = resources.publishArtifact(execDir, 'capabilityInvocation', relative,
    technical ? [technical.descriptor] : []);
  const eventType = {
    SUCCEEDED: 'capabilityInvocationCompleted',
    FAILED: 'capabilityInvocationFailed',
    UNKNOWN: 'capabilityInvocationOutcomeUnknown',
  }[outcome.status];
  store.appendEvent(execDir, eventType, {
    capabilityInvocationId: state.operationId,
    capabilityName: definition.name,
    definitionDigest: definitionSha,
    purpose: request.purpose,
    status: outcome.status,
    summary: safeSummary,
    ...(technical ? { technicalFactRef: technical.data.ref } : {}),
  }, options);
  return { record, publication, technical };
}

module.exports = {
  beginInvocation,
  bounded,
  completeInvocation,
  redact,
};
