'use strict';

const fs = require('fs');
const path = require('path');
const { displayAction } = require('../lib/display-format');
const { projectActionSpatialEvidence } = require('../lib/action-spatial-evidence');
const { buildExecutionNarrative } = require('./execution-narrative');
const { assertPlanIntegrity } = require('../case-runtime/plan-service');

const STATE_CHANGING_ACTIONS = new Set(['tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard']);
const VERDICT_LABELS = Object.freeze({ PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断', NOT_RUN: '无法执行' });

function actionLabel(value) {
  const displayed = displayAction(value);
  return displayed && displayed !== value ? displayed : '未知操作';
}

function readJson(file, fallback = null) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  } catch { return []; }
}

function safeRef(value) {
  return typeof value === 'string' && value && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes('..') ? value : null;
}

function redactAction(action) {
  if (!action || typeof action !== 'object') return action || null;
  return action.type === 'inputText' ? { ...action, text: '[已脱敏]' } : { ...action };
}

function sanitizeOperationValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeOperationValue);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = sanitizeOperationValue(item);
  if (copy.type === 'inputText' && Object.prototype.hasOwnProperty.call(copy, 'text')) copy.text = '[已脱敏]';
  if (Object.prototype.hasOwnProperty.call(copy, 'expectedText')) copy.expectedText = '[已脱敏]';
  if (Object.prototype.hasOwnProperty.call(copy, 'actualText')) copy.actualText = '[已脱敏]';
  return copy;
}

function decisionField(event, field) {
  const decision = event?.decision || {};
  const source = event?.decisionFieldSources?.[field];
  if (source === 'AGENT_AUTHORED') return decision[field];
  if (source === 'NOT_PROVIDED') return null;
  const value = decision[field];
  return typeof value === 'string' && value && value !== decision.purpose ? value : null;
}

function projectDecision(event) {
  const decision = event?.decision || {};
  return {
    ...decision,
    assessment: decisionField(event, 'assessment') || '',
    observation: decisionField(event, 'observation') || '',
    conclusion: decisionField(event, 'conclusion') || '',
    expectedOutcome: decisionField(event, 'expectedOutcome') || '',
  };
}

function sceneEntry(report, event, index) {
  const scene = readJson(path.join(report.latest, 'scenes', `${event.sceneId}.json`), null);
  const screenshot = safeRef(event.screenshotRef || scene?.screenshot?.ref);
  return {
    sequence: index + 1,
    time: event.time || '',
    durationMs: null,
    phase: event.purpose === 'RECOVERY_AFTER' ? 'RECOVERY' : 'EXECUTE',
    category: 'OBSERVATION',
    operationId: event.operationId || null,
    sceneId: event.sceneId,
    decisionId: event.decisionId || null,
    title: `观察现场：${event.purpose || 'CURRENT_SCENE'}`,
    intent: null,
    expectedOutcome: null,
    summary: screenshot ? '已取得当前页面现场' : '当前现场缺少截图',
    observationPurpose: event.purpose || 'CURRENT_SCENE',
    relatedOperationId: event.relatedOperationId || null,
    captureMode: event.captureMode || scene?.captureMode || 'FULL_SCENE',
    promoted: event.promoted !== false,
    planId: event.planId || scene?.source?.planId || null,
    stepId: event.stepId || scene?.source?.stepId || null,
    outcome: { status: screenshot ? 'SUCCEEDED' : 'FAILED', code: screenshot ? null : 'SCREENSHOT_MISSING', summary: screenshot ? '截图可用于当前执行' : '截图不可用于业务判断' },
    observation: {
      ref: screenshot,
      sha256: event.screenshotSha256 || scene?.screenshot?.sha256 || null,
      usable: Boolean(screenshot),
      app: event.app || scene?.app || null,
      technicalSignals: event.technicalSignals || scene?.technicalSignals || null,
    },
    artifacts: { screenshot, layout: safeRef(event.layoutRef || scene?.layoutRef), logs: [] },
    raw: sanitizeOperationValue(event),
  };
}

