'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureArray, ensureObject, ensureString, sha256 } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { withAuthorizationSha } = require('../lib/plan-authorization');
const { coordinateActionConflict } = require('../lib/observation-consistency');
const { assertCurrentKnowledgeContext, buildCurrentKnowledgeContext } = require('../lib/knowledge-context');
const { KNOWLEDGE_REVIEW_CONCLUSIONS } = require('../execution/contracts/execution-event-contract');
const {
  STATE_CHANGING_ACTIONS,
  assertCurrentPlan,
  assertAgentWriteReady,
  changePhase,
  confirmStartObservation,
  currentObservation,
  hasCurrentStartObservation,
  knowledgeQueryDraftIds,
  latestStateChangeIndex,
  operationDraftIds,
  timelineEvents,
  turnDraftIds,
} = require('../execution/core');
const { validateLiveAgentBinding } = require('../lib/agent-driven-contract');
const { commitAgentTurn } = require('./turn');
const {
  alignOperationPhase,
  executeDeviceOperation,
  freezeOperationRequest,
  operationContext,
  operationPaths,
  validateOperationRequest,
} = require('./operations');
const { executeKnowledgeQuery } = require('./query-knowledge');
const { finalizeWithReview } = require('./finalize');
const { createAgentResult } = require('./core');
const { buildObservationView, findElement } = require('./observation-view');
const { activeCheckpoint, controlRequestPath } = require('./control-request');
const {
  assertConclusionEligibility,
  assertFindingEvidenceOwnership,
  checkpointFacts,
  defaultResultFields,
} = require('./conclusion-policy');
const {
  assertAgentInputFields,
  normalizeTextList,
  validateSemanticActionInput,
} = require('../lib/agent-input-contract');
const {
  buildPlanTurn,
  buildUnderstandingTurn,
  sameCurrentPlan,
  sameUnderstanding,
} = require('./semantic-service');

