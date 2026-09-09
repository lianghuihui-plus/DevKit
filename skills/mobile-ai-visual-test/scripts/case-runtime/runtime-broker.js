'use strict';

const path = require('path');
const { readJson } = require('../lib/execution-lifecycle');
const runtimeCore = require('./runtime-core');

const AGENT_OPERATIONS = Object.freeze(['observe', 'act', 'knowledge', 'recover', 'finish', 'status']);

function executeAgentRequest(execDir, request, options = {}) {
  const resolved = path.resolve(execDir);
  const runtime = readJson(path.join(resolved, 'runtime.json'), null);
  const allowed = runtime?.broker?.schemaVersion === 1 && Array.isArray(runtime.broker.allowedOperations)
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

module.exports = { AGENT_OPERATIONS, executeAgentRequest };
