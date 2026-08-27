'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError, ensureArray, ensureObject, ensureString, sha256 } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { withAuthorizationSha } = require('../lib/plan-authorization');
const { checkpointActivity } = require('../lib/checkpoint-progress');
const { coordinateActionConflict } = require('../lib/observation-consistency');
const { KNOWLEDGE_REVIEW_CONCLUSIONS } = require('../execution/contracts/execution-event-contract');
const {
  STATE_CHANGING_ACTIONS,
  assertAgentWriteReady,
  changePhase,
  confirmStartObservation,
  currentObservation,
  hasCurrentStartObservation,
  knowledgeQueryDraftIds,
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

const STAGES = new Set(['PREPARE', 'BUSINESS']);
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

function withRuntimeState(execDir, value, options = {}) {
  const { readAgentStatus } = require('./status');
  return { ...value, runtimeState: readAgentStatus(execDir, options.now) };
}

function stageScope(stage) {
  return stage === 'PREPARE' ? 'case-prepare' : 'case-business';
}

function normalizeStage(value, execDir) {
  const current = context(execDir);
  const inferred = hasCurrentStartObservation(current.events, current.understanding?.revision, current.execution.warmSessionGeneration)
    ? 'BUSINESS' : 'PREPARE';
  const stage = String(value || inferred).trim().toUpperCase();
  if (!STAGES.has(stage)) {
    throw contractError('AGENT_FACADE_INVALID', 'stage must be PREPARE or BUSINESS', {
      fieldPath: 'stage', expected: 'PREPARE | BUSINESS', received: value,
    });
  }
  return stage;
}

function authorizationFor(execDir, input, stage) {
  const current = context(execDir);
  if (!current.understanding || !current.plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understanding and plan are required before device work');
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
    purpose: requireText(input.intent || input.purpose || '观察并推进当前用例', 'intent'),
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
  ensureObject(input, 'inspect request', 'AGENT_FACADE_INVALID');
  assertNoFacadeRecovery(execDir);
  const stage = normalizeStage(input.stage, execDir);
  const request = {
    operationId: generatedId('obs'),
    intent: requireText(input.intent || (stage === 'PREPARE' ? '观察当前现场并建立用例起点' : '观察当前业务现场'), 'intent'),
    expectedOutcome: requireText(input.expectedOutcome || '取得当前 App 截图、控件树和诊断资料', 'expectedOutcome'),
    purpose: input.purpose || (stage === 'PREPARE' ? 'ESTABLISH_START' : 'AGENT_DECIDED'),
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
  ensureObject(proposal, 'action', 'AGENT_FACADE_INVALID');
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
  assertNoFacadeRecovery(execDir);
  const stage = normalizeStage(input.stage, execDir);
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
  ensureObject(input, 'understand request', 'AGENT_FACADE_INVALID');
  assertNoFacadeRecovery(execDir);
  const current = context(execDir);
  const previousUnderstanding = current.understanding;
  const previousPlan = current.plan;
  if (!input.understanding && !previousUnderstanding) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'initial understand request requires understanding');
  const understanding = input.understanding ? {
    ...input.understanding,
    schemaVersion: 1,
    revision: (previousUnderstanding?.revision || 0) + 1,
    uncertainties: input.understanding.uncertainties || [],
    requirementDispositions: input.understanding.requirementDispositions || [],
    ...(previousUnderstanding ? { reason: input.reason || 'Agent 根据当前执行信息修订用例理解' } : {}),
  } : undefined;
  const checkpoints = input.checkpoints || input.plan?.checkpoints;
  if (!checkpoints && !previousPlan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'initial understand request requires checkpoints');
  const plan = checkpoints ? {
    schemaVersion: 1,
    revision: (previousPlan?.revision || 0) + 1,
    reason: input.reason || input.plan?.reason || 'Agent 根据冻结原文建立可修订检查点',
    checkpoints: ensureArray(checkpoints, 'checkpoints', 'AGENT_FACADE_INVALID').map((checkpoint) => ({
      ...checkpoint,
      requiredAction: checkpoint.requiredAction === true,
    })),
  } : undefined;
  return {
    schemaVersion: 1,
    turnId: generatedId('turn-understand'),
    ...(understanding ? { understanding } : {}),
    ...(plan ? { plan } : {}),
    facts: [],
  };
}

function semanticUnderstanding(value) {
  if (!value) return null;
  return {
    summary: value.summary,
    sourceRefs: value.sourceRefs,
    startConditions: value.startConditions,
    requirements: value.requirements,
    uncertainties: value.uncertainties || [],
    requirementDispositions: value.requirementDispositions || [],
  };
}

function semanticCheckpoints(values = []) {
  return values.map((checkpoint) => ({
    id: checkpoint.id,
    goal: checkpoint.goal,
    requirementRefs: checkpoint.requirementRefs,
    requiredAction: checkpoint.requiredAction === true,
  }));
}

function unchangedUnderstandingRequest(execDir, input) {
  const current = context(execDir);
  if (!current.understanding || !current.plan) return false;
  const requestedCheckpoints = input.checkpoints || input.plan?.checkpoints;
  const sameUnderstanding = !input.understanding || canonicalJson(semanticUnderstanding(input.understanding))
    === canonicalJson(semanticUnderstanding(current.understanding));
  const samePlan = !requestedCheckpoints || canonicalJson(semanticCheckpoints(requestedCheckpoints))
    === canonicalJson(semanticCheckpoints(current.plan.checkpoints));
  return sameUnderstanding && samePlan;
}

function understand(execDir, input, options = {}) {
  ensureObject(input, 'understand request', 'AGENT_FACADE_INVALID');
  assertNoFacadeRecovery(execDir);
  if (unchangedUnderstandingRequest(execDir, input)) {
    return withRuntimeState(execDir, { accepted: true, idempotent: true }, options);
  }
  const turn = normalizeUnderstandingInput(execDir, input);
  return withRuntimeState(execDir, commitAgentTurn(execDir, turn, options), options);
}

function markStart(execDir, input = {}, options = {}) {
  ensureObject(input, 'mark-start request', 'AGENT_FACADE_INVALID');
  assertNoFacadeRecovery(execDir);
  assertAgentWriteReady(execDir);
  const current = context(execDir);
  if (!current.understanding || !current.plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understanding and plan are required before marking the start');
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
  ensureObject(input, 'investigate request', 'AGENT_FACADE_INVALID');
  assertNoFacadeRecovery(execDir);
  if (input.query) {
    const query = executeKnowledgeQuery({ execDir, queryId: generatedId('query'), query: input.query, reason: input.reason, now: options.now });
    if (query.matchCount > 0) return withRuntimeState(execDir, query, options);
    const review = {
      factId: generatedId('knowledge-review'), type: 'knowledgeReview', queryId: query.queryId,
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
    conclusion, assessmentRefs: facts.map((fact) => fact.knowledgeRef), reason: requireText(input.reason, 'reason'),
  });
  return withRuntimeState(execDir, commitAgentTurn(execDir, { schemaVersion: 1, turnId: generatedId('turn-assess'), facts }, options), options);
}

function defaultResultFields(input, events) {
  const stopped = events.some((event) => event.type === 'timeLimitReached');
  if (input.verdict === 'PASS') return { executionStatus: stopped ? 'STOPPED_BY_BUDGET' : 'COMPLETED', verdictBasis: input.verdictBasis || 'DIRECT_EVIDENCE', technicalFailureCode: null };
  if (input.verdict === 'FAIL') return { executionStatus: 'COMPLETED', verdictBasis: input.verdictBasis || 'DIRECT_EVIDENCE', technicalFailureCode: null };
  if (input.verdict === 'INCONCLUSIVE') return { executionStatus: stopped ? 'STOPPED_BY_BUDGET' : 'COMPLETED', verdictBasis: 'INSUFFICIENT_EVIDENCE', technicalFailureCode: null };
  if (input.technicalFailureCode) return { executionStatus: 'TECHNICALLY_BLOCKED', verdictBasis: 'TECHNICAL_CONSTRAINT', technicalFailureCode: input.technicalFailureCode };
  return { executionStatus: 'COMPLETED', verdictBasis: input.verdictBasis || 'DIRECT_EVIDENCE', technicalFailureCode: null };
}

function checkpointFacts(current, findings) {
  const byRequirement = new Map(findings.map((finding) => [finding.requirementId, finding]));
  return current.plan.checkpoints.map((checkpoint) => {
    const related = checkpoint.requirementRefs.map((ref) => byRequirement.get(ref)).filter(Boolean);
    const activity = checkpointActivity(current.events, checkpoint.id, current.execution.warmSessionGeneration);
    const actions = activity.filter((event) => event.type === 'actionResult');
    const observations = activity.filter((event) => event.type === 'observation' && event.usable === true);
    const statuses = new Set(related.map((finding) => finding.status));
    const semanticStatus = statuses.has('NOT_SATISFIED') ? 'NOT_SATISFIED'
      : statuses.has('BLOCKED') ? 'BLOCKED'
        : statuses.has('UNRESOLVED') ? 'UNRESOLVED' : 'SATISFIED';
    const requiredActionSatisfied = checkpoint.requiredAction !== true || actions.length > 0;
    const findingEvidenceRefs = related.flatMap((finding) => finding.evidenceRefs || []);
    const evidenceRefs = [...new Set([
      ...observations.map((event) => event.ref),
      ...(checkpoint.requiredAction === true ? [] : findingEvidenceRefs),
    ])];
    const status = evidenceRefs.length > 0 && requiredActionSatisfied ? semanticStatus : 'NOT_EXECUTED';
    return {
      factId: sha256(canonicalJson({ planSha: current.plan.planSha, checkpointId: checkpoint.id, findings }), 'finding', 16),
      type: 'checkpointFinding',
      checkpointId: checkpoint.id,
      planRevision: current.plan.revision,
      status,
      requirementRefs: checkpoint.requirementRefs,
      evidenceRefs,
      finding: status === 'NOT_EXECUTED'
        ? `检查点“${checkpoint.goal}”没有满足执行证据要求`
        : related.map((finding) => finding.reason).filter(Boolean).join('；') || `检查点“${checkpoint.goal}”已由最终 requirement 结论覆盖`,
      reason: status === 'NOT_EXECUTED'
        ? `关联 ${actions.length} 次操作、${observations.length} 次可用观察${checkpoint.requiredAction && !requiredActionSatisfied ? '，缺少要求的操作' : ''}`
        : related.map((finding) => finding.reason).filter(Boolean).join('；') || `检查点“${checkpoint.goal}”已完成`,
    };
  });
}

function assertConclusionEligibility(current, input, findings, checkpointFindings, defaults) {
  const technicalBlocked = input.verdict === 'BLOCKED' && defaults.verdictBasis === 'TECHNICAL_CONSTRAINT';
  const startEstablished = hasCurrentStartObservation(
    current.events,
    current.understanding.revision,
    current.execution.warmSessionGeneration,
  );
  if (['PASS', 'FAIL'].includes(input.verdict) && !startEstablished) {
    throw contractError('START_NOT_ESTABLISHED', `${input.verdict} requires mark-start for the current understanding and warm session`, {
      fieldPath: 'verdict', expected: 'current startEstablished evidence before PASS or FAIL', received: input.verdict,
    });
  }
  if (!technicalBlocked && !current.observation) {
    throw contractError('CURRENT_OBSERVATION_REQUIRED', `${input.verdict} requires a current usable observation`);
  }
  if (input.verdict === 'PASS') {
    const incomplete = checkpointFindings.filter((finding) => finding.status === 'NOT_EXECUTED');
    if (incomplete.length) {
      throw contractError('CHECKPOINT_EXECUTION_INCOMPLETE', 'PASS requires execution evidence for every current checkpoint', {
        fieldPath: 'checkpoints', expected: 'no NOT_EXECUTED checkpoint', received: incomplete.map((finding) => finding.checkpointId),
      });
    }
  }
  if (input.verdict === 'FAIL') {
    const productIncidents = new Set(current.events
      .filter((event) => event.type === 'runtimeIncident' && event.category === 'PRODUCT')
      .map((event) => event.incidentId));
    const stale = findings.filter((finding) => finding.status === 'NOT_SATISFIED'
      && !finding.evidenceRefs.includes(current.observation.ref)
      && !finding.incidentRefs.some((ref) => productIncidents.has(ref)));
    if (stale.length) {
      throw contractError('CURRENT_OBSERVATION_REQUIRED', 'each NOT_SATISFIED finding must cite the latest usable observation or a PRODUCT incident', {
        fieldPath: 'findings.evidenceRefs', expected: current.observation.ref, received: stale.map((finding) => finding.requirementId),
      });
    }
  }
}

function conclude(execDir, input, options = {}) {
  ensureObject(input, 'conclude request', 'AGENT_FACADE_INVALID');
  assertNoFacadeRecovery(execDir);
  if (!VERDICTS.has(input.verdict)) throw contractError('AGENT_FACADE_INVALID', 'verdict is invalid', { fieldPath: 'verdict', allowed: [...VERDICTS] });
  requireText(input.summary, 'summary');
  const current = context(execDir);
  if (!current.understanding || !current.plan) throw contractError('AGENT_TURN_NOT_EXECUTABLE', 'understanding and plan are required before conclude');
  const latest = current.observation;
  const findingsInput = ensureArray(input.findings, 'findings', 'AGENT_FACADE_INVALID');
  const findings = findingsInput.map((finding, index) => ({
    requirementId: requireText(finding.requirementId || finding.requirementRef, `findings[${index}].requirementRef`),
    status: requireText(finding.status, `findings[${index}].status`),
    reason: requireText(finding.reason, `findings[${index}].reason`),
    evidenceRefs: finding.evidenceRefs?.length ? finding.evidenceRefs : latest ? [latest.ref] : [],
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
  const allKnowledgeQueryRefs = current.events.filter((event) => event.type === 'knowledgeQuery').map((event) => event.queryId);
  const completedKnowledgeReviews = new Set(current.events.filter((event) => event.type === 'knowledgeReview').map((event) => event.queryId));
  const queryRefs = input.queryRefs || (completedKnowledgeReviews.size ? [...completedKnowledgeReviews] : allKnowledgeQueryRefs);
  const defaults = defaultResultFields(input, current.events);
  const businessNegative = ['FAIL', 'INCONCLUSIVE'].includes(input.verdict)
    || (input.verdict === 'BLOCKED' && defaults.verdictBasis !== 'TECHNICAL_CONSTRAINT');
  if (businessNegative && queryRefs.length === 0) {
    throw contractError('KNOWLEDGE_QUERY_REQUIRED', `${input.verdict} requires a completed knowledge investigation`, {
      fieldPath: 'queryRefs', expected: 'at least one query from investigate', received: [],
    });
  }
  const unreviewedQueryRefs = queryRefs.filter((ref) => !completedKnowledgeReviews.has(ref));
  if (unreviewedQueryRefs.length) {
    throw contractError('KNOWLEDGE_REVIEW_REQUIRED', `${input.verdict} requires reviewed knowledge queries`, {
      fieldPath: 'queryRefs', expected: 'queryRefs with completed knowledgeReview', received: unreviewedQueryRefs,
    });
  }
  const proposedResult = {
    verdict: input.verdict,
    ...defaults,
    summary: input.summary,
    requirementFindings: findings,
    uncertainties: input.uncertainties || [],
  };
  const conclusionFacts = checkpointFacts(current, findings);
  assertConclusionEligibility(current, input, findings, conclusionFacts, defaults);
  let execution = readJson(path.join(execDir, 'execution.json'), null);
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
  if (execution.phase === 'UNDERSTAND' || (execution.phase === 'CONCLUDE'
    && !hasCurrentStartObservation(current.events, current.understanding.revision, execution.warmSessionGeneration))) {
    changePhase(execDir, 'ESTABLISH_START', '进入可记录检查点结论的执行阶段', {
      implementationSha: execution.implementationSha,
      now: options.now,
    });
    execution = readJson(path.join(execDir, 'execution.json'), null);
  } else if (execution.phase === 'CONCLUDE') {
    changePhase(execDir, 'EXECUTE', '继续提交语义化检查点结论', { implementationSha: execution.implementationSha, now: options.now });
  }
  const turn = {
    schemaVersion: 1,
    turnId: sha256(canonicalJson({ planSha: current.plan.planSha, findings }), 'turn-conclusion', 16),
    facts: conclusionFacts,
  };
  const findingTurn = commitAgentTurn(execDir, turn, options);
  const refreshed = context(execDir);
  const stoppedWithoutObservation = refreshed.events.some((event) => event.type === 'timeLimitReached' && event.observationUnavailable === true);
  const recoveryEvents = refreshed.events.filter((event) => event.type === 'recoveryCompleted');
  const review = defaults.verdictBasis === 'TECHNICAL_CONSTRAINT' && !refreshed.observation && !stoppedWithoutObservation ? null : {
    factId: sha256(canonicalJson({ verdict: input.verdict, planSha: refreshed.plan.planSha, findings }), 'review', 16),
    type: 'verdictReview',
    understandingRevision: refreshed.understanding.revision,
    planRevision: refreshed.plan.revision,
    planSha: refreshed.plan.planSha,
    requirementRefs: refreshed.understanding.requirements.map((entry) => entry.id),
    queryRefs,
    requestedVerdict: input.verdict,
    sourceRecheck: {
      sourceRefs: refreshed.understanding.sourceRefs.map((entry) => entry.id),
      conclusion: input.sourceRecheck || `已按冻结原文复核全部 ${refreshed.understanding.requirements.length} 项要求`,
    },
    currentObservationRefs: refreshed.observation ? [refreshed.observation.ref] : [],
    ...(stoppedWithoutObservation ? { observationUnavailable: true } : {}),
    recoveryAttempt: {
      performed: recoveryEvents.length > 0,
      explanation: input.recoveryExplanation || (recoveryEvents.length
        ? '当前 execution 已完成受控恢复并重新取得现场'
        : '未发现需要额外执行受控恢复的技术异常'),
      evidenceRefs: input.recoveryEvidenceRefs || [],
    },
    remainingUncertainties: input.uncertainties || [],
    reason: input.reason || input.summary,
  };
  const finalized = finalizeWithReview(execDir, proposedResult, review, { reason: input.summary, now: options.now });
  return withRuntimeState(execDir, { ...finalized, findingTurn }, options);
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
  resolvePostActionSettleMs,
  resolveSemanticAction,
  settleStepRecoveryFailure,
  settleStepAtTimeLimit,
  understand,
};