const VERDICTS = new Set(['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
const DEFAULT_POST_ACTION_SETTLE_MS = 500;
const MAX_POST_ACTION_SETTLE_MS = 5000;

function resolvePostActionSettleMs(action, env = process.env) {
  if (!STATE_CHANGING_ACTIONS.has(action?.type) || action.type === 'wait') return 0;
  const configured = env.MAVT_POST_ACTION_SETTLE_MS;
  if (configured === undefined || configured === '') return DEFAULT_POST_ACTION_SETTLE_MS;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_POST_ACTION_SETTLE_MS;
  return Math.min(value, MAX_POST_ACTION_SETTLE_MS);
}

function generatedId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function requireText(value, field) {
  ensureString(value, field, 'AGENT_FACADE_INVALID');
  return value.trim();
}

function facadeStepDir(execDir) {
  return path.join(execDir, 'agent', 'steps');
}

function facadeStepDrafts(execDir) {
  const dir = facadeStepDir(execDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^step-.+\.draft\.json$/.test(name)).sort().map((name) => {
    const value = readJson(path.join(dir, name), null);
    return value?.stepId ? value : null;
  }).filter(Boolean);
}

function assertNoFacadeRecovery(execDir, allowedStepId = null) {
  if (!allowedStepId && fs.existsSync(controlRequestPath(execDir))) {
    throw contractError('AGENT_CONTROL_REQUEST_PENDING', 'the coordinator must complete the pending App recovery before Agent execution continues');
  }
  const pending = facadeStepDrafts(execDir).filter((entry) => entry.stepId !== allowedStepId);
  if (pending.length) {
    throw contractError('AGENT_STEP_RECOVERY_REQUIRED', `recover Agent step before continuing: ${pending.map((entry) => entry.stepId).join(', ')}`);
  }
  if (!allowedStepId) {
    const internal = [
      ...operationDraftIds(execDir).map((id) => `operation:${id}`),
      ...knowledgeQueryDraftIds(execDir).map((id) => `knowledge-query:${id}`),
      ...turnDraftIds(execDir).map((id) => `turn:${id}`),
    ];
    if (internal.length) {
      throw contractError('FRAMEWORK_RECOVERY_PENDING', `the coordinator must recover internal transactions before Agent execution continues: ${internal.join(', ')}`);
    }
  }
}

function context(execDir) {
  const binding = validateLiveAgentBinding(execDir);
  const value = operationContext(execDir);
  const events = timelineEvents(execDir);
  const observation = currentObservation(events, value.execution.warmSessionGeneration);
  return { ...value, binding, events, observation };
}

function knowledgeContext(current) {
  return buildCurrentKnowledgeContext({
    execution: current.execution,
    understanding: current.understanding,
    plan: current.plan,
    events: current.events,
    observation: current.observation,
    stateBoundaryIndex: latestStateChangeIndex(current.events),
  });
}

function assertExecutableRequirements(current) {
  if (!current.understanding?.requirements?.length) {
    throw contractError('NO_EXECUTABLE_REQUIREMENTS', 'the current understanding has no executable requirements; device work is not authorized');
  }
}

function withRuntimeState(execDir, value, options = {}) {
  const { readAgentStatus } = require('./status');
  return { ...value, runtimeState: readAgentStatus(execDir, options.now, { includeEvidence: false }) };
}

function stageScope(stage) {
  return stage === 'PREPARE' ? 'case-prepare' : 'case-business';
}

function currentStage(execDir) {
  const current = context(execDir);
  return hasCurrentStartObservation(current.events, current.understanding?.revision, current.execution.warmSessionGeneration)
    ? 'BUSINESS' : 'PREPARE';
}

function authorizationFor(execDir, input, stage) {
  const current = context(execDir);
  if (!current.understanding || !current.plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understanding and plan are required before device work');
  assertExecutableRequirements(current);
  assertCurrentPlan(current.events);
  const scope = stageScope(stage);
  const checkpointRef = stage === 'BUSINESS'
    ? input.checkpointRef || activeCheckpoint(current.plan, current.events, current.execution.warmSessionGeneration)
    : input.checkpointRef;
  const checkpoint = checkpointRef
    ? current.plan.checkpoints.find((entry) => entry.id === checkpointRef)
    : null;
  if (checkpointRef && !checkpoint) {
    throw contractError('PLAN_AUTHORIZATION_REFERENCE_INVALID', `unknown checkpointRef: ${checkpointRef}`, {
      fieldPath: 'checkpointRef', expected: 'checkpoint from the current plan', received: checkpointRef,
    });
  }
  if (stage === 'PREPARE' && checkpoint) {
    throw contractError('AGENT_FACADE_INVALID', 'PREPARE does not bind a checkpoint', { fieldPath: 'checkpointRef' });
  }
  if (stage === 'BUSINESS' && input.startConditionRef) {
    throw contractError('AGENT_FACADE_INVALID', 'BUSINESS does not bind a start condition', { fieldPath: 'startConditionRef' });
  }
  const startCondition = input.startConditionRef
    ? current.understanding.startConditions.find((entry) => entry.id === input.startConditionRef)
    : current.understanding.startConditions.length === 1 ? current.understanding.startConditions[0] : null;
  if (input.startConditionRef && !startCondition) {
    throw contractError('PLAN_AUTHORIZATION_REFERENCE_INVALID', `unknown startConditionRef: ${input.startConditionRef}`, {
      fieldPath: 'startConditionRef', expected: 'start condition from the current understanding', received: input.startConditionRef,
    });
  }
  return withAuthorizationSha({
    schemaVersion: 1,
    source: 'agent-plan',
    executionId: current.execution.executionId,
    phase: scope,
    understandingRevision: current.understanding.revision,
    purpose: requireText(input.intent || '观察并推进当前用例', 'intent'),
    requirementRefs: checkpoint?.requirementRefs || [],
    sourceRefs: [],
    ...(stage === 'PREPARE' && startCondition ? { startConditionId: startCondition.id } : {}),
    ...(stage === 'BUSINESS' && checkpoint ? { planRevision: current.plan.revision, checkpointId: checkpoint.id } : {}),
  });
}

function observationResponse(execDir, fact, extra = {}) {
  return {
    accepted: true,
    observation: fact,
    observationView: buildObservationView(execDir, fact),
    ...extra,
  };
}

function inspectCurrent(execDir, input = {}, options = {}) {
  assertAgentInputFields('inspect', input);
  assertNoFacadeRecovery(execDir);
  const stage = currentStage(execDir);
  const request = {
    operationId: generatedId('obs'),
    intent: requireText(input.intent || (stage === 'PREPARE' ? '观察当前现场并建立用例起点' : '观察当前业务现场'), 'intent'),
    expectedOutcome: requireText(input.expectedOutcome || '取得当前 App 截图、控件树和诊断资料', 'expectedOutcome'),
    purpose: stage === 'PREPARE' ? 'ESTABLISH_START' : 'AGENT_DECIDED',
    authorization: authorizationFor(execDir, input, stage),
  };
  const value = executeDeviceOperation(execDir, request, options);
  return withRuntimeState(execDir, observationResponse(execDir, value.fact, { stage }), options);
}

function normalizedNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw contractError('AGENT_FACADE_INVALID', `${field} must be between 0 and 1`, {
      fieldPath: field, expected: 'number from 0 to 1', received: value,
    });
  }
  return number;
}

function pixelPoint(point, image, field) {
  if (!Array.isArray(point) || point.length !== 2) {
    throw contractError('AGENT_FACADE_INVALID', `${field} must contain [x,y]`, { fieldPath: field });
  }
  return [
    Math.min(image.width - 1, Math.round(normalizedNumber(point[0], `${field}[0]`) * image.width)),
    Math.min(image.height - 1, Math.round(normalizedNumber(point[1], `${field}[1]`) * image.height)),
  ];
}

function pixelBounds(bounds, image, field = 'action.normalizedBounds') {
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    throw contractError('AGENT_FACADE_INVALID', `${field} must contain [x1,y1,x2,y2]`, { fieldPath: field });
  }
  const first = pixelPoint(bounds.slice(0, 2), image, field);
  const second = pixelPoint(bounds.slice(2), image, field);
  if (second[0] <= first[0] || second[1] <= first[1]) {
    throw contractError('AGENT_FACADE_INVALID', `${field} must describe a positive area`, { fieldPath: field });
  }
  return [...first, ...second];
}

