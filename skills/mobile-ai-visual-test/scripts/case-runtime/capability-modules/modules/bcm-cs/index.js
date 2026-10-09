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
      return invocationResult(createAdapter(context, options).invoke(invocation, request.input), name);
    },
  };
}

module.exports = createBcmCsProvider();
module.exports.createBcmCsProvider = createBcmCsProvider;
