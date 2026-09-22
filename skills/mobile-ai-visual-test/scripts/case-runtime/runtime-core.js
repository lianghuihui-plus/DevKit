'use strict';

const { validateRuntimeRequest } = require('./contract');
const actionService = require('./action-service');
const knowledgeService = require('./knowledge-service');
const narrativeService = require('./narrative-service');
const { requestCorrection } = require('./runtime-operation-contract');
const resultService = require('./result-service');
const sceneService = require('./scene-service');
const store = require('./store');
const telemetry = require('./telemetry');

const TIME_LIMIT_MS = 30 * 60 * 1000;

function knowledgeInvestigationStatus(execDir) {
  const runtime = require('../lib/execution-lifecycle').readJson(store.paths(execDir).runtime, null);
  const events = store.events(execDir);
  const reviews = new Map(events.filter((event) => event.type === 'knowledgeReviewed')
    .map((event) => [event.queryId, event]));
  return {
    available: runtime?.broker?.allowedOperations?.includes('knowledge') === true,
    pendingReviews: events.filter((event) => event.type === 'knowledgeQueried' && !reviews.has(event.queryId))
      .map((event) => require('./knowledge-review').projectPendingKnowledgeReview(event)),
    reviewedExpectationRefs: [...new Set([...reviews.values()].flatMap((event) => event.expectationRefs || []))].sort(),
  };
}

function preparationStatus(execDir, execution) {
  const events = store.events(execDir);
  const completed = events.filter((event) => event.type === 'appPreparationCompleted').at(-1);
  if (completed) {
    return {
      targetState: completed.targetState,
      status: 'SATISFIED',
      sessionId: completed.sessionId,
      epoch: completed.epoch,
      generation: completed.generation,
    };
  }
  if (!execution.preparationFailed) return null;
  const failed = events.filter((event) => event.type === 'appPreparationFailed').at(-1);
  const fact = events.filter((event) => event.type === 'technicalIssue'
    && event.operation === 'prepare' && event.code === 'APP_INITIAL_STATE_UNAVAILABLE').at(-1);
  return {
    targetState: failed?.targetState || execution.preparationTargetState || null,
    status: 'FAILED',
    code: 'APP_INITIAL_STATE_UNAVAILABLE',
    technicalFactRef: fact?.technicalFactRef || null,
  };
}

function runtimeStatus(execDir) {
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  const preparation = preparationStatus(execDir, execution);
  return {
    status: execution.status === 'CANCELLED' ? 'CANCELLED' : execution.finalized ? 'COMPLETED' : 'READY',
    executionId: execution.executionId,
    generation: execution.warmSessionGeneration,
    remainingMs: Math.max(0, TIME_LIMIT_MS - (Date.now() - Date.parse(execution.startedAt))),
    scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
    narrative: narrativeService.narrativeStatus(execDir),
    knowledgeInvestigation: knowledgeInvestigationStatus(execDir),
    ...(preparation ? { preparation } : {}),
    ...(execution.finalized && execution.status !== 'CANCELLED'
      ? { verdict: require('../lib/execution-lifecycle').readJson(store.paths(execDir).result, null)?.verdict || null } : {}),
  };
}

function timeBudget(execDir, execution, now, context = {}) {
  const remainingMs = Math.max(0, TIME_LIMIT_MS - (Date.parse(now) - Date.parse(execution.startedAt)));
  if (remainingMs > 0) return { exhausted: false, remainingMs };
  const expectationRefs = [...new Set(context.expectationRefs || [])].sort();
  let fact = store.events(execDir).find((event) => event.type === 'timeBudgetExhausted'
    && JSON.stringify([...(event.expectationRefs || [])].sort()) === JSON.stringify(expectationRefs)) || null;
  if (!fact) fact = store.appendEvent(execDir, 'timeBudgetExhausted', {
    operation: context.operation || null,
    decisionId: context.decisionId || null,
    expectationRefs,
  }, { now });
  return { exhausted: true, remainingMs: 0, technicalFactRef: fact.technicalFactRef };
}

