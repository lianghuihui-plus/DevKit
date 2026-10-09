'use strict';

const { validateCapabilityDefinition } = require('../../../capability-modules/contract');
const {
  capabilityId,
  createAdapter,
  findCapabilityItems,
  normalizeDescription,
  parseJson,
} = require('./adapter');
const { commandSucceeded, discoveryResult, invocationResult } = require('./response-mapper');

function findPreviewId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  for (const key of ['preview_id', 'previewId']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findPreviewId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function createBcmCsProvider(options = {}) {
  return {
    manifest: {
      id: 'bcm-cs',
      version: '1.0.0',
      summary: 'BCM test environment configuration and data capabilities',
    },

    probe(context) {
      const adapter = createAdapter(context, options);
      const version = adapter.version();
      if (!commandSucceeded(version)) {
        return { status: 'UNAVAILABLE', implementationVersion: null, diagnostic: 'bcm-cs executable unavailable', discoverySeed: null };
      }
      const listed = discoveryResult(adapter.list());
      if (!listed.ok) {
        return { status: 'UNAVAILABLE', implementationVersion: String(version.stdout || '').trim() || null,
          diagnostic: listed.diagnostic, discoverySeed: null };
      }
      return {
        status: 'READY',
        implementationVersion: String(version.stdout || '').trim() || 'bcm-cs',
        diagnostic: null,
        discoverySeed: listed.value,
      };
    },

    listCapabilities(context, probeResult) {
      const adapter = createAdapter(context, options);
      const seed = probeResult?.discoverySeed || discoveryResult(adapter.list()).value;
      const definitions = [];
      const diagnostics = [];
      for (const item of findCapabilityItems(seed)) {
        const id = capabilityId(item);
        if (!id) {
          diagnostics.push('capability without a stable id was excluded');
          continue;
        }
        if (item?.availability?.available === false) {
          diagnostics.push(`capability ${id} was excluded because it is not currently available`);
          continue;
        }
        try {
          const result = adapter.describe(id);
          if (!commandSucceeded(result)) throw new Error('describe command failed');
          const definition = normalizeDescription(parseJson(result.stdout), id);
          validateCapabilityDefinition(definition);
          definitions.push(definition);
        } catch (_error) {
          diagnostics.push(`capability ${id} was excluded because its description is invalid`);
        }
      }
      Object.defineProperty(definitions, 'diagnostics', { value: diagnostics, enumerable: false });
      return definitions;
    },

    invoke(request, context) {
      const invocation = request.capability?.invocation;
      if (!invocation || !invocation.method || !invocation.path) {
        return { status: 'FAILED', summary: 'BCM capability definition is not executable', output: null,
          diagnostic: 'frozen BCM invocation descriptor is missing' };
      }
      const name = request.capability.providerCapabilityName || request.capability.name;
      const adapter = createAdapter(context, options);
      const prepare = (endpoint, input) => {
        const body = { ...input };
        let apiPath = endpoint.path;
        for (const parameter of endpoint.pathParameters || []) {
          if (!Object.hasOwn(body, parameter)) throw new Error(`BCM path parameter is missing: ${parameter}`);
          apiPath = apiPath.replaceAll(`{${parameter}}`, encodeURIComponent(String(body[parameter])));
          delete body[parameter];
        }
        return { endpoint: { ...endpoint, path: apiPath }, body };
      };
      try {
        const executeInput = { ...request.input };
        if (invocation.preview) {
          const preview = prepare(invocation.preview, request.input);
          const previewOutcome = invocationResult(adapter.invoke(preview.endpoint, preview.body), `${name} preview`);
          if (previewOutcome.status !== 'SUCCEEDED') return previewOutcome;
          const previewId = findPreviewId(previewOutcome.output);
          if (invocation.confirmationRequired && !previewId) {
            return { status: 'FAILED', summary: `BCM capability ${name} preview failed`, output: previewOutcome.output,
              diagnostic: 'BCM preview response did not contain preview_id' };
          }
          if (previewId) executeInput.preview_id = previewId;
        }
        if (invocation.confirmationRequired) executeInput.confirm = true;
        const execute = prepare(invocation, executeInput);
        return invocationResult(adapter.invoke(execute.endpoint, execute.body), name);
      } catch (error) {
        return { status: 'FAILED', summary: `BCM capability ${name} failed`, output: null,
          diagnostic: error?.message || String(error) };
      }
    },
  };
}

module.exports = createBcmCsProvider();
module.exports.createBcmCsProvider = createBcmCsProvider;
