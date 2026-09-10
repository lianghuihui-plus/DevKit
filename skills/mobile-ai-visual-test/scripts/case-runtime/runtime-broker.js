'use strict';

const path = require('path');
const { readJson } = require('../lib/execution-lifecycle');
const runtimeCore = require('./runtime-core');
const {
  AGENT_OPERATIONS,
  BROKER_OPERATION_SETS,
  isSupportedBroker,
} = require('./runtime-operation-contract');

const LEGACY_AGENT_OPERATIONS = BROKER_OPERATION_SETS[1];
const V3_AGENT_OPERATIONS = BROKER_OPERATION_SETS[3];

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
  // Loader validation never reaches this broker; this idempotently marks the first Agent Runtime invocation.
  require('./lifecycle').recordTimingAnchor({ executionDir: resolved, field: 'handoffConsumedAt', now: options.now });
  return runtimeCore.execute(resolved, request, options);
}

module.exports = {
  AGENT_OPERATIONS,
  LEGACY_AGENT_OPERATIONS,
  V3_AGENT_OPERATIONS,
  executeAgentRequest,
  isSupportedBroker,
};