function resolveSemanticAction(execDir, proposal) {
  validateSemanticActionInput(proposal);
  requireText(proposal.type, 'action.type');
  const current = context(execDir);
  if (!current.observation) throw contractError('CURRENT_OBSERVATION_REQUIRED', 'step requires a current usable observation');
  const view = buildObservationView(execDir, current.observation);
  const coordinateConflict = coordinateActionConflict(view, current.execution.platform, proposal.type);
  if (coordinateConflict) {
    throw contractError('ACTION_COORDINATE_CONFLICT', '当前 iOS 键盘坐标空间与截图不一致，坐标动作未发送', {
      conflict: coordinateConflict,
      suggestion: '先执行 dismissKeyboard 并基于新的 observationView 继续',
    });
  }
  const reason = proposal.reason || proposal.intent || '根据当前现场执行 Agent 选择的动作';
  const clean = { ...proposal };
  delete clean.targetRef;
  delete clean.normalizedPoint;
  delete clean.normalizedBounds;
  delete clean.normalizedFrom;
  delete clean.normalizedTo;
  delete clean.intent;

  if (proposal.targetRef) {
    const element = findElement(view, proposal.targetRef);
    const [left, top, right, bottom] = element.bounds;
    const coordinates = {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
      coordinateSource: 'layout',
      coordinateEvidence: `当前控件树元素 ${element.text} 的 bounds=[${element.bounds.join(',')}]`,
      coordinateArtifactRef: view.layoutRef,
    };
    if (proposal.type === 'inputText' && ['android', 'ios'].includes(current.execution.platform)) {
      Object.assign(clean, { target: proposal.target || element.text, reason });
    } else {
      Object.assign(clean, coordinates, { target: proposal.target || element.text, reason });
    }
  } else if (proposal.normalizedPoint) {
    const [x, y] = pixelPoint(proposal.normalizedPoint, view.screenshot, 'action.normalizedPoint');
    const bounds = pixelBounds(proposal.normalizedBounds || [Math.max(0, proposal.normalizedPoint[0] - 0.03), Math.max(0, proposal.normalizedPoint[1] - 0.03), Math.min(1, proposal.normalizedPoint[0] + 0.03), Math.min(1, proposal.normalizedPoint[1] + 0.03)], view.screenshot);
    Object.assign(clean, {
      x, y,
      target: proposal.target || '视觉目标',
      coordinateSource: 'visual',
      targetBounds: bounds,
      coordinateEvidence: `基于当前原始截图 ${view.screenshot.width}x${view.screenshot.height} 的归一化视觉位置`,
      coordinateArtifactRef: view.screenshot.ref,
      reason,
    });
  } else if (proposal.type === 'swipe' && proposal.normalizedFrom && proposal.normalizedTo) {
    const [fromX, fromY] = pixelPoint(proposal.normalizedFrom, view.screenshot, 'action.normalizedFrom');
    const [toX, toY] = pixelPoint(proposal.normalizedTo, view.screenshot, 'action.normalizedTo');
    Object.assign(clean, {
      fromX, fromY, toX, toY,
      coordinateSource: 'visual',
      targetBounds: pixelBounds(proposal.normalizedBounds || [0, 0, 1, 1], view.screenshot),
      coordinateEvidence: `基于当前原始截图 ${view.screenshot.width}x${view.screenshot.height} 的归一化滑动轨迹`,
      coordinateArtifactRef: view.screenshot.ref,
      reason,
    });
  } else if (clean.reason === undefined) {
    clean.reason = reason;
  }
  return { action: clean, observation: current.observation, view };
}

function stepPaths(execDir, stepId) {
  const dir = facadeStepDir(execDir);
  return { dir, draft: path.join(dir, `${stepId}.draft.json`), completed: path.join(dir, `${stepId}.json`) };
}

function completeStep(paths, value) {
  writeJsonAtomic(paths.completed, value);
  if (fs.existsSync(paths.draft)) fs.unlinkSync(paths.draft);
}

