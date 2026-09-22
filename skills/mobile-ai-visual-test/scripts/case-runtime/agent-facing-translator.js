'use strict';

const { validateRuntimeRequest } = require('./contract');
const store = require('./store');
const {
  PUBLIC_CONTRACT,
  projectPreviousAction,
  validateAgentFacingRequest,
  documentationRefFor,
} = require('./agent-facing-contract');
const { resolveActionRef } = require('./capability-catalog');
const { successEnvelope, errorEnvelope } = require('../lib/agent-facing-envelope');

function inputError(issues) {
  const error = new Error('Agent-facing request is invalid');
  error.code = 'AGENT_INPUT_INVALID';
  error.issues = issues;
  return error;
}

function issue(field, message, code = 'INVALID') {
  return { field, message, code };
}

function caseFlow(execDir) {
  return require('./case-flow-service').current(execDir);
}

function knownExpectations(execDir) {
  return new Set(require('./case-flow-service').checkpointRegistry(execDir)
    .filter((item) => item.baseline || item.active).map((item) => item.ref));
}

function validateExpectationRefs(execDir, refs, field = 'expectationRefs') {
  const known = knownExpectations(execDir);
  return (refs || []).filter((ref) => !known.has(ref))
    .map((ref) => issue(field, `未知验证点 ${ref}`, 'EXPECTATION_UNKNOWN'));
}

function currentScene(execDir) {
  return store.readCurrentScene(execDir);
}

function executionPlatform(execDir) {
  return store.loadExecution(execDir, { allowFinalized: true }).platform;
}

function sceneByRef(execDir, sceneRef) {
  if (!sceneRef) return currentScene(execDir);
  return require('../lib/execution-lifecycle').readJson(
    require('path').join(store.paths(execDir).scenes, `${sceneRef}.json`), null,
  );
}

function currentPlan(execDir) {
  const flow = caseFlow(execDir);
  return flow ? { version: flow.revision, reason: flow.reason, nodes: flow.nodes, edges: flow.edges } : null;
}