function narrativeExpectationRefs(narrative) {
  const decisionRefs = narrative?.decisionEvent?.decision?.expectationRefs || [];
  if (decisionRefs.length) return decisionRefs;
  return narrative?.caseContext?.expectations?.map((item) => item.id) || [];
}

function assertSceneBasis(execDir, request) {
  if (!['act', 'knowledge', 'reviewKnowledge', 'recover', 'finish'].includes(request.operation)) return;
  const scene = store.readCurrentScene(execDir);
  if (!scene) return;
  if (!request.basedOnSceneId) {
    const error = new Error(`${request.operation} requires basedOnSceneId from the Scene used for this decision`);
    error.code = 'CASE_RUNTIME_REQUEST_INVALID';
    throw error;
  }
  if (request.basedOnSceneId !== scene.sceneId) {
    const error = new Error(`request is based on ${request.basedOnSceneId}, but the current Scene is ${scene.sceneId}`);
    error.code = 'CASE_RUNTIME_SCENE_STALE';
    throw error;
  }
}

function recoveryBarrier(execDir, recoveredTransactions, pendingFinish) {
  const visibleRecoveries = recoveredTransactions.filter((item) => item.status !== 'NOT_SENT');
  if (!visibleRecoveries.length && !pendingFinish) return null;
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  return {
    status: 'RECOVERY_APPLIED',
    executionId: execution.executionId,
    executionStatus: execution.status,
    requiresReassessment: execution.finalized !== true,
    recoveredTransactions: visibleRecoveries.map((item) => ({
      kind: item.kind,
      operationId: item.operationId,
      status: item.status,
      ...(item.response?.code ? { code: item.response.code } : {}),
      ...(item.response?.technicalFactRef ? { technicalFactRef: item.response.technicalFactRef } : {}),
    })),
    ...(pendingFinish ? { recoveredFinish: { status: pendingFinish.status, verdict: pendingFinish.verdict || null } } : {}),
    scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
  };
}