function settleStepAtTimeLimit(execDir, draft, options = {}) {
  const paths = stepPaths(execDir, draft.stepId);
  const requests = [draft.actionRequest, draft.observationRequest].filter(Boolean);
  const errors = [];
  for (const request of requests) {
    const operationDraft = operationPaths(execDir, request.operationId).draft;
    if (!fs.existsSync(operationDraft)) continue;
    try {
      executeDeviceOperation(execDir, request, options);
    } catch (error) {
      errors.push({ code: error.code || 'CASE_TIME_LIMIT_REACHED', message: error.message });
    }
  }
  const actionRecord = readJson(operationPaths(execDir, draft.actionRequest.operationId).completed, null);
  const observationRecord = draft.observationRequest
    ? readJson(operationPaths(execDir, draft.observationRequest.operationId).completed, null)
    : null;
  const actionNeverStarted = draft.status === 'ACTION_PENDING' && !actionRecord;
  const completed = {
    schemaVersion: 1,
    stepId: draft.stepId,
    status: actionNeverStarted ? 'CANCELLED_BY_TIME_LIMIT' : 'INCOMPLETE_BY_TIME_LIMIT',
    semanticRequest: draft.semanticRequest,
    expandedActionRequest: draft.actionRequest,
    action: actionRecord,
    observation: observationRecord,
    actionUncertain: actionRecord?.error?.code === 'DEVICE_ACTION_OUTCOME_UNCERTAIN',
    postActionSettleMs: draft.postActionSettleMs || 0,
    error: errors[0] || {
      code: 'CASE_TIME_LIMIT_REACHED',
      message: actionNeverStarted
        ? 'semantic step was cancelled before its action was sent'
        : 'semantic step ended without a usable post-action observation',
    },
    completedAt: options.now || new Date().toISOString(),
  };
  completeStep(paths, completed);
  return completed;
}

function settleStepRecoveryFailure(execDir, draft, error, options = {}) {
  const paths = stepPaths(execDir, draft.stepId);
  const completed = {
    schemaVersion: 1,
    stepId: draft.stepId,
    status: 'OBSERVATION_RECOVERY_FAILED',
    semanticRequest: draft.semanticRequest,
    expandedActionRequest: draft.actionRequest,
    action: readJson(operationPaths(execDir, draft.actionRequest.operationId).completed, null),
    observation: draft.observationRequest
      ? readJson(operationPaths(execDir, draft.observationRequest.operationId).completed, null)
      : null,
    actionUncertain: draft.actionUncertain === true,
    postActionSettleMs: draft.postActionSettleMs || 0,
    error: { code: error.code || 'DEVICE_OBSERVATION_FAILED', message: error.message },
    completedAt: options.now || new Date().toISOString(),
  };
  completeStep(paths, completed);
  return completed;
}

function executeFrozenStep(execDir, draft, options = {}) {
  const paths = stepPaths(execDir, draft.stepId);
  let actionValue;
  let actionUncertain = false;
  const postActionSettleMs = draft.postActionSettleMs
    ?? resolvePostActionSettleMs(draft.actionRequest.action, options.env || process.env);
  try {
    actionValue = executeDeviceOperation(execDir, draft.actionRequest, {
      ...options,
      postActionSettleMs,
    });
  } catch (error) {
    if (error.code !== 'DEVICE_ACTION_OUTCOME_UNCERTAIN') {
      completeStep(paths, {
        ...draft,
        status: 'FAILED',
        error: {
          code: error.code || 'AGENT_STEP_FAILED',
          message: error.message,
          ...(Number.isFinite(error.remainingMs) ? { remainingMs: error.remainingMs } : {}),
          ...(Number.isFinite(error.requiredMs) ? { requiredMs: error.requiredMs } : {}),
          ...(error.adapterDiagnostics ? { adapterDiagnostics: error.adapterDiagnostics } : {}),
        },
      });
      throw error;
    }
    actionUncertain = true;
    actionValue = { accepted: false, uncertain: true, error: { code: error.code, message: error.message } };
  }
  draft = { ...draft, status: 'ACTION_COMPLETED', actionValue, actionUncertain, postActionSettleMs };
  writeJsonAtomic(paths.draft, draft);
  const observationRequest = draft.observationRequest || {
    operationId: generatedId('obs'),
    relatedOperationId: draft.actionRequest.operationId,
    intent: `观察“${draft.semanticRequest.intent}”后的当前现场`,
    expectedOutcome: draft.semanticRequest.expectedOutcome || '取得动作后的真实当前现场',
    purpose: 'POST_ACTION',
    authorization: draft.actionRequest.authorization,
  };
  draft = { ...draft, status: 'OBSERVATION_PENDING', observationRequest };
  writeJsonAtomic(paths.draft, draft);
  let observationValue;
  try {
    observationValue = executeDeviceOperation(execDir, observationRequest, {
      ...options,
      preAdapterDelayMs: postActionSettleMs,
    });
  } catch (error) {
    draft = {
      ...draft,
      status: 'OBSERVATION_PENDING',
      observationRequest: { ...observationRequest, operationId: generatedId('obs') },
      lastObservationError: { code: error.code || 'DEVICE_OBSERVATION_FAILED', message: error.message },
    };
    writeJsonAtomic(paths.draft, draft);
    throw error;
  }
  const completed = {
    schemaVersion: 1,
    stepId: draft.stepId,
    semanticRequest: draft.semanticRequest,
    expandedActionRequest: draft.actionRequest,
    action: actionValue,
    observation: observationValue,
    actionUncertain,
    postActionSettleMs,
    completedAt: options.now || new Date().toISOString(),
  };
  completeStep(paths, completed);
  return observationResponse(execDir, observationValue.fact, {
    stepId: draft.stepId,
    action: actionValue.fact || actionValue,
    actionUncertain,
  });
}

