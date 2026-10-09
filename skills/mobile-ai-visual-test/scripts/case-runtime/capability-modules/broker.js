'use strict';

const path = require('path');
const { createRegistry } = require('./registry');
const { CATALOG_RELATIVE, freezeCatalog, loadCatalog } = require('./snapshot-store');
const resources = require('../agent-resource-store');
const store = require('../store');

function providerContext(execDir, options = {}) {
  const execution = store.loadExecution(execDir);
  return Object.freeze({
    executionDir: path.resolve(execDir),
    executionId: execution.executionId,
    workspaceRoot: options.workspaceRoot || null,
    platform: execution.platform,
    targetApp: execution.targetBinding ? {
      appId: execution.targetBinding.appId || null,
      appName: execution.targetBinding.appName || null,
    } : null,
    now: options.now || new Date().toISOString(),
    ...(options.bcmCsExecutable ? { bcmCsExecutable: options.bcmCsExecutable } : {}),
    ...(options.capabilityProcessRunner ? { processRunner: options.capabilityProcessRunner } : {}),
  });
}

function registryFor(options) {
  return options.capabilityRegistry || createRegistry(options.capabilityProviders || []);
}

function queryCapabilities(execDir, options = {}) {
  const freeze = () => {
    let catalog = loadCatalog(execDir);
    if (!catalog) {
      const context = providerContext(execDir, options);
      catalog = freezeCatalog(execDir, registryFor(options).discover(context), options);
    }
    const catalogRef = resources.resourceRef(execDir, 'capabilityCatalog', CATALOG_RELATIVE);
    const publication = resources.readPublishedResource(execDir, catalogRef);
    return {
      status: 'CAPABILITY_CATALOG_READY',
      catalogRef,
      availableCount: catalog.availableCount,
      data: publication.data,
      resources: publication.declaredResources,
    };
  };
  return options.lockHeld ? freeze() : store.withRuntimeLock(execDir, freeze, options);
}

module.exports = {
  providerContext,
  queryCapabilities,
};
