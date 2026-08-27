'use strict';

const fs = require('fs');
const path = require('path');
const { displayAction } = require('../lib/display-format');
const { inputEffectMetrics, readAgentAttempts } = require('../lib/execution-time-limit');
const { deriveCheckpointProgress } = require('../lib/checkpoint-progress');

const STATE_CHANGING_ACTIONS = new Set(['tap', 'toggle', 'longPress', 'inputText', 'swipe', 'back', 'home', 'dismissKeyboard']);
const PHASE_LABELS = Object.freeze({ UNDERSTAND: '理解用例', ESTABLISH_START: '建立起点', EXECUTE: '执行与检查', INVESTIGATE: '调查异常', RECOVERY: '恢复现场', CONCLUDE: '形成结论', FINALIZED: '执行完成', UNKNOWN: '未归类' });
const VERDICT_LABELS = Object.freeze({ PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断' });
const KNOWLEDGE_ASSESSMENT_LABELS = Object.freeze({ APPLICABLE: '适用', NOT_APPLICABLE: '不适用', CONFLICTING: '存在冲突', INSUFFICIENT: '依据不足' });
const RECOVERY_STATUS_LABELS = Object.freeze({ SUCCEEDED: '成功', FAILED: '失败', STARTED: '进行中', UNKNOWN: '未知' });

function actionLabel(value) {
  const displayed = displayAction(value);
  return displayed && displayed !== value ? displayed : '未知操作';
}

function readJson(file, fallback = null) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [];
  } catch {
    return [];
  }
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
  return copy;
}

function operationRecords(execDir) {
  const agentDir = path.join(execDir || '', 'agent');
  if (!execDir || !fs.existsSync(agentDir)) return new Map();
  const records = new Map();
  for (const name of fs.readdirSync(agentDir).filter((item) => /^operation-.+\.json$/.test(item) && !item.endsWith('.draft.json'))) {
    const record = readJson(path.join(agentDir, name), null);
    const operationId = record?.request?.operationId;
    if (operationId) records.set(operationId, record);
  }
  return records;
}

function executionRecoveries(report) {
  const timelineRecoveries = (report.events || []).filter((event) => event.type === 'recoveryCompleted');
  if (timelineRecoveries.length) return timelineRecoveries;
  const execDir = report.latest;
  const executionId = report.execution?.executionId;
  const batchId = report.execution?.batchId;
  if (!execDir || !executionId || !batchId) return [];
  let workspace = path.resolve(execDir);
  for (let index = 0; index < 6; index += 1) workspace = path.dirname(workspace);
  return readJsonl(path.join(workspace, 'runs', batchId, 'events.jsonl'))
    .filter((event) => event.type === 'appRecovery' && event.executionId === executionId);
}