function contextualIssues(execDir, request, scene) {
  const issues = [];
  if ((['inspect', 'act', 'knowledge'].includes(request.operation)
    || (request.operation === 'recover' && request.mode === 'restart')) && !scene) {
    issues.push(issue('operation', '当前没有 Scene，请先使用 observe', 'SCENE_REQUIRED'));
  }
  if (request.operation === 'finish' && !currentPlan(execDir)) {
    issues.push(issue('operation', '结束前必须先使用 plan 形成 Case Flow', 'CASE_FLOW_REQUIRED'));
  }
  if (request.operation === 'plan' && currentPlan(execDir) && !request.reason) {
    const reason = request.caseFlow?.reason || request.reason;
    const replay = request.caseFlow
      ? require('./case-flow-service').matchingRevision(execDir, request.caseFlow)
      : null;
    if (!reason && !replay) issues.push(issue(request.caseFlow ? 'caseFlow.reason' : 'reason', '修订 Case Flow 时必须说明原因', 'REQUIRED'));
  }
  issues.push(...validateExpectationRefs(execDir, request.checkNodeRefs, 'checkNodeRefs'));
  if (request.flowContext !== undefined) {
    try {
      require('./case-flow-service').validateFlowContext(execDir, request.flowContext);
    } catch (error) {
      issues.push(issue('flowContext', error.message, error.code || 'CASE_FLOW_CONTEXT_INVALID'));
    }
  }
  if (request.operation === 'recordResult') {
    for (const [index, result] of (request.results || []).entries()) {
      issues.push(...validateExpectationRefs(execDir, [result.checkNodeRef], `results[${index}].checkNodeRef`));
    }
    if (!issues.length) {
      try {
        require('./expectation-result-service').prepareExpectationResults(execDir, request.results.map(({ checkNodeRef, ...item }) => ({
          ...item, expectationRef: checkNodeRef,
        })));
      } catch (error) {
        issues.push(issue('results', error.message, ['EXPECTATION_UNKNOWN', 'EVIDENCE_REFERENCE_INVALID'].includes(error.code)
          ? error.code : 'RECORD_RESULT_INVALID'));
      }
    }
  }
  if (request.operation === 'inspect') {
    if (request.mode === 'action' && !scene?.previousAction?.spatialEvidence) {
      issues.push(issue('mode', '当前 Scene 没有可检查的上一动作落点标注图', 'ACTION_SPATIAL_EVIDENCE_REQUIRED'));
    }
  }
  if (request.operation === 'runPlan' && scene && request.sceneRef !== scene.sceneId) {
    issues.push(issue('sceneRef', `当前 Scene 是 ${scene.sceneId}`, 'SCENE_CHANGED'));
  }
  if (request.operation === 'act' && scene) {
    if (request.sceneRef && request.sceneRef !== scene.sceneId) {
      issues.push(issue('sceneRef', `当前 Scene 是 ${scene.sceneId}`, 'SCENE_CHANGED'));
      return issues;
    }
    let internalCapability = null;
    if (!request.actionRef?.startsWith('visual:')) {
      try {
        internalCapability = resolveActionRef(scene, request.actionRef, executionPlatform(execDir));
      } catch (error) {
        if (error.code !== 'ACTION_REF_INVALID') throw error;
      }
    }
    const visualGesture = request.actionRef?.startsWith('visual:')
      ? request.actionRef.slice('visual:'.length) : null;
    const action = visualGesture && (scene.visual?.gestures || []).includes(visualGesture)
      ? { requiredInput: visualGesture === 'swipe' ? ['from', 'to']
        : visualGesture === 'longPress' ? ['point', 'durationMs'] : ['point'] }
      : internalCapability && {
        requiredInput: internalCapability.kind === 'longPress' ? ['durationMs']
          : internalCapability.kind === 'inputText' ? ['text']
            : internalCapability.kind === 'wait' ? ['ms'] : [],
      };
    if (!action) issues.push(issue('actionRef', 'actionRef 对当前 Scene 不可用', 'ACTION_NOT_AVAILABLE'));
    for (const field of action?.requiredInput || []) {
      if (request.input?.[field] === undefined) issues.push(issue(`input.${field}`, `动作 ${request.actionRef} 必须提供 ${field}`, 'ACTION_INPUT_INVALID'));
    }
    const allowedInput = request.actionRef === 'visual:swipe' ? ['from', 'to']
      : ['visual:tap', 'visual:doubleTap'].includes(request.actionRef) ? ['point']
      : request.actionRef === 'visual:longPress' ? ['point', 'durationMs']
      : request.actionRef?.endsWith(':longPress') ? ['durationMs']
      : request.actionRef?.endsWith(':inputText') ? ['text', 'mode']
      : request.actionRef?.endsWith(':wait') ? ['ms'] : [];
    for (const field of Object.keys(request.input || {})) {
      if (!allowedInput.includes(field)) issues.push(issue(`input.${field}`, `动作 ${request.actionRef} 不支持该输入字段`, 'ACTION_INPUT_INVALID'));
    }
    if (request.action?.ref && !allowedInput.length && request.input !== undefined) {
      issues.push(issue('action.input', '该 ActionRef 不接受动态 input', 'ACTION_INPUT_INVALID'));
    }
    if (request.sceneRef && request.actionRef?.startsWith('visual:')) {
      const inspected = store.events(execDir).some((event) => event.type === 'visualInspected' && event.sceneId === scene.sceneId);
      if (!inspected) issues.push(issue('actionRef', '视觉动作要求先登记该 Scene 的视觉事实', 'VISUAL_INSPECTION_REQUIRED'));
    }
  }
  if (request.operation === 'knowledge' && request.mode === 'review') {
    const query = store.events(execDir).find((event) => event.type === 'knowledgeQueried' && event.queryId === request.queryId);
    if (!query) issues.push(issue('queryId', '该知识查询不存在或不属于当前 execution', 'QUERY_UNKNOWN'));
    else {
      issues.push(...validateExpectationRefs(execDir, query.expectationRefs, 'queryId'));
      const expected = new Set((query.candidates || []).map((item) => item.entryId));
      const supplied = request.assessments || [];
      const unknown = supplied.filter((item) => !expected.has(item.entryId));
      for (const item of unknown) issues.push(issue('assessments', `候选 ${item.entryId} 不属于该查询`, 'CANDIDATE_UNKNOWN'));
      try {
        require('./knowledge-review').validateKnowledgeReview(execDir, {
          queryId: request.queryId, conclusion: request.conclusion, assessments: request.assessments,
        });
      } catch (error) {
        issues.push(issue('assessments', error.message, error.code || 'KNOWLEDGE_REVIEW_INVALID'));
      }
    }
  }
  if (request.operation === 'finish' && request.mode === 'notRun') {
    const sceneRefs = request.evidence?.sceneRefs || [];
    const technicalRefs = request.evidence?.technicalRefs || [];
    if (!sceneRefs.length && !technicalRefs.length) {
      issues.push(issue('evidence', 'NOT_RUN 必须引用至少一个已登记 Scene 或技术事实', 'REQUIRED'));
    }
    const events = store.events(execDir);
    const knownScenes = new Set(events.filter((event) => event.type === 'sceneObserved').map((event) => event.sceneId));
    const knownTechnical = new Set(events.map((event) => event.technicalFactRef).filter(Boolean));
    for (const ref of sceneRefs.filter((item) => !knownScenes.has(item))) issues.push(issue('evidence.sceneRefs', `未知 Scene ${ref}`, 'EVIDENCE_REFERENCE_INVALID'));
    for (const ref of technicalRefs.filter((item) => !knownTechnical.has(item))) issues.push(issue('evidence.technicalRefs', `未知技术事实 ${ref}`, 'EVIDENCE_REFERENCE_INVALID'));
  }
  return issues;
}

