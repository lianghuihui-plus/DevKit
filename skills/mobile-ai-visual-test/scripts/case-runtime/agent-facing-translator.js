'use strict';

const { validateRuntimeRequest } = require('./contract');
const { aggregateVerdict } = require('./result-integrity');
const store = require('./store');
const { attachTechnicalContext } = require('../lib/technical-context');
const {
  actionRefFor,
  capabilityCards,
  finishTemplate,
  projectActions,
  projectPreviousAction,
  projectScene,
  validateAgentFacingRequest,
} = require('./agent-facing-contract');

function inputError(issues) {
  const error = new Error('Agent-facing request is invalid');
  error.code = 'AGENT_INPUT_INVALID';
  error.issues = issues;
  return error;
}

function issue(field, message, code = 'INVALID') {
  return { field, message, code };
}

function caseModel(execDir) {
  return require('./case-model-service').current(execDir);
}

function knownExpectations(execDir) {
  return new Set((caseModel(execDir)?.verificationPoints || []).map((item) => item.ref));
}

function validateExpectationRefs(execDir, refs, field = 'expectationRefs') {
  const known = knownExpectations(execDir);
  return (refs || []).filter((ref) => !known.has(ref))
    .map((ref) => issue(field, `未知验证点 ${ref}`, 'EXPECTATION_UNKNOWN'));
}

function currentScene(execDir) {
  return store.readCurrentScene(execDir);
}

function currentPlan(execDir) {
  const model = caseModel(execDir);
  return model ? { version: model.revision, reason: model.reason, items: model.items } : null;
}

function contextualIssues(execDir, request, scene) {
  const issues = [];
  if ((['inspect', 'act', 'knowledge'].includes(request.capability)
    || (request.capability === 'recover' && !request.targetState && !request.externalAction)) && !scene) {
    issues.push(issue('capability', '当前没有 Scene，请先使用 observe', 'SCENE_REQUIRED'));
  }
  if (request.capability === 'finish' && !currentPlan(execDir)) {
    issues.push(issue('capability', '结束前必须先使用 plan 形成本次用例理解、验证点和计划', 'CASE_MODEL_REQUIRED'));
  }
  if (request.capability === 'plan' && currentPlan(execDir) && !request.reason) {
    issues.push(issue('reason', '更新执行计划时必须说明路径变化原因', 'REQUIRED'));
  }
  issues.push(...validateExpectationRefs(execDir, request.expectationRefs));
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
    const allowedFilters = request.channel === 'elements' ? ['interactiveOnly', 'textContains', 'role']
      : request.channel === 'capabilities' ? ['actionType', 'elementRef'] : [];
    for (const field of Object.keys(request.filter || {})) {
      if (!allowedFilters.includes(field)) issues.push(issue(`filter.${field}`, `${request.channel} 检查不支持该过滤字段`, 'FIELD_UNSUPPORTED'));
    }
  }
  if (request.capability === 'act' && scene) {
    const action = projectActions(scene).find((item) => item.actionRef === request.actionRef);
    if (!action) issues.push(issue('actionRef', '请使用当前 scene.actions 中的 actionRef', 'ACTION_UNKNOWN'));
    for (const field of action?.requiredInput || []) {
      if (request.input?.[field] === undefined) issues.push(issue(`input.${field}`, `动作 ${request.actionRef} 必须提供 ${field}`, 'REQUIRED'));
    }
    const allowedInput = request.actionRef === 'visual:swipe' ? ['from', 'to']
      : ['visual:tap', 'visual:doubleTap'].includes(request.actionRef) ? ['point']
      : request.actionRef === 'visual:longPress' ? ['point', 'durationMs', 'duringActionAtMs']
      : request.actionRef?.endsWith(':longPress') ? ['durationMs', 'duringActionAtMs']
      : request.actionRef?.endsWith(':inputText') ? ['text', 'mode']
      : request.actionRef?.endsWith(':wait') ? ['ms'] : [];
    for (const field of Object.keys(request.input || {})) {
      if (!allowedInput.includes(field)) issues.push(issue(`input.${field}`, `动作 ${request.actionRef} 不支持该输入字段`, 'FIELD_UNSUPPORTED'));
    }
    if (request.actionRef === 'visual:longPress' && request.input?.duringActionAtMs !== undefined
      && request.input.duringActionAtMs >= request.input.durationMs) {
      issues.push(issue('input.duringActionAtMs', '必须小于长按 durationMs', 'RANGE_INVALID'));
    }
  }
  if (request.capability === 'recover' && request.targetState && request.externalAction) {
    issues.push(issue('externalAction', 'targetState 与 externalAction 不能在同一次恢复请求中同时使用', 'MUTUALLY_EXCLUSIVE'));
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
  if (request.capability === 'finish') {
    const expected = [...knownExpectations(execDir)];
    if (!expected.length) issues.push(issue('checks', '当前 Case Model 没有 ACTIVE 验证点', 'CASE_MODEL_REQUIRED'));
    const supplied = (request.checks || []).map((item) => item.expectationRef);
    for (const ref of expected.filter((ref) => !supplied.includes(ref))) issues.push(issue('checks', `缺少验证点 ${ref}`, 'EXPECTATION_MISSING'));
    for (const ref of supplied.filter((ref) => !expected.includes(ref))) issues.push(issue('checks', `未知验证点 ${ref}`, 'EXPECTATION_UNKNOWN'));
    for (const ref of new Set(supplied.filter((value, index) => supplied.indexOf(value) !== index))) issues.push(issue('checks', `验证点 ${ref} 重复`, 'EXPECTATION_DUPLICATE'));
    const knownScenes = new Set(store.events(execDir).filter((event) => event.type === 'sceneObserved').map((event) => event.sceneId));
    if (scene) knownScenes.add(scene.sceneId);
    for (const [index, check] of (request.checks || []).entries()) {
      if (['PASS', 'FAIL'].includes(check.status) && !(check.evidence || []).length) {
        issues.push(issue(`checks[${index}].evidence`, `${check.status} 必须引用支持判断的 Scene`, 'EVIDENCE_REQUIRED'));
      }
      for (const ref of check.evidence || []) {
        if (ref === 'current' && !scene) issues.push(issue(`checks[${index}].evidence`, '当前没有可引用的 Scene', 'SCENE_REQUIRED'));
        else if (ref !== 'current' && !knownScenes.has(ref)) issues.push(issue(`checks[${index}].evidence`, `未知 Scene ${ref}`, 'SCENE_UNKNOWN'));
      }
    }
  }
  return issues;
}

