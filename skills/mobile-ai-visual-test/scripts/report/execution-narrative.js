'use strict';

const { technicalFactView, technicalFacts } = require('../lib/technical-facts');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');

function bySequence(left, right) {
  return Number(left.sequence || 0) - Number(right.sequence || 0);
}

function latest(items) {
  return items.slice().sort(bySequence).at(-1) || null;
}

function modelContext(event) {
  if (!event) return null;
  return {
    summary: event.understanding,
    preconditions: event.preconditions || [],
    expectations: (event.verificationPoints || []).filter((item) => item.status !== 'CANCELLED').map((item) => ({
      id: item.ref,
      text: item.text,
      verificationKind: 'DIRECT_OBSERVATION',
    })),
    initialPlan: event.items || [],
    uncertainties: event.uncertainties || [],
  };
}

function modelForEvent(models, event) {
  const explicitRevision = Number(event?.caseModelRevision || 0);
  if (explicitRevision) return models.find((model) => model.revision === explicitRevision) || null;
  return models.filter((model) => Number(model.sequence || 0) <= Number(event?.sequence || 0)).at(-1) || null;
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

function decisionField(event, field) {
  const decision = event?.decision || {};
  const source = event?.decisionFieldSources?.[field];
  if (source === 'AGENT_AUTHORED') return decision[field];
  if (source === 'NOT_PROVIDED') return ['expectationRefs', 'uncertainties'].includes(field) ? [] : null;
  if (['purpose', 'expectationRefs', 'planUpdate', 'knowledgeReview', 'uncertainties'].includes(field)) return decision[field];
  const value = decision[field];
  return typeof value === 'string' && value && value !== decision.purpose ? value : null;
}

function processState({ operation, action, knowledge, recovery, visualInspection, beforeScene, afterScene, technicalIssue }) {
  if (technicalIssue || action?.status === 'FAILED' || recovery?.status === 'FAILED') return 'ISSUE';
  if (action && ['UNKNOWN', 'PENDING'].includes(action.status)) return 'UNKNOWN';
  if (operation === 'act') return action ? 'EXECUTED' : 'UNKNOWN';
  if (operation === 'knowledge') return knowledge ? 'INVESTIGATED' : 'UNKNOWN';
  if (operation === 'recover') return recovery?.status === 'SUCCEEDED' ? 'RECOVERED' : 'UNKNOWN';
  if (operation === 'inspectVisual') return visualInspection ? 'OBSERVED' : 'UNKNOWN';
  if (operation === 'observe') return afterScene || beforeScene ? 'OBSERVED' : 'UNKNOWN';
  return 'UNKNOWN';
}

function investigationStatus(expectationRef, report, events, reviews) {
  const frozen = report.metrics?.knowledgeInvestigation?.byExpectation?.[expectationRef];
  if (frozen?.status) return frozen;
  const queries = events.filter((event) => event.type === 'knowledgeQueried'
    && (event.expectationRefs || []).includes(expectationRef));
  const conclusions = queries.map((event) => reviews.get(event.queryId)?.conclusion).filter(Boolean);
  for (const status of ['APPLICABLE_FOUND', 'CONFLICTING', 'INSUFFICIENT', 'NO_APPLICABLE', 'NO_MATCH']) {
    if (conclusions.includes(status)) {
      return { required: false, status, queryIds: queries.map((event) => event.queryId), reviewedQueryIds: queries.filter((event) => reviews.has(event.queryId)).map((event) => event.queryId) };
    }
  }
  return { required: false, status: queries.length ? 'MISSING' : 'NOT_REQUIRED', queryIds: queries.map((event) => event.queryId), reviewedQueryIds: [] };
}

function projectCurrentNarrative(report) {
  const events = Array.isArray(report.events) ? report.events.slice().sort(bySequence) : [];
  const modelEvents = events.filter((event) => event.type === 'caseModelRevised');
  const legacyContextEvents = events.filter((event) => event.type === 'caseContextRecorded');
  const decisions = events.filter((event) => event.type === 'agentDecisionRecorded');
  const executionDecisions = decisions.filter((event) => !['finish', 'recordPlan'].includes(event.requestedOperation));
  const finalDecisionEvent = latest(decisions.filter((event) => event.requestedOperation === 'finish'));
  const gaps = events.filter((event) => event.type === 'narrativeGap');
  const latestModel = latest(modelEvents);
  const latestLegacyContext = latest(legacyContextEvents);
  const context = modelContext(latestModel) || latestLegacyContext?.caseContext || null;
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

  const planHistory = modelEvents.length ? modelEvents.map((event) => ({
    version: event.revision, time: event.time, reason: event.reason, items: event.items || [], decisionId: null,
  })) : [];
  if (!modelEvents.length) {
    const firstContext = legacyContextEvents[0] || null;
    if (firstContext?.caseContext?.initialPlan?.length) {
      planHistory.push({ version: 1, time: firstContext.time, reason: firstContext.reason, items: firstContext.caseContext.initialPlan, decisionId: null });
    }
    for (const event of decisions.filter((item) => item.decision?.planUpdate)) {
      planHistory.push({ version: planHistory.length + 1, time: event.time, reason: event.decision.planUpdate.reason, items: event.decision.planUpdate.next, decisionId: event.decisionId });
    }
  }
  const understandingHistory = modelEvents.length ? modelEvents.map((event) => ({
    version: event.revision, time: event.time, reason: event.reason, caseContext: modelContext(event), retiredVerificationRefs: event.retiredVerificationRefs || [],
  })) : legacyContextEvents.map((event) => ({
    version: event.contextVersion, time: event.time, reason: event.reason, caseContext: event.caseContext,
  }));
  const initialPlan = planHistory[0] || null;

  const expectations = context?.expectations || [];
  const expectationByRef = new Map(expectations.map((item) => [item.id, item]));
  const candidatesById = new Map(events.filter((event) => event.type === 'knowledgeQueried')
    .flatMap((event) => event.candidates || []).map((candidate) => [candidate.entryId, candidate]));
  const technicalByRef = new Map(technicalFacts(events).map((event) => [event.technicalFactRef, event]));
  const checks = (report.result?.checks || []).map((check) => ({
    ...check,
    expectation: expectationByRef.get(check.expectationRef)?.text || check.expectation || check.expectationRef || '未命名验证点',
    knowledge: (check.knowledgeRefs || []).map((entryId) => candidatesById.get(entryId) || { entryId }),
    knowledgeInvestigation: investigationStatus(check.expectationRef, report, events, knowledgeReviews),
    technicalFacts: (check.technicalRefs || []).map((ref) => {
      const fact = technicalByRef.get(ref);
      return fact ? technicalFactView(fact, events, report.execution, check.expectationRef) : {
        ref, type: null, code: 'TECHNICAL_FACT_MISSING', message: '引用的技术事实不存在', time: null,
        operation: null, operationId: null, decisionId: null, sceneId: null, generation: null,
        state: 'INVALID', stateReason: '技术事实不属于当前 execution',
      };
    }),
  }));
  const steps = executionDecisions.map((event, index) => {
    const decision = event.decision || {};
    const stepModel = modelForEvent(modelEvents, event);
    const stepExpectations = new Map((stepModel?.verificationPoints || context?.expectations || []).map((item) => [item.ref || item.id, item]));
    const action = actionByDecision.get(event.decisionId) || null;
    const actionResult = action ? resultByOperation.get(action.operationId) || null : null;
    const spatialInspection = action ? latest(events.filter((candidate) => candidate.type === 'actionSpatialInspected'
      && candidate.operationId === action.operationId)) : null;
    const knowledge = knowledgeByDecision.get(event.decisionId) || null;
    const recovery = recoveryByDecision.get(event.decisionId) || null;
    const visualInspection = events.find((candidate) => candidate.type === 'visualInspected' && candidate.decisionId === event.decisionId) || null;
    const technicalIssue = events.find((candidate) => candidate.type === 'technicalIssue' && candidate.decisionId === event.decisionId) || null;
    const operationId = action?.operationId || recovery?.operationId || null;
    const beforeScene = scenes.get(event.sceneId) || null;
    const afterScene = (operationId ? postSceneByOperation.get(operationId) : null)
      || postSceneByDecision.get(event.decisionId)
      || null;
    const decisionIndex = decisions.indexOf(event);
    const following = decisions.slice(decisionIndex + 1).find((candidate) => candidate.requestedOperation !== 'finish'
      && (!afterScene || candidate.sceneId === afterScene.sceneId)) || null;
    const actionView = action ? {
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
        screenComparison: actionResult.observedEffect ? {
          status: actionResult.observedEffect.status === 'CHANGED' ? 'DIFFERENT'
            : actionResult.observedEffect.status === 'UNCHANGED' ? 'IDENTICAL' : 'UNAVAILABLE',
          beforeSceneRef: actionResult.observedEffect.beforeSceneRef || null,
          afterSceneRef: actionResult.observedEffect.afterSceneRef || null,
        } : null,
        duringActionObservation: actionResult.duringActionObservation || null,
      } : null,
      spatialEvidence: actionResult?.spatialEvidenceRef
        ? projectActionSpatialEvidence(report.latest, actionResult.spatialEvidenceRef, {
          operationId: actionResult.operationId,
          actionType: actionResult.action?.type || action.action?.type,
        })
        : actionResult?.coordinateAudit || null,
      spatialInspection: spatialInspection ? {
        observation: spatialInspection.observation,
        time: spatialInspection.time,
        caseModelRevision: spatialInspection.caseModelRevision || null,
        expectationRefs: spatialInspection.expectationRefs || [],
      } : null,
    } : null;
    const recoveryView = recovery ? { operationId: recovery.operationId, status: recovery.type === 'appRecovered' ? 'SUCCEEDED' : recovery.type === 'recoveryFailed' ? 'FAILED' : 'UNKNOWN', reason: recovery.reason || recovery.message || '' } : null;
    return {
      number: index + 1,
      decisionId: event.decisionId,
      time: event.time,
      operation: event.requestedOperation,
      sceneId: event.sceneId || null,
      assessment: decisionField(event, 'assessment') || '',
      observation: decisionField(event, 'observation') || '',
      conclusion: decisionField(event, 'conclusion') || '',
      purpose: decision.purpose || '',
      expectedOutcome: decisionField(event, 'expectedOutcome') || '',
      expectationRefs: decision.expectationRefs || [],
      expectationTargets: (decision.expectationRefs || []).map((ref) => ({
        ref,
        text: stepExpectations.get(ref)?.text || ref,
      })),
      caseModelRevision: stepModel?.revision || null,
      planUpdate: modelEvents.length ? null : decision.planUpdate || null,
      action: actionView,
      knowledge: knowledge ? {
        queryId: knowledge.queryId,
        query: knowledge.query,
        candidateCount: knowledge.candidateCount || 0,
        candidates: knowledge.candidates || [],
        filterDiagnostics: knowledge.filterDiagnostics || null,
        review: knowledgeReviews.get(knowledge.queryId) || null,
      } : null,
      recovery: recoveryView,
      visualInspection: visualInspection ? {
        inspectionId: visualInspection.inspectionId,
        sceneId: visualInspection.sceneId,
        screenshotRef: visualInspection.screenshotRef,
      } : null,
      beforeScene: sceneSummary(beforeScene),
      afterScene: sceneSummary(afterScene),
      postAssessment: following && following !== event ? {
        observation: decisionField(following, 'observation') || '',
        conclusion: decisionField(following, 'conclusion') || '',
        decisionId: following.decisionId,
      } : null,
      processState: processState({
        operation: event.requestedOperation,
        action: actionView,
        knowledge,
        recovery: recoveryView,
        visualInspection,
        beforeScene,
        afterScene,
        technicalIssue,
      }),
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
    contextVersion: latestModel?.revision || latestLegacyContext?.contextVersion || null,
    caseModel: latestModel,
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
      purpose: finalDecisionEvent.decision?.purpose || '',
      assessment: decisionField(finalDecisionEvent, 'assessment') || '',
      observation: decisionField(finalDecisionEvent, 'observation') || '',
      conclusion: decisionField(finalDecisionEvent, 'conclusion') || '',
      expectedOutcome: decisionField(finalDecisionEvent, 'expectedOutcome') || '',
      expectationRefs: finalDecisionEvent.decision?.expectationRefs || [],
      uncertainties: decisionField(finalDecisionEvent, 'uncertainties') || [],
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
