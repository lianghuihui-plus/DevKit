'use strict';

const path = require('path');
const { validateAgentJson } = require('../../lib/agent-json-contract');
const { createRegistry } = require('./registry');
const { beginInvocation, completeInvocation } = require('./invocation-store');
const { CATALOG_RELATIVE, definitionDigest, freezeCatalog, loadCatalog, resolveCapability } = require('./snapshot-store');
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

function rejectedReference(error) {
  return {
    status: 'REQUEST_INVALID',
    code: error.code === 'RESOURCE_SCOPE_MISMATCH' ? 'CAPABILITY_SCOPE_MISMATCH' : 'CAPABILITY_UNKNOWN',
    issues: [{ fieldPath: 'input.capabilityRef', expected: 'a capabilityRef from this execution catalog', code: error.code || 'CAPABILITY_UNKNOWN' }],
  };
}

function normalizeOutcome(value) {
  if (value && ['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(value.status)) {
    return {
      status: value.status,
      summary: typeof value.summary === 'string' ? value.summary : '',
      output: value.output === undefined ? null : value.output,
      diagnostic: value.diagnostic === undefined ? null : value.diagnostic,
    };
  }
  return { status: 'UNKNOWN', summary: 'provider returned an invalid outcome', output: null, diagnostic: 'provider outcome contract invalid' };
}

function invokeCapability(execDir, request, options = {}) {
  let definition;
  try {
    definition = resolveCapability(execDir, request.capabilityRef);
  } catch (error) {
    return rejectedReference(error);
  }
  const issues = validateAgentJson(request.input, definition.inputSchema, {}, 'input.input');
  if (issues.length) return { status: 'REQUEST_INVALID', code: 'CAPABILITY_INPUT_INVALID', issues };
  const provider = registryFor(options).get(definition.moduleId);
  if (!provider) {
    return {
      status: 'FAILED', code: 'CAPABILITY_EXECUTION_FAILED', capabilityName: definition.name,
      issues: [{ fieldPath: 'input.capabilityRef', expected: 'a currently registered provider', code: 'CAPABILITY_PROVIDER_UNAVAILABLE' }],
    };
  }
  const definitionSha = definitionDigest(definition);
  const state = beginInvocation(execDir, definition, definitionSha, request, options);
  let outcome;
  try {
    const context = Object.freeze({ ...providerContext(execDir, options), operationId: state.operationId });
    outcome = normalizeOutcome(provider.invoke({ capability: definition, input: request.input }, context));
  } catch (error) {
    const uncertain = error?.outcomeKnown === false || ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code);
    outcome = {
      status: uncertain ? 'UNKNOWN' : 'FAILED', summary: uncertain ? 'provider outcome is unknown' : 'provider invocation failed',
      output: null, diagnostic: error?.message || String(error),
    };
  }
  const persisted = completeInvocation(execDir, state, definition, definitionSha, request, outcome, options);
  return {
    status: outcome.status === 'SUCCEEDED' ? 'CAPABILITY_COMPLETED' : outcome.status,
    ...(outcome.status === 'FAILED' ? { code: 'CAPABILITY_EXECUTION_FAILED' } : {}),
    ...(outcome.status === 'UNKNOWN' ? { code: 'CAPABILITY_OUTCOME_UNKNOWN', retryable: false } : {}),
    capabilityName: definition.name,
    invocationRef: persisted.publication.data.ref,
    data: persisted.publication.data,
    resources: persisted.publication.resources,
  };
}

module.exports = {
  invokeCapability,
  providerContext,
  queryCapabilities,
};
