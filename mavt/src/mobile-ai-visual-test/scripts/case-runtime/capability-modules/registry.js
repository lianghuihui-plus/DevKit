'use strict';

const { contractError } = require('../../lib/contract-utils');
const { validateCapabilityDefinition, validateProvider } = require('./contract');

function moduleUnavailable(provider, diagnostic) {
  return {
    moduleId: provider.manifest.id,
    summary: provider.manifest.summary,
    diagnostic,
  };
}

function createRegistry(providers = []) {
  const registered = providers.map(validateProvider);
  const byId = new Map();
  for (const provider of registered) {
    if (byId.has(provider.manifest.id)) {
      throw contractError('CAPABILITY_PROVIDER_DUPLICATE', `duplicate capability provider: ${provider.manifest.id}`);
    }
    byId.set(provider.manifest.id, provider);
  }

  return Object.freeze({
    discover(context) {
      const available = [];
      const unavailable = [];
      for (const provider of registered) {
        let probeResult;
        try {
          probeResult = provider.probe(context);
        } catch (_error) {
          unavailable.push(moduleUnavailable(provider, 'provider probe failed'));
          continue;
        }
        if (!probeResult || probeResult.status !== 'READY') {
          unavailable.push(moduleUnavailable(provider, probeResult?.diagnostic || 'provider unavailable'));
          continue;
        }
        try {
          const listed = provider.listCapabilities(context, probeResult);
          if (!Array.isArray(listed)) throw contractError('CAPABILITY_DISCOVERY_INVALID', 'provider list must return an array');
          const definitions = [];
          const diagnostics = [...(listed.diagnostics || [])];
          const names = new Set();
          for (const candidate of listed) {
            try {
              validateCapabilityDefinition(candidate);
              if (names.has(candidate.name)) throw contractError('CAPABILITY_DEFINITION_INVALID', `duplicate capability: ${candidate.name}`);
              names.add(candidate.name);
              definitions.push(candidate);
            } catch (_error) {
              diagnostics.push('invalid capability definition excluded');
            }
          }
          available.push({
            moduleId: provider.manifest.id,
            moduleVersion: provider.manifest.version,
            moduleSummary: provider.manifest.summary,
            implementationVersion: probeResult.implementationVersion || null,
            definitions,
            diagnostics,
          });
        } catch (_error) {
          unavailable.push(moduleUnavailable(provider, 'provider discovery failed'));
        }
      }
      return { available, unavailable };
    },
    get(moduleId) { return byId.get(moduleId) || null; },
    list() { return [...registered]; },
  });
}

function defaultProviders() {
  return [require('./modules/bcm-cs')];
}

module.exports = { createRegistry, defaultProviders };
