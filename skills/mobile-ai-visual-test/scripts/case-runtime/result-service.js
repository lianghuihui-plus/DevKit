'use strict';

const { canonicalJson, contractError } = require('../lib/contract-utils');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateResultIntegrity } = require('./result-integrity');
const store = require('./store');
const telemetry = require('./telemetry');

function metrics(execution, result, events, endedAt, execDir = null, options = {}) {
  const count = (type) => events.filter((event) => event.type === type).length;
  const totalElapsedMs = Math.max(0, Date.parse(endedAt) - Date.parse(execution.startedAt));
  const timing = execDir ? telemetry.summarize(execDir, totalElapsedMs, options.openInvocation || null, options) : {
    totalElapsedMs,
    runtimeActiveMs: 0,
    adapterActiveMs: 0,
    actionDeviceMs: 0,
    observationCaptureMs: 0,
    postActionSettleMs: 0,
    explicitWaitMs: 0,
    knowledgeQueryMs: 0,
    recoveryControlMs: 0,
    runtimeOverheadMs: 0,
    recoveryMs: 0,
    agentAndSchedulingGapMs: totalElapsedMs,
    agentTiming: {
      firstPreparationMs: 0,
      stepDecisionMs: 0,
      conclusionPreparationMs: 0,
      unclassifiedGapMs: totalElapsedMs,
      stepDecisionIntervals: [],
    },
    invocationCount: 0,
    invocationErrorCount: 0,
  };
  const knowledgeEvents = events.filter((event) => event.type === 'knowledgeQueried');
  const knowledgeReviews = events.filter((event) => event.type === 'knowledgeReviewed');
  return {
    schemaVersion: 3,
    executionId: execution.executionId,
    verdict: result.verdict,
    executionStatus: 'COMPLETED',
    elapsedMs: totalElapsedMs,
    ...timing,
    warmSessionGenerationStart: execution.warmSessionGenerationStart,
    warmSessionGenerationEnd: execution.warmSessionGeneration,
    warmSessionIdStart: execution.warmSessionIdStart,
    warmSessionIdEnd: execution.warmSessionId,
    warmSessionEpochStart: execution.warmSessionEpochStart,
    warmSessionEpochEnd: execution.warmSessionEpoch,
    warmSessionReused: execution.warmSessionReused === true,
    appPreparation: {
      requested: count('appPreparationRequested') > 0,
      completed: count('appPreparationCompleted') > 0,
      failed: count('appPreparationFailed') > 0,
      targetState: execution.preparationTargetState || events.find((event) => event.type === 'appPreparationRequested')?.targetState || null,
    },
    executionRecoveryCount: execution.executionRecoveryCount || 0,
    batchRecoveryCountAtStart: execution.batchRecoveryCountAtStart || 0,
    batchRecoveryCountAtEnd: execution.batchRecoveryCountAtEnd || 0,
    timeLimitStopped: events.some((event) => event.type === 'timeBudgetExhausted'),
    counts: {
      actions: count('actionRequested'),
      observations: count('sceneObserved'),
      visualInspections: count('visualInspected'),
      knowledgeQueries: count('knowledgeQueried'),
      knowledgeReviews: count('knowledgeReviewed'),
      recoveries: count('appRecovered'),
      appPreparations: count('appPreparationCompleted'),
      appPreparationFailures: count('appPreparationFailed'),
      agentContinuations: count('agentContinuation'),
      invocationCorrections: timing.invocationErrorCount,
      caseContextRevisions: count('caseContextRecorded'),
      agentDecisions: count('agentDecisionRecorded'),
      narrativeGaps: count('narrativeGap'),
    },
    knowledgeUsage: {
      queryIds: knowledgeEvents.map((event) => event.queryId),
      reviewedQueryIds: knowledgeReviews.map((event) => event.queryId),
      candidateRefs: [...new Set(knowledgeEvents.flatMap((event) => event.candidateRefs || []))],
      applicableEntryIds: [...new Set(knowledgeReviews.flatMap((event) => (event.assessments || [])
        .filter((item) => item.status === 'APPLICABLE').map((item) => item.entryId)))],
    },
    ...(options.knowledgeCoverage?.investigation
      ? { knowledgeInvestigation: options.knowledgeCoverage.investigation }
      : {}),
  };
}

