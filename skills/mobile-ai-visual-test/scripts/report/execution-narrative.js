'use strict';

const { technicalFactView, technicalFacts } = require('../lib/technical-facts');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');

function bySequence(left, right) {
  return Number(left.sequence || 0) - Number(right.sequence || 0);
}

function latest(items) {
  return items.slice().sort(bySequence).at(-1) || null;
}

function sceneSummary(event) {
  if (!event) return null;
  return {
    sceneId: event.sceneId,
    time: event.time,
    screenshotRef: event.screenshotRef || null,
    layoutRef: event.layoutRef || null,
    app: event.app || null,
    usable: Boolean(event.screenshotRef),
  };
}

function projectCurrentNarrative(report) {
  const events = Array.isArray(report.events) ? report.events.slice().sort(bySequence) : [];
  const contextEvents = events.filter((event) => event.type === 'caseContextRecorded');
  const decisions = events.filter((event) => event.type === 'agentDecisionRecorded');
  const executionDecisions = decisions.filter((event) => event.requestedOperation !== 'finish');
  const finalDecisionEvent = latest(decisions.filter((event) => event.requestedOperation === 'finish'));
  const gaps = events.filter((event) => event.type === 'narrativeGap');
  const latestContextEvent = latest(contextEvents);
  const firstContextEvent = contextEvents[0] || null;
  const context = latestContextEvent?.caseContext || null;
  const scenes = new Map(events.filter((event) => event.type === 'sceneObserved').map((event) => [event.sceneId, event]));
  const requestedActions = events.filter((event) => event.type === 'actionRequested');
  const actionResults = events.filter((event) => ['actionCompleted', 'actionOutcomeUnknown'].includes(event.type));
  const actionByDecision = new Map(requestedActions.filter((event) => event.decisionId).map((event) => [event.decisionId, event]));
  const resultByOperation = new Map(actionResults.map((event) => [event.operationId, event]));
  const postSceneByOperation = new Map(events.filter((event) => event.type === 'sceneObserved' && event.relatedOperationId)
    .map((event) => [event.relatedOperationId, event]));
  const postSceneByDecision = new Map(events.filter((event) => event.type === 'sceneObserved' && event.decisionId)
    .map((event) => [event.decisionId, event]));
  const knowledgeByDecision = new Map(events.filter((event) => event.type === 'knowledgeQueried' && event.decisionId)
    .map((event) => [event.decisionId, event]));
  const knowledgeReviews = new Map(events.filter((event) => event.type === 'knowledgeReviewed')
    .map((event) => [event.queryId, event]));
  const recoveryByDecision = new Map(events.filter((event) => ['appRecovered', 'recoveryFailed', 'recoveryOutcomeUnknown'].includes(event.type) && event.decisionId)
    .map((event) => [event.decisionId, event]));

  let planVersion = 0;
  const planHistory = [];
  if (firstContextEvent) {
    planVersion = 1;
    planHistory.push({
      version: planVersion,
      time: firstContextEvent.time,
      reason: firstContextEvent.reason,
      items: firstContextEvent.caseContext.initialPlan,
      decisionId: null,
    });
  }
  for (const event of events) {
    if (event.type === 'agentDecisionRecorded' && event.decision?.planUpdate) {
      planVersion += 1;
      planHistory.push({
        version: planVersion,
        time: event.time,
        reason: event.decision.planUpdate.reason,
        items: event.decision.planUpdate.next,
        decisionId: event.decisionId,
      });
    }
  }

  const understandingHistory = contextEvents.map((event) => ({
    version: event.contextVersion,
    time: event.time,
    reason: event.reason,
    caseContext: event.caseContext,
  }));
  const initialPlan = firstContextEvent ? {
    version: 1,
    time: firstContextEvent.time,
    reason: firstContextEvent.reason,
    items: firstContextEvent.caseContext.initialPlan || [],
    decisionId: null,
  } : null;

  const expectations = context?.expectations || [];
  const expectationByRef = new Map(expectations.map((item) => [item.id, item]));
  const candidatesById = new Map(events.filter((event) => event.type === 'knowledgeQueried')
    .flatMap((event) => event.candidates || []).map((candidate) => [candidate.entryId, candidate]));
  const technicalByRef = new Map(technicalFacts(events).map((event) => [event.technicalFactRef, event]));
  const checks = (report.result?.checks || []).map((check) => ({
    ...check,
    expectation: expectationByRef.get(check.expectationRef)?.text || check.expectation || check.expectationRef || '未命名验证点',
    knowledge: (check.knowledgeRefs || []).map((entryId) => candidatesById.get(entryId) || { entryId }),
    technicalFacts: (check.technicalRefs || []).map((ref) => {
      const fact = technicalByRef.get(ref);
      return fact ? technicalFactView(fact, events, report.execution, check.expectationRef) : {
        ref, type: null, code: 'TECHNICAL_FACT_MISSING', message: '引用的技术事实不存在', time: null,
        operation: null, operationId: null, decisionId: null, sceneId: null, generation: null,
        state: 'INVALID', stateReason: '技术事实不属于当前 execution',
      };
    }),
  }));
  const checkByExpectation = new Map(checks.map((check) => [check.expectationRef, check]));

  const steps = executionDecisions.map((event, index) => {
    const decision = event.decision || {};
    const action = actionByDecision.get(event.decisionId) || null;
    const actionResult = action ? resultByOperation.get(action.operationId) || null : null;
    const knowledge = knowledgeByDecision.get(event.decisionId) || null;
    const recovery = recoveryByDecision.get(event.decisionId) || null;
    const operationId = action?.operationId || recovery?.operationId || null;
    const beforeScene = scenes.get(event.sceneId) || null;
    const afterScene = (operationId ? postSceneByOperation.get(operationId) : null)
      || postSceneByDecision.get(event.decisionId)
      || null;
    const decisionIndex = decisions.indexOf(event);
    const following = decisions.slice(decisionIndex + 1).find((candidate) => !afterScene || candidate.sceneId === afterScene.sceneId) || null;
    return {
      number: index + 1,
      decisionId: event.decisionId,
      time: event.time,
      operation: event.requestedOperation,
      sceneId: event.sceneId || null,
      observation: decision.observation || '',
      conclusion: decision.conclusion || '',
      purpose: decision.purpose || '',
      expectedOutcome: decision.expectedOutcome || '',
      expectationRefs: decision.expectationRefs || [],
      expectations: (decision.expectationRefs || []).map((ref) => {
        const check = checkByExpectation.get(ref) || null;
        return {
          ref,
          text: expectationByRef.get(ref)?.text || ref,
          status: check?.status || 'NOT_ASSESSED',
          actual: check?.actual || '',
          sceneRefs: check?.sceneRefs || [],
        };
      }),
      planUpdate: decision.planUpdate || null,
      action: action ? {
        operationId: action.operationId,
        value: action.action || null,
        status: actionResult?.type === 'actionOutcomeUnknown'
          ? 'UNKNOWN'
          : actionResult?.command?.status === 'REJECTED' || actionResult?.deviceExecution?.status === 'FAILED'
            ? 'FAILED' : actionResult ? 'OBSERVED' : 'PENDING',
        result: actionResult ? {
          lifecycle: actionResult.lifecycle || null,
          command: actionResult.command || null,
          deviceExecution: actionResult.deviceExecution || null,
          observedEffect: actionResult.observedEffect || null,
          duringActionObservation: actionResult.duringActionObservation || null,
        } : null,
        spatialEvidence: actionResult?.spatialEvidenceRef
          ? projectActionSpatialEvidence(report.latest, actionResult.spatialEvidenceRef, {
            operationId: actionResult.operationId,
            actionType: actionResult.action?.type || action.action?.type,
          })
          : actionResult?.coordinateAudit || null,
      } : null,
      knowledge: knowledge ? {
        queryId: knowledge.queryId,
        query: knowledge.query,
        candidateCount: knowledge.candidateCount || 0,
        candidates: knowledge.candidates || [],
        filterDiagnostics: knowledge.filterDiagnostics || null,
        review: knowledgeReviews.get(knowledge.queryId) || null,
      } : null,
      recovery: recovery ? { operationId: recovery.operationId, status: recovery.type === 'appRecovered' ? 'SUCCEEDED' : recovery.type === 'recoveryFailed' ? 'FAILED' : 'UNKNOWN', reason: recovery.reason || recovery.message || '' } : null,
      beforeScene: sceneSummary(beforeScene),
      afterScene: sceneSummary(afterScene),
      postAssessment: following && following !== event ? {
        observation: following.decision?.observation || '',
        conclusion: following.decision?.conclusion || '',
        decisionId: following.decisionId,
      } : null,
    };
  });

  for (const check of checks) {
    check.relatedSteps = steps.filter((step) => step.expectationRefs.includes(check.expectationRef))
      .map((step) => ({ number: step.number, decisionId: step.decisionId, beforeScene: step.beforeScene, afterScene: step.afterScene }));
  }
  const covered = new Set(checks.map((check) => check.expectationRef).filter(Boolean));
  const reviewedQueries = new Set(events.filter((event) => event.type === 'knowledgeReviewed').map((event) => event.queryId));
  const hasUnreviewedKnowledge = events.some((event) => event.type === 'knowledgeQueried' && !reviewedQueries.has(event.queryId));
  const recordingStatus = !context ? 'UNAVAILABLE'
    : gaps.length || !initialPlan?.items.length || hasUnreviewedKnowledge ? 'PARTIAL' : 'COMPLETE';
  return {
    available: Boolean(context),
    recordingStatus,
    contextVersion: latestContextEvent?.contextVersion || null,
    understanding: context,
    understandingHistory,
    initialPlan,
    plan: latest(planHistory),
    planHistory,
    steps,
    finalDecision: finalDecisionEvent ? {
      decisionId: finalDecisionEvent.decisionId,
      time: finalDecisionEvent.time,
      sceneId: finalDecisionEvent.sceneId || null,
      ...finalDecisionEvent.decision,
    } : null,
    knowledgeInvestigations: events.filter((event) => event.type === 'knowledgeQueried').map((event) => ({
      queryId: event.queryId,
      time: event.time,
      sceneId: event.sceneId || null,
      expectationRefs: event.expectationRefs || [],
      query: event.query,
      candidates: event.candidates || [],
      candidateCount: event.candidateCount || 0,
      truncated: event.truncated === true,
      filterDiagnostics: event.filterDiagnostics || null,
      review: knowledgeReviews.get(event.queryId) || null,
    })),
    checks,
    coverage: {
      total: expectations.length,
      covered: expectations.filter((item) => covered.has(item.id)).length,
      missing: expectations.filter((item) => !covered.has(item.id)),
    },
    gaps,
  };
}

function buildExecutionNarrative(report) {
  return projectCurrentNarrative(report);
}

module.exports = { buildExecutionNarrative, projectCurrentNarrative };