function durationMs(start, end) {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function operationArtifacts(event, record) {
  const adapter = record?.deviceResult || {};
  const artifacts = event.artifacts || adapter.artifacts || {};
  return {
    screenshot: safeRef(artifacts.screenshot || event.ref),
    layout: safeRef(artifacts.layout),
    logs: Array.isArray(artifacts.logs) ? artifacts.logs.map(safeRef).filter(Boolean) : [],
  };
}

function actionOutcome(event, completed, record) {
  if (record?.error?.code === 'DEVICE_ACTION_OUTCOME_UNCERTAIN') {
    return { status: 'UNCERTAIN', code: record.error.code, summary: record.error.message };
  }
  if (event) {
    return {
      status: event.ok ? 'SUCCEEDED' : 'FAILED',
      code: event.deviceResult?.failureCode || null,
      summary: event.ok ? '设备已接受并完成操作' : (event.deviceResult?.reason || event.deviceResult?.message || '设备操作失败'),
    };
  }
  if (completed?.outcome === 'FAILED') {
    return { status: completed.failureCode === 'DEVICE_ACTION_OUTCOME_UNCERTAIN' ? 'UNCERTAIN' : 'FAILED', code: completed.failureCode || null, summary: completed.reason || '设备操作未完成' };
  }
  return { status: completed?.outcome || 'UNKNOWN', code: null, summary: '未找到结构化操作结果' };
}

function retrySafety(action, authorization, outcome) {
  if (!action) return { status: 'UNKNOWN', reason: '没有动作请求数据' };
  if (action.type === 'wait') return { status: 'SAFE', reason: '等待不会改变业务数据' };
  if (outcome.status === 'UNCERTAIN' || action.type === 'inputText') {
    return { status: 'OBSERVE_FIRST', reason: '结果不确定或输入可能已经生效，重试前必须先观察现场' };
  }
  return { status: 'AGENT_DECIDES', reason: '根据动作后观察和当前检查点决定是否重试' };
}

function phaseTitle(event) {
  return `${PHASE_LABELS[event.from] || '未归类'} -> ${PHASE_LABELS[event.to] || '未归类'}`;
}

function checkpointBinding(entry, latestRevision) {
  const checkpointId = entry.authorization?.checkpointId || entry.checkpointId || null;
  if (!checkpointId) return null;
  return {
    checkpointId,
    planRevision: entry.authorization?.planRevision || entry.planRevision || latestRevision || null,
  };
}

function buildExecutionNarrative(report, entries) {
  const plan = report.plan || null;
  const latestRevision = plan?.revision || null;
  const requirements = new Map((report.understanding?.requirements || []).map((item) => [item.id, item]));
  const requirementFindings = new Map((report.result?.requirementFindings || []).map((item) => [item.requirementId, item]));
  const checkpoints = [];
  const checkpointByKey = new Map();
  const currentCheckpointById = new Map();

  function addCheckpoint(checkpoint, planRevision, current, order) {
    const key = `${planRevision ?? 'unknown'}:${checkpoint.id}`;
    if (checkpointByKey.has(key)) return checkpointByKey.get(key);
    const item = {
      id: checkpoint.id,
      planRevision,
      current,
      order,
      goal: checkpoint.goal || '已从当前计划移除的检查点',
      status: null,
      requiredAction: checkpoint.requiredAction ?? null,
      requirementRefs: checkpoint.requirementRefs || [],
      requirements: (checkpoint.requirementRefs || []).map((ref) => requirements.get(ref)).filter(Boolean),
      requirementFindings: (checkpoint.requirementRefs || []).map((ref) => requirementFindings.get(ref)).filter(Boolean),
      entries: [],
      actions: [],
      observations: [],
      findings: [],
      knowledge: [],
      firstTime: null,
      lastTime: null,
      recordPlanRevisions: [],
    };
    checkpointByKey.set(key, item);
    if (current) currentCheckpointById.set(checkpoint.id, item);
    checkpoints.push(item);
    return item;
  }

  for (const [index, checkpoint] of (plan?.checkpoints || []).entries()) {
    addCheckpoint(checkpoint, latestRevision, true, index + 1);
  }

  const startPreparation = [];
  const investigation = [];
  for (const entry of entries) {
    const binding = checkpointBinding(entry, latestRevision);
    if (binding) {
      const key = `${binding.planRevision ?? 'unknown'}:${binding.checkpointId}`;
      const checkpoint = currentCheckpointById.get(binding.checkpointId)
        || checkpointByKey.get(key)
        || addCheckpoint({ id: binding.checkpointId }, binding.planRevision, false, checkpoints.length + 1);
      if (binding.planRevision !== null && !checkpoint.recordPlanRevisions.includes(binding.planRevision)) {
        checkpoint.recordPlanRevisions.push(binding.planRevision);
        checkpoint.recordPlanRevisions.sort((left, right) => left - right);
      }
      checkpoint.entries.push(entry);
      if (entry.category === 'ACTION') checkpoint.actions.push(entry);
      if (entry.category === 'OBSERVATION') checkpoint.observations.push(entry);
      if (entry.category === 'CHECKPOINT') checkpoint.findings.push(entry);
      if (entry.category === 'KNOWLEDGE') checkpoint.knowledge.push(entry);
      checkpoint.firstTime ||= entry.time || null;
      checkpoint.lastTime = entry.time || checkpoint.lastTime;
    }
    if (entry.authorization?.phase === 'case-prepare' || entry.raw?.event?.scope === 'case-prepare') startPreparation.push(entry);
    if (entry.phase === 'INVESTIGATE' || ['KNOWLEDGE', 'REVIEW', 'RECOVERY'].includes(entry.category)) investigation.push(entry);
  }

  const progress = new Map(deriveCheckpointProgress(plan, report.events, report.result, {
    warmSessionGeneration: report.execution?.warmSessionGeneration,
  })
    .map((entry) => [entry.checkpointId, entry]));
  for (const checkpoint of checkpoints) {
    const currentProgress = checkpoint.current ? progress.get(checkpoint.id) : null;
    checkpoint.executionStatus = currentProgress?.status || (checkpoint.entries.length ? 'SUPERSEDED' : 'SUPERSEDED');
    checkpoint.progress = currentProgress;
  }

  return {
    source: { text: report.sourceText || '', refs: report.understanding?.sourceRefs || [] },
    understanding: report.understanding || null,
    latestPlan: plan,
    startPreparation,
    checkpoints,
    investigation,
    conclusion: {
      display: report.display || null,
      result: report.result || null,
      reviews: entries.filter((entry) => entry.category === 'REVIEW'),
    },
  };
}

function plainEntry(event, index) {
  const base = { sequence: index + 1, time: event.time || '', durationMs: null, phase: event.phase || 'UNKNOWN', operationId: null, raw: sanitizeOperationValue(event) };
  switch (event.type) {
    case 'phaseChanged': return { ...base, category: 'PHASE', title: phaseTitle(event), summary: event.reason };
    case 'caseUnderstood': return { ...base, category: 'UNDERSTANDING', title: `用例理解版本 ${event.understandingRevision}`, summary: `已关联 ${event.sourceRefs?.length || 0} 项原文引用` };
    case 'planRevised': return { ...base, category: 'PLAN', title: `计划版本 ${event.planRevision}`, summary: event.reason, planRevision: event.planRevision };
    case 'startEstablished': return { ...base, category: 'DECISION', title: '用例起点已确认', summary: event.reason, evidenceRefs: [event.observationRef] };
    case 'checkpointFinding': return { ...base, category: 'CHECKPOINT', title: `检查点 ${event.checkpointId}`, summary: event.finding, checkpointId: event.checkpointId, planRevision: event.planRevision, evidenceRefs: event.evidenceRefs || [] };
    case 'reflection': return { ...base, category: 'DECISION', title: 'Agent 决策记录', summary: event.reason };
    case 'knowledgeQuery': return { ...base, category: 'KNOWLEDGE', title: `知识查询 ${event.queryId}`, summary: `${event.matchCount} 个候选`, query: event.query, candidates: event.candidates || [] };
    case 'knowledgeAssessment': return { ...base, category: 'KNOWLEDGE', title: `知识评估：${KNOWLEDGE_ASSESSMENT_LABELS[event.assessment] || '未知评估'}`, summary: event.reason, knowledgeRef: event.knowledgeRef, entryId: event.entryId };
    case 'knowledgeReview': return { ...base, category: 'KNOWLEDGE', title: '知识调查已收口', summary: event.reason, queryId: event.queryId, conclusion: event.conclusion };
    case 'verdictReview': return { ...base, category: 'REVIEW', title: `结论复核：${VERDICT_LABELS[event.requestedVerdict] || '未知结论'}`, summary: event.reason, review: sanitizeOperationValue(event) };
    case 'result': return { ...base, category: 'RESULT', title: `最终结论：${VERDICT_LABELS[event.verdict] || '未知结论'}`, summary: '' };
    default: return null;
  }
}

function buildExecutionTrace(report) {
  const events = Array.isArray(report.events) ? report.events : [];
  const records = operationRecords(report.latest);
  const attempts = readAgentAttempts(report.latest, report.result?.endedAt || report.execution?.endedAt || new Date().toISOString());
  const started = new Map(events.filter((event) => event.type === 'operationStarted').map((event) => [event.operationId, event]));
  const completed = new Map(events.filter((event) => event.type === 'operationCompleted').map((event) => [event.operationId, event]));
  const entries = [];
  const operationEntries = new Map();

  for (const [eventIndex, event] of events.entries()) {
    if (event.type === 'operationStarted' || event.type === 'operationCompleted') continue;
    if (event.type === 'operationRejected') {
      entries.push({
        sequence: eventIndex + 1, time: event.time || '', durationMs: 0, phase: event.phase, category: 'GUARD',
        operationId: event.operationId, title: `守卫拒绝${event.actionType ? `：${actionLabel(event.actionType)}` : ''}`,
        summary: event.reason, outcome: { status: 'REJECTED', code: event.failureCode, summary: event.reason },
        relatedOperationId: event.relatedOperationId || null, raw: sanitizeOperationValue(event),
      });
      continue;
    }
    if (event.type === 'observation') {
      const record = records.get(event.operationId);
      const request = record?.request || {};
      const artifacts = operationArtifacts(event, record);
      const begin = started.get(event.operationId);
      const finish = completed.get(event.operationId);
      const entry = {
        sequence: eventIndex + 1, time: event.time || begin?.time || '', durationMs: durationMs(begin?.time, finish?.time),
        phase: event.phase, category: 'OBSERVATION', operationId: event.operationId,
        title: request.intent || event.intent || `观察现场：${event.observationPurpose || 'AGENT_DECIDED'}`,
        intent: request.intent || event.intent || request.authorization?.purpose || event.authorization?.purpose || null,
        expectedOutcome: request.expectedOutcome || event.expectedOutcome || null,
        summary: event.usable ? '已取得可用现场证据' : '已取得现场，但目标 App 状态不可用',
        authorization: request.authorization || event.authorization || null,
        observationPurpose: event.observationPurpose || request.purpose || 'AGENT_DECIDED',
        relatedOperationId: event.relatedOperationId || request.relatedOperationId || null,
        outcome: { status: event.usable ? 'SUCCEEDED' : 'FAILED', code: event.usable ? null : 'OBSERVATION_NOT_USABLE', summary: event.usable ? '截图可用于当前执行' : '截图不可作为业务结论证据' },
        observation: { ref: event.ref, sha256: event.sha256, usable: event.usable, app: event.app || record?.deviceResult?.app || null, device: event.device || record?.deviceResult?.device || null },
        artifacts, raw: sanitizeOperationValue({ event, request, deviceResult: record?.deviceResult || null }),
      };
      entries.push(entry);
      operationEntries.set(event.operationId, entry);
      continue;
    }
    if (event.type === 'actionResult') {
      const record = records.get(event.operationId);
      const request = record?.request || {};
      const action = redactAction(event.requestedAction || request.action);
      const finish = completed.get(event.operationId);
      const begin = started.get(event.operationId);
      const outcome = actionOutcome(event, finish, record);
      const authorization = request.authorization || event.authorization || null;
      const entry = {
        sequence: eventIndex + 1, time: event.time || begin?.time || '', durationMs: durationMs(begin?.time, finish?.time),
        phase: event.phase, category: 'ACTION', operationId: event.operationId,
        title: request.intent || event.intent || `${actionLabel(action?.type)}${action?.target ? `：${action.target}` : ''}`,
        intent: request.intent || event.intent || authorization?.purpose || null,
        expectedOutcome: request.expectedOutcome || event.expectedOutcome || null,
        summary: outcome.summary, authorization, action, outcome,
        retrySafety: retrySafety(action, authorization, outcome),
        raw: sanitizeOperationValue({ event, request, deviceResult: record?.deviceResult || event.deviceResult || null }),
      };
      entries.push(entry);
      operationEntries.set(event.operationId, entry);
      continue;
    }
    const entry = plainEntry(event, eventIndex);
    if (entry) entries.push(entry);
  }

  for (const [operationId, record] of records) {
    if (operationEntries.has(operationId) || !record.error) continue;
    const begin = started.get(operationId);
    const finish = completed.get(operationId);
    const action = redactAction(record.request?.action);
    const outcome = actionOutcome(null, finish, record);
    entries.push({
      sequence: events.indexOf(begin) + 1, time: begin?.time || '', durationMs: durationMs(begin?.time, finish?.time), phase: begin?.phase || 'UNKNOWN',
      category: record.kind === 'ACTION' ? 'ACTION' : 'OBSERVATION', operationId,
      title: record.request?.intent || (action ? actionLabel(action.type) : '观察现场'), intent: record.request?.intent || record.request?.authorization?.purpose || null,
      expectedOutcome: record.request?.expectedOutcome || null, action, authorization: record.request?.authorization || null, outcome,
      retrySafety: action ? retrySafety(action, record.request?.authorization, outcome) : null,
      raw: sanitizeOperationValue(record),
    });
  }

  for (const recovery of executionRecoveries(report)) {
    entries.push({
      sequence: entries.length + events.length + 1, time: recovery.time || '', durationMs: null, phase: 'RECOVERY', category: 'RECOVERY',
      operationId: recovery.recoveryId, title: `受控恢复：${RECOVERY_STATUS_LABELS[recovery.status] || '状态未知'}`, summary: recovery.decisionReason || recovery.reason || recovery.triggerType || 'App 已受控恢复',
      outcome: { status: recovery.status || 'UNKNOWN', code: recovery.failureCode || null, summary: recovery.decisionReason || recovery.reason || recovery.triggerType || '' }, raw: sanitizeOperationValue(recovery),
    });
  }

  for (const attempt of attempts.filter((item) => item.ok === false)) {
    entries.push({
      sequence: entries.length + events.length + 1,
      time: attempt.endedAt || attempt.startedAt || '',
      durationMs: attempt.durationMs ?? null,
      phase: 'UNKNOWN',
      category: 'PROTOCOL',
      operationId: null,
      title: `协议请求被拒绝：${attempt.entrypoint || '未知入口'}`,
      summary: attempt.error?.message || attempt.error?.code || '请求不符合当前 Agent 契约',
      outcome: { status: 'REJECTED', code: attempt.error?.code || null, summary: attempt.error?.message || '' },
      raw: sanitizeOperationValue(attempt),
    });
  }

  entries.sort((left, right) => {
    const leftTime = Date.parse(left.time);
    const rightTime = Date.parse(right.time);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.sequence - right.sequence;
  });
  entries.forEach((entry, index) => { entry.sequence = index + 1; });

  const observations = entries.filter((entry) => entry.category === 'OBSERVATION');
  const actions = entries.filter((entry) => entry.category === 'ACTION');
  for (const action of actions) {
    const before = [...observations].reverse().find((entry) => entry.sequence < action.sequence) || null;
    const after = observations.find((entry) => entry.relatedOperationId === action.operationId)
      || observations.find((entry) => entry.sequence > action.sequence) || null;
    action.beforeObservation = before?.observation || null;
    action.afterObservation = after?.observation || null;
  }

  const screenshots = observations.filter((entry) => entry.artifacts?.screenshot).map((entry, index) => ({
    id: `screenshot-${index + 1}`, index, ref: entry.artifacts.screenshot, operationId: entry.operationId,
    time: entry.time, phase: entry.phase, purpose: entry.observationPurpose, title: entry.title,
  }));
  const screenshotByRef = new Map(screenshots.map((item) => [item.ref, item]));
  for (const entry of entries) {
    if (entry.category === 'OBSERVATION') entry.screenshot = screenshotByRef.get(entry.artifacts?.screenshot) || null;
    if (entry.category === 'ACTION') {
      entry.beforeScreenshot = screenshotByRef.get(entry.beforeObservation?.ref) || null;
      entry.afterScreenshot = screenshotByRef.get(entry.afterObservation?.ref) || null;
    }
  }

  const lastObservation = observations.at(-1) || null;
  const lastTrustedObservation = [...observations].reverse().find((entry) => entry.observation?.usable) || null;
  const lastAction = actions.at(-1) || null;
  const pendingAction = [...actions].reverse().find((entry) => STATE_CHANGING_ACTIONS.has(entry.action?.type) && !entry.afterObservation) || null;
  const lastKnowledge = [...entries].reverse().find((entry) => entry.category === 'KNOWLEDGE') || null;
  const lastAuthorized = [...entries].reverse().find((entry) => entry.authorization) || null;
  const recoveryAnchor = {
    lastTrustedScreenshot: lastTrustedObservation?.screenshot || null,
    phase: report.execution?.phase || (report.execution?.finalized ? 'FINALIZED' : entries.at(-1)?.phase) || null,
    checkpointId: lastAuthorized?.authorization?.checkpointId || null,
    planRevision: lastAuthorized?.authorization?.planRevision || report.plan?.revision || null,
    lastCompletedOperation: lastAction ? { operationId: lastAction.operationId, title: lastAction.title, outcome: lastAction.outcome } : null,
    pendingOrUncertainOperation: pendingAction ? { operationId: pendingAction.operationId, title: pendingAction.title, outcome: pendingAction.outcome } : (lastAction?.outcome?.status === 'UNCERTAIN' ? { operationId: lastAction.operationId, title: lastAction.title, outcome: lastAction.outcome } : null),
    warmSessionGeneration: report.metrics?.warmSessionGeneration ?? report.execution?.warmSessionGeneration ?? null,
    recoveryCount: report.metrics?.recoveryCount ?? report.execution?.recoveryCount ?? 0,
    lastKnowledgeInvestigation: lastKnowledge ? { title: lastKnowledge.title, summary: lastKnowledge.summary } : null,
    remainingUncertainties: report.result?.uncertainties || report.display?.uncertainties || [],
  };

  return {
    entries, screenshots, recoveryAnchor,
    narrative: buildExecutionNarrative(report, entries),
    counts: {
      entries: entries.length,
      actions: actions.length,
      observations: observations.length,
      guardRejections: entries.filter((entry) => entry.category === 'GUARD').length,
      protocolAttempts: attempts.length,
      statusReads: attempts.filter((entry) => entry.entrypoint === 'status').length,
      protocolRejections: attempts.filter((entry) => entry.ok === false).length,
      inputEffects: inputEffectMetrics([...records.values()]),
      knowledge: entries.filter((entry) => entry.category === 'KNOWLEDGE').length,
      recoveries: entries.filter((entry) => entry.category === 'RECOVERY').length,
    },
    raw: sanitizeOperationValue({
      execution: report.execution, understanding: report.understanding, plan: report.plan,
      result: report.result, metrics: report.metrics, events, attempts,
    }),
  };
}

module.exports = { buildExecutionNarrative, buildExecutionTrace, redactAction, sanitizeOperationValue };
