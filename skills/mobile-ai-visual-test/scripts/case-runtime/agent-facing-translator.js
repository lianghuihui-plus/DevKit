'use strict';

const { validateRuntimeRequest } = require('./contract');
const store = require('./store');
const {
  AGENT_FACING_PROTOCOL,
  projectPreviousAction,
  projectScene,
  validateAgentFacingRequest,
  documentationRefFor,
} = require('./agent-facing-contract');
const { resolveActionRef } = require('./capability-catalog');

function inputError(issues) {
  const error = new Error('Agent-facing request is invalid');
  error.code = 'AGENT_INPUT_INVALID';
  error.issues = issues;
  return error;
}

function issue(field, message, code = 'INVALID') {
  return { field, message, code };
}

function projectCheckTerminology(value) {
  if (Array.isArray(value)) return value.map(projectCheckTerminology);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key === 'expectationRef' ? 'checkNodeRef' : key === 'expectationRefs' ? 'checkNodeRefs' : key,
    projectCheckTerminology(child),
  ]));
}

function caseFlow(execDir) {
  return require('./case-flow-service').current(execDir);
}

function knownExpectations(execDir) {
  return new Set((caseFlow(execDir)?.nodes || []).filter((item) => item.type === 'CHECK').map((item) => item.ref));
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
  if ((['inspect', 'act', 'knowledge'].includes(request.capability)
    || (request.capability === 'recover' && !request.targetState && !request.externalAction)) && !scene) {
    issues.push(issue('capability', '当前没有 Scene，请先使用 observe', 'SCENE_REQUIRED'));
  }
  if (request.capability === 'finish' && !currentPlan(execDir)) {
    issues.push(issue('capability', '结束前必须先使用 plan 形成 Case Flow', 'CASE_FLOW_REQUIRED'));
  }
  if (request.capability === 'plan' && currentPlan(execDir) && !request.reason) {
    const reason = request.caseFlow?.reason || request.reason;
    if (!reason) issues.push(issue(request.caseFlow ? 'caseFlow.reason' : 'reason', '修订 Case Flow 时必须说明原因', 'REQUIRED'));
  }
  issues.push(...validateExpectationRefs(execDir, request.checkNodeRefs, 'checkNodeRefs'));
  if (request.flowContext !== undefined) {
    try {
      require('./case-flow-service').validateFlowContext(execDir, request.flowContext);
    } catch (error) {
      issues.push(issue('flowContext', error.message, error.code || 'CASE_FLOW_CONTEXT_INVALID'));
    }
  }
  if (request.capability === 'recordResult') {
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
  if (request.capability === 'inspect') {
    if (['visual', 'action'].includes(request.channel) && !request.observation) {
      issues.push(issue('observation', `${request.channel === 'visual' ? '视觉' : '动作落点'}登记必须描述实际看到的图片事实`, 'REQUIRED'));
    }
    if (!['visual', 'action'].includes(request.channel) && request.observation !== undefined) {
      issues.push(issue('observation', '只有 visual 或 action 检查可以提交 observation', 'FIELD_UNSUPPORTED'));
    }
    if (request.channel === 'action' && !scene?.previousAction?.spatialEvidence) {
      issues.push(issue('channel', '当前 Scene 没有可检查的上一动作落点标注图', 'ACTION_SPATIAL_EVIDENCE_REQUIRED'));
    }
    const allowedFilters = request.channel === 'elements' ? ['interactiveOnly', 'textContains', 'role'] : [];
    for (const field of Object.keys(request.filter || {})) {
      if (!allowedFilters.includes(field)) issues.push(issue(`filter.${field}`, `${request.channel} 检查不支持该过滤字段`, 'FIELD_UNSUPPORTED'));
    }
  }
  if (request.capability === 'act' && scene) {
    if (request.basedOnSceneRef && request.basedOnSceneRef !== scene.sceneId) {
      issues.push(issue('basedOnSceneRef', `当前 Scene 是 ${scene.sceneId}`, 'SCENE_CHANGED'));
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
      : request.actionRef === 'visual:longPress' ? ['point', 'durationMs', 'duringActionAtMs']
      : request.actionRef?.endsWith(':longPress') ? ['durationMs', 'duringActionAtMs']
      : request.actionRef?.endsWith(':inputText') ? ['text', 'mode']
      : request.actionRef?.endsWith(':wait') ? ['ms'] : [];
    for (const field of Object.keys(request.input || {})) {
      if (!allowedInput.includes(field)) issues.push(issue(`input.${field}`, `动作 ${request.actionRef} 不支持该输入字段`, 'ACTION_INPUT_INVALID'));
    }
    if (request.actionRef === 'visual:longPress' && request.input?.duringActionAtMs !== undefined
      && request.input.duringActionAtMs >= request.input.durationMs) {
      issues.push(issue('input.duringActionAtMs', '必须小于长按 durationMs', 'ACTION_INPUT_INVALID'));
    }
    if (request.basedOnSceneRef && request.actionRef?.startsWith('visual:')) {
      const inspected = store.events(execDir).some((event) => event.type === 'visualInspected' && event.sceneId === scene.sceneId);
      if (!inspected) issues.push(issue('actionRef', '视觉动作要求先登记该 Scene 的视觉事实', 'VISUAL_INSPECTION_REQUIRED'));
    }
  }
  if (request.capability === 'recover' && request.targetState && request.externalAction) {
    issues.push(issue('externalAction', 'targetState 与 externalAction 不能在同一次恢复请求中同时使用', 'MUTUALLY_EXCLUSIVE'));
  }
  if (request.capability === 'recover' && !request.targetState && !request.externalAction
    && currentScene(execDir) && !request.basedOnSceneRef) {
    issues.push(issue('basedOnSceneRef', 'App 重启恢复必须绑定当前 Scene', 'SCENE_REQUIRED'));
  }
  if (request.capability === 'knowledge' && request.queryId) {
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
  if (request.capability === 'finish' && request.outcome === 'NOT_RUN') {
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
  const current = currentScene(execDir);
  const scene = request.capability === 'inspect' ? sceneByRef(execDir, request.basedOnSceneRef) : current;
  const contextual = contextualIssues(execDir, request, scene);
  if (contextual.length) throw inputError(contextual);
  const expectationRefs = request.checkNodeRefs || [];
  const flowContext = request.flowContext ? { flowContext: request.flowContext } : {};
  let translated;
  if (request.capability === 'observe') translated = {
    operation: 'observe',
    ...flowContext,
    ...(request.purpose ? { decision: { purpose: request.purpose, expectationRefs: [] } } : {}),
  };
  else if (request.capability === 'inspect' && request.channel === 'visual') translated = {
    operation: 'inspectVisual', basedOnSceneId: scene.sceneId,
    ...flowContext,
    decision: { purpose: '记录当前截图的视觉事实', expectationRefs, observation: request.observation },
  };
  else if (request.capability === 'inspect') translated = {
    operation: 'inspectScene', basedOnSceneId: scene.sceneId,
    ...flowContext,
    view: { action: 'ACTION', elements: 'ELEMENTS', layout: 'LAYOUT' }[request.channel],
    ...(request.channel === 'action' ? { observation: request.observation, expectationRefs } : {}),
    ...(request.filter ? { filter: request.filter } : {}),
  };
  else if (request.capability === 'plan') {
    translated = {
      operation: 'recordCaseFlow',
      caseFlow: request.caseFlow,
    };
  } else if (request.capability === 'recordResult') {
    translated = {
      operation: 'recordExpectationResults',
      results: request.results.map(({ checkNodeRef, ...item }) => ({ ...item, expectationRef: checkNodeRef })),
    };
  } else if (request.capability === 'act') {
    const internalCapability = request.actionRef.startsWith('visual:')
      ? null : resolveActionRef(scene, request.actionRef, executionPlatform(execDir));
    translated = {
      operation: 'act', basedOnSceneId: scene.sceneId,
      ...flowContext,
      ...(request.actionRef.startsWith('visual:')
        ? { visual: visualRequest(request.actionRef, request.input || {}) }
        : {
          capabilityId: internalCapability.id,
          ...(request.input ? { input: Object.fromEntries(Object.entries(request.input).filter(([field]) => field !== 'duringActionAtMs')) } : {}),
        }),
      ...(request.actionRef.endsWith(':longPress') && request.input?.duringActionAtMs !== undefined
        ? { observationPolicy: { duringActionAtMs: request.input.duringActionAtMs } } : {}),
      decision: { purpose: request.purpose, expectationRefs: [] },
    };
  } else if (request.capability === 'knowledge' && request.queryId) {
    const query = store.events(execDir).find((event) => event.type === 'knowledgeQueried' && event.queryId === request.queryId);
    translated = {
      operation: 'reviewKnowledge', basedOnSceneId: scene.sceneId,
      ...flowContext,
      decision: {
        purpose: '登记知识候选复核结果', expectationRefs: query.expectationRefs || [],
        knowledgeReview: { queryId: request.queryId, conclusion: request.conclusion, assessments: request.assessments },
      },
    };
  } else if (request.capability === 'knowledge') translated = {
    operation: 'knowledge', basedOnSceneId: scene.sceneId, query: request.query,
    ...flowContext,
    decision: { purpose: '调查当前异常的已知解释和处理规则', expectationRefs },
  };
  else if (request.capability === 'recover') translated = {
    operation: request.targetState ? 'prepare' : 'recover',
    ...flowContext,
    ...(request.targetState
      ? { preparation: { targetState: request.targetState } }
      : { ...(scene ? { basedOnSceneId: scene.sceneId } : {}), reason: request.reason }),
    ...(request.externalAction ? { externalAction: request.externalAction } : {}),
  };
  else if (request.capability === 'finish') {
    const flow = caseFlow(execDir);
    const result = request.outcome === 'NOT_RUN' ? {
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

function projectAgentFacingResponse(execDir, response, request = null) {
  if (response.status === 'COMPLETED') {
    return {
      protocol: AGENT_FACING_PROTOCOL,
      status: 'COMPLETED',
      executionRef: response.executionId,
      verdict: response.verdict,
      resultRef: 'result.json',
      ...(response.idempotent === true ? { idempotent: true } : {}),
    };
  }
  const projected = { ...response };
  delete projected.allowedOperations;
  delete projected.capabilities;
  delete projected.narrative;
  delete projected.requiredReview;
  delete projected.nextCall;
  delete projected.retryWith;
  delete projected.technicalContext;
  if (projected.diagnostic && typeof projected.diagnostic === 'object') {
    const technical = {
      ...(projected.diagnostic.code ? { code: projected.diagnostic.code } : {}),
      ...(projected.diagnostic.stage ? { stage: projected.diagnostic.stage } : {}),
      ...(projected.diagnostic.logRefs ? { logRefs: projected.diagnostic.logRefs } : {}),
      ...(projected.diagnostic.resourceFacts ? { resourceFacts: projected.diagnostic.resourceFacts } : {}),
    };
    if (Object.keys(technical).length) projected.facts = { ...(projected.facts || {}), technical };
  }
  delete projected.diagnostic;
  delete projected.result;
  delete projected.evidenceDiagnostics;
  delete projected.knowledgeUsage;
  delete projected.caseModel;
  const scene = currentScene(execDir);
  if (request?.capability === 'inspect') delete projected.scene;
  else projected.scene = projectScene(scene);
  if (response.status === 'SCENE_INSPECTION') {
    delete projected.evidence;
    if (response.view === 'ELEMENTS') {
      projected.items = (response.items || []).map((element) => ({
        ref: element.id,
        ...(element.text ? { text: element.text } : {}),
        ...(element.role ? { role: element.role } : {}),
        bounds: element.bounds,
        clickable: element.clickable === true,
        checkable: element.checkable === true,
        editable: element.editable === true,
        enabled: element.enabled !== false,
        visible: element.visible !== false,
        ...(element.focused === true ? { focused: true } : {}),
      }));
    }
  }
  if (projected.action) projected.action = projectPreviousAction(projected.action, model);
  if (projected.knowledgeInvestigation) {
    projected.knowledgeInvestigation = {
      ...projected.knowledgeInvestigation,
      pendingReviews: (projected.knowledgeInvestigation.pendingReviews || []).map((pending) => ({
        queryId: pending.queryId,
        query: pending.query,
        candidateCount: pending.candidateCount,
        checkNodeRefs: pending.expectationRefs || [],
        candidates: pending.candidates || [],
      })),
    };
  }
  projected.protocol = AGENT_FACING_PROTOCOL;
  const state = require('./expectation-result-service').caseStateSummary(execDir);
  if (state.caseFlowRevision !== null) projected.caseState = state;
  if (response.caseFlowChange) projected.caseFlowChange = response.caseFlowChange;
  if (projected.code) {
    projected.retryable = projected.retryable !== undefined ? projected.retryable
      : !['ACTION_OUTCOME_UNKNOWN', 'TIME_LIMIT'].includes(projected.code);
    projected.documentationRef = documentationRefFor(projected.code);
  }
  return projectCheckTerminology(projected);
}

module.exports = {
  projectAgentFacingResponse,
  translateAgentFacingRequest,
};
