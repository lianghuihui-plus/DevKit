'use strict';

// The shared wire contract intentionally has no dependency on a particular Agent-facing facade.
const AGENT_FACING_PROTOCOL = 'agent-facing';
const AGENT_FACING_STATUSES = Object.freeze(['SUCCEEDED', 'REJECTED', 'FAILED', 'UNKNOWN']);

const RESOURCE_DESCRIPTOR_SCHEMA = Object.freeze({
  type: 'object',
  required: ['ref', 'type', 'role'],
  additionalProperties: false,
  properties: {
    ref: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    role: { type: 'string', minLength: 1 },
    revision: { type: 'integer', minimum: 0 },
    integrity: { type: 'string', minLength: 1 },
  },
});

const STABLE_CODE = /^[A-Z][A-Z0-9_]*$/;

function unsupportedOptions(options, allowed, builder) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${builder} options must be an object`);
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new TypeError(`${builder} has unsupported option: ${key}`);
  }
}

function operationValue(operation) {
  if (operation === null) return null;
  if (typeof operation !== 'string' || !operation.trim()) {
    throw new TypeError('operation must be a non-empty string or null');
  }
  return operation;
}

function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function resourceDescriptor(resource, index) {
  const descriptor = objectValue(resource, `resources[${index}]`);
  const allowed = Object.keys(RESOURCE_DESCRIPTOR_SCHEMA.properties);
  for (const key of Object.keys(descriptor)) {
    if (!allowed.includes(key)) throw new TypeError(`resources[${index}] does not support field: ${key}`);
  }
  for (const field of RESOURCE_DESCRIPTOR_SCHEMA.required) {
    if (typeof descriptor[field] !== 'string' || !descriptor[field].trim()) {
      throw new TypeError(`resources[${index}].${field} must be a non-empty string`);
    }
  }
  if (descriptor.revision !== undefined && (!Number.isInteger(descriptor.revision) || descriptor.revision < 0)) {
    throw new TypeError(`resources[${index}].revision must be an integer >= 0`);
  }
  if (descriptor.integrity !== undefined && (typeof descriptor.integrity !== 'string' || !descriptor.integrity.trim())) {
    throw new TypeError(`resources[${index}].integrity must be a non-empty string`);
  }
  return Object.freeze({ ...descriptor });
}

function uniqueResources(resources) {
  if (!Array.isArray(resources)) throw new TypeError('resources must be an array');
  const published = new Map();
  resources.forEach((resource, index) => {
    const descriptor = resourceDescriptor(resource, index);
    if (!published.has(descriptor.ref)) published.set(descriptor.ref, descriptor);
  });
  return Object.freeze([...published.values()]);
}

function resourceData(data) {
  const value = objectValue(data, 'data');
  for (const field of ['ref', 'type', 'content']) {
    if (value[field] === undefined) throw new TypeError(`data.${field} is required`);
  }
  if (typeof value.ref !== 'string' || !value.ref.trim() || typeof value.type !== 'string' || !value.type.trim()) {
    throw new TypeError('data.ref and data.type must be non-empty strings');
  }
  return value;
}

function requestEnvelopeSchema(operationSchemas) {
  if (!operationSchemas || typeof operationSchemas !== 'object' || Array.isArray(operationSchemas)) {
    throw new TypeError('operationSchemas must be an object');
  }
  const operations = Object.keys(operationSchemas);
  if (!operations.length || operations.some((operation) => !operation.trim())) {
    throw new TypeError('operationSchemas must contain named operations');
  }
  for (const operation of operations) objectValue(operationSchemas[operation], `operationSchemas.${operation}`);
  return Object.freeze({
    oneOf: Object.freeze(operations.map((operation) => Object.freeze({
      type: 'object',
      required: ['operation', 'input'],
      additionalProperties: false,
      properties: Object.freeze({
        operation: Object.freeze({ const: operation }),
        input: operationSchemas[operation],
      }),
    }))),
  });
}

function associatedResources(primaryData, resources) {
  if (!Array.isArray(resources)) throw new TypeError('resources must be an array');
  const associated = [];
  resources.forEach((resource, index) => {
    const descriptor = resourceDescriptor(resource, index);
    if (descriptor.ref === primaryData.ref) {
      if (descriptor.type !== primaryData.type) {
        throw new TypeError('data.type must match resources type when refs are equal');
      }
      return;
    }
    associated.push(descriptor);
  });
  return uniqueResources(associated);
}

function successEnvelope(options) {
  unsupportedOptions(options, ['operation', 'result', 'data', 'resources'], 'successEnvelope');
  const result = options.result === undefined ? {} : objectValue(options.result, 'result');
  const data = options.data === undefined ? undefined : resourceData(options.data);
  const envelope = {
    protocol: AGENT_FACING_PROTOCOL,
    status: 'SUCCEEDED',
    operation: operationValue(options.operation),
    result: { ...result },
    resources: data
      ? associatedResources(data, options.resources === undefined ? [] : options.resources)
      : uniqueResources(options.resources === undefined ? [] : options.resources),
  };
  if (data) envelope.data = data;
  return Object.freeze(envelope);
}

function errorEnvelope(options) {
  unsupportedOptions(options, [
    'status', 'operation', 'result', 'resources', 'code', 'retryable', 'issues', 'documentationRef', 'operationDocumentationRef',
  ], 'errorEnvelope');
  if (!AGENT_FACING_STATUSES.includes(options.status) || options.status === 'SUCCEEDED') {
    throw new TypeError('errorEnvelope status must be REJECTED, FAILED, or UNKNOWN');
  }
  if (typeof options.code !== 'string' || !STABLE_CODE.test(options.code)) {
    throw new TypeError('error code must be a stable uppercase identifier');
  }
  if (typeof options.retryable !== 'boolean') throw new TypeError('retryable must be boolean');
  if (options.status === 'UNKNOWN' && options.retryable) {
    throw new TypeError('UNKNOWN status requires retryable to be false');
  }
  const result = options.result === undefined ? {} : objectValue(options.result, 'result');
  const error = { code: options.code, retryable: options.retryable };
  if (options.issues !== undefined) {
    if (!Array.isArray(options.issues)) throw new TypeError('issues must be an array');
    error.issues = options.issues;
  }
  for (const field of ['documentationRef', 'operationDocumentationRef']) {
    if (options[field] !== undefined) {
      if (typeof options[field] !== 'string' || !options[field].trim()) throw new TypeError(`${field} must be a non-empty string`);
      error[field] = options[field];
    }
  }
  return Object.freeze({
    protocol: AGENT_FACING_PROTOCOL,
    status: options.status,
    operation: operationValue(options.operation),
    result: { ...result },
    resources: uniqueResources(options.resources === undefined ? [] : options.resources),
    error: Object.freeze(error),
  });
}

module.exports = {
  AGENT_FACING_PROTOCOL,
  AGENT_FACING_STATUSES,
  RESOURCE_DESCRIPTOR_SCHEMA,
  requestEnvelopeSchema,
  successEnvelope,
  errorEnvelope,
};