function visualRequest(actionRef, input) {
  const gesture = actionRef.slice('visual:'.length);
  if (gesture === 'swipe') return { gesture, from: input.from, to: input.to };
  return { gesture, point: input.point, ...(gesture === 'longPress' ? { durationMs: input.durationMs } : {}) };
}

function translateAgentFacingRequest(execDir, request) {
  const structural = validateAgentFacingRequest(request);
  if (structural.length) throw inputError(structural);
  request = { ...request.input, operation: request.operation };
  if (request.operation === 'read') return { operation: 'read', ref: request.ref };
  if (request.operation === 'act') {
    const action = request.action;
    if (action.ref?.startsWith('visual:')) {
      throw inputError([issue('input.action.ref', '自主视觉动作使用 action.type 和 action.target', 'ACTION_NOT_AVAILABLE')]);
    }
    request = {
      ...request,
      actionRef: action.ref || `visual:${action.type}`,
      input: action.ref ? action.input : { ...action.target, ...(action.durationMs ? { durationMs: action.durationMs } : {}) },
      purpose: request.purpose || '执行 Agent 选择的动作',
    };
  }
  const current = currentScene(execDir);
  const scene = request.operation === 'inspect' ? sceneByRef(execDir, request.sceneRef) : current;
  const contextual = contextualIssues(execDir, request, scene);
  if (contextual.length) throw inputError(contextual.map((item) => ({
    ...item,
    field: item.field === 'operation' ? 'operation'
      : `input.${item.field.replace(/^actionRef/, 'action.ref').replace(/^input\./, 'action.input.')}`,
  })));
  const expectationRefs = request.checkNodeRefs || [];
  const flowContext = request.flowContext ? { flowContext: request.flowContext } : {};
  let translated;
  if (request.operation === 'observe') translated = {
    operation: 'observe',
    ...flowContext,
    ...(request.purpose ? { decision: { purpose: request.purpose, expectationRefs: [] } } : {}),
  };
  else if (request.operation === 'inspect' && request.mode === 'visual') translated = {
    operation: 'inspectVisual', basedOnSceneId: scene.sceneId,
    ...flowContext,
    decision: { purpose: '记录当前截图的视觉事实', expectationRefs, observation: request.observation },
  };
  else if (request.operation === 'inspect') translated = {
    operation: 'inspectScene', basedOnSceneId: scene.sceneId,
    ...flowContext,
    view: 'ACTION', observation: request.observation, expectationRefs,
  };
  else if (request.operation === 'plan') {
    translated = {
      operation: 'recordCaseFlow',
      caseFlow: request.caseFlow,
    };
  } else if (request.operation === 'recordResult') {
    translated = {
      operation: 'recordExpectationResults',
      results: request.results.map(({ checkNodeRef, ...item }) => ({ ...item, expectationRef: checkNodeRef })),
    };
  } else if (request.operation === 'act') {
    const internalCapability = request.actionRef.startsWith('visual:')
      ? null : resolveActionRef(scene, request.actionRef, executionPlatform(execDir));
    translated = {
      operation: 'act', basedOnSceneId: scene.sceneId,
      ...flowContext,
      ...(request.actionRef.startsWith('visual:')
        ? { visual: visualRequest(request.actionRef, request.input || {}) }
        : {
          capabilityId: internalCapability.id,
          ...(request.input ? { input: request.input } : {}),
        }),
      decision: { purpose: request.purpose, expectationRefs: [] },
    };
  } else if (request.operation === 'runPlan') {
    translated = {
      operation: 'runPlan',
      submissionId: request.submissionId,
      basedOnSceneId: request.sceneRef,
      purpose: request.purpose,
      maxDurationMs: request.maxDurationMs,
      onFailure: request.onFailure,
      steps: request.steps,
      ...flowContext,
      decision: { purpose: request.purpose, expectationRefs: [] },
    };
  } else if (request.operation === 'knowledge' && request.mode === 'review') {
    const query = store.events(execDir).find((event) => event.type === 'knowledgeQueried' && event.queryId === request.queryId);
    translated = {
      operation: 'reviewKnowledge', basedOnSceneId: scene.sceneId,
      ...flowContext,
      decision: {
        purpose: '登记知识候选复核结果', expectationRefs: query.expectationRefs || [],
        knowledgeReview: { queryId: request.queryId, conclusion: request.conclusion, assessments: request.assessments },
      },
    };
  } else if (request.operation === 'knowledge') translated = {
    operation: 'knowledge', basedOnSceneId: scene.sceneId, query: request.query,
    ...flowContext,
    decision: { purpose: '调查当前异常的已知解释和处理规则', expectationRefs },
  };
  else if (request.operation === 'recover') translated = {
    operation: request.mode === 'prepare' ? 'prepare' : 'recover',
    ...flowContext,
    ...(request.mode === 'prepare'
      ? { preparation: { targetState: request.targetState } }
      : { ...(scene ? { basedOnSceneId: scene.sceneId } : {}), reason: request.reason }),
    ...(request.mode === 'external' ? { externalAction: request.externalAction } : {}),
  };
  else if (request.operation === 'finish') {
    const flow = caseFlow(execDir);
    const result = request.mode === 'notRun' ? {
      verdict: 'NOT_RUN', summary: request.summary, checks: [], uncertainties: request.uncertainties || [],
      caseFlowRevision: flow.revision, notRunReason: request.reason, notRunEvidence: request.evidence,
    } : require('./expectation-result-service').buildCaseResultFromLedger(execDir, request);
    translated = {
      operation: 'finish', ...(current ? { basedOnSceneId: current.sceneId } : {}),
      ...flowContext,
      decision: { purpose: '提交最终结论', expectationRefs: result.checks.map((item) => item.checkNodeRef) },
      result,
    };
  }
  try {
    validateRuntimeRequest(translated);
  } catch (error) {
    const wrapped = new Error(error.message);
    wrapped.code = 'FACADE_TRANSLATION_ERROR';
    wrapped.cause = error;
    throw wrapped;
  }
  return translated;
}