function executeStep(execDir, input, options = {}) {
  ensureObject(input, 'step request', 'AGENT_FACADE_INVALID');
  const resumeStepId = options.resumeStepId || null;
  if (resumeStepId) {
    assertNoFacadeRecovery(execDir, resumeStepId);
    const draft = readJson(stepPaths(execDir, resumeStepId).draft, null);
    if (!draft) throw contractError('AGENT_STEP_RECOVERY_MISSING', `step draft is missing: ${resumeStepId}`);
    return withRuntimeState(execDir, executeFrozenStep(execDir, draft, options), options);
  }
  assertAgentInputFields('step', input);
  assertNoFacadeRecovery(execDir);
  assertExecutableRequirements(context(execDir));
  const stage = currentStage(execDir);
  const intent = requireText(input.intent, 'intent');
  const resolved = resolveSemanticAction(execDir, input.action);
  const authorization = authorizationFor(execDir, { ...input, intent }, stage);
  const actionRequest = freezeOperationRequest({
    operationId: generatedId('act'),
    intent,
    expectedOutcome: input.expectedOutcome || '操作后现场符合 Agent 当前预期',
    authorization,
    basisObservationRef: resolved.observation.ref,
    action: resolved.action,
  });
  alignOperationPhase(execDir, actionRequest, options);
  validateOperationRequest(execDir, actionRequest, 'ACTION');
  const stepId = generatedId('step');
  const paths = stepPaths(execDir, stepId);
  fs.mkdirSync(paths.dir, { recursive: true });
  const draft = {
    schemaVersion: 1,
    stepId,
    status: 'ACTION_PENDING',
    semanticRequest: {
      stage,
      checkpointRef: authorization.checkpointId || null,
      intent,
      expectedOutcome: input.expectedOutcome || null,
      action: input.action,
    },
    actionRequest,
    createdAt: options.now || new Date().toISOString(),
  };
  writeJsonAtomic(paths.draft, draft);
  return withRuntimeState(execDir, executeFrozenStep(execDir, draft, options), options);
}

function normalizeUnderstandingInput(execDir, input) {
  assertAgentInputFields('understand', input);
  assertNoFacadeRecovery(execDir);
  return buildUnderstandingTurn(execDir, input, context(execDir), generatedId, requireText);
}

function understand(execDir, input, options = {}) {
  assertAgentInputFields('understand', input);
  assertNoFacadeRecovery(execDir);
  if (sameUnderstanding(context(execDir), input)) {
    return withRuntimeState(execDir, { accepted: true, idempotent: true }, options);
  }
  const turn = normalizeUnderstandingInput(execDir, input);
  return withRuntimeState(execDir, commitAgentTurn(execDir, turn, options), options);
}

function normalizePlanInput(execDir, input) {
  assertAgentInputFields('plan', input);
  assertNoFacadeRecovery(execDir);
  return buildPlanTurn(input, context(execDir), generatedId);
}

function plan(execDir, input, options = {}) {
  assertAgentInputFields('plan', input);
  assertNoFacadeRecovery(execDir);
  const current = context(execDir);
  if (sameCurrentPlan(current, input)) {
    return withRuntimeState(execDir, { accepted: true, idempotent: true }, options);
  }
  return withRuntimeState(execDir, commitAgentTurn(execDir, normalizePlanInput(execDir, input), options), options);
}

