'use strict';

const { validateCapabilityDefinition } = require('../../../capability-modules/contract');
const { createAdapter } = require('./adapter');
const { commandSucceeded, invocationResult } = require('./response-mapper');

function cliDefinition() {
  return validateCapabilityDefinition({
    name: 'cli',
    summary: 'Run the native bcm-cs CLI. Use --help and command-level help to discover and execute BCM commands.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        args: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
          description: 'Arguments passed after bcm-cs. Use --help and command-level help to discover native commands.',
        },
      },
      required: ['args'],
    },
    sensitiveFields: { input: ['args'], output: [] },
  });
}

function createBcmCsProvider(options = {}) {
  return {
    manifest: {
      id: 'bcm-cs',
      version: '2.0.0',
      summary: 'BCM test environment configuration and data through the native bcm-cs CLI',
    },

    probe(context) {
      const result = createAdapter(context, options).version();
      if (!commandSucceeded(result)) {
        return {
          status: 'UNAVAILABLE',
          implementationVersion: null,
          diagnostic: 'bcm-cs executable unavailable',
          discoverySeed: null,
        };
      }
      return {
        status: 'READY',
        implementationVersion: String(result.stdout || '').trim() || 'bcm-cs',
        diagnostic: null,
        discoverySeed: null,
      };
    },

    listCapabilities() {
      return [cliDefinition()];
    },

    invoke(request, context) {
      const name = request.capability?.providerCapabilityName || request.capability?.name;
      if (name !== 'cli') {
        return {
          status: 'FAILED',
          summary: 'BCM capability is not executable',
          output: null,
          diagnostic: 'unknown bcm-cs provider capability',
        };
      }
      const args = request.input?.args;
      if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string' || !arg)) {
        return {
          status: 'FAILED',
          summary: 'BCM capability cli failed',
          output: null,
          diagnostic: 'bcm-cs args must be a non-empty array of non-empty strings',
        };
      }
      return invocationResult(createAdapter(context, options).invoke(args), name);
    },
  };
}

module.exports = createBcmCsProvider();
module.exports.createBcmCsProvider = createBcmCsProvider;
