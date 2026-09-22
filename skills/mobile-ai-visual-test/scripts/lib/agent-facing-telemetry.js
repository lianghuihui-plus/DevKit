'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonl } = require('./execution-lifecycle');
const { AGENT_FACING_STATUSES } = require('./agent-facing-envelope');

const CASE_PROTOCOL_FILE = 'operations/telemetry/agent-facing.jsonl';
const BYTE_FIELDS = ['responseBytes', 'resultBytes', 'dataBytes', 'resourceDescriptorBytes'];
const TOTAL_FIELDS = [...BYTE_FIELDS, 'resourceDescriptorCount', 'documentationRefCount', 'durationMs', 'projectionMs', 'ledgerProjectionMs'];
const TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/;
const token = (value) => typeof value === 'string' && TOKEN.test(value);
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bytes = (value) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
const known = (value, catalog) => typeof value === 'string' && Object.hasOwn(catalog || {}, value);

function countDocumentationRefs(value) {
  // Documentation belongs to the public error contract; never inspect resource content.
  return ['documentationRef', 'operationDocumentationRef'].filter((field) => typeof value?.error?.[field] === 'string').length;
}

function createAgentFacingEvent(response, durationMs, options = {}) {
  // Serialize once before measuring each section so JSON omission/toJSON semantics agree with the wire.
  const serialized = options.serializedResponse || JSON.stringify(response);
  const envelope = JSON.parse(serialized);
  const contract = options.contract || {};
  const operation = known(envelope.operation, contract.methods) ? envelope.operation : null;
  const dataType = known(envelope.data?.type, contract.resourceCatalog) ? envelope.data.type : null;
  const descriptors = Array.isArray(envelope.resources) ? envelope.resources : [];
  const resourceTypeCounts = {};
  for (const type of [dataType, ...descriptors.map((item) => item?.type)]) {
    if (known(type, contract.resourceCatalog)) resourceTypeCounts[type] = (resourceTypeCounts[type] || 0) + 1;
  }
  return {
    schemaVersion: 1,
    at: options.now || new Date().toISOString(),
    operation,
    status: AGENT_FACING_STATUSES.includes(envelope.status) ? envelope.status : 'FAILED',
    responseBytes: Buffer.byteLength(serialized),
    resultBytes: bytes(envelope.result),
    dataBytes: bytes(envelope.data),
    resourceDescriptorBytes: bytes(envelope.resources),
    resourceDescriptorCount: descriptors.length,
    resourceTypeCounts,
    ...(dataType ? { dataType } : {}),
    ...(operation === 'read' ? { readTargetType: dataType || 'unknown' } : {}),
    recordsResult: operation === 'recordResult',
    unresolvedFinish: operation === 'finish' && envelope.error?.code === 'CASE_RESULT_INCOMPLETE',
    documentationRefCount: countDocumentationRefs(envelope),
    ...(['stdin', 'mcp'].includes(options.hostTransport) ? { hostTransport: options.hostTransport } : {}),
    durationMs: Math.max(0, Number(durationMs) || 0),
    projectionMs: Math.max(0, Number(options.agentFacingMetrics?.projectionMs) || 0),
    ledgerProjectionMs: Math.max(0, Number(options.agentFacingMetrics?.ledgerProjectionMs) || 0),
  };
}

function validateAgentFacingEvent(event) {
  const fields = ['schemaVersion', 'at', 'operation', 'status', ...TOTAL_FIELDS, 'resourceTypeCounts', 'dataType',
    'readTargetType', 'recordsResult', 'unresolvedFinish', 'hostTransport'];
  return Boolean(event && event.schemaVersion === 1
    && Object.keys(event).every((field) => fields.includes(field))
    && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
    && (event.operation === null || token(event.operation))
    && AGENT_FACING_STATUSES.includes(event.status)
    && TOTAL_FIELDS.every((field) => nonnegative(event[field]))
    && [...BYTE_FIELDS, 'resourceDescriptorCount', 'documentationRefCount'].every((field) => Number.isInteger(event[field]))
    && event.resourceTypeCounts && typeof event.resourceTypeCounts === 'object' && !Array.isArray(event.resourceTypeCounts)
    && Object.entries(event.resourceTypeCounts).every(([type, count]) => token(type) && Number.isInteger(count) && count >= 0)
    && (event.dataType === undefined || token(event.dataType))
    && (event.readTargetType === undefined || (event.operation === 'read' && token(event.readTargetType)))
    && typeof event.recordsResult === 'boolean' && typeof event.unresolvedFinish === 'boolean'
    && (event.hostTransport === undefined || ['stdin', 'mcp'].includes(event.hostTransport)));
}

function diagnostic() {
  try { process.stderr.write('[mavt] AGENT_PROTOCOL_TELEMETRY_UNAVAILABLE\n'); } catch { /* Diagnostics are best effort too. */ }
}

function recordAgentFacingEvent(file, response, durationMs, options = {}) {
  try {
    const event = createAgentFacingEvent(response, durationMs, options);
    if (!validateAgentFacingEvent(event)) throw new Error('invalid telemetry event');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    appendJsonl(file, event);
  } catch { diagnostic(); }
}

function readAgentFacingEvents(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { const event = JSON.parse(line); return validateAgentFacingEvent(event) ? [event] : []; } catch { return []; }
    });
  } catch { diagnostic(); return []; }
}

function summarizeAgentFacing(entries) {
  const empty = () => ({ requestCount: 0, ...Object.fromEntries(TOTAL_FIELDS.map((field) => [field, 0])),
    resourceTypeCounts: {}, readTargetTypeCounts: {}, statusCounts: {} });
  const summary = { ...empty(), recordResultCount: 0, unresolvedFinishAttemptCount: 0,
    operationCounts: {}, hostTransportCounts: {}, byOperation: {} };
  const increment = (counts, key, count = 1) => {
    // defineProperty also treats a future __proto__-like counter as data, never a prototype setter.
    Object.defineProperty(counts, key, { value: (Object.hasOwn(counts, key) ? counts[key] : 0) + count, enumerable: true, configurable: true, writable: true });
  };
  for (const event of entries.filter(validateAgentFacingEvent)) {
    const operation = event.operation || 'unknown';
    if (!Object.hasOwn(summary.byOperation, operation)) Object.defineProperty(summary.byOperation, operation, { value: empty(), enumerable: true });
    for (const target of [summary, summary.byOperation[operation]]) {
      target.requestCount += 1;
      for (const field of TOTAL_FIELDS) target[field] += event[field];
      for (const [type, count] of Object.entries(event.resourceTypeCounts)) increment(target.resourceTypeCounts, type, count);
      if (event.readTargetType) increment(target.readTargetTypeCounts, event.readTargetType);
      increment(target.statusCounts, event.status);
    }
    increment(summary.operationCounts, operation);
    if (event.hostTransport) increment(summary.hostTransportCounts, event.hostTransport);
    if (event.recordsResult) summary.recordResultCount += 1;
    if (event.unresolvedFinish) summary.unresolvedFinishAttemptCount += 1;
  }
  return summary;
}

module.exports = { CASE_PROTOCOL_FILE, createAgentFacingEvent, validateAgentFacingEvent,
  recordAgentFacingEvent, readAgentFacingEvents, summarizeAgentFacing, diagnostic };