function actionOutcome(event) {
  if (event.type === 'actionOutcomeUnknown') {
    return { status: 'UNCERTAIN', code: event.code || null, summary: event.message || '动作结果未知，已转为现场观察' };
  }
  if (event.command?.status === 'REJECTED') {
    return { status: 'FAILED', code: event.command.failureCode || null, summary: event.command.message || '设备命令被拒绝' };
  }
  if (event.deviceExecution?.status === 'FAILED') {
    return { status: 'FAILED', code: event.deviceExecution.failureCode || null, summary: event.deviceExecution.message || '设备操作效果已确认不符合请求' };
  }
  if (!event.command) return { status: 'UNCERTAIN', code: null, summary: '动作结果缺少分层执行事实' };
  const device = event.deviceExecution?.status || 'UNVERIFIED';
  return {
    status: 'OBSERVED',
    code: null,
    summary: `命令${event.command.status === 'ACCEPTED' ? '已接受' : '状态未知'}；设备执行${device === 'VERIFIED' ? '已验证' : device === 'NOT_EXECUTED' ? '未执行' : '未验证'}`,
  };
}

function planEventEntry(event, index) {
  const base = {
    sequence: index + 1, time: event.time || '', durationMs: event.durationMs ?? event.elapsedMs ?? null,
    phase: 'EXECUTE', category: 'PLAN', operationId: null, planId: event.planId || null,
    stepId: event.stepId || null, raw: sanitizeOperationValue(event),
  };
  if (event.type === 'planRequested') {
    return { ...base, title: `Runtime 命令计划 ${event.planId}`, summary: '已接受并开始顺序执行', outcome: { status: 'RUNNING', code: null, summary: '计划执行中' } };
  }
  if (event.type === 'planStepStarted') {
    return { ...base, title: `计划步骤 ${event.stepId}`, summary: `${event.stepType || 'unknown'} 已开始`, outcome: { status: 'RUNNING', code: null, summary: '步骤执行中' } };
  }
  if (event.type === 'planStepCompleted') {
    return { ...base, title: `计划步骤 ${event.stepId}`, summary: `${event.stepType || 'unknown'} · ${event.durationMs || 0}ms`, outcome: { status: 'SUCCEEDED', code: null, summary: '技术步骤已完成' } };
  }
  if (event.type === 'planStepFailed') {
    return { ...base, title: `计划步骤 ${event.stepId}`, summary: event.error?.message || '技术步骤失败', outcome: { status: 'FAILED', code: event.error?.code || 'PLAN_STEP_FAILED', summary: event.error?.message || '' } };
  }
  if (event.type === 'planCompleted') {
    return { ...base, title: `Runtime 命令计划 ${event.planId}`, summary: event.status || 'PLAN_COMPLETED', outcome: { status: 'SUCCEEDED', code: null, summary: '计划执行完成' } };
  }
  return { ...base, title: `Runtime 命令计划 ${event.planId}`, summary: event.failure?.message || event.status || 'PLAN_INTERRUPTED', outcome: { status: 'FAILED', code: event.failure?.code || event.status || 'PLAN_INTERRUPTED', summary: event.failure?.message || '计划未完整执行' } };
}

function retrySafety(action, outcome) {
  if (!action) return null;
  if (action.type === 'wait') return { status: 'SAFE', reason: '等待不会改变业务数据' };
  if (outcome.status === 'UNCERTAIN' || action.type === 'inputText') {
    return { status: 'OBSERVE_FIRST', reason: '结果不确定或输入可能已经生效，重试前先观察现场' };
  }
  return { status: 'AGENT_DECIDES', reason: '根据动作后现场决定是否继续' };
}

