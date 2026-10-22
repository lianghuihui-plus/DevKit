'use strict';

const path = require('path');
const { readJson } = require('../lib/execution-lifecycle');
const runtimeCore = require('./runtime-core');
const {
  AGENT_OPERATIONS,
  isSupportedBroker,
} = require('./runtime-operation-contract');

function executeAgentRequest(execDir, request, options = {}) {
  require('../lib/runtime-binding').assertExecutionRuntime(execDir);
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
      issues: [{
        fieldPath: 'operation',
        expected: allowed.join(' | '),
        code: 'OPERATION_FORBIDDEN',
      }],
      allowedOperations: allowed,
    };
  }
  // Loader validation never reaches this broker; this idempotently marks the first Agent Runtime invocation.
  require('./lifecycle').recordTimingAnchor({ executionDir: resolved, field: 'handoffConsumedAt', now: options.now, lockHeld: options.lockHeld });
  return runtimeCore.execute(resolved, request, options);
}

function executeFacadeRequest(execDir, request, options = {}) {
  require('../lib/runtime-binding').assertExecutionRuntime(execDir);
  if (['queryCapabilities', 'useCapability', 'reviewKnowledge', 'recordCaseFlow', 'recordExpectationResults', 'prepare'].includes(request?.operation)) {
    const resolved = path.resolve(execDir);
    const runtime = readJson(path.join(resolved, 'runtime.json'), null);
    if (!isSupportedBroker(runtime?.broker) || !runtime?.entry) {
      return {
        status: 'REQUEST_INVALID', code: 'CASE_RUNTIME_OPERATION_FORBIDDEN',
        message: `${request.operation} is only available through a bound Agent-facing Facade`, scene: null,
      };
    }
    require('./lifecycle').recordTimingAnchor({ executionDir: resolved, field: 'handoffConsumedAt', now: options.now, lockHeld: options.lockHeld });
    if (request.operation === 'queryCapabilities') {
      return require('./capability-modules/broker').queryCapabilities(resolved, options);
    }
    if (request.operation === 'useCapability') {
      return require('./capability-modules/broker').invokeCapability(resolved, request, options);
    }
    return runtimeCore.execute(resolved, request, options);
  }
  return executeAgentRequest(execDir, request, options);
}

module.exports = {
  AGENT_OPERATIONS,
  executeAgentRequest,
  executeFacadeRequest,
  isSupportedBroker,
};
