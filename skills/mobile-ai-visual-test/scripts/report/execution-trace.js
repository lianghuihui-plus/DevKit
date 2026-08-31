'use strict';

const fs = require('fs');
const path = require('path');
const { displayAction } = require('../lib/display-format');
const { inputEffectMetrics, readAgentAttempts } = require('../lib/execution-time-limit');
const { deriveCheckpointProgress } = require('../lib/checkpoint-progress');
const { classifyActionEffect } = require('../lib/observation-consistency');

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
  if (Object.prototype.hasOwnProperty.call(copy, 'expectedText')) copy.expectedText = '[已脱敏]';
  if (Object.prototype.hasOwnProperty.call(copy, 'actualText')) copy.actualText = '[已脱敏]';
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

function semanticStepRecords(execDir) {
  const stepsDir = path.join(execDir || '', 'agent', 'steps');
  const byActionOperation = new Map();
  const byObservationOperation = new Map();
  if (!execDir || !fs.existsSync(stepsDir)) return { byActionOperation, byObservationOperation };
  for (const name of fs.readdirSync(stepsDir).filter((item) => item.endsWith('.json') && !item.endsWith('.draft.json'))) {
    const step = readJson(path.join(stepsDir, name), null);
    if (!step?.stepId) continue;
    const actionOperationId = step.expandedActionRequest?.operationId || step.action?.fact?.operationId || null;
    const observationOperationId = step.observation?.fact?.operationId || null;
    if (actionOperationId) byActionOperation.set(actionOperationId, step);
    if (observationOperationId) byObservationOperation.set(observationOperationId, step);
  }
  return { byActionOperation, byObservationOperation };
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
      objective: checkpoint.objective || '已从当前计划移除的检查点',
      status: null,
      requirementRefs: checkpoint.requirementRefs || [],
      requirements: (checkpoint.requirementRefs || []).map((ref) => requirements.get(ref)).filter(Boolean),
      requiredInteractions: (checkpoint.requirementRefs || []).flatMap((ref) => requirements.get(ref)?.requiredInteractions || []),
      expectedOutcomes: (checkpoint.requirementRefs || []).flatMap((ref) => requirements.get(ref)?.expectedOutcomes || []),
      requiresAction: (checkpoint.requirementRefs || []).some((ref) => (requirements.get(ref)?.requiredInteractions || []).length > 0),
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
    understanding: report.understanding,
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
    case 'knowledgeQuery': return { ...base, category: 'KNOWLEDGE', title: `知识查询 ${event.queryId}`, summary: `${event.candidateCount} 个候选${event.truncated ? '（已截断）' : ''}`, query: event.query, candidates: event.candidates || [] };
    case 'knowledgeAssessment': return { ...base, category: 'KNOWLEDGE', title: `知识评估：${KNOWLEDGE_ASSESSMENT_LABELS[event.assessment] || '未知评估'}`, summary: event.reason, knowledgeRef: event.knowledgeRef, entryId: event.entryId };
    case 'knowledgeReview': return { ...base, category: 'KNOWLEDGE', title: '知识调查已收口', summary: event.reason, queryId: event.queryId, conclusion: event.conclusion };
    case 'verdictReview': return { ...base, category: 'REVIEW', title: `结论复核：${VERDICT_LABELS[event.requestedVerdict] || '未知结论'}`, summary: event.reason, review: sanitizeOperationValue(event) };
    case 'result': return { ...base, category: 'RESULT', title: `最终结论：${VERDICT_LABELS[event.verdict] || '未知结论'}`, summary: '' };
    default: return null;
  }
}

function linkedRequirementFindings(report, evidenceRef, requirementRefs = []) {
  if (!evidenceRef) return [];
  const allowed = new Set(requirementRefs || []);
  return (report.result?.requirementFindings || []).filter((finding) => (finding.evidenceRefs || []).includes(evidenceRef)
    && (!allowed.size || allowed.has(finding.requirementId)));
}

