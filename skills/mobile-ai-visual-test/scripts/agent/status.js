#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildCounts, timeLimitState } = require('../lib/execution-time-limit');
const { collectEvidence } = require('../lib/execution-evidence');
const { readJson } = require('../lib/execution-lifecycle');
const {
  currentObservation,
  hasCurrentStartObservation,
  knowledgeQueryDraftIds,
  latestRecoveryIndex,
  openOperations,
  pendingPostActionObservation,
  timelineEvents,
  turnDraftIds,
} = require('../execution/core');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');
const { activeCheckpoint, controlRequestPath } = require('./control-request');
const { deriveCheckpointProgress } = require('../lib/checkpoint-progress');

function operationRecoveries(execDir, events, timeLimitReached = false) {
  const agentDir = path.join(execDir, 'agent');
  if (!fs.existsSync(agentDir)) return [];
  return fs.readdirSync(agentDir).filter((name) => /^operation-.+\.draft\.json$/.test(name)).sort().map((name) => {
    const draft = readJson(path.join(agentDir, name), null);
    if (!draft?.request?.operationId) return null;
    const operationId = draft.request.operationId;
    const timelineCompleted = events.some((event) => event.type === 'operationCompleted' && event.operationId === operationId);
    let recoveryMode = 'EXECUTE_FROZEN_REQUEST';
    if (timelineCompleted) recoveryMode = 'REBUILD_FROZEN_RECORD';
    else if (draft.status === 'RESULT_FROZEN') recoveryMode = 'COMMIT_FROZEN_RESULT';
    else if (draft.status === 'ADAPTER_CALLING' && draft.kind === 'ACTION') recoveryMode = 'MARK_OUTCOME_UNCERTAIN';
    else if (draft.status === 'ADAPTER_CALLING') recoveryMode = timeLimitReached ? 'MARK_OBSERVATION_UNAVAILABLE' : 'REOBSERVE';
    else if (draft.status === 'REQUEST_FROZEN' && timeLimitReached) recoveryMode = 'CANCEL_FROZEN_REQUEST';
    return { operationId, kind: draft.kind, status: draft.status || 'REQUEST_FROZEN', recoveryMode };
  }).filter(Boolean);
}

function turnRecoveries(execDir) {
  const turnsDir = path.join(execDir, 'agent', 'turns');
  return turnDraftIds(execDir).map((turnId) => {
    const draft = readJson(path.join(turnsDir, `${turnId}.draft.json`), null);
    return {
      turnId,
      committedFactIds: timelineEvents(execDir)
        .filter((event) => event.turnId === turnId)
        .map((event) => event.factId)
        .filter(Boolean)
        .sort(),
      recoveryMode: 'COMMIT_FROZEN_TURN',
      frozen: Boolean(draft?.turn),
    };
  });
}

function stepRecoveries(execDir) {
  const stepsDir = path.join(execDir, 'agent', 'steps');
  if (!fs.existsSync(stepsDir)) return [];
  return fs.readdirSync(stepsDir).filter((name) => /^step-.+\.draft\.json$/.test(name)).sort().flatMap((name) => {
    const draft = readJson(path.join(stepsDir, name), null);
    return draft?.stepId ? [{ stepId: draft.stepId, status: draft.status || 'ACTION_PENDING', recoveryMode: 'RESUME_SEMANTIC_STEP' }] : [];
  });
}