function eventEntry(event, index) {
  const base = { sequence: index + 1, time: event.time || '', durationMs: null, phase: 'EXECUTE', operationId: event.operationId || null, raw: sanitizeOperationValue(event) };
  if (['planRequested', 'planStepStarted', 'planStepCompleted', 'planStepFailed', 'planCompleted', 'planInterrupted'].includes(event.type)) {
    return planEventEntry(event, index);
  }
  switch (event.type) {
    case 'caseFlowRevised':
      return { ...base, phase: 'UNDERSTAND', category: 'UNDERSTANDING', title: event.revision === 1 ? 'Agent 已形成 Case Flow' : 'Agent 已修订 Case Flow', summary: event.summary || '', caseFlowRevision: event.revision, reason: event.reason || '' };
    case 'agentDecisionRecorded':
      return { ...base, category: 'DECISION', title: event.decision?.purpose || 'Agent 业务决策', summary: decisionField(event, 'conclusion') || '', decisionId: event.decisionId, intent: event.decision?.purpose || null, expectedOutcome: decisionField(event, 'expectedOutcome') || null };
    case 'flowContextRecorded':
      return { ...base, category: 'FLOW', title: `关联 Case Flow 节点 ${event.nodeRef}`, summary: event.selectedEdgeRef ? `选择分支 ${event.selectedEdgeRef}` : '记录当前处理节点', decisionId: event.decisionId || null, caseFlowRevision: event.caseFlowRevision || null, flowContext: { nodeRef: event.nodeRef, selectedEdgeRef: event.selectedEdgeRef || null } };
    case 'knowledgeQueried':
      return { ...base, phase: 'INVESTIGATE', category: 'KNOWLEDGE', title: '查询本地知识', summary: `${event.candidateCount || 0} 个候选`, query: event.query, candidates: event.candidates || [], filterDiagnostics: event.filterDiagnostics || null };
    case 'knowledgeReviewed':
      return {
        ...base,
        phase: 'INVESTIGATE',
        category: 'KNOWLEDGE',
        title: '复核知识候选',
        summary: `${event.conclusion || '未形成结论'} · ${(event.assessments || []).length} 个评估`,
        queryId: event.queryId,
        assessments: event.assessments || [],
      };
    case 'appRecovered':
      return { ...base, phase: 'RECOVERY', category: 'RECOVERY', title: 'App 已恢复', summary: event.reason || '已取得恢复后现场', outcome: { status: 'SUCCEEDED', code: null, summary: event.reason || '恢复成功' } };
    case 'appPreparationRequested':
      return { ...base, phase: 'PREPARE', category: 'PREPARATION', title: '请求建立 App 初始状态', summary: event.targetState || '', outcome: { status: 'OBSERVED', code: null, summary: 'Runtime 已接受语义化初始状态目标' } };
    case 'appPreparationCompleted':
      return { ...base, phase: 'PREPARE', category: 'PREPARATION', title: 'App 初始状态已建立', summary: `${event.targetState || ''}${event.strategy ? ` · ${event.strategy}` : ''}`, outcome: { status: 'SUCCEEDED', code: null, summary: `暖会话已轮换至 ${event.sessionId || '新会话'}` } };
    case 'appPreparationFailed':
    case 'appPreparationOutcomeUnknown':
      return { ...base, phase: 'PREPARE', category: 'PREPARATION', title: 'App 初始状态未建立', summary: event.message || event.code || '', outcome: { status: event.type === 'appPreparationOutcomeUnknown' ? 'UNCERTAIN' : 'FAILED', code: event.internalCode || event.code || null, summary: event.message || '' } };
    case 'recoveryFailed':
    case 'recoveryOutcomeUnknown':
      return { ...base, phase: 'RECOVERY', category: 'RECOVERY', title: 'App 恢复未完成', summary: event.message || event.reason || '', outcome: { status: event.type === 'recoveryFailed' ? 'FAILED' : 'UNCERTAIN', code: event.code || null, summary: event.message || event.reason || '' } };
    case 'narrativeGap':
      return { ...base, category: 'GUARD', title: '执行记录不完整', summary: event.message || '缺少业务叙事', outcome: { status: 'REJECTED', code: event.code || null, summary: event.message || '' } };
    case 'technicalIssue':
      return { ...base, category: 'GUARD', title: '运行时技术状态', summary: event.message || event.code || '', outcome: { status: 'FAILED', code: event.code || null, summary: event.message || '' } };
    case 'caseFinished':
      return { ...base, phase: 'CONCLUDE', category: 'RESULT', title: `最终结论：${VERDICT_LABELS[event.verdict] || event.verdict || '未知'}`, summary: '' };
    default:
      return null;
  }
}