function assessmentFromFindings(findings) {
  if (!findings.length) return null;
  const statuses = new Set(findings.map((finding) => finding.status));
  const summary = findings.map((finding) => finding.reason).filter(Boolean).join('；');
  if (statuses.has('NOT_SATISFIED')) return { status: 'NOT_MATCHED', summary: summary || 'Agent 认为当前证据不满足关联要求', basis: 'Agent 检查结果' };
  if (statuses.has('BLOCKED') || statuses.has('UNRESOLVED')) return { status: 'UNRESOLVED', summary: summary || 'Agent 未能对关联要求形成确定判断', basis: 'Agent 检查结果' };
  if ([...statuses].every((status) => status === 'SATISFIED')) return { status: 'MATCHED', summary: summary || 'Agent 认为当前证据满足关联要求', basis: 'Agent 检查结果' };
  return null;
}

function assessmentFromInputEffect(inputEffect) {
  if (!inputEffect) return null;
  if (['VERIFIED', 'MASKED'].includes(inputEffect.status)) {
    return { status: 'MATCHED', summary: inputEffect.status === 'MASKED' ? '安全输入的掩码长度与预期一致' : '设备适配器已核验整串输入效果', basis: '输入效果核验' };
  }
  if (inputEffect.status === 'MISMATCH') return { status: 'NOT_MATCHED', summary: '设备适配器检测到输入效果与预期不一致', basis: '输入效果核验' };
  return { status: 'UNRESOLVED', summary: '设备适配器未能验证输入效果', basis: '输入效果核验' };
}

function expectationAssessment(report, entry) {
  const evidenceRef = entry.category === 'ACTION' ? entry.afterObservation?.ref : entry.observation?.ref;
  const requirementRefs = entry.authorization?.requirementRefs || [];
  const findings = linkedRequirementFindings(report, evidenceRef, requirementRefs);
  const findingAssessment = assessmentFromFindings(findings);
  if (findingAssessment) return { ...findingAssessment, findingRefs: findings.map((finding) => finding.requirementId) };
  const inputAssessment = assessmentFromInputEffect(entry.inputEffect);
  if (inputAssessment) return inputAssessment;
  if (entry.outcome?.status === 'FAILED' || entry.outcome?.status === 'UNCERTAIN' || entry.outcome?.status === 'REJECTED') {
    return { status: 'UNRESOLVED', summary: '操作未产生可靠的完成结果，无法判断是否符合预期', basis: '操作结果' };
  }
  if (entry.category === 'ACTION' && !entry.afterObservation) {
    return { status: 'UNRESOLVED', summary: '没有取得与该操作绑定的操作后现场', basis: '现场证据' };
  }
  if ((entry.category === 'ACTION' && entry.afterObservation?.usable !== true)
    || (entry.category === 'OBSERVATION' && entry.observation?.usable !== true)) {
    return { status: 'UNRESOLVED', summary: '当前现场不可用，不能支撑业务预期判断', basis: '现场证据' };
  }
  return { status: 'NOT_ASSESSED', summary: 'Agent 未对该单次操作形成独立的预期判断', basis: '无显式单步结论' };
}

function nextAgentDecision(entries, entry, linkedFinding) {
  if (linkedFinding) return { status: 'EXPLICIT', summary: linkedFinding.summary, category: linkedFinding.category };
  const boundary = entry.afterObservationEntry?.sequence || entry.sequence;
  const next = entries.find((candidate) => candidate.sequence > boundary
    && ['ACTION', 'PLAN', 'CHECKPOINT', 'KNOWLEDGE', 'REVIEW', 'DECISION', 'RECOVERY', 'GUARD'].includes(candidate.category));
  if (!next) return { status: 'NOT_RECORDED', summary: 'Agent 没有为该步骤留下独立分析记录', category: null };
  const prefixes = {
    ACTION: 'Agent 继续执行', PLAN: 'Agent 调整计划', CHECKPOINT: 'Agent 形成检查点结论',
    KNOWLEDGE: 'Agent 进入知识调查', REVIEW: 'Agent 进行结论复核', DECISION: 'Agent 形成决策',
    RECOVERY: 'Agent 进入受控恢复', GUARD: '框架拒绝了后续操作',
  };
  return {
    status: 'CONTINUED',
    summary: `${prefixes[next.category] || 'Agent 继续执行'}：${next.intent || next.summary || next.title}`,
    category: next.category,
    targetSequence: next.sequence,
  };
}