function readAgentStatus(execDir, now = new Date().toISOString()) {
  const binding = validateLiveAgentBinding(execDir);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  const runtime = readJson(path.join(execDir, 'agent', 'runtime.json'), null);
  if (!execution || !runtime || runtime.executionId !== execution.executionId) throw new Error('AGENT_STATUS_BINDING_MISMATCH: execution and Runtime are required');
  const events = timelineEvents(execDir);
  const limit = timeLimitState(execution, now);
  const understanding = readJson(path.join(execDir, 'understanding.json'), null);
  const plan = readJson(path.join(execDir, 'plan.json'), null);
  const evidence = collectEvidence(events, { execDir, executionId: execution.executionId });
  const pendingObservation = pendingPostActionObservation(events);
  const pendingRecoveries = operationRecoveries(execDir, events, limit.reached);
  const knowledgeQueryRecoveries = knowledgeQueryDraftIds(execDir).map((queryId) => ({ queryId, recoveryMode: 'COMMIT_FROZEN_QUERY' }));
  const pendingTurnRecoveries = turnRecoveries(execDir);
  const pendingStepRecoveries = stepRecoveries(execDir);
  const controlRequest = readJson(controlRequestPath(execDir), null);
  const startEstablished = Boolean(understanding && hasCurrentStartObservation(
    events, understanding.revision, execution.warmSessionGeneration,
  ));
  const hasCheckpoints = Boolean(plan?.checkpoints?.length);
  const missingArtifacts = [];
  if (!understanding) missingArtifacts.push('understanding');
  else {
    if (!understanding.sourceRefs?.length) missingArtifacts.push('understanding.sourceRefs');
    if (!understanding.requirements?.length) missingArtifacts.push('understanding.requirements');
  }
  if (!plan) missingArtifacts.push('plan');
  else if (!plan.checkpoints?.length) missingArtifacts.push('plan.checkpoints');
  const operationSlotAvailable = !execution.finalized && !limit.reached && openOperations(events).length === 0
    && pendingRecoveries.length === 0 && knowledgeQueryRecoveries.length === 0 && pendingTurnRecoveries.length === 0
    && pendingStepRecoveries.length === 0;
  const executionReady = missingArtifacts.length === 0;
  const latestObservation = currentObservation(events, execution.warmSessionGeneration);
  const postRecoveryObservationRequired = latestRecoveryIndex(events) >= 0 && !latestObservation;
  const timeLimitObservationGap = events.some((event) => event.type === 'timeLimitReached'
    && event.observationUnavailable === true);
  const completedKnowledgeReview = events.some((event) => event.type === 'knowledgeReview');
  const conclusionConstraint = timeLimitObservationGap ? {
    mode: 'TIME_LIMIT_OBSERVATION_GAP',
    allowedVerdicts: ['INCONCLUSIVE'],
    findingStatus: 'UNRESOLVED',
    knowledgeRequired: true,
  } : {
    mode: 'NORMAL',
    allowedVerdicts: ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'],
    findingStatus: null,
    knowledgeRequired: false,
  };
  const conclusionTransactionsReady = !execution.finalized && Boolean(understanding && plan) && !pendingObservation
    && pendingRecoveries.length === 0 && knowledgeQueryRecoveries.length === 0 && pendingTurnRecoveries.length === 0
    && pendingStepRecoveries.length === 0 && !controlRequest
    && ['UNDERSTAND', 'ESTABLISH_START', 'EXECUTE', 'INVESTIGATE', 'CONCLUDE'].includes(execution.phase);
  return {
    schemaVersion: 1,
    executionId: execution.executionId,
    sessionId: runtime.sessionId,
    warmSessionGeneration: execution.warmSessionGeneration,
    phase: execution.phase,
    finalized: execution.finalized === true,
    understandingRevision: understanding?.revision || null,
    planRevision: plan?.revision || null,
    checkpointIds: (plan?.checkpoints || []).map((entry) => entry.id),
    activeCheckpointRef: activeCheckpoint(plan, events, execution.warmSessionGeneration),
    checkpointProgress: deriveCheckpointProgress(plan, events, null, {
      warmSessionGeneration: execution.warmSessionGeneration,
    }),
    evidence: evidence.map((entry) => ({
      ref: entry.ref,
      scope: entry.phase,
      usable: entry.usable,
      warmSessionGeneration: entry.warmSessionGeneration || null,
    })),
    currentObservationRef: latestObservation?.ref || null,
    openOperationIds: openOperations(events).map((entry) => entry.operationId),
    operationRecoveries: pendingRecoveries,
    knowledgeQueryRecoveries,
    turnRecoveries: pendingTurnRecoveries,
    stepRecoveries: pendingStepRecoveries,
    frameworkRecoveryPending: pendingRecoveries.length > 0 || knowledgeQueryRecoveries.length > 0
      || pendingTurnRecoveries.length > 0 || pendingStepRecoveries.length > 0,
    controlRequestPending: Boolean(controlRequest),
    postActionObservationRequired: pendingObservation ? {
      operationId: pendingObservation.operationId,
      actionType: pendingObservation.requestedAction?.type || pendingObservation.actionType || null,
    } : null,
    postRecoveryObservationRequired,
    counts: buildCounts(events),
    timeLimitReached: limit.reached,
    remainingMs: limit.remainingMs,
    conclusionConstraint,
    readiness: {
      missingArtifacts,
      executionReady,
      contractPath: binding.request.agentContractPath,
      contractSha: binding.request.agentContractSha,
    },
    signals: {
      mayOperate: operationSlotAvailable && executionReady && !controlRequest,
      mayObserve: operationSlotAvailable && executionReady && !controlRequest,
      mayAct: operationSlotAvailable && executionReady && Boolean(latestObservation) && !pendingObservation && !controlRequest,
      mayConclude: conclusionTransactionsReady && (!timeLimitObservationGap || completedKnowledgeReview),
      startEstablished,
      currentObservationAvailable: Boolean(latestObservation),
      hasCheckpoints,
      knowledgeAvailable: Array.isArray(binding.request.knowledgeRoots) && binding.request.knowledgeRoots.length === 2,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--exec-dir') options.execDir = path.resolve(argv[++index]);
    else if (argv[index] === '--now') options.now = argv[++index];
    else throw new Error(`AGENT_STATUS_CLI_INVALID: unknown option ${argv[index]}`);
  }
  if (!options.execDir) throw new Error('AGENT_STATUS_CLI_INVALID: --exec-dir is required');
  return readAgentStatus(options.execDir, options.now);
}

if (require.main === module) {
  require('./cli-support').runAgentCli('status', process.argv.slice(2), {
    command: 'node scripts/agent/status.js --exec-dir <execution> [--now <iso-time>]',
  }, main);
}

module.exports = { main, operationRecoveries, readAgentStatus, stepRecoveries, turnRecoveries };
