'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../../lib/execution-lifecycle');
const resources = require('../agent-resource-store');
const store = require('../store');

const SECRET_KEY = /^(?:authorization|token|access_token|refresh_token|password|cookie|set-cookie|secret)$/i;
const SECRET_TEXT = /\b(authorization|token|access_token|refresh_token|password|cookie|set-cookie|secret)(\s*[:=]\s*)([^\s,;]+)/gi;
const MAX_PERSISTED_BYTES = 4 * 1024 * 1024;

function redact(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (depth > 32) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '$1$2[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redact(item, '', depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name, depth + 1)]));
}

function bounded(value) {
  const safe = redact(value);
  const bytes = Buffer.byteLength(JSON.stringify(safe));
  return bytes <= MAX_PERSISTED_BYTES ? safe : { truncated: true, originalBytes: bytes };
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
    input: bounded(request.input),
  }, options);
  return { operationId, startedAt, startedMs };
}

function completeInvocation(execDir, state, definition, definitionSha, request, outcome, options = {}) {
  const endedAt = options.now || new Date().toISOString();
  const endedMs = typeof options.capabilityClock === 'function' ? options.capabilityClock() : Date.now();
  let technical = null;
  if (outcome.status !== 'SUCCEEDED') {
    const code = outcome.status === 'UNKNOWN' ? 'CAPABILITY_OUTCOME_UNKNOWN' : 'CAPABILITY_EXECUTION_FAILED';
    const fact = store.appendEvent(execDir, 'technicalIssue', {
      code,
      message: redact(outcome.diagnostic || outcome.summary || code),
      operation: 'useCapability',
      decisionId: state.operationId,
      expectationRefs: [],
    }, options);
    technical = resources.publishEvent(execDir, 'technicalFact', fact);
  }
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
    summary: redact(outcome.summary || ''),
    ...(technical ? { technicalFactRef: technical.data.ref } : {}),
  }, options);
  const record = {
    schemaVersion: 1,
    type: 'capabilityInvocation',
    operationId: state.operationId,
    capabilityName: definition.name,
    definitionDigest: definitionSha,
    purpose: request.purpose,
    ...(request.flowContext ? { flowContext: request.flowContext } : {}),
    input: bounded(request.input),
    startedAt: state.startedAt,
    endedAt,
    elapsedMs: Math.max(0, endedMs - state.startedMs),
    status: outcome.status,
    summary: redact(outcome.summary || ''),
    output: bounded(outcome.output),
    diagnostic: redact(outcome.diagnostic),
    ...(technical ? { technicalFactRef: technical.data.ref } : {}),
  };
  const relative = `capabilities/invocations/${state.operationId}.json`;
  fs.mkdirSync(path.dirname(path.join(execDir, relative)), { recursive: true });
  writeJsonAtomic(path.join(execDir, relative), record);
  const publication = resources.publishArtifact(execDir, 'capabilityInvocation', relative,
    technical ? [technical.descriptor] : []);
  return { record, publication, technical };
}

module.exports = {
  beginInvocation,
  bounded,
  completeInvocation,
  redact,
};
