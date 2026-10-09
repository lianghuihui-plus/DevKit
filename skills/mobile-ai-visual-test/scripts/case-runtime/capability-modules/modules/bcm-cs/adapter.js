'use strict';

const childProcess = require('child_process');

const DISCOVERY_TIMEOUT_MS = 15_000;
const INVOCATION_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

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

function normalizeDescription(value, requestedId) {
  const raw = unwrapDescription(value);
  const id = capabilityId(raw) || requestedId;
  const inputSchema = raw?.inputSchema || raw?.input_schema || raw?.parameters?.schema || raw?.parameters;
  const execution = raw?.invocation || raw?.api || raw?.request || raw?.execution;
  const method = execution?.method || execution?.httpMethod || execution?.http_method;
  const apiPath = execution?.path || execution?.apiPath || execution?.api_path;
  if (typeof id !== 'string' || !id.trim()) throw new Error('capability id is missing');
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw new Error(`${id} input schema is missing`);
  if (typeof method !== 'string' || !/^(?:GET|POST|PUT|PATCH|DELETE)$/i.test(method)) throw new Error(`${id} API method is invalid`);
  if (typeof apiPath !== 'string' || !/^\/api\/v1\/bcm-tools\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(apiPath)) {
    throw new Error(`${id} API path is invalid`);
  }
  return {
    name: id,
    summary: raw.summary || raw.description || raw.title || `BCM capability ${id}`,
    inputSchema,
    invocation: { method: method.toUpperCase(), path: apiPath, capabilityId: id },
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
  parseJson,
};