function markStart(execDir, input = {}, options = {}) {
  assertAgentInputFields('markStart', input);
  assertNoFacadeRecovery(execDir);
  assertAgentWriteReady(execDir);
  const current = context(execDir);
  if (!current.understanding || !current.plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understanding and plan are required before marking the start');
  assertExecutableRequirements(current);
  assertCurrentPlan(current.events);
  const latest = current.observation;
  if (!latest || latest.scope !== 'case-prepare' || latest.understandingRevision !== current.understanding.revision) {
    throw contractError('START_OBSERVATION_REQUIRED', 'mark-start requires the latest usable PREPARE observation for the current understanding');
  }
  const before = readJson(path.join(execDir, 'execution.json'), null);
  if (before.phase !== 'ESTABLISH_START') {
    changePhase(execDir, 'ESTABLISH_START', 'Agent 准备确认当前现场为本用例起点', {
      implementationSha: before.implementationSha,
      now: options.now,
    });
  }
  const active = readJson(path.join(execDir, 'execution.json'), null);
  if (active.phase !== 'ESTABLISH_START' && active.phase !== 'EXECUTE') {
    throw contractError('EXECUTION_PHASE_TRANSITION_INVALID', `mark-start is not available during ${active.phase}`);
  }
  const event = confirmStartObservation(execDir, latest.ref,
    requireText(input.reason || 'Agent 确认当前现场满足本用例起点', 'reason'), options);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution.phase === 'ESTABLISH_START') {
    changePhase(execDir, 'EXECUTE', 'Agent 已确认本用例起点', { implementationSha: execution.implementationSha, now: options.now });
  }
  return withRuntimeState(execDir, { accepted: true, start: event, idempotent: event.idempotent === true }, options);
}

function investigate(execDir, input, options = {}) {
  assertAgentInputFields('investigate', input);
  assertNoFacadeRecovery(execDir);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution.phase !== 'INVESTIGATE') {
    changePhase(execDir, 'INVESTIGATE', input.reason || 'Agent 开始本地知识调查', {
      implementationSha: execution.implementationSha,
      now: options.now,
    });
  }
  if (input.query) {
    const current = context(execDir);
    const decisionContext = knowledgeContext(current);
    const query = executeKnowledgeQuery({
      execDir,
      queryId: generatedId('query'),
      query: input.query,
      reason: input.reason,
      knowledgeContext: decisionContext,
      now: options.now,
    });
    if (query.candidateCount > 0) return withRuntimeState(execDir, query, options);
    const review = {
      factId: generatedId('knowledge-review'), type: 'knowledgeReview', queryId: query.queryId,
      knowledgeContext: query.knowledgeContext,
      conclusion: 'NO_MATCH', assessmentRefs: [], reason: input.reason || '本次知识查询未命中候选，调查已完成',
    };
    const reviewTurn = commitAgentTurn(execDir, { schemaVersion: 1, turnId: generatedId('turn-review'), facts: [review] }, options);
    return withRuntimeState(execDir, { ...query, knowledgeReview: review, reviewTurn }, options);
  }
  const assessments = ensureArray(input.assessments, 'assessments', 'AGENT_FACADE_INVALID');
  requireText(input.queryId, 'queryId');
  if (assessments.length === 0) throw contractError('KNOWLEDGE_REVIEW_REQUIRED', 'matched knowledge query requires at least one candidate assessment');
  const conclusion = requireText(input.conclusion, 'conclusion');
  if (conclusion === 'NO_MATCH' || !KNOWLEDGE_REVIEW_CONCLUSIONS.has(conclusion)) {
    throw contractError('AGENT_FACADE_INVALID', 'knowledge review conclusion is invalid', {
      fieldPath: 'conclusion', allowed: [...KNOWLEDGE_REVIEW_CONCLUSIONS].filter((value) => value !== 'NO_MATCH'),
    });
  }
  const query = timelineEvents(execDir).find((event) => event.type === 'knowledgeQuery' && event.queryId === input.queryId);
  if (!query) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', `unknown queryId: ${input.queryId}`);
  assertCurrentKnowledgeContext(query.knowledgeContext, knowledgeContext(context(execDir)), {
    fieldPath: 'queryId',
  });
  const facts = assessments.map((assessment) => {
    const candidate = query.candidates.find((entry) => entry.entryId === assessment.entryId);
    if (!candidate) throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', `unknown knowledge candidate: ${assessment.entryId}`);
    return {
      factId: generatedId('assessment'),
      type: 'knowledgeAssessment',
      queryId: query.queryId,
      knowledgeRef: generatedId('knowledge'),
      entryId: candidate.entryId,
      sourceNamespace: candidate.sourceNamespace,
      relativePath: candidate.relativePath,
      contentSha: candidate.contentSha,
      assessment: assessment.assessment,
      reason: requireText(assessment.reason, 'assessment.reason'),
    };
  });
  facts.push({
    factId: generatedId('knowledge-review'), type: 'knowledgeReview', queryId: query.queryId,
    knowledgeContext: query.knowledgeContext,
    conclusion, assessmentRefs: facts.map((fact) => fact.knowledgeRef), reason: requireText(input.reason, 'reason'),
  });
  return withRuntimeState(execDir, commitAgentTurn(execDir, { schemaVersion: 1, turnId: generatedId('turn-assess'), facts }, options), options);
}

