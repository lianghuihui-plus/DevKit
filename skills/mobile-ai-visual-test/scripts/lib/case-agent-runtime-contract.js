'use strict';

const { canonicalJson, sha256 } = require('./contract-utils');
const { buildCaseAgentGuidance } = require('./case-agent-guidance');
const { describeAgentInputSchemas } = require('./agent-input-contract');

function commandTemplates() {
  return {
    status: 'node scripts/agent/status.js --exec-dir <execution>',
    understand: "node scripts/agent/understand.js --exec-dir <execution> --request-json '<json>'",
    plan: "node scripts/agent/plan.js --exec-dir <execution> --request-json '<json>'",
    inspect: "node scripts/agent/inspect.js --exec-dir <execution> [--request-json '<json>']",
    step: "node scripts/agent/step.js --exec-dir <execution> --request-json '<json>'",
    markStart: "node scripts/agent/mark-start.js --exec-dir <execution> [--request-json '<json>']",
    requestRecovery: "node scripts/agent/request-recovery.js --exec-dir <execution> --request-json '<json>'",
    investigate: "node scripts/agent/investigate.js --exec-dir <execution> --request-json '<json>'",
    conclude: "node scripts/agent/conclude.js --exec-dir <execution> --request-json '<json>'",
  };
}

function schemas(platform) {
  const inputs = describeAgentInputSchemas(platform);
  return {
    ...inputs,
    observationView: {
      required: ['observationRef', 'scope', 'usable', 'screenshot', 'layout', 'signals', 'actionEffect', 'stateChanges', 'conflicts', 'elements'],
      screenshotRequired: ['ref', 'sha256', 'width', 'height'],
      layoutRequired: ['usable', 'format', 'diagnostics'],
      elementRequired: ['ref', 'text', 'role', 'bounds', 'clickable', 'checkable', 'editable', 'enabled', 'visible', 'focused', 'secure', 'maskedLength', 'stateKey'],
      signals: ['keyboard', 'focusedElement', 'layoutViewport', 'adapterWindowRect', 'coordinateConsistency'],
      actionEffect: ['CHANGED', 'NO_VISIBLE_CHANGE', 'UNKNOWN', null],
      note: 'elements, technical signals, actionEffect, stateChanges and conflicts are framework-derived technical evidence; actionEffect only describes visible change and is not a business assertion',
    },
    runtimeState: {
      required: ['phase', 'finalized', 'currentObservationRef', 'activeCheckpointRef', 'activeCheckpoint', 'continuation', 'frameworkRecoveryPending', 'controlRequestPending', 'timeLimitReached', 'remainingMs', 'conclusionConstraint', 'signals'],
      activeCheckpoint: 'null before start establishment; afterward expands the active checkpoint and linked requirements',
      continuation: 'INITIAL requires understanding and plan creation; RESUME preserves current semantic artifacts and phase; RECOVERY_RESUME requires status-driven continuation without rebuilding understanding or plan',
      conclusionConstraint: 'TIME_LIMIT_OBSERVATION_GAP exposes only INCONCLUSIVE after the required knowledge review; NORMAL keeps verdict-specific guards',
      recoveryRule: 'internal transaction recovery belongs to the coordinator; Agent only waits for controlRequestPending to clear',
      timingNote: 'agentOrchestrationGapMs is residual Agent/tool orchestration time, not pure model thinking time',
    },
  };
}

function buildCaseAgentRuntimeContract(options = {}) {
  const value = {
    schemaVersion: 1,
    role: 'case-executor',
    platform: options.platform,
    protocolSha: options.protocolSha,
    implementationSha: options.implementationSha,
    commands: commandTemplates(),
    guidance: buildCaseAgentGuidance(),
    schemas: schemas(options.platform),
    behavior: {
      responsibility: 'Agent decides business intent, path, assertions, knowledge applicability, and verdict; framework derives protocol bookkeeping',
      initialTurn: 'use runtimeState.continuation; create understanding and plan only when they are missing, otherwise preserve current semantic artifacts and resume the current phase',
      executionLoop: 'consume observationView, submit one semantic step, then consume its automatic post-action observation; stage and the default active checkpoint are framework-derived',
      start: 'mark-start explicitly confirms the usable start observation before BUSINESS steps',
      state: 'normal successful responses carry compact runtimeState without the full evidence inventory; status returns the full runtime state only for reconnect or uncertain transport',
      understandingRevision: 'revise understanding only to correct omission or misinterpretation; a revision invalidates the plan and start confirmation',
      planRevision: 'revise only checkpoint organization or strategy; ordinary actions and progress do not create plan revisions',
      knowledge: 'query only when the current scene needs investigation or the intended verdict requires it',
      finalize: 'conclude generates checkpoint facts, verdictReview, result, metrics, and AgentResult atomically',
      noNextWork: true,
      zeroRequirements: 'after an empty requirement set and empty plan, device operations, start confirmation, and recovery requests are disabled; revise understanding or investigate and conclude INCONCLUSIVE',
      isolation: 'the Agent host must enforce the allowed entrypoint and read-only resource lists as a tool allowlist; without host enforcement this contract provides protocol isolation only',
    },
  };
  return { ...value, contractSha: sha256(canonicalJson(value), 'case-agent-runtime-contract', 24) };
}

module.exports = {
  buildCaseAgentRuntimeContract,
  commandTemplates,
  schemas,
};
