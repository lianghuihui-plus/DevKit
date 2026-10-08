'use strict';

const { technicalFactView, technicalFacts } = require('../lib/technical-facts');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');

function bySequence(left, right) {
  return Number(left.sequence || 0) - Number(right.sequence || 0);
}

function latest(items) {
  return items.slice().sort(bySequence).at(-1) || null;
}

function flowContext(event) {
  if (!event) return null;
  return {
    summary: event.summary,
    preconditions: [],
    expectations: (event.nodes || []).filter((item) => item.type === 'CHECK').map((item) => ({
      id: item.ref,
      text: item.text,
      verificationKind: item.verificationKind,
      sourceBasis: item.sourceBasis,
    })),
    initialPlan: (event.nodes || []).map((item) => `${item.ref} ${item.type}: ${item.text}`),
    uncertainties: event.uncertainties || [],
  };
}

function modelForEvent(models, event) {
  const explicitRevision = Number(event?.caseFlowRevision || 0);
  if (explicitRevision) return models.find((model) => model.revision === explicitRevision) || null;
  return models.filter((model) => Number(model.sequence || 0) <= Number(event?.sequence || 0)).at(-1) || null;
}

function sceneSummary(event) {
  if (!event) return null;
  return {
    sceneId: event.sceneId,
    time: event.time,
    screenshotRef: event.screenshotRef || null,
    purpose: event.purpose || null,
    captureOrigins: event.captureOrigins || [],
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
  if (['purpose', 'expectationRefs', 'knowledgeReview', 'uncertainties'].includes(field)) return decision[field];
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

function sequenceStepState(step, action, scene) {
  if (step?.status === 'FAILED') return 'ISSUE';
  if (step?.type === 'act') {
    if (!action) return step?.status === 'COMPLETED' ? 'EXECUTED' : 'UNKNOWN';
    if (action.status === 'FAILED') return 'ISSUE';
    if (['UNKNOWN', 'PENDING'].includes(action.status)) return 'UNKNOWN';
    return 'EXECUTED';
  }
  if (step?.type === 'capture' && scene) return 'OBSERVED';
  return step?.status === 'COMPLETED' ? 'EXECUTED' : 'UNKNOWN';
}

function actionView(report, events, action, resultByOperation) {
  if (!action) return null;
  const result = resultByOperation.get(action.operationId) || null;
  const spatialInspection = latest(events.filter((candidate) => candidate.type === 'actionSpatialInspected'
    && candidate.operationId === action.operationId));
  return {
    operationId: action.operationId,
    value: action.action || null,
    status: result?.type === 'actionOutcomeUnknown'
      ? 'UNKNOWN'
      : result?.command?.status === 'REJECTED' || result?.deviceExecution?.status === 'FAILED'
        ? 'FAILED' : result ? 'OBSERVED' : 'PENDING',
    result: result ? {
      lifecycle: result.lifecycle || null,
      command: result.command || null,
      deviceExecution: result.deviceExecution || null,
      evidence: result.evidence || null,
      duringActionObservation: result.duringActionObservation || null,
    } : null,
    spatialEvidence: result?.spatialEvidenceRef
      ? projectActionSpatialEvidence(report.latest, result.spatialEvidenceRef, {
        operationId: result.operationId,
        actionType: result.action?.type || action.action?.type,
      })
      : result?.coordinateAudit || null,
    spatialInspection: spatialInspection ? {
      observation: spatialInspection.observation,
      time: spatialInspection.time,
      caseFlowRevision: spatialInspection.caseFlowRevision || null,
      expectationRefs: spatialInspection.expectationRefs || [],
    } : null,
  };
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
  const flowEvents = events.filter((event) => event.type === 'caseFlowRevised');
  const decisions = events.filter((event) => event.type === 'agentDecisionRecorded');
  const executionDecisions = decisions.filter((event) => event.requestedOperation !== 'finish');
  const finalDecisionEvent = latest(decisions.filter((event) => event.requestedOperation === 'finish'));
  const gaps = events.filter((event) => event.type === 'narrativeGap');
  const latestFlow = latest(flowEvents);
  const context = flowContext(latestFlow);
  const scenes = new Map(events.filter((event) => event.type === 'sceneObserved').map((event) => [event.sceneId, event]));
  const requestedActions = events.filter((event) => event.type === 'actionRequested');
  const actionResults = events.filter((event) => ['actionCompleted', 'actionOutcomeUnknown'].includes(event.type));
  const actionByDecision = new Map(requestedActions.filter((event) => event.decisionId).map((event) => [event.decisionId, event]));
  const actionByOperation = new Map(requestedActions.map((event) => [event.operationId, event]));
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
  const flowContextByDecision = new Map(events.filter((event) => event.type === 'flowContextRecorded' && event.decisionId)
    .map((event) => [event.decisionId, event]));
  const sequenceRecords = report.latest ? require('../case-runtime/sequence-service').readSequences(report.latest) : [];
  const sequenceByDecision = new Map(sequenceRecords.filter((record) => record.decisionId)
    .map((record) => [record.decisionId, record]));
  const sequenceById = new Map(sequenceRecords.map((record) => [record.sequenceId, record]));

  const planHistory = flowEvents.map((event) => ({
    version: event.revision, time: event.time, reason: event.reason,
    items: (event.nodes || []).map((item) => `${item.ref} ${item.type}: ${item.text}`), decisionId: null,
  }));
  const initialPlan = planHistory[0] || null;

  const expectations = context?.expectations || [];
  const expectationByRef = new Map(expectations.map((item) => [item.id, item]));
  const candidatesById = new Map(events.filter((event) => event.type === 'knowledgeQueried')
    .flatMap((event) => event.candidates || []).map((candidate) => [candidate.entryId, candidate]));
  const technicalByRef = new Map(technicalFacts(events).map((event) => [event.technicalFactRef, event]));
  const checks = (report.result?.checks || []).map((check) => ({
    ...check,
    expectationRef: check.checkNodeRef || check.expectationRef,
    expectation: expectationByRef.get(check.checkNodeRef || check.expectationRef)?.text || check.expectation || check.checkNodeRef || check.expectationRef || '未命名验证点',
    knowledge: (check.knowledgeRefs || []).map((entryId) => candidatesById.get(entryId) || { entryId }),
    knowledgeInvestigation: investigationStatus(check.checkNodeRef || check.expectationRef, report, events, knowledgeReviews),
    technicalFacts: (check.technicalRefs || []).map((ref) => {
      const fact = technicalByRef.get(ref);
      return fact ? technicalFactView(fact, events, report.execution, check.checkNodeRef || check.expectationRef) : {
        ref, type: null, code: 'TECHNICAL_FACT_MISSING', message: '引用的技术事实不存在', time: null,
        operation: null, operationId: null, decisionId: null, sceneId: null, generation: null,
        state: 'INVALID', stateReason: '技术事实不属于当前 execution',
      };
    }),
  }));
  const decisionSteps = executionDecisions.flatMap((event) => {
    const decision = event.decision || {};
    const stepModel = modelForEvent(flowEvents, event);
    const stepExpectations = new Map(((stepModel?.nodes || []).filter((item) => item.type === 'CHECK')
      .concat(stepModel?.verificationPoints || context?.expectations || [])).map((item) => [item.ref || item.id, item]));
    const stepFlowContext = flowContextByDecision.get(event.decisionId) || null;
    const action = actionByDecision.get(event.decisionId) || null;
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
    const projectedAction = actionView(report, events, action, resultByOperation);
    const recoveryView = recovery ? { operationId: recovery.operationId, status: recovery.type === 'appRecovered' ? 'SUCCEEDED' : recovery.type === 'recoveryFailed' ? 'FAILED' : 'UNKNOWN', reason: recovery.reason || recovery.message || '' } : null;
    const baseStep = {
      number: 0,
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
      caseFlowRevision: event.caseFlowRevision || stepFlowContext?.caseFlowRevision || null,
      flowContext: stepFlowContext ? {
        nodeRef: stepFlowContext.nodeRef,
        selectedEdgeRef: stepFlowContext.selectedEdgeRef || null,
      } : null,
      action: projectedAction,
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
        action: projectedAction,
        knowledge,
        recovery: recoveryView,
        visualInspection,
        beforeScene,
        afterScene,
        technicalIssue,
      }),
    };
    if (event.requestedOperation !== 'runSequence') return [baseStep];

    const sequence = sequenceByDecision.get(event.decisionId);
    if (!sequence?.steps?.length) return [baseStep];
    return sequence.steps.map((sequenceStep, stepIndex) => {
      const stepAction = actionByOperation.get(sequenceStep.operationId) || null;
      const stepActionView = actionView(report, events, stepAction, resultByOperation);
      const before = scenes.get(sequenceStep.preSceneRef) || null;
      const after = scenes.get(sequenceStep.postSceneRef) || null;
      return {
        ...baseStep,
        operation: sequenceStep.type,
        sequenceId: sequence.sequenceId,
        sequenceStepId: sequenceStep.stepId,
        sequenceStep: {
          status: sequenceStep.status,
          durationMs: sequenceStep.durationMs ?? null,
          error: sequenceStep.error || null,
          preSceneRef: sequenceStep.preSceneRef,
          postSceneRef: sequenceStep.postSceneRef || null,
          operationId: sequenceStep.operationId || null,
          purpose: sequenceStep.purpose || null,
          captureOrigins: after?.captureOrigins || [],
        },
        action: stepActionView,
        sceneId: sequenceStep.preSceneRef || baseStep.sceneId,
        beforeScene: sceneSummary(before),
        afterScene: sceneSummary(after),
        postAssessment: stepIndex === sequence.steps.length - 1 ? baseStep.postAssessment : null,
        processState: sequenceStepState(sequenceStep, stepActionView, after),
      };
    });
  });
  const steps = decisionSteps.map((step, index) => ({ ...step, number: index + 1 }));
  const operationGroups = [];
  const sequenceGroups = new Map();
  for (const step of steps) {
    if (!step.sequenceId && step.operation !== 'runSequence') {
      operationGroups.push({
        kind: step.operation === 'act' ? 'ACT' : 'STEP',
        sourceOperation: step.operation,
        decisionId: step.decisionId,
        purpose: step.purpose,
        time: step.time,
        status: step.processState,
        beforeScene: step.beforeScene,
        afterScene: step.afterScene,
        steps: [step],
      });
      continue;
    }
    const record = step.sequenceId ? sequenceById.get(step.sequenceId) || null
      : sequenceByDecision.get(step.decisionId) || null;
    const sequenceId = step.sequenceId || record?.sequenceId || null;
    const groupId = sequenceId || step.decisionId;
    let group = sequenceGroups.get(groupId);
    if (!group) {
      const declaredFinalScene = sceneSummary(scenes.get(record?.finalSceneRef)) || null;
      group = {
        kind: 'RUN_SEQUENCE',
        sourceOperation: 'runSequence',
        groupId,
        sequenceId,
        decisionId: step.decisionId,
        purpose: record?.purpose || step.purpose,
        time: record?.startedAt || step.time,
        status: record?.status || 'SEQUENCE_NOT_RECORDED',
        durationMs: record?.elapsedMs ?? null,
        beforeScene: step.beforeScene,
        afterScene: declaredFinalScene || step.afterScene,
        finalSceneSource: declaredFinalScene ? 'DECLARED' : step.afterScene ? 'LAST_AVAILABLE' : 'UNAVAILABLE',
        requestStep: step.sequenceId ? null : step,
        steps: [],
      };
      sequenceGroups.set(groupId, group);
      operationGroups.push(group);
    }
    if (step.sequenceId) {
      group.steps.push(step);
      if (group.finalSceneSource !== 'DECLARED' && step.afterScene) {
        group.afterScene = step.afterScene;
        group.finalSceneSource = 'LAST_AVAILABLE';
      }
    }
  }
  const operationMetrics = {
    standaloneActCount: operationGroups.filter((group) => group.kind === 'ACT').length,
    sequenceCount: operationGroups.filter((group) => group.kind === 'RUN_SEQUENCE').length,
    sequenceActionCount: operationGroups.filter((group) => group.kind === 'RUN_SEQUENCE')
      .reduce((count, group) => count + group.steps.filter((step) => step.operation === 'act').length, 0),
  };

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
    modelKind: 'CASE_FLOW',
    recordingStatus,
    contextVersion: latestFlow?.revision || null,
    caseFlow: latestFlow,
    caseFlowHistory: flowEvents,
    understanding: context,
    understandingHistory: [],
    initialPlan,
    plan: latest(planHistory),
    planHistory,
    steps,
    operationGroups,
    operationMetrics,
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