function responseProjection(request, outcome) {
  let selected = PUBLIC_CONTRACT.methods[request?.operation]?.responseProjection;
  if (selected?.modes) selected = selected.modes[request.input?.mode];
  if (selected?.outcomes) selected = selected.outcomes[outcome];
  return selected;
}

function publicErrorStatus(response) {
  if (response.status === 'UNKNOWN' || response.outcomeKnown === false
    || ['ACTION_OUTCOME_UNKNOWN', 'PLAN_ACTION_OUTCOME_UNKNOWN'].includes(response.code)
    || response.action?.outcomeKnown === false || response.action?.deliveryStatus === 'UNKNOWN'
    || response.action?.status === 'UNKNOWN' || response.action?.command?.status === 'UNKNOWN') return 'UNKNOWN';
  if (['REJECTED', 'REQUEST_INVALID', 'INPUT_INVALID', 'SCENE_CHANGED', 'RESULT_INCOMPLETE'].includes(response.status)) return 'REJECTED';
  if (['FAILED', 'TECHNICAL', 'TIME_LIMIT'].includes(response.status)
    || response.action?.command?.status === 'REJECTED' || response.action?.deviceExecution?.status === 'FAILED') return 'FAILED';
  return null;
}

function projectAgentFacingError(response, request = null, resources = [], provided = {}) {
  const status = publicErrorStatus(response) || 'FAILED';
  const operation = Object.hasOwn(PUBLIC_CONTRACT.methods, request?.operation) ? request.operation : null;
  const failureCode = response.code || response.action?.failureCode || response.action?.deviceExecution?.failureCode;
  const code = status === 'UNKNOWN' ? (operation === 'runPlan' ? 'PLAN_ACTION_OUTCOME_UNKNOWN' : 'ACTION_OUTCOME_UNKNOWN')
    : response.status === 'SCENE_CHANGED' ? 'SCENE_CHANGED'
      : PUBLIC_CONTRACT.errors[failureCode] ? failureCode : 'CASE_RUNTIME_TECHNICAL';
  const definition = PUBLIC_CONTRACT.errors[code];
  return errorEnvelope({
    operation, status, code,
    result: projectResponseResult(response, request, provided).result,
    retryable: status === 'UNKNOWN' ? false : (response.retryable ?? definition.retryable),
    ...(response.issues ? { issues: response.issues.map((item) => ({
      field: item.field || item.fieldPath || 'request',
      code: item.code || 'INVALID',
      ...(item.message ? { message: item.message } : {}),
    })) } : {}),
    resources: resources.filter((resource) => (definition.resourceTypes || []).includes(resource.type)),
    documentationRef: documentationRefFor(code),
    ...(operation ? { operationDocumentationRef: `references/case-runtime/methods/${operation}.md` } : {}),
  });
}

