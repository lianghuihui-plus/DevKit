'use strict';

const childProcess = require('child_process');

const DISCOVERY_TIMEOUT_MS = 15_000;
const INVOCATION_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const API_PREFIX = '/api/v1/bcm-tools';

function parseJson(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('bcm-cs returned empty JSON output');
  return JSON.parse(value);
}

function findCapabilityItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const field of ['capabilities', 'items', 'data', 'result']) {
    const found = findCapabilityItems(value[field]);
    if (found.length) return found;
  }
  return [];
}

function capabilityId(item) {
  if (typeof item === 'string') return item;
  return item?.id || item?.capabilityId || item?.capability_id || item?.name || null;
}

function unwrapDescription(value) {
  let current = value;
  for (const field of ['capability', 'data', 'result']) {
    if (current?.[field] && typeof current[field] === 'object' && !Array.isArray(current[field])) current = current[field];
  }
  return current;
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'sensitive') continue;
    if (key === 'properties') {
      normalized.properties = Object.fromEntries(Object.entries(value || {})
        .map(([name, child]) => [name, normalizeSchema(child)]));
    } else if (key === 'items') normalized.items = normalizeSchema(value);
    else if (key === 'oneOf') normalized.oneOf = Array.isArray(value) ? value.map(normalizeSchema) : value;
    else normalized[key] = value;
  }
  return normalized;
}

function inputSchemaFromDescription(raw) {
  const declared = raw?.inputSchema || raw?.input_schema || raw?.parameters?.schema || raw?.parameters;
  if (declared) return normalizeSchema(declared);
  if (!raw?.params || typeof raw.params !== 'object' || Array.isArray(raw.params)) return null;
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(raw.params)
      .map(([name, schema]) => [name, normalizeSchema(schema)])),
    required: Array.isArray(raw.required) ? [...raw.required] : [],
  };
}

function normalizeEndpoint(value, id) {
  const method = value?.method || value?.httpMethod || value?.http_method;
  const declaredPath = value?.path || value?.apiPath || value?.api_path;
  if (typeof method !== 'string' || !/^(?:GET|POST|PUT|PATCH|DELETE)$/i.test(method)) {
    throw new Error(`${id} API method is invalid`);
  }
  const apiPath = typeof declaredPath === 'string' && declaredPath.startsWith(`${API_PREFIX}/`)
    ? declaredPath : `${API_PREFIX}${declaredPath || ''}`;
  if (!/^\/api\/v1\/bcm-tools\/[A-Za-z0-9._~!$&'()*+,;=:@%/?{}-]*$/.test(apiPath)) {
    throw new Error(`${id} API path is invalid`);
  }
  const pathParameters = [...apiPath.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
  return { method: method.toUpperCase(), path: apiPath, pathParameters };
}

function normalizeDescription(value, requestedId) {
  const raw = unwrapDescription(value);
  const id = capabilityId(raw) || requestedId;
  const inputSchema = inputSchemaFromDescription(raw);
  const execution = raw?.rest?.execute || raw?.rest?.query || raw?.invocation || raw?.api || raw?.request || raw?.execution;
  if (typeof id !== 'string' || !id.trim()) throw new Error('capability id is missing');
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw new Error(`${id} input schema is missing`);
  const endpoint = normalizeEndpoint(execution, id);
  const preview = raw?.rest?.preview ? normalizeEndpoint(raw.rest.preview, `${id} preview`) : null;
  const sensitiveOutputFields = Array.isArray(raw?.output?.sensitive_fields)
    ? [...new Set(raw.output.sensitive_fields.filter((name) => typeof name === 'string' && name))].sort() : [];
  const params = raw?.params && typeof raw.params === 'object' && !Array.isArray(raw.params) ? raw.params : {};
  const sensitiveInputFields = [...new Set([
    ...Object.entries(params).filter(([, schema]) => schema?.sensitive === true).map(([name]) => name),
    ...sensitiveOutputFields.flatMap((name) => [name, `${name}s`]).filter((name) => Object.hasOwn(params, name)),
  ])].sort();
  return {
    name: id,
    summary: raw.summary || raw.description || raw.title || `BCM capability ${id}`,
    inputSchema,
    sensitiveFields: { input: sensitiveInputFields, output: sensitiveOutputFields },
    invocation: {
      ...endpoint,
      capabilityId: id,
      ...(preview ? { preview } : {}),
      confirmationRequired: raw?.supports?.confirm === true,
    },
  };
}

function createAdapter(context = {}, options = {}) {
  const executable = options.executable || context.bcmCsExecutable || process.env.BCM_CS_BIN || 'bcm-cs';
  const runner = context.processRunner || options.runner || childProcess.spawnSync;
  const env = options.env || process.env;
  const run = (args, timeout) => runner(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER, env, shell: false,
  });
  return {
    executable,
    version() { return run(['version'], DISCOVERY_TIMEOUT_MS); },
    list() { return run(['--output', 'json', 'capabilities', 'list'], DISCOVERY_TIMEOUT_MS); },
    describe(id) { return run(['--output', 'json', 'capabilities', 'describe', id], DISCOVERY_TIMEOUT_MS); },
    invoke(invocation, input) {
      return run(['--output', 'json', 'api', invocation.method, invocation.path, '--body', JSON.stringify(input)], INVOCATION_TIMEOUT_MS);
    },
  };
}

module.exports = {
  DISCOVERY_TIMEOUT_MS,
  INVOCATION_TIMEOUT_MS,
  MAX_BUFFER,
  capabilityId,
  createAdapter,
  findCapabilityItems,
  normalizeDescription,
  normalizeEndpoint,
  normalizeSchema,
  parseJson,
};