function conclude(execDir, input, options = {}) {
  assertAgentInputFields('conclude', input);
  assertNoFacadeRecovery(execDir);
  if (!VERDICTS.has(input.verdict)) throw contractError('AGENT_FACADE_INVALID', 'verdict is invalid', { fieldPath: 'verdict', allowed: [...VERDICTS] });
  requireText(input.summary, 'summary');
  const current = context(execDir);
  if (!current.understanding || !current.plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understanding and plan are required before conclude');
  const findingsInput = ensureArray(input.findings, 'findings', 'AGENT_FACADE_INVALID');
  const findings = findingsInput.map((finding, index) => ({
    requirementId: requireText(finding.requirementRef, `findings[${index}].requirementRef`),
    status: requireText(finding.status, `findings[${index}].status`),
    reason: requireText(finding.reason, `findings[${index}].reason`),
    evidenceRefs: finding.evidenceRefs || [],
    knowledgeRefs: finding.knowledgeRefs || [],
    incidentRefs: finding.incidentRefs || [],
    ...(finding.necessityReason ? { necessityReason: finding.necessityReason } : {}),
  }));
  const expectedRequirements = new Set(current.understanding.requirements.map((entry) => entry.id));
  const receivedRequirements = new Set(findings.map((entry) => entry.requirementId));
  if (receivedRequirements.size !== findings.length) {
    throw contractError('RESULT_REFERENCE_INVALID', 'findings must contain exactly one entry for each requirement', {
      fieldPath: 'findings', received: findings.map((entry) => entry.requirementId),
    });
  }
  const missing = [...expectedRequirements].filter((ref) => !receivedRequirements.has(ref));
  const unknown = [...receivedRequirements].filter((ref) => !expectedRequirements.has(ref));
  if (missing.length || unknown.length) {
    throw contractError('RESULT_REFERENCE_INVALID', 'findings must cover each current requirement exactly once', {
      fieldPath: 'findings', expected: [...expectedRequirements], received: [...receivedRequirements], missing, unknown,
    });
  }
  const decisionContext = knowledgeContext(current);
  const knowledgeQueries = new Map(current.events.filter((event) => event.type === 'knowledgeQuery')
    .map((event) => [event.queryId, event]));
  const knowledgeReviews = new Map(current.events.filter((event) => event.type === 'knowledgeReview')
    .map((event) => [event.queryId, event]));
  const currentReviewedQueryRefs = [...knowledgeReviews.keys()].filter((queryId) => {
    const query = knowledgeQueries.get(queryId);
    if (!query) return false;
    try {
      assertCurrentKnowledgeContext(query.knowledgeContext, decisionContext);
      assertCurrentKnowledgeContext(knowledgeReviews.get(queryId).knowledgeContext, decisionContext);
      return true;
    } catch (error) {
      if (error.code === 'KNOWLEDGE_CONTEXT_STALE') return false;
      throw error;
    }
  });
  const currentQueryRefs = [...knowledgeQueries.entries()].filter(([, query]) => {
    try {
      assertCurrentKnowledgeContext(query.knowledgeContext, decisionContext);
      return true;
    } catch (error) {
      if (error.code === 'KNOWLEDGE_CONTEXT_STALE') return false;
      throw error;
    }
  }).map(([queryId]) => queryId);
  const queryRefs = input.queryRefs || (currentReviewedQueryRefs.length ? currentReviewedQueryRefs : currentQueryRefs);
  const defaults = defaultResultFields(input, current.events);
  const stoppedWithoutObservation = current.events.some((event) => event.type === 'timeLimitReached'
    && event.observationUnavailable === true);
  const businessNegative = ['FAIL', 'INCONCLUSIVE'].includes(input.verdict)
    || (input.verdict === 'BLOCKED' && defaults.verdictBasis !== 'TECHNICAL_CONSTRAINT');
  if (businessNegative && queryRefs.length === 0) {
    throw contractError('KNOWLEDGE_QUERY_REQUIRED', `${input.verdict} requires a completed knowledge investigation`, {
      fieldPath: 'queryRefs', expected: 'at least one query from investigate', received: [],
    });
  }
  const unknownQueryRefs = queryRefs.filter((ref) => !knowledgeQueries.has(ref));
  if (unknownQueryRefs.length) {
    throw contractError('EXECUTION_EVENT_REFERENCE_INVALID', 'queryRefs contains an unknown knowledge query', {
      fieldPath: 'queryRefs', received: unknownQueryRefs,
    });
  }
  queryRefs.forEach((ref) => assertCurrentKnowledgeContext(knowledgeQueries.get(ref).knowledgeContext, decisionContext, {
    fieldPath: 'queryRefs',
  }));
  const unreviewedQueryRefs = queryRefs.filter((ref) => !knowledgeReviews.has(ref));
  if (unreviewedQueryRefs.length) {
    throw contractError('KNOWLEDGE_REVIEW_REQUIRED', `${input.verdict} requires reviewed knowledge queries`, {
      fieldPath: 'queryRefs', expected: 'queryRefs with completed knowledgeReview', received: unreviewedQueryRefs,
    });
  }
  const uncertainties = [...new Set([
    ...normalizeTextList(input.uncertainties || [], 'uncertainties'),
    ...(stoppedWithoutObservation && !(input.uncertainties || []).length
      ? ['最新状态变更后未取得可用观察'] : []),
  ])];
  const proposedResult = {
    verdict: input.verdict,
    ...defaults,
    summary: input.summary,
    requirementFindings: findings,
    uncertainties,
  };
  assertFindingEvidenceOwnership(current, findings);
  const conclusionFacts = checkpointFacts(current, findings);
  assertConclusionEligibility(current, input, findings, conclusionFacts, defaults);
  const execution = readJson(path.join(execDir, 'execution.json'), null);
  if (execution.finalized === true) {
    const existing = readJson(path.join(execDir, 'result.json'), null);
    const fields = ['verdict', 'executionStatus', 'verdictBasis', 'summary', 'requirementFindings', 'uncertainties', 'technicalFailureCode'];
    const comparable = (value) => Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]));
    if (canonicalJson(comparable(existing)) !== canonicalJson(comparable(proposedResult))) {
      throw contractError('EXECUTION_FINALIZED', 'execution is already finalized with a different semantic conclusion');
    }
    return withRuntimeState(execDir, {
      executionId: execution.executionId,
      result: existing,
      agentResult: createAgentResult({ execDir }),
      alreadyFinalized: true,
      idempotent: true,
    }, options);
  }
  const recoveryEvents = current.events.filter((event) => event.type === 'recoveryCompleted');
  const noExecutableRequirements = current.understanding.requirements.length === 0;
  const reviewRequired = !(defaults.verdictBasis === 'TECHNICAL_CONSTRAINT' && !current.observation && !stoppedWithoutObservation);
  const reviewInput = reviewRequired ? ensureObject(input.review, 'review', 'AGENT_FACADE_INVALID') : null;
  const review = !reviewRequired ? null : {
    factId: sha256(canonicalJson({ verdict: input.verdict, planSha: current.plan.planSha, findings }), 'review', 16),
    type: 'verdictReview',
    understandingRevision: current.understanding.revision,
    planRevision: current.plan.revision,
    planSha: current.plan.planSha,
    requirementRefs: current.understanding.requirements.map((entry) => entry.id),
    queryRefs,
    requestedVerdict: input.verdict,
    sourceRecheck: {
      sourceRefs: current.understanding.sourceRefs.map((entry) => entry.id),
      conclusion: requireText(reviewInput.sourceConclusion, 'review.sourceConclusion'),
    },
    currentObservationRefs: current.observation ? [current.observation.ref] : [],
    ...((stoppedWithoutObservation || (noExecutableRequirements && !current.observation)) ? { observationUnavailable: true } : {}),
    recoveryAttempt: {
      performed: recoveryEvents.length > 0,
      explanation: requireText(reviewInput.recoveryConclusion, 'review.recoveryConclusion'),
      evidenceRefs: recoveryEvents.length > 0 && current.observation ? [current.observation.ref] : [],
    },
    remainingUncertainties: uncertainties,
    reason: input.reason || input.summary,
  };
  const turn = {
    schemaVersion: 1,
    turnId: sha256(canonicalJson({ verdict: input.verdict, planSha: current.plan.planSha, findings }), 'turn-conclusion', 16),
    facts: [...conclusionFacts, ...(review ? [review] : [])],
  };
  const finalized = finalizeWithReview(execDir, proposedResult, turn, { reason: input.summary, now: options.now });
  return withRuntimeState(execDir, {
    ...finalized,
    ...(finalized.conclusionTurn ? { findingTurn: finalized.conclusionTurn } : {}),
  }, options);
}

module.exports = {
  assertNoFacadeRecovery,
  conclude,
  context,
  executeStep,
  facadeStepDrafts,
  inspectCurrent,
  investigate,
  markStart,
  normalizeUnderstandingInput,
  normalizePlanInput,
  plan,
  resolvePostActionSettleMs,
  resolveSemanticAction,
  settleStepRecoveryFailure,
  settleStepAtTimeLimit,
  understand,
};
