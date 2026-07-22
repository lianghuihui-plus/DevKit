'use strict';

const { fail } = require('./common');
const { assessAction } = require('./safety');
const { executeDeviceAction } = require('./device-action-executor');
const { loadObservationBundle } = require('./observation-store');
const { executableActionFromIntent } = require('./action-intent');

function assessReplayableAction(action, scan, replayPolicy = null, reasonCode = 'REPLAY_ACTION_UNSAFE') {
  const safety = assessAction(action, scan.target);
  if (!safety.allowed || replayPolicy === 'NONREPEATABLE') fail('Path replay action is missing, unsafe, or non-repeatable', reasonCode);
  return safety;
}

function executePathStepAction(scanDir, {
  scan,
  contextId,
  beforeObservationId,
  action,
  safety,
  owner,
  role,
  category,
  locatorResolution = 'COORDINATE_ONLY',
  idempotency = 'SAFE_RETRY_AFTER_OBSERVATION',
  actionResultExtra = {},
  failureReasonCode = 'PATH_REPLAY_ACTION_FAILED',
  syntheticSeed = null
}) {
  return executeDeviceAction(scanDir, {
    scan,
    contextId,
    beforeObservationId,
    action,
    safety,
    owner,
    role,
    category,
    locatorResolution,
    idempotency,
    actionResultExtra,
    failureReasonCode,
    syntheticSeed,
    emitActionResultEvents: false,
    writeUnknownEvidence: false,
    writeSuccessEvidence: false,
    includeSafetyInResult: false
  });
}

function navigationStepAction(graph, step) {
  if (step.kind === 'BACK') return {
    action: { type: 'keyEvent', key: 'BACK' },
    intent: { schemaVersion: 1, type: 'keyEvent', key: 'BACK', target: 'BACK' },
    expectedReachableStateId: step.expectedReachableStateId,
    locatorResolution: 'SYSTEM_KEY'
  };
  const edge = graph.edges.find(item => item.id === step.edgeId);
  return {
    edge,
    intent: edge?.intent,
    expectedReachableStateId: edge?.toReachableStateId,
    locatorResolution: 'SEMANTIC_RESOLVED'
  };
}

function resolveReplayAction(scanDir, contextId, beforeObservationId, edgeOrIntent) {
  const intent = edgeOrIntent?.intent || edgeOrIntent;
  const bundle = loadObservationBundle(scanDir, beforeObservationId, { contextId, requireComplete: true, requireFiles: true });
  return executableActionFromIntent({
    intent,
    layout: bundle.layout,
    previousEvidence: edgeOrIntent?.locatorEvidence || null
  });
}

module.exports = {
  assessReplayableAction,
  executePathStepAction,
  navigationStepAction,
  resolveReplayAction
};