function projectResponseResult(response, request, provided = {}) {
  const internalOutcome = response.result?.outcome || response.status;
  const outcome = request?.operation === 'observe' && internalOutcome === 'SCENE' ? 'SCENE_CAPTURED' : internalOutcome;
  const projection = responseProjection(request, outcome);
  if (!projection) return { projection: null, result: {} };
  const inspection = response.visualInspection || response.actionInspection || {};
  const action = response.action ? projectPreviousAction(response.action) : null;
  const values = {
    outcome,
    sceneRef: response.sceneRef || response.sceneId || inspection.sceneId || response.scene?.sceneId,
    inspectionId: inspection.inspectionId || response.inspectionId,
    checkNodeIds: inspection.expectationRefs,
    revision: response.caseFlow?.revision,
    idempotent: response.idempotent,
    retiredNodeIds: response.caseFlowChange?.retiredNodeRefs,
    retiredEdgeIds: response.caseFlowChange?.retiredEdgeRefs,
    invalidatedResultRefs: response.caseFlowChange?.invalidatedResultRefs,
    idempotentCheckNodeIds: response.unchanged,
    operationId: action?.operationRef,
    planId: response.planId,
    deliveryStatus: action?.deliveryStatus,
    outcomeKnown: action?.outcomeKnown,
    candidateCount: response.candidateCount ?? response.candidates?.length,
    reviewRequired: response.reviewRequired,
    conclusion: response.conclusion || (response.status === 'KNOWLEDGE_REVIEWED' ? request?.input?.conclusion : undefined),
    verificationRequired: response.status === 'EXTERNAL_ACTION_RECORDED' ? true : undefined,
    preparationState: response.preparationState,
    executionId: response.executionId,
    verdict: response.verdict,
    ...response.result,
    ...provided.result,
    outcome,
  };
  const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  const result = Object.fromEntries(projection.resultFields
    .filter((field) => scalar(values[field]) || (Array.isArray(values[field]) && values[field].every(scalar)))
    .map((field) => [field, values[field]]));
  return { projection, result };
}

function projectAgentFacingResponse(execDir, response, request = null, options = {}) {
  // The resource provider owns persistence and canonical content. No current Scene/global
  // state is appended here, and no reference is synthesized by the wire projector.
  const provided = options.resourceProvider?.(execDir, response, request) || {};
  const failure = publicErrorStatus(response);
  if (failure) return projectAgentFacingError(response, request, provided.resources || response.resources || [], provided);
  const { projection, result } = projectResponseResult(response, request, provided);
  if (!projection) return projectAgentFacingError({ status: 'FAILED', code: 'CASE_RUNTIME_TECHNICAL' }, request);
  const candidateData = provided.data || response.data;
  const primaryType = projection.primaryResourceType === '$resourceType'
    ? result.resourceType : projection.primaryResourceType;
  const data = candidateData?.ref && candidateData.content !== undefined && candidateData.type === primaryType
    ? candidateData : undefined;
  const allowedResources = projection.associatedResourceTypes;
  const resources = (provided.resources || response.resources || []).filter((resource) =>
    Array.isArray(allowedResources) ? allowedResources.includes(resource.type)
      : allowedResources === '$declaredResources' && (provided.declaredResources || []).some((declared) =>
        declared.ref === resource.ref && declared.type === resource.type));
  return successEnvelope({ operation: request.operation, result, ...(data ? { data } : {}), resources });
}

module.exports = {
  projectAgentFacingResponse,
  projectAgentFacingError,
  translateAgentFacingRequest,
};