function projectPlans(report, events) {
  const terminal = new Map(events.filter((event) => ['planCompleted', 'planInterrupted'].includes(event.type))
    .map((event) => [event.planId, event]));
  const requested = events.filter((event) => event.type === 'planRequested');
  return requested.map((event) => {
    const ref = safeRef(event.planRecordRef || terminal.get(event.planId)?.planRecordRef);
    const record = ref ? readJson(path.join(report.latest, ref), null) : null;
    if (!record) {
      return {
        planId: event.planId, status: terminal.get(event.planId)?.status || 'PLAN_INTERRUPTED',
        planRecordRef: ref, steps: [], evidence: null, technicalFacts: [],
        integrity: { status: 'INVALID', code: 'PLAN_RECORD_INCOMPLETE' },
      };
    }
    let integrity = { status: 'VALID', recordSha256: record.integrity?.recordSha256 || null };
    try {
      assertPlanIntegrity(record);
    } catch (error) {
      integrity = { status: 'INVALID', code: error.code || 'PLAN_RECORD_INCOMPLETE', message: error.message };
    }
    const steps = (record.steps || []).map((step) => {
      const factRef = (step.outputRefs || []).map(safeRef)
        .find((ref) => ref?.startsWith('operations/plan-evidence/check-')) || safeRef(step.technicalFactRef);
      return {
        ...sanitizeOperationValue(step),
        technicalFact: factRef ? sanitizeOperationValue(readJson(path.join(report.latest, factRef), null)) : null,
      };
    });
    const durationFor = (type) => steps.filter((step) => step.type === type)
      .reduce((sum, step) => sum + Math.max(0, Number(step.durationMs) || 0), 0);
    return sanitizeOperationValue({
      planId: record.planId,
      purpose: record.purpose || '',
      status: record.status,
      planRecordRef: ref,
      startedAt: record.startedAt || null,
      endedAt: record.endedAt || null,
      elapsedMs: record.elapsedMs || 0,
      remainingMs: record.remainingMs || 0,
      steps,
      evidence: record.evidence || null,
      technicalFacts: record.technicalFacts || [],
      timing: {
        actionMs: durationFor('act'), waitMs: durationFor('wait'), captureMs: durationFor('capture'),
        locateMs: durationFor('locate'), checkMs: durationFor('check'),
      },
      failure: record.failure || null,
      integrity,
    });
  });
}

function expectationAssessment(report, action) {
  const refs = action.decision?.expectationRefs || [];
  if (!refs.length) return { status: 'NOT_TARGETED', summary: '该操作未直接推进验证点', basis: '当时关联目标' };
  return { status: 'TARGETED', summary: refs.join(' · '), basis: '当时关联目标' };
}

