'use strict';

const OPERATION_CONTRACT = Object.freeze({
  prepare: Object.freeze({
    agentAccessible: false,
    requestFields: Object.freeze(['operation', 'preparation', 'decision']),
  }),
  observe: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'purpose', 'decision']),
  }),
  act: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'basedOnSceneId', 'capabilityId', 'visual', 'input', 'observationPolicy', 'decision']),
  }),
  inspectVisual: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'basedOnSceneId', 'decision']),
  }),
  inspectScene: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'basedOnSceneId', 'view', 'filter']),
  }),
  knowledge: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'basedOnSceneId', 'query', 'context', 'decision']),
  }),
  recover: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'basedOnSceneId', 'reason', 'decision']),
  }),
  finish: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation', 'basedOnSceneId', 'result', 'decision']),
  }),
  status: Object.freeze({
    agentAccessible: true,
    requestFields: Object.freeze(['operation']),
  }),
});

const RUNTIME_OPERATIONS = Object.freeze(Object.keys(OPERATION_CONTRACT));
const AGENT_OPERATIONS = Object.freeze(RUNTIME_OPERATIONS
  .filter((operation) => OPERATION_CONTRACT[operation].agentAccessible));
const BROKER_OPERATION_SETS = Object.freeze({
  1: Object.freeze(['observe', 'act', 'knowledge', 'recover', 'finish', 'status']),
  2: Object.freeze(['observe', 'act', 'inspectVisual', 'knowledge', 'recover', 'finish', 'status']),
  3: Object.freeze(['observe', 'act', 'inspectVisual', 'knowledge', 'recover', 'finish', 'status']),
  4: AGENT_OPERATIONS,
});

function isSupportedBroker(broker) {
  if (!broker || typeof broker !== 'object') return false;
  const expected = BROKER_OPERATION_SETS[broker.schemaVersion];
  return Boolean(expected) && JSON.stringify(broker.allowedOperations) === JSON.stringify(expected);
}

module.exports = {
  AGENT_OPERATIONS,
  BROKER_OPERATION_SETS,
  OPERATION_CONTRACT,
  RUNTIME_OPERATIONS,
  isSupportedBroker,
};