function finish(execDir, caseResult, options = {}) {
  const execution = store.loadExecution(execDir, { allowFinalized: true });
  const { result, graph } = validateResultIntegrity(execDir, caseResult);
  const target = store.paths(execDir);
  const readJson = require('../lib/execution-lifecycle').readJson;
  const existingResult = readJson(target.result, null);
  if (existingResult && canonicalJson(existingResult) !== canonicalJson(result)) {
    throw contractError('CASE_RESULT_IMMUTABLE', 'CaseResult is already finalized with different content');
  }
  fs.mkdirSync(target.transactions, { recursive: true });
  const draftPath = path.join(target.transactions, 'finish.draft.json');
  let draft = readJson(draftPath, null);
  if (execution.finalized === true && !draft) {
    return { status: 'COMPLETED', executionId: execution.executionId, verdict: existingResult.verdict, result: existingResult, idempotent: true };
  }
  if (draft && (draft.schemaVersion !== 1 || draft.executionId !== execution.executionId
    || !['PREPARED', 'ARTIFACTS_WRITTEN', 'EVENT_WRITTEN', 'EXECUTION_FINALIZED', 'RUNTIME_COMPLETED'].includes(draft.status))) {
    throw contractError('CASE_RESULT_TRANSACTION_INVALID', 'finish transaction is invalid');
  }
  if (draft && canonicalJson(draft.result) !== canonicalJson(result)) {
    throw contractError('CASE_RESULT_IMMUTABLE', 'a different CaseResult is already being finalized');
  }
  const knownScenes = new Set(store.events(execDir).filter((event) => event.type === 'sceneObserved').map((event) => event.sceneId));
  const unresolvedSceneRefs = [...new Set(result.checks.flatMap((check) => check.sceneRefs || []).filter((ref) => !knownScenes.has(ref)))];
  if (unresolvedSceneRefs.length) {
    throw contractError('CASE_RESULT_SCENE_UNKNOWN', `CaseResult references unknown scenes: ${unresolvedSceneRefs.join(', ')}`);
  }
  const wasResumed = Boolean(draft);
  if (!draft) {
    const endedAt = options.now || new Date().toISOString();
    draft = {
      schemaVersion: 1,
      status: 'PREPARED',
      executionId: execution.executionId,
      result,
      metrics: metrics(execution, result, store.events(execDir), endedAt, execDir, {
        ...options,
        knowledgeCoverage: graph.knowledgeCoverage,
      }),
      endedAt,
    };
    writeJsonAtomic(draftPath, draft);
  }
  if (draft.status === 'PREPARED') {
    writeJsonAtomic(target.result, draft.result);
    writeJsonAtomic(target.metrics, draft.metrics);
    draft = { ...draft, status: 'ARTIFACTS_WRITTEN' };
    writeJsonAtomic(draftPath, draft);
  }
  if (options.interruptAfter === 'artifacts') throw new Error('MAVT_CASE_FINISH_INTERRUPTED: artifacts');
  if (draft.status === 'ARTIFACTS_WRITTEN') {
    if (!store.events(execDir).some((event) => event.type === 'caseFinished')) {
      store.appendEvent(execDir, 'caseFinished', {
        verdict: draft.result.verdict,
        checkCount: draft.result.checks.length,
        expectationCount: graph.expectationCoverage.expectations.length,
        coveredExpectationRefs: graph.expectationCoverage.coveredExpectationRefs,
        unresolvedSceneRefs,
        decisionId: options.narrative?.decisionEvent?.decisionId
          || require('./narrative-service').narrativeStatus(execDir).lastDecision?.decisionId
          || null,
      }, { now: draft.endedAt });
    }
    draft = { ...draft, status: 'EVENT_WRITTEN' };
    writeJsonAtomic(draftPath, draft);
  }
  if (options.interruptAfter === 'event') throw new Error('MAVT_CASE_FINISH_INTERRUPTED: event');
  if (draft.status === 'EVENT_WRITTEN') {
    const latestExecution = store.loadExecution(execDir, { allowFinalized: true });
    if (!latestExecution.finalized) {
      store.updateExecution(execDir, {
        ...latestExecution,
        status: 'FINISHED',
        lifecycle: 'FINALIZED',
        finalized: true,
        endedAt: draft.endedAt,
        executionStatus: draft.metrics.executionStatus,
      });
    }
    draft = { ...draft, status: 'EXECUTION_FINALIZED' };
    writeJsonAtomic(draftPath, draft);
  }
  if (options.interruptAfter === 'execution') throw new Error('MAVT_CASE_FINISH_INTERRUPTED: execution');
  if (draft.status === 'EXECUTION_FINALIZED') {
    const runtime = readJson(target.runtime, null);
    if (!runtime || runtime.executionId !== execution.executionId) {
      throw contractError('CASE_RUNTIME_STATE_INVALID', 'finish transaction requires the bound Case Runtime');
    }
    writeJsonAtomic(target.runtime, { ...runtime, status: 'COMPLETED', completedAt: draft.endedAt });
    draft = { ...draft, status: 'RUNTIME_COMPLETED' };
    writeJsonAtomic(draftPath, draft);
  }
  if (options.interruptAfter === 'runtime') throw new Error('MAVT_CASE_FINISH_INTERRUPTED: runtime');
  if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  return {
    status: 'COMPLETED', executionId: execution.executionId, verdict: draft.result.verdict,
    result: draft.result,
    evidenceDiagnostics: { unresolvedSceneRefs, validatedSceneRefs: graph.sceneRefs },
    knowledgeUsage: draft.metrics.knowledgeUsage,
    ...(wasResumed ? { idempotent: true } : {}),
  };
}

function resumePendingFinish(execDir, options = {}) {
  const draft = require('../lib/execution-lifecycle').readJson(store.paths(execDir).finishDraft, null);
  if (!draft) return null;
  if (!draft.result) throw contractError('CASE_RESULT_TRANSACTION_INVALID', 'finish transaction has no frozen CaseResult');
  return finish(execDir, draft.result, options);
}

module.exports = { finish, metrics, resumePendingFinish };
