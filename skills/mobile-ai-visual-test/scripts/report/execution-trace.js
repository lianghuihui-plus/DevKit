'use strict';

const fs = require('fs');
const path = require('path');
const { displayAction } = require('../lib/display-format');
const { classifyActionEffect } = require('../lib/observation-consistency');
const { buildExecutionNarrative } = require('./execution-narrative');

const STATE_CHANGING_ACTIONS = new Set(['tap', 'doubleTap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard']);
const VERDICT_LABELS = Object.freeze({ PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断' });

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
  return event.ok === false
    ? { status: 'FAILED', code: event.code || null, summary: event.message || '设备操作失败' }
    : { status: 'SUCCEEDED', code: null, summary: '设备已完成操作' };
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
  switch (event.type) {
    case 'caseContextRecorded':
      return { ...base, phase: 'UNDERSTAND', category: 'UNDERSTANDING', title: 'Agent 已形成用例理解与初始计划', summary: event.caseContext?.summary || '' };
    case 'agentDecisionRecorded':
      return { ...base, category: 'DECISION', title: event.decision?.purpose || 'Agent 业务决策', summary: event.decision?.conclusion || '', decisionId: event.decisionId, intent: event.decision?.purpose || null, expectedOutcome: event.decision?.expectedOutcome || null };
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

function expectationAssessment(report, action) {
  const refs = action.decision?.expectationRefs || [];
  const sceneRef = action.afterObservation?.sceneId;
  const checks = (report.result?.checks || []).filter((check) => refs.includes(check.expectationRef));
  if (!checks.length) return { status: 'NOT_ASSESSED', summary: '该操作未形成独立的最终检查', basis: '最终检查' };
  const linked = checks.filter((check) => !sceneRef || (check.sceneRefs || []).includes(sceneRef));
  const selected = linked[0] || checks[0];
  const status = selected.status === 'PASS' ? 'MATCHED' : selected.status === 'FAIL' ? 'NOT_MATCHED' : 'UNRESOLVED';
  return { status, summary: selected.actual || '已形成最终检查', basis: linked.length ? '操作后现场与最终检查' : '最终检查' };
}

function buildExecutionTrace(report) {
  const events = Array.isArray(report.events) ? report.events.slice().sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0)) : [];
  const invocations = readJsonl(path.join(report.latest, 'telemetry', 'invocations.jsonl'));
  const invocationStarts = invocations.filter((entry) => entry.phase === 'START');
  const invocationEnds = invocations.filter((entry) => entry.phase === 'END');
  const decisions = new Map(events.filter((event) => event.type === 'agentDecisionRecorded').map((event) => [event.decisionId, event.decision || {}]));
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
        action, decision, outcome, coordinateAudit: sanitizeOperationValue(event.coordinateAudit || null),
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
    action.actionEffect = classifyActionEffect(
      before ? { screenshot: { sha256: before.observation?.sha256 } } : null,
      after ? { screenshot: { sha256: after.observation?.sha256 } } : null,
      action.operationId,
    );
    action.expectationAssessment = expectationAssessment(report, action);
    const followingDecision = entries.find((entry) => entry.sequence > (after?.sequence || action.sequence) && entry.category === 'DECISION');
    action.agentAnalysis = followingDecision
      ? { status: 'EXPLICIT', summary: followingDecision.summary || followingDecision.title, category: 'DECISION' }
      : { status: 'NOT_RECORDED', summary: '没有单独记录后续判断', category: null };
  }

  const screenshots = observations.filter((entry) => entry.artifacts?.screenshot).map((entry, index) => ({
    id: `screenshot-${index + 1}`, index, ref: entry.artifacts.screenshot, operationId: entry.operationId,
    time: entry.time, phase: entry.phase, purpose: entry.observationPurpose, title: entry.title,
  }));
  const screenshotByRef = new Map(screenshots.map((shot) => [shot.ref, shot]));
  for (const entry of observations) entry.screenshot = screenshotByRef.get(entry.artifacts?.screenshot) || null;
  for (const action of actions) {
    action.beforeScreenshot = screenshotByRef.get(action.beforeObservation?.ref) || null;
    action.afterScreenshot = screenshotByRef.get(action.afterObservation?.ref) || null;
    const overlayRef = safeRef(action.coordinateAudit?.overlayRef);
    if (overlayRef && action.beforeScreenshot?.ref) {
      const coordinateScreenshot = {
        id: `coordinate-audit-${action.operationId}`,
        index: screenshots.length,
        ref: overlayRef,
        baseRef: action.beforeScreenshot.ref,
        operationId: action.operationId,
        time: action.time,
        phase: action.phase,
        purpose: 'COORDINATE_AUDIT',
        title: `坐标标记：${action.title}`,
      };
      screenshots.push(coordinateScreenshot);
      action.coordinateScreenshot = coordinateScreenshot;
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
    recoveryAnchor,
    narrative: buildExecutionNarrative(report),
    counts: {
      entries: entries.length, actions: actions.length, observations: observations.length,
      guardRejections: entries.filter((entry) => entry.category === 'GUARD').length,
      protocolAttempts: invocationStarts.length, statusReads: invocationStarts.filter((entry) => entry.operation === 'status').length,
      protocolRejections: invocationEnds.filter((entry) => entry.error === true).length,
      inputEffects: { total: 0, statuses: {}, attempts: 0, settledMs: 0 }, knowledge: entries.filter((entry) => entry.category === 'KNOWLEDGE').length,
      recoveries: entries.filter((entry) => entry.category === 'RECOVERY').length,
    },
    raw: sanitizeOperationValue({ execution: report.execution, result: report.result, metrics: report.metrics, events, invocations }),
  };
}

module.exports = { buildExecutionNarrative, buildExecutionTrace, redactAction, sanitizeOperationValue };