function execute(execDir, request, options = {}) {
  const operation = String(request?.operation || '').trim() || 'unknown';
  let invocation;
  try {
    invocation = telemetry.beginInvocation(execDir, operation, request, options);
  } catch {
    invocation = null;
  }
  let response;
  let narrative = null;
  try {
    validateRuntimeRequest(request);
  } catch (error) {
    response = {
      status: 'REQUEST_INVALID',
      code: error.code || 'CASE_RUNTIME_REQUEST_INVALID',
      message: error.message || String(error),
      scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
      ...requestCorrection(operation, error),
    };
    if (invocation) telemetry.endInvocation(execDir, invocation, response, options);
    return response;
  }
  try {
    const executeLocked = () => {
      store.loadExecution(execDir, { allowFinalized: true });
      const recoveredTransactions = [
        ...require('./preparation-service').recoverPendingPreparation(execDir, { ...options, allowFinalized: true }),
        ...require('./recovery-service').recoverPendingTransactions(execDir, { ...options, allowFinalized: true }),
        ...require('./plan-service').recoverInterruptedPlans(execDir, { ...options, allowFinalized: true }),
      ];
      const pendingFinish = resultService.resumePendingFinish(execDir, { ...options, openInvocation: invocation });
      if (request.operation === 'status') {
        return runtimeStatus(execDir);
      }
      const barrier = recoveryBarrier(execDir, recoveredTransactions, pendingFinish);
      if (barrier) return barrier;
      const latestExecution = store.loadExecution(execDir, { allowFinalized: true });
      if (latestExecution.finalized) {
        return request.operation === 'finish'
          ? resultService.finish(execDir, request.result, { ...options, openInvocation: invocation })
          : runtimeStatus(execDir);
      }
      const preparationRecovery = require('./preparation-service').preparationRecoveryState(execDir);
      const retriesPreparation = request.operation === 'prepare'
        && preparationRecovery?.retryAllowed === true
        && request.preparation?.targetState === preparationRecovery.targetState;
      const recordsExternalRecovery = request.operation === 'recover' && !!request.externalAction;
      if (latestExecution.preparationFailed
        && !['finish', 'status'].includes(request.operation)
        && !retriesPreparation
        && !recordsExternalRecovery) {
        const preparation = preparationStatus(execDir, latestExecution);
        return {
          status: 'TECHNICAL',
          code: 'APP_INITIAL_STATE_UNAVAILABLE',
          message: preparationRecovery?.message || 'The requested App initial state cannot be established in this execution',
          diagnostic: {
            code: preparationRecovery?.internalCode || 'APP_STATE_RESET_FAILED',
            stage: 'PREPARE',
            summary: preparationRecovery?.message || 'The requested App initial state cannot be established in this execution',
            retryable: preparationRecovery?.retryAllowed === true,
          },
          technicalFactRef: preparation?.technicalFactRef || null,
          scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
        };
      }
      assertSceneBasis(execDir, request);
      const flowContext = require('./case-flow-service').validateFlowContext(execDir, request.flowContext);
      narrative = request.operation === 'recordExpectationResults'
        ? narrativeService.narrativeStatus(execDir)
        : narrativeService.recordRequestNarrative(execDir, request, options);
      if (flowContext) {
        store.appendEvent(execDir, 'flowContextRecorded', {
          requestedOperation: request.operation,
          sceneId: store.readCurrentScene(execDir)?.sceneId || null,
          decisionId: narrative.decisionEvent?.decisionId || null,
          ...flowContext,
        }, options);
      }
      if (request.operation === 'finish') {
        return resultService.finish(execDir, request.result, { ...options, openInvocation: invocation, narrative });
      }
      const now = options.now || new Date().toISOString();
      const budget = timeBudget(execDir, latestExecution, now, {
        operation: request.operation,
        decisionId: narrative.decisionEvent?.decisionId || null,
        expectationRefs: narrativeExpectationRefs(narrative),
      });
      const recoveredRecovery = recoveredTransactions.find((item) => item.kind === 'recovery');
      if (request.operation === 'recover' && recoveredRecovery) {
        return { ...recoveredRecovery.response, remainingMs: budget.remainingMs };
      }
      if (budget.exhausted && ['prepare', 'observe', 'act', 'runPlan', 'recover'].includes(request.operation)) {
        return { status: 'TIME_LIMIT', remainingMs: 0, technicalFactRef: budget.technicalFactRef, scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)) };
      }
      let response;
      const runtimeOptions = {
        ...options,
        onAdapterSpan: (span) => telemetry.recordSpan(execDir, span.name, span.durationMs, {
          ...span,
          runtimeOperation: request.operation,
        }, options),
      };
      const enrichedRequest = {
        ...request,
        decision: narrative.decisionEvent?.decision || undefined,
        decisionId: narrative.decisionEvent?.decisionId || null,
      };
      if (request.operation === 'recordCaseFlow') response = require('./case-flow-service').revise(execDir, request.caseFlow, options);
      else if (request.operation === 'recordExpectationResults') {
        const expectationResultService = require('./expectation-result-service');
        const recorded = expectationResultService.applyExpectationResults(execDir, request.results, options);
        response = {
          status: 'RESULTS_RECORDED',
          recorded: recorded.updated,
          unchanged: recorded.idempotent,
          readiness: expectationResultService.finishReadiness(execDir),
        };
      }
      else if (request.operation === 'prepare') response = require('./preparation-service').prepare(execDir, enrichedRequest, runtimeOptions);
      else if (request.operation === 'observe') response = sceneService.observe(execDir, { ...runtimeOptions, purpose: request.purpose, decisionId: enrichedRequest.decisionId });
      else if (request.operation === 'act') response = actionService.act(execDir, enrichedRequest, runtimeOptions);
      else if (request.operation === 'runPlan') response = require('./plan-service').runPlan(execDir, enrichedRequest, {
        ...runtimeOptions, remainingMs: budget.remainingMs, lockHeld: true,
      });
      else if (request.operation === 'inspectVisual') response = require('./visual-inspection-service').inspectVisual(execDir, enrichedRequest, options);
      else if (request.operation === 'inspectScene') response = require('./scene-inspection-service').inspectScene(execDir, enrichedRequest, options);
      else if (request.operation === 'knowledge') response = knowledgeService.knowledge(execDir, enrichedRequest, options);
      else if (request.operation === 'reviewKnowledge') response = {
        status: 'KNOWLEDGE_REVIEWED',
        queryId: enrichedRequest.decision.knowledgeReview.queryId,
        scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
      };
      else if (request.operation === 'recover') response = require('./recovery-service').recover(execDir, enrichedRequest, runtimeOptions);
      return {
        ...response,
        remainingMs: budget.remainingMs,
        narrative: {
          caseContext: narrative.caseContext,
          contextVersion: narrative.contextVersion,
          latestPlan: narrative.latestPlan,
          warnings: narrative.warnings,
        },
      };
    };
    response = options.lockHeld ? executeLocked() : store.withRuntimeLock(execDir, executeLocked, options);
  } catch (error) {
    const requestInvalid = [
      'CASE_RUNTIME_REQUEST_INVALID', 'CASE_RUNTIME_VISUAL_ACTION_INVALID',
      'CASE_NARRATIVE_INVALID', 'CASE_RESULT_INVALID', 'ACTION_CONTRACT_INVALID',
    ].includes(error.code) || String(error.code || '').startsWith('CASE_MODEL_')
      || String(error.code || '').startsWith('CASE_FLOW_');
    response = requestInvalid
      ? {
        status: 'REQUEST_INVALID',
        code: error.code,
        message: error.message,
        scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
        ...requestCorrection(operation, error),
      }
      : error.code === 'CASE_RUNTIME_SCENE_STALE'
      ? {
        status: 'SCENE_CHANGED',
        code: error.code,
        message: error.message,
        scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
      }
      : error.code === 'CASE_RESULT_INCOMPLETE'
      ? {
        status: 'RESULT_INCOMPLETE',
        code: error.code,
        message: error.message,
        missing: error.missing || [],
            scene: sceneService.projectSceneSummary(store.readCurrentScene(execDir)),
        narrative: narrativeService.narrativeStatus(execDir),
      }
      : store.technicalResponse(execDir, error, {
        ...options,
        operation,
        decisionId: narrative?.decisionEvent?.decisionId || null,
        expectationRefs: narrativeExpectationRefs(narrative),
        allowFinalized: true,
      });
  }
  response = { ...response, knowledgeInvestigation: knowledgeInvestigationStatus(execDir) };
  if (invocation) telemetry.endInvocation(execDir, invocation, response, options);
  return response;
}

function reconcileExecution(execDir, options = {}) {
  return store.withRuntimeLock(execDir, () => {
    const recoveredTransactions = [
      ...require('./preparation-service').recoverPendingPreparation(execDir, { ...options, allowFinalized: true }),
      ...require('./recovery-service').recoverPendingTransactions(execDir, { ...options, allowFinalized: true }),
      ...require('./plan-service').recoverInterruptedPlans(execDir, { ...options, allowFinalized: true }),
    ];
    const finish = resultService.resumePendingFinish(execDir, options);
    return { recoveredTransactions, finish, status: runtimeStatus(execDir) };
  }, options);
}

module.exports = { TIME_LIMIT_MS, assertSceneBasis, execute, knowledgeInvestigationStatus, reconcileExecution, recoveryBarrier, runtimeStatus, timeBudget };
