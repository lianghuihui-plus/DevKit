'use strict';

const path = require('path');
const { readJson } = require('../lib/execution-lifecycle');
const runtimeCore = require('./runtime-core');

const LEGACY_AGENT_OPERATIONS = Object.freeze(['observe', 'act', 'knowledge', 'recover', 'finish', 'status']);
const AGENT_OPERATIONS = Object.freeze(['observe', 'act', 'inspectVisual', 'knowledge', 'recover', 'finish', 'status']);

function isSupportedBroker(broker) {
  if (!broker || typeof broker !== 'object') return false;
  if (broker.schemaVersion === 3 || broker.schemaVersion === 2) {
    return JSON.stringify(broker.allowedOperations) === JSON.stringify(AGENT_OPERATIONS);
  }
  if (broker.schemaVersion === 1) {
    return JSON.stringify(broker.allowedOperations) === JSON.stringify(LEGACY_AGENT_OPERATIONS);
  }
  return false;
}

function executeAgentRequest(execDir, request, options = {}) {
  const resolved = path.resolve(execDir);
  const runtime = readJson(path.join(resolved, 'runtime.json'), null);
  const allowed = isSupportedBroker(runtime?.broker) && Array.isArray(runtime.broker.allowedOperations)
    ? runtime.broker.allowedOperations : [];
  if (!allowed.includes(request?.operation) || !AGENT_OPERATIONS.includes(request?.operation)) {
    return {
      status: 'REQUEST_INVALID',
      code: 'CASE_RUNTIME_OPERATION_FORBIDDEN',
      message: `${request?.operation || 'unknown'} is not available through the Case Agent Runtime Client`,
      scene: null,
      expected: { operation: AGENT_OPERATIONS.join(' | ') },
    };
  }
  return runtimeCore.execute(resolved, request, options);
}

module.exports = {
  AGENT_OPERATIONS,
  LEGACY_AGENT_OPERATIONS,
  executeAgentRequest,
  isSupportedBroker,
};