function buildExecutionTrace(report) {
  const events = Array.isArray(report.events) ? report.events : [];
  const records = operationRecords(report.latest);
  const steps = semanticStepRecords(report.latest);
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
      const step = steps.byObservationOperation.get(event.operationId) || null;
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
        stepId: step?.stepId || null,
        outcome: { status: event.usable ? 'SUCCEEDED' : 'FAILED', code: event.usable ? null : 'OBSERVATION_NOT_USABLE', summary: event.usable ? '截图可用于当前执行' : '截图不可作为业务结论证据' },
        observation: {
          ref: event.ref,
          sha256: event.sha256,
          usable: event.usable,
          app: event.app || record?.deviceResult?.app || null,
          device: event.device || record?.deviceResult?.device || null,
          technicalSignals: event.technicalSignals || null,
        },
        artifacts, raw: sanitizeOperationValue({ event, request, deviceResult: record?.deviceResult || null }),
      };
      entries.push(entry);
      operationEntries.set(event.operationId, entry);
      continue;
    }
    if (event.type === 'actionResult') {
      const record = records.get(event.operationId);
      const step = steps.byActionOperation.get(event.operationId) || null;
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
        summary: outcome.summary, authorization, action, outcome, stepId: step?.stepId || null,
        semanticRequest: sanitizeOperationValue(step?.semanticRequest || null),
        inputEffect: sanitizeOperationValue(event.deviceResult?.inputEffect || record?.deviceResult?.inputEffect || null),
        coordinateAudit: sanitizeOperationValue(event.coordinateAudit || record?.fact?.coordinateAudit || null),
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
    const step = steps.byActionOperation.get(operationId) || steps.byObservationOperation.get(operationId) || null;
    const outcome = actionOutcome(null, finish, record);
    entries.push({
      sequence: events.indexOf(begin) + 1, time: begin?.time || '', durationMs: durationMs(begin?.time, finish?.time), phase: begin?.phase || 'UNKNOWN',
      category: record.kind === 'ACTION' ? 'ACTION' : 'OBSERVATION', operationId,
      title: record.request?.intent || (action ? actionLabel(action.type) : '观察现场'), intent: record.request?.intent || record.request?.authorization?.purpose || null,
      expectedOutcome: record.request?.expectedOutcome || null, action, authorization: record.request?.authorization || null, outcome,
      stepId: step?.stepId || null, semanticRequest: sanitizeOperationValue(step?.semanticRequest || null),
      inputEffect: sanitizeOperationValue(record.deviceResult?.inputEffect || null),
      coordinateAudit: sanitizeOperationValue(record.fact?.coordinateAudit || null),
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
  const observationByRef = new Map(observations.filter((entry) => entry.observation?.ref).map((entry) => [entry.observation.ref, entry]));
  const observationByOperation = new Map(observations.filter((entry) => entry.operationId).map((entry) => [entry.operationId, entry]));
  for (const action of actions) {
    const step = steps.byActionOperation.get(action.operationId) || null;
    const basisRef = step?.expandedActionRequest?.basisObservationRef || action.raw?.event?.basisObservationRef
      || action.raw?.request?.basisObservationRef || null;
    const stepObservationOperationId = step?.observation?.fact?.operationId || null;
    const stepObservationRef = step?.observation?.fact?.ref || null;
    const before = observationByRef.get(basisRef) || null;
    const after = observationByOperation.get(stepObservationOperationId)
      || observationByRef.get(stepObservationRef)
      || observations.find((entry) => entry.relatedOperationId === action.operationId) || null;
    action.beforeObservation = before?.observation || null;
    action.afterObservation = after?.observation || null;
    action.beforeObservationEntry = before;
    action.afterObservationEntry = after;
    action.observationLinkage = after ? 'EXACT' : 'MISSING';
    action.postActionArtifacts = after?.artifacts || null;
    action.actionEffect = classifyActionEffect(
      before ? { screenshot: { sha256: before.observation?.sha256 } } : null,
      after ? { screenshot: { sha256: after.observation?.sha256 } } : null,
      action.operationId,
    );
  }

  const screenshots = observations.filter((entry) => entry.artifacts?.screenshot).map((entry) => ({
    ref: entry.artifacts.screenshot, operationId: entry.operationId,
    time: entry.time, phase: entry.phase, purpose: entry.observationPurpose, title: entry.title,
  }));
  for (const action of actions) {
    if (safeRef(action.coordinateAudit?.overlayRef)) {
      screenshots.push({
        ref: action.coordinateAudit.overlayRef,
        operationId: action.operationId,
        time: action.time,
        phase: action.phase,
        purpose: 'COORDINATE_AUDIT',
        title: '操作前坐标审计',
      });
    }
  }
  screenshots.forEach((entry, index) => Object.assign(entry, { id: `screenshot-${index + 1}`, index }));
  const screenshotByRef = new Map(screenshots.map((item) => [item.ref, item]));
  for (const entry of entries) {
    if (entry.category === 'OBSERVATION') entry.screenshot = screenshotByRef.get(entry.artifacts?.screenshot) || null;
    if (entry.category === 'ACTION') {
      entry.beforeScreenshot = screenshotByRef.get(entry.beforeObservation?.ref) || null;
      entry.afterScreenshot = screenshotByRef.get(entry.afterObservation?.ref) || null;
      entry.coordinateOverlayScreenshot = screenshotByRef.get(entry.coordinateAudit?.overlayRef) || null;
    }
  }

  const checkpoints = new Map((report.plan?.checkpoints || []).map((checkpoint, index) => [checkpoint.id, { ...checkpoint, order: index + 1 }]));
  const startConditions = new Map((report.understanding?.startConditions || []).map((condition, index) => [condition.id, { ...condition, order: index + 1 }]));
  for (const entry of entries) {
    const checkpointId = entry.authorization?.checkpointId || entry.checkpointId || null;
    const checkpoint = checkpoints.get(checkpointId) || null;
    const startCondition = startConditions.get(entry.authorization?.startConditionId) || null;
    entry.executionContext = checkpoint ? {
      type: 'CHECKPOINT', order: checkpoint.order, objective: checkpoint.objective, planRevision: entry.authorization?.planRevision || entry.planRevision || report.plan?.revision || null,
    } : startCondition ? { type: 'START', order: startCondition.order, goal: startCondition.text, planRevision: null } : null;
  }
  for (const entry of entries.filter((item) => ['ACTION', 'OBSERVATION'].includes(item.category))) {
    if (entry.category === 'OBSERVATION' && entry.relatedOperationId) continue;
    const evidenceRef = entry.category === 'ACTION' ? entry.afterObservation?.ref : entry.observation?.ref;
    const linkedFinding = entries.find((candidate) => candidate.category === 'CHECKPOINT'
      && evidenceRef && (candidate.evidenceRefs || []).includes(evidenceRef)
      && (!entry.authorization?.checkpointId || candidate.checkpointId === entry.authorization.checkpointId)) || null;
    entry.expectationAssessment = expectationAssessment(report, entry);
    entry.agentAnalysis = nextAgentDecision(entries, entry, linkedFinding);
  }

  const pathEntries = entries.filter((entry) => {
    if (entry.category === 'OBSERVATION' && entry.relatedOperationId) return false;
    return !['PHASE', 'UNDERSTANDING', 'RESULT'].includes(entry.category);
  });

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
    entries, pathEntries, screenshots, recoveryAnchor,
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