function visualRequest(actionRef, input) {
  const gesture = actionRef.slice('visual:'.length);
  if (gesture === 'swipe') return { gesture, from: input.from, to: input.to };
  return { gesture, point: input.point, ...(gesture === 'longPress' ? { durationMs: input.durationMs } : {}) };
}

function resolveEvidence(scene, refs = []) {
  return refs.map((ref) => ref === 'current' ? scene?.sceneId : ref);
}

function translateAgentFacingRequest(execDir, request) {
  const structural = validateAgentFacingRequest(request);
  if (structural.length) throw inputError(structural);
  const scene = currentScene(execDir);
  const contextual = contextualIssues(execDir, request, scene);
  if (contextual.length) throw inputError(contextual);
  const expectationRefs = request.expectationRefs || [];
  let translated;
  if (request.capability === 'observe') translated = {
    operation: 'observe',
    ...(request.purpose || expectationRefs.length ? { decision: { purpose: request.purpose || '刷新当前页面现场', expectationRefs } } : {}),
  };
  else if (request.capability === 'inspect' && request.channel === 'visual') translated = {
    operation: 'inspectVisual', basedOnSceneId: scene.sceneId,
    decision: { purpose: '记录当前截图的视觉事实', expectationRefs, observation: request.observation },
  };
  else if (request.capability === 'inspect') translated = {
    operation: 'inspectScene', basedOnSceneId: scene.sceneId,
    view: { action: 'ACTION', elements: 'ELEMENTS', capabilities: 'CAPABILITIES', layout: 'LAYOUT' }[request.channel],
    ...(request.channel === 'action' ? { observation: request.observation, expectationRefs } : {}),
    ...(request.filter ? { filter: request.filter } : {}),
  };
  else if (request.capability === 'plan') {
    translated = {
      operation: 'recordCaseModel',
      caseModel: {
        understanding: request.understanding,
        preconditions: request.preconditions,
        verificationPoints: request.verificationPoints,
        items: request.items,
        uncertainties: request.uncertainties,
        ...(request.reason ? { reason: request.reason } : {}),
      },
    };
  } else if (request.capability === 'act') {
    const action = projectActions(scene).find((item) => item.actionRef === request.actionRef);
    const internalCapability = (scene.capabilities || []).find((item) => actionRefFor(item) === action.actionRef);
    translated = {
      operation: 'act', basedOnSceneId: scene.sceneId,
      ...(request.actionRef.startsWith('visual:')
        ? { visual: visualRequest(request.actionRef, request.input || {}) }
        : {
          capabilityId: internalCapability.id,
          ...(request.input ? { input: Object.fromEntries(Object.entries(request.input).filter(([field]) => field !== 'duringActionAtMs')) } : {}),
        }),
      ...(request.actionRef.endsWith(':longPress') && request.input?.duringActionAtMs !== undefined
        ? { observationPolicy: { duringActionAtMs: request.input.duringActionAtMs } } : {}),
      decision: { purpose: request.purpose, expectationRefs },
    };
  } else if (request.capability === 'knowledge' && request.queryId) {
    const query = store.events(execDir).find((event) => event.type === 'knowledgeQueried' && event.queryId === request.queryId);
    translated = {
      operation: 'reviewKnowledge', basedOnSceneId: scene.sceneId,
      decision: {
        purpose: '登记知识候选复核结果', expectationRefs: query.expectationRefs || [],
        knowledgeReview: { queryId: request.queryId, conclusion: request.conclusion, assessments: request.assessments },
      },
    };
  } else if (request.capability === 'knowledge') translated = {
    operation: 'knowledge', basedOnSceneId: scene.sceneId, query: request.query,
    decision: { purpose: '调查当前异常的已知解释和处理规则', expectationRefs },
  };
  else if (request.capability === 'recover') translated = {
    operation: request.targetState ? 'prepare' : 'recover',
    ...(request.targetState
      ? { preparation: { targetState: request.targetState } }
      : { ...(scene ? { basedOnSceneId: scene.sceneId } : {}), reason: request.reason }),
    ...(request.externalAction ? { externalAction: request.externalAction } : {}),
  };
  else if (request.capability === 'finish') {
    const checks = request.checks.map((check) => ({
      expectationRef: check.expectationRef,
      status: check.status,
      actual: check.actual,
      ...(check.evidence ? { sceneRefs: resolveEvidence(scene, check.evidence) } : {}),
      ...(check.knowledgeRefs ? { knowledgeRefs: check.knowledgeRefs } : {}),
      ...(check.technicalRefs ? { technicalRefs: check.technicalRefs } : {}),
      ...(check.evidenceBasis ? { evidenceBasis: {
        ...check.evidenceBasis,
        sceneRef: check.evidenceBasis.sceneRef === 'current' ? scene?.sceneId : check.evidenceBasis.sceneRef,
      } } : {}),
    }));
    translated = {
      operation: 'finish', ...(scene ? { basedOnSceneId: scene.sceneId } : {}),
      decision: { purpose: '提交最终结论', expectationRefs: checks.map((item) => item.expectationRef) },
      result: { verdict: aggregateVerdict(checks), summary: request.summary, checks, uncertainties: request.uncertainties || [] },
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

function reviewExample(requiredReview) {
  if (!requiredReview?.template) return null;
  return {
    capability: 'knowledge',
    queryId: requiredReview.template.queryId,
    conclusion: requiredReview.template.conclusion,
    assessments: (requiredReview.template.assessments || []).map((item) => ({
      entryId: item.entryId,
      status: item.status,
      reason: '说明该候选对当前现场是否适用',
    })),
  };
}

function preparationNextCall(execDir, response, model) {
  if (response.code !== 'APP_INITIAL_STATE_UNAVAILABLE'
    && response.status !== 'EXTERNAL_ACTION_RECORDED') return null;
  const recovery = require('./preparation-service').preparationRecoveryState(execDir);
  if (!recovery?.targetState) return null;
  if (recovery.retryAllowed) {
    return {
      reason: 'RETRY_APP_INITIAL_STATE',
      example: {
        capability: 'recover',
        reason: '重新建立用例要求的 App 初始状态',
        targetState: recovery.targetState,
      },
    };
  }
  if (recovery.requiresExternalAction) {
    return {
      reason: 'RECORD_TECHNICAL_RECOVERY',
      example: {
        capability: 'recover',
        reason: '完成当前 execution 范围内的技术处置后登记事实',
        externalAction: { summary: '说明已完成的技术处置及结果' },
      },
    };
  }
  if (!model) return null;
  return { reason: 'CLOSE_UNRECOVERABLE_INITIAL_STATE', example: finishTemplate(model) };
}

function projectAgentFacingResponse(execDir, response, request = null) {
  const projected = { ...response };
  delete projected.allowedOperations;
  delete projected.capabilities;
  delete projected.narrative;
  delete projected.requiredReview;
  const scene = currentScene(execDir);
  const model = caseModel(execDir);
  projected.scene = projectScene(scene, { caseModel: model });
  if (projected.action) projected.action = projectPreviousAction(projected.action, model);
  const nextReview = reviewExample(response.requiredReview);
  if (nextReview) projected.nextCall = { reason: 'REVIEW_KNOWLEDGE_CANDIDATES', example: nextReview };
  const preparationRecovery = preparationNextCall(execDir, response, model);
  if (preparationRecovery) projected.nextCall = preparationRecovery;
  else if (response.status === 'EXTERNAL_ACTION_RECORDED') {
    projected.nextCall = { reason: 'VERIFY_EXTERNAL_ACTION_WITH_NEW_SCENE', example: { capability: 'observe' } };
  }
  if (projected.knowledgeInvestigation) {
    projected.knowledgeInvestigation = {
      ...projected.knowledgeInvestigation,
      pendingReviews: (projected.knowledgeInvestigation.pendingReviews || []).map((pending) => ({
        queryId: pending.queryId,
        query: pending.query,
        candidateCount: pending.candidateCount,
        expectationRefs: pending.expectationRefs || [],
        candidates: pending.candidates || [],
        nextCall: { example: reviewExample(pending.requiredReview) },
      })),
    };
  }
  return attachTechnicalContext(projected, 'EXECUTION', { capability: 'observe' }, {
    resourceFacts: [
      `execution=${store.loadExecution(execDir, { allowFinalized: true }).executionId}`,
      `scene=${scene?.sceneId || 'none'}`,
    ],
  });
}

function finishExample(values = {}) {
  return { capability: 'finish', summary: values.summary, checks: values.checks, uncertainties: values.uncertainties || [] };
}

function retryExample(execDir, request = {}) {
  const scene = currentScene(execDir);
  const model = caseModel(execDir);
  if (!scene && ['inspect', 'act', 'knowledge', 'recover', 'finish'].includes(request.capability)) return { capability: 'observe' };
  if (!currentPlan(execDir) && request.capability === 'finish') {
    return capabilityCards({ scene, caseModel: null }).plan.example;
  }
  if (request.capability === 'plan') {
    const fallback = model ? {
      capability: 'plan',
      understanding: model.understanding,
      preconditions: model.preconditions,
      verificationPoints: model.verificationPoints.map(({ ref, text }) => ({ ref, text })),
      items: model.items,
      uncertainties: model.uncertainties,
    } : capabilityCards({ scene, caseModel: null }).plan.example;
    return { ...fallback, ...request, ...(model ? { reason: request.reason || '说明本次用例理解或计划变化原因' } : {}) };
  }
  if (request.capability === 'act') {
    const action = projectActions(scene).find((item) => item.actionRef === request.actionRef) || projectActions(scene)[0];
    return action?.example || { capability: 'observe' };
  }
  if (request.capability === 'inspect') {
    if (request.channel === 'action' && scene?.previousAction?.spatialEvidence?.inspect?.example) {
      return scene.previousAction.spatialEvidence.inspect.example;
    }
    return request.channel === 'visual'
      ? { capability: 'inspect', channel: 'visual', observation: '描述截图中实际看到的事实', expectationRefs: [] }
      : { capability: 'inspect', channel: ['elements', 'capabilities', 'layout'].includes(request.channel) ? request.channel : 'elements' };
  }
  if (request.capability === 'knowledge' && request.queryId) {
    const query = store.events(execDir).find((event) => event.type === 'knowledgeQueried' && event.queryId === request.queryId);
    if (query) return reviewExample(require('./knowledge-review').buildKnowledgeReviewGuidance(query.queryId, query.candidates || []));
  }
  if (request.capability === 'knowledge') return { capability: 'knowledge', query: request.query || '描述当前无法解释的问题', expectationRefs: [] };
  if (request.capability === 'recover') return {
    capability: 'recover', reason: request.reason || '目标 App 无法继续交互',
    ...(request.targetState ? { targetState: request.targetState } : {}),
    ...(request.externalAction ? { externalAction: request.externalAction } : {}),
  };
  if (request.capability === 'finish') return finishTemplate(model);
  return { capability: 'observe' };
}

module.exports = {
  finishExample,
  projectAgentFacingResponse,
  reviewExample,
  retryExample,
  translateAgentFacingRequest,
};