function buildExecutionTrace(report) {
  const events = Array.isArray(report.events) ? report.events.slice().sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0)) : [];
  const invocations = readJsonl(path.join(report.latest, 'telemetry', 'invocations.jsonl'));
  const invocationStarts = invocations.filter((entry) => entry.phase === 'START');
  const invocationEnds = invocations.filter((entry) => entry.phase === 'END');
  const decisions = new Map(events.filter((event) => event.type === 'agentDecisionRecorded').map((event) => [event.decisionId, projectDecision(event)]));
  const requested = new Map(events.filter((event) => event.type === 'actionRequested').map((event) => [event.operationId, event]));
  const entries = [];

  for (const [index, event] of events.entries()) {
    if (event.type === 'sceneObserved') {
      entries.push(sceneEntry(report, event, index));
      continue;
    }
    if (event.type === 'actionCompleted' || event.type === 'actionOutcomeUnknown') {
      const request = requested.get(event.operationId) || {};
      const decision = decisions.get(event.decisionId || request.decisionId) || {};
      const action = redactAction(event.action || request.action);
      const outcome = actionOutcome(event);
      entries.push({
        sequence: index + 1, time: event.time || '', durationMs: null, phase: 'EXECUTE', category: 'ACTION',
        operationId: event.operationId, sceneId: event.sceneId || request.sceneId || null, decisionId: event.decisionId || request.decisionId || null,
        title: decision.purpose || request.intent || actionLabel(action?.type), intent: decision.purpose || request.intent || null,
        expectedOutcome: decision.expectedOutcome || request.expectedOutcome || null, summary: outcome.summary,
        action, decision, outcome,
        evidence: sanitizeOperationValue(event.evidence || null),
        spatialEvidence: event.spatialEvidenceRef
          ? sanitizeOperationValue(projectActionSpatialEvidence(report.latest, event.spatialEvidenceRef, {
            operationId: event.operationId,
            actionType: action?.type,
          }))
          : null,
        retrySafety: retrySafety(action, outcome), raw: sanitizeOperationValue({ event, request, decision }),
      });
      continue;
    }
    if (['executionStarted', 'actionRequested'].includes(event.type)) continue;
    const entry = eventEntry(event, index);
    if (entry) entries.push(entry);
  }

  for (const attempt of invocationEnds.filter((item) => item.error === true)) {
    entries.push({
      sequence: entries.length + events.length + 1, time: attempt.at || '', durationMs: attempt.durationMs ?? null,
      phase: 'FRAMEWORK_CHECK', category: 'PROTOCOL', operationId: null, title: 'Runtime 请求未通过',
      summary: attempt.message || attempt.code || '请求不符合当前契约',
      outcome: { status: 'REJECTED', code: attempt.code || null, summary: attempt.message || '' }, raw: sanitizeOperationValue(attempt),
    });
  }

  entries.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  entries.forEach((entry, index) => { entry.sequence = index + 1; });
  const observations = entries.filter((entry) => entry.category === 'OBSERVATION');
  const actions = entries.filter((entry) => entry.category === 'ACTION');
  const observationByScene = new Map(observations.map((entry) => [entry.sceneId, entry]));
  const postObservationByOperation = new Map(observations.filter((entry) => entry.relatedOperationId).map((entry) => [entry.relatedOperationId, entry]));

  for (const action of actions) {
    const before = observationByScene.get(action.sceneId) || null;
    const after = postObservationByOperation.get(action.operationId) || null;
    action.beforeObservationEntry = before;
    action.afterObservationEntry = after;
    action.beforeObservation = before?.observation || null;
    action.afterObservation = after?.observation ? { ...after.observation, sceneId: after.sceneId } : null;
    action.postActionArtifacts = after?.artifacts || null;
    action.evidence = {
      ...(action.evidence || {}),
      sceneRefs: {
        before: action.evidence?.sceneRefs?.before || before?.sceneId || null,
        after: action.evidence?.sceneRefs?.after || after?.sceneId || null,
      },
      screenshotRefs: action.evidence?.screenshotRefs || [before?.artifacts?.screenshot, after?.artifacts?.screenshot].filter(Boolean),
    };
    action.expectationAssessment = expectationAssessment(report, action);
    const followingDecision = entries.find((entry) => entry.sequence > (after?.sequence || action.sequence) && entry.category === 'DECISION');
    action.agentAnalysis = followingDecision
      ? { status: 'EXPLICIT', summary: followingDecision.summary || followingDecision.title, category: 'DECISION' }
      : { status: 'NOT_RECORDED', summary: '没有单独记录后续判断', category: null };
  }

  const screenshots = observations.filter((entry) => entry.artifacts?.screenshot).map((entry, index) => ({
    id: `screenshot-${index + 1}`, index, ref: entry.artifacts.screenshot, operationId: entry.operationId,
    time: entry.time, phase: entry.phase, purpose: entry.observationPurpose, title: entry.title,
    captureMode: entry.captureMode, promoted: entry.promoted, planId: entry.planId, stepId: entry.stepId,
  }));
  const screenshotByRef = new Map(screenshots.map((shot) => [shot.ref, shot]));
  for (const entry of observations) entry.screenshot = screenshotByRef.get(entry.artifacts?.screenshot) || null;
  for (const action of actions) {
    action.beforeScreenshot = screenshotByRef.get(action.beforeObservation?.ref) || null;
    action.afterScreenshot = screenshotByRef.get(action.afterObservation?.ref) || null;
    const annotatedRef = safeRef(action.spatialEvidence?.annotatedScreenshot?.ref);
    if (annotatedRef && action.spatialEvidence?.annotatedScreenshot) {
      const spatialScreenshot = {
        id: `action-spatial-evidence-${action.operationId}`,
        index: screenshots.length,
        ref: annotatedRef,
        operationId: action.operationId,
        time: action.time,
        phase: action.phase,
        purpose: 'ACTION_SPATIAL_EVIDENCE',
        title: `动作落点：${action.title}`,
      };
      screenshots.push(spatialScreenshot);
      action.spatialEvidenceScreenshot = spatialScreenshot;
    }
  }

  const lastTrustedObservation = [...observations].reverse().find((entry) => entry.observation?.usable) || null;
  const lastAction = actions.at(-1) || null;
  const pendingAction = [...actions].reverse().find((entry) => STATE_CHANGING_ACTIONS.has(entry.action?.type) && !entry.afterObservation) || null;
  const lastKnowledge = [...entries].reverse().find((entry) => entry.category === 'KNOWLEDGE') || null;
  const recoveryAnchor = {
    lastTrustedScreenshot: lastTrustedObservation?.screenshot || null,
    phase: report.execution?.finalized ? 'FINALIZED' : entries.at(-1)?.phase || null,
    lastCompletedOperation: lastAction ? { operationId: lastAction.operationId, title: lastAction.title, outcome: lastAction.outcome } : null,
    pendingOrUncertainOperation: pendingAction || (lastAction?.outcome?.status === 'UNCERTAIN' ? lastAction : null),
    warmSessionGenerationStart: report.metrics?.warmSessionGenerationStart ?? report.execution?.warmSessionGenerationStart ?? null,
    warmSessionGenerationEnd: report.metrics?.warmSessionGenerationEnd ?? report.execution?.warmSessionGeneration ?? null,
    warmSessionIdStart: report.metrics?.warmSessionIdStart ?? report.execution?.warmSessionIdStart ?? null,
    warmSessionIdEnd: report.metrics?.warmSessionIdEnd ?? report.execution?.warmSessionId ?? null,
    warmSessionEpochStart: report.metrics?.warmSessionEpochStart ?? report.execution?.warmSessionEpochStart ?? null,
    warmSessionEpochEnd: report.metrics?.warmSessionEpochEnd ?? report.execution?.warmSessionEpoch ?? null,
    appPreparation: report.metrics?.appPreparation || null,
    executionRecoveryCount: report.metrics?.executionRecoveryCount ?? report.execution?.executionRecoveryCount ?? 0,
    batchRecoveryCountAtStart: report.metrics?.batchRecoveryCountAtStart ?? report.execution?.batchRecoveryCountAtStart ?? 0,
    batchRecoveryCountAtEnd: report.metrics?.batchRecoveryCountAtEnd ?? report.execution?.batchRecoveryCountAtEnd ?? 0,
    lastKnowledgeInvestigation: lastKnowledge ? { title: lastKnowledge.title, summary: lastKnowledge.summary } : null,
    remainingUncertainties: report.result?.uncertainties || report.display?.uncertainties || [],
  };

  return {
    entries,
    pathEntries: entries.filter((entry) => entry.category !== 'RESULT' && !(entry.category === 'OBSERVATION' && entry.relatedOperationId)),
    screenshots,
    plans: projectPlans(report, events),
    recoveryAnchor,
    narrative: buildExecutionNarrative(report),
    counts: {
      entries: entries.length, actions: actions.length, observations: observations.length,
      guardRejections: entries.filter((entry) => entry.category === 'GUARD').length,
      protocolAttempts: invocationStarts.length, statusReads: invocationStarts.filter((entry) => entry.operation === 'status').length,
      protocolRejections: invocationEnds.filter((entry) => entry.error === true).length,
      inputEffects: { total: 0, statuses: {}, attempts: 0, settledMs: 0 }, knowledge: entries.filter((entry) => entry.category === 'KNOWLEDGE').length,
      recoveries: entries.filter((entry) => entry.category === 'RECOVERY').length,
      preparations: entries.filter((entry) => entry.category === 'PREPARATION' && entry.outcome?.status === 'SUCCEEDED').length,
    },
    raw: sanitizeOperationValue({ execution: report.execution, result: report.result, metrics: report.metrics, events, invocations }),
  };
}

module.exports = { buildExecutionNarrative, buildExecutionTrace, redactAction, sanitizeOperationValue };
