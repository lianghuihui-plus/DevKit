'use strict';

const path = require('path');
const {
  className,
  displayAction,
  escapeHtml,
  formatDisplayTime,
  formatDuration,
} = require('../lib/display-format');
const { buildExecutionTrace } = require('./execution-trace');
const { deriveCheckpointProgress } = require('../lib/checkpoint-progress');

const CATEGORY_LABELS = Object.freeze({
  PHASE: '阶段', UNDERSTANDING: '理解', PLAN: '计划', CHECKPOINT: '检查点', DECISION: '决策',
  ACTION: '操作', OBSERVATION: '观察', GUARD: '守卫', PROTOCOL: '协议', KNOWLEDGE: '知识', RECOVERY: '恢复', REVIEW: '复核', RESULT: '结论',
});
const PHASE_LABELS = Object.freeze({
  UNDERSTAND: '理解用例', ESTABLISH_START: '建立起点', EXECUTE: '执行与检查', INVESTIGATE: '调查异常', RECOVERY: '恢复现场', CONCLUDE: '形成结论', FINALIZED: '执行完成', UNKNOWN: '未归类',
});
const VERDICT_LABELS = Object.freeze({ PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断', NOT_RUN: '未执行', RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布' });
const BASIS_LABELS = Object.freeze({ DIRECT_EVIDENCE: '直接证据', KNOWLEDGE_SUPPORTED: '知识支持', INSUFFICIENT_EVIDENCE: '证据不足', TECHNICAL_CONSTRAINT: '技术约束' });
const EXECUTION_STATUS_LABELS = Object.freeze({ RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布', COMPLETED: '执行完成', STOPPED_BY_BUDGET: '达到时限后停止', TECHNICALLY_BLOCKED: '技术阻塞', INTERRUPTED: '执行中断' });
const OUTCOME_LABELS = Object.freeze({ SUCCEEDED: '成功', FAILED: '失败', REJECTED: '已拒绝', UNCERTAIN: '结果待确认', UNKNOWN: '未知' });
const RETRY_LABELS = Object.freeze({ SAFE: '可安全重试', OBSERVE_FIRST: '先观察现场', AGENT_DECIDES: '由 Agent 判断', UNKNOWN: '未知' });
const SCOPE_LABELS = Object.freeze({ 'case-prepare': '起点准备', 'case-business': '业务执行' });
const OBSERVATION_PURPOSE_LABELS = Object.freeze({ CASE_ENTRY: '进入用例', ESTABLISH_START: '建立起点', PRE_ACTION: '操作前', POST_ACTION: '操作后', INVESTIGATION: '异常调查', RECOVERY_BEFORE: '恢复前', RECOVERY_AFTER: '恢复后', FINAL: '最终结论', AGENT_DECIDED: 'Agent 自主观察' });
const REQUIREMENT_STATUS_LABELS = Object.freeze({ SATISFIED: '已满足', NOT_SATISFIED: '未满足', BLOCKED: '阻塞', UNRESOLVED: '未确认' });
const REQUIREMENT_BASIS_LABELS = Object.freeze({ explicit: '原文明示', implied: '根据原文推导' });
const CHECKPOINT_STATUS_LABELS = Object.freeze({
  PENDING: '待处理', ACTIVE: '执行中', VERIFIED: '已验证', NOT_SATISFIED: '未满足',
  BLOCKED: '阻塞', UNRESOLVED: '未确认', NOT_EXECUTED: '未执行', SUPERSEDED: '已被新计划替代',
});
const ACTION_FIELD_LABELS = Object.freeze({
  target: '目标', x: '横坐标', y: '纵坐标', coordinateSource: '定位依据', targetBounds: '目标区域',
  coordinateEvidence: '坐标证据', text: '输入内容', mode: '输入方式', durationMs: '长按时长',
  fromX: '起点横坐标', fromY: '起点纵坐标', toX: '终点横坐标', toY: '终点纵坐标',
  velocity: '滑动速度', ms: '等待时长', reason: '操作原因',
});
const ACTION_VALUE_LABELS = Object.freeze({
  layout: '控件树定位', visual: '视觉识别', pixel: '像素定位', replace: '替换原内容', append: '追加内容',
});

function label(mapping, value, empty = '-') {
  return mapping[value] || empty;
}

function actionLabel(value) {
  const displayed = displayAction(value);
  return displayed && displayed !== value ? displayed : '未知操作';
}

function formatInputEffects(inputEffects) {
  if (!inputEffects?.total) return '无';
  const statuses = inputEffects.statuses || {};
  return [
    statuses.VERIFIED ? `明文已核对 ${statuses.VERIFIED}` : null,
    statuses.MASKED ? `安全掩码 ${statuses.MASKED}` : null,
    statuses.UNVERIFIABLE ? `无法直接核对 ${statuses.UNVERIFIABLE}` : null,
    statuses.MISMATCH ? `明确不一致 ${statuses.MISMATCH}` : null,
    `检测 ${inputEffects.attempts || 0} 次`,
  ].filter(Boolean).join(' · ');
}

function statusReadCount(report, trace) {
  return report.metrics?.timing?.statusReads ?? trace.counts.statusReads ?? 0;
}

function reportInputEffects(report, trace) {
  return report.metrics?.timing?.inputEffects || trace.counts.inputEffects;
}

function markdownText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderSourceMarkdown(value) {
  const lines = markdownText(value).split('\n');
  const html = [];
  let list = null;
  let paragraph = [];
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushParagraph(); closeList();
      if (code === null) code = [];
      else { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const type = ordered ? 'ol' : 'ul';
      if (list !== type) { closeList(); html.push(`<${type}>`); list = type; }
      html.push(`<li>${renderInlineMarkdown((ordered || unordered)[1])}</li>`);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); closeList(); html.push('<hr>'); continue; }
    paragraph.push(line.trim());
  }
  flushParagraph(); closeList();
  if (code !== null) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return html.join('');
}

function actionValue(field, value) {
  if (ACTION_VALUE_LABELS[value]) return ACTION_VALUE_LABELS[value];
  if (field === 'durationMs' || field === 'ms') return `${value} 毫秒`;
  if (field === 'velocity') return `${value} 像素/秒`;
  if (Array.isArray(value)) return value.join('，');
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value ?? '-');
}

function actionDetails(action) {
  if (!action || typeof action !== 'object') return [];
  return Object.entries(action)
    .filter(([field, value]) => field !== 'type' && ACTION_FIELD_LABELS[field] && value !== undefined && value !== null && value !== '')
    .map(([field, value]) => ({ label: ACTION_FIELD_LABELS[field], value: actionValue(field, value) }));
}

function evidenceHref(report, ref) {
  if (!report.execution?.executionId || typeof ref !== 'string' || path.isAbsolute(ref) || ref.split(/[\\/]+/).includes('..')) return null;
  return `executions/${encodeURIComponent(report.execution.executionId)}/${ref.split('/').map(encodeURIComponent).join('/')}`;
}

function markdownEvidence(report, ref) {
  const href = evidenceHref(report, ref);
  return href ? `[${markdownText(ref)}](${href})` : markdownText(ref);
}

function htmlEvidence(report, ref, label = ref) {
  const href = evidenceHref(report, ref);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function renderCurrentContextMarkdown(caseJson, report) {
  const display = report.display || {};
  const trace = buildExecutionTrace(report);
  const anchor = trace.recoveryAnchor;
  const checkpointProgress = new Map(deriveCheckpointProgress(report.plan, report.events, report.result, {
    warmSessionGeneration: report.execution?.warmSessionGeneration,
  })
    .map((entry) => [entry.checkpointId, entry]));
  const lines = [
    `# ${caseJson.identity?.caseNo ? `${caseJson.identity.caseNo} · ` : ''}${caseJson.identity?.title || '未命名用例'}`, '',
    `- 执行结论：${label(VERDICT_LABELS, display.verdict || display.status, '未执行')}`,
    `- 结论依据：${label(BASIS_LABELS, display.verdictBasis)}`,
    `- 执行状态：${label(EXECUTION_STATUS_LABELS, display.executionStatus)}`,
    `- 执行标识：${report.execution?.executionId || '-'}`,
    `- 耗时：${formatDuration(display.durationMs)}`,
    `- 操作 / 观察：${trace.counts.actions} / ${trace.counts.observations}`,
    `- Agent 编排间隔：${formatDuration(report.metrics?.timing?.agentOrchestrationGapMs ?? report.metrics?.timing?.agentDecisionGapMs)}`,
    `- 设备适配器工作：${formatDuration(report.metrics?.timing?.adapterActiveMs)}`,
    `- 协议状态读取：${statusReadCount(report, trace)} 次`,
    `- 输入效果检查：${formatInputEffects(reportInputEffects(report, trace))}`,
    `- 协议拒绝：${trace.counts.protocolRejections || 0}`, '',
    '## 执行结论', '', display.summary || '暂无结论。', '',
    '## 最新动态计划', '',
    `- 当前版本：${report.plan?.revision || '-'}`,
    `- 生成或调整原因：${markdownText(report.plan?.reason || '暂无计划')}`,
    `- 检查点进度：${[...checkpointProgress.values()].filter((item) => ['VERIFIED', 'NOT_SATISFIED', 'BLOCKED', 'UNRESOLVED'].includes(item.status)).length}/${(report.plan?.checkpoints || []).length}`, '',
    ...(report.plan?.checkpoints || []).flatMap((checkpoint, index) => [
      `${index + 1}. [${label(CHECKPOINT_STATUS_LABELS, checkpointProgress.get(checkpoint.id)?.status, '未知')}] ${markdownText(checkpoint.goal)}`,
      `   - 检查点：${checkpoint.id}`,
      `   - 操作要求：${checkpoint.requiredAction ? '需要操作' : '不要求操作'}`,
      `   - 关联要求：${checkpoint.requirementRefs?.length ? checkpoint.requirementRefs.join('、') : '无'}`,
    ]),
    '', '## 完整执行轨迹', '',
  ];
  if (!trace.entries.length) lines.push('- 暂无执行轨迹');
  for (const entry of trace.entries) {
    const detail = [
      entry.operationId ? `操作标识=${entry.operationId}` : null,
      entry.durationMs !== null ? `耗时=${formatDuration(entry.durationMs)}` : null,
      entry.outcome?.status ? `结果=${label(OUTCOME_LABELS, entry.outcome.status)}` : null,
      entry.authorization?.checkpointId ? `检查点=${entry.authorization.checkpointId}` : null,
      entry.authorization?.planRevision ? `计划版本=${entry.authorization.planRevision}` : null,
    ].filter(Boolean).join('；');
    lines.push(`${entry.sequence}. [${label(PHASE_LABELS, entry.phase, '未归类')}] ${CATEGORY_LABELS[entry.category] || '未归类'}：${markdownText(entry.title)}${detail ? `（${detail}）` : ''}`);
    if (entry.intent) lines.push(`   - 意图：${markdownText(entry.intent)}`);
    if (entry.expectedOutcome) lines.push(`   - 预期：${markdownText(entry.expectedOutcome)}`);
    if (entry.summary) lines.push(`   - 结果：${markdownText(entry.summary)}`);
    for (const candidate of entry.candidates || []) {
      const scope = [candidate.metadata?.platform?.join('/'), candidate.metadata?.version, candidate.metadata?.page].filter(Boolean).join(' · ');
      lines.push(`   - 知识候选：${markdownText(candidate.entryId)} ${markdownText(candidate.title || '')}${scope ? `（${markdownText(scope)}）` : ''}`);
      if (candidate.snapshotRef) lines.push(`   - 冻结知识：${markdownEvidence(report, candidate.snapshotRef)}`);
    }
    if (entry.action) {
      lines.push(`   - 操作：${actionLabel(entry.action.type)}`);
      for (const detail of actionDetails(entry.action)) lines.push(`   - ${detail.label}：${markdownText(detail.value)}`);
    }
    if (entry.screenshot?.ref) lines.push(`   - 截图：${markdownEvidence(report, entry.screenshot.ref)}`);
    if (entry.beforeScreenshot?.ref) lines.push(`   - 操作前：${markdownEvidence(report, entry.beforeScreenshot.ref)}`);
    if (entry.afterScreenshot?.ref) lines.push(`   - 操作后：${markdownEvidence(report, entry.afterScreenshot.ref)}`);
  }
  lines.push('', '## 恢复锚点', '',
    `- 最后可信截图：${anchor.lastTrustedScreenshot ? markdownEvidence(report, anchor.lastTrustedScreenshot.ref) : '无'}`,
    `- 当前阶段：${label(PHASE_LABELS, anchor.phase)}`,
    `- 检查点 / 计划版本：${anchor.checkpointId || '-'} / ${anchor.planRevision || '-'}`,
    `- 最后完成操作：${anchor.lastCompletedOperation?.operationId || '无'}`,
    `- 未完成或结果不确定操作：${anchor.pendingOrUncertainOperation?.operationId || '无'}`,
    `- 暖会话代次 / 恢复次数：${anchor.warmSessionGeneration ?? '-'} / ${anchor.recoveryCount}`,
    `- 剩余不确定性：${anchor.remainingUncertainties.length ? anchor.remainingUncertainties.join('；') : '无'}`, '',
    '## 原始用例', '', '```text', markdownText(report.sourceText), '```', '');
  return lines.join('\n');
}

function jsonText(value) {
  const localizeTimes = (item) => {
    if (Array.isArray(item)) return item.map(localizeTimes);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, localizeTimes(child)]));
    }
    if (typeof item !== 'string'
      || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(item)) return item;
    return formatDisplayTime(item);
  };
  return escapeHtml(JSON.stringify(localizeTimes(value), null, 2));
}

function outcomeClass(status) {
  return className(status === 'SUCCEEDED' ? 'PASS' : status === 'REJECTED' || status === 'UNCERTAIN' ? 'BLOCKED' : status === 'FAILED' ? 'FAIL' : 'UNKNOWN');
}

function renderScreenshot(report, shot, label) {
  if (!shot?.ref) return '<span class="empty-shot">无截图</span>';
  const src = evidenceHref(report, shot.ref);
  if (!src) return '<span class="empty-shot">截图路径无效</span>';
  return `<button type="button" class="shot-trigger" data-shot="${escapeHtml(shot.index)}" title="在当前页面查看 ${escapeHtml(label)}">
    <img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy">
    <span>${escapeHtml(label)}</span>
  </button>`;
}

function renderAuthorization(value) {
  if (!value) return '';
  const parts = [
    label(SCOPE_LABELS, value.phase),
    value.checkpointId ? `检查点 ${value.checkpointId}` : null,
    value.startConditionId ? `起点条件 ${value.startConditionId}` : null,
    value.planRevision ? `计划版本 ${value.planRevision}` : null,
  ].filter(Boolean);
  return `<div class="binding">${parts.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
}

function renderArtifacts(report, artifacts) {
  if (!artifacts) return '';
  const links = [];
  if (artifacts.layout) links.push(htmlEvidence(report, artifacts.layout, '控件树'));
  for (const [index, ref] of (artifacts.logs || []).entries()) links.push(htmlEvidence(report, ref, `诊断资料 ${index + 1}`));
  return links.length ? `<details class="artifacts"><summary>现场附件 ${links.length}</summary><div>${links.join('')}</div></details>` : '';
}

function renderKnowledgeCandidates(report, candidates = []) {
  if (!candidates.length) return '';
  return `<div class="knowledge-list">${candidates.map((candidate) => {
    const scope = [candidate.metadata?.app, candidate.metadata?.platform?.join(' / '), candidate.metadata?.version, candidate.metadata?.page].filter(Boolean).join(' · ');
    return `<div><b>${escapeHtml(candidate.entryId)} ${escapeHtml(candidate.title || '')}</b>${scope ? `<span>${escapeHtml(scope)}</span>` : ''}${candidate.snapshotRef ? htmlEvidence(report, candidate.snapshotRef, '查看冻结知识') : ''}</div>`;
  }).join('')}</div>`;
}

function renderActionSpec(action) {
  if (!action) return '';
  const fields = actionDetails(action).map((detail) => {
    const wide = ['坐标证据', '操作原因'].includes(detail.label) || String(detail.value).length > 56;
    return `<div class="action-field${wide ? ' wide' : ''}"><dt>${escapeHtml(detail.label)}</dt><dd>${escapeHtml(detail.value)}</dd></div>`;
  }).join('');
  return `<div class="action-spec"><div class="action-kind"><span>执行操作</span><b>${escapeHtml(actionLabel(action.type))}</b></div><dl>${fields}</dl></div>`;
}

function renderEntry(report, entry) {
  const outcome = entry.outcome ? `<span class="outcome ${outcomeClass(entry.outcome.status)}">${escapeHtml(label(OUTCOME_LABELS, entry.outcome.status))}</span>` : '';
  const meta = [formatDisplayTime(entry.time), entry.durationMs !== null ? formatDuration(entry.durationMs) : null, entry.operationId].filter(Boolean);
  const intent = entry.intent || entry.expectedOutcome ? `<dl class="decision-fields">${entry.intent ? `<div><dt>Agent 意图</dt><dd>${escapeHtml(entry.intent)}</dd></div>` : ''}${entry.expectedOutcome ? `<div><dt>预期结果</dt><dd>${escapeHtml(entry.expectedOutcome)}</dd></div>` : ''}</dl>` : '';
  const action = renderActionSpec(entry.action);
  const compare = entry.category === 'ACTION' ? `<div class="shot-pair"><div><small>操作前</small>${renderScreenshot(report, entry.beforeScreenshot, '操作前现场')}</div><div><small>操作后</small>${renderScreenshot(report, entry.afterScreenshot, '操作后现场')}</div></div>` : '';
  const observation = entry.category === 'OBSERVATION' ? `<div class="observation-row">${renderScreenshot(report, entry.screenshot, label(OBSERVATION_PURPOSE_LABELS, entry.observationPurpose, '现场截图'))}<div><b>${entry.observation?.usable ? '证据可用' : '证据不可用'}</b><p>${escapeHtml(entry.observation?.app?.foregroundApp || '未记录前台 App')}</p><p class="muted">${escapeHtml(label(OBSERVATION_PURPOSE_LABELS, entry.observationPurpose, 'Agent 自主观察'))}${entry.relatedOperationId ? ` · 关联操作 ${escapeHtml(entry.relatedOperationId)}` : ''}</p></div></div>` : '';
  const retry = entry.retrySafety ? `<p class="retry"><b>重试策略</b> ${escapeHtml(label(RETRY_LABELS, entry.retrySafety.status))}：${escapeHtml(entry.retrySafety.reason)}</p>` : '';
  return `<article class="trace-entry" data-category="${escapeHtml(entry.category)}">
    <div class="trace-rail"><span>${escapeHtml(entry.sequence)}</span></div>
    <div class="trace-body">
      <div class="entry-head"><div><span class="category ${className(entry.category)}">${escapeHtml(CATEGORY_LABELS[entry.category] || '未归类')}</span><h3>${escapeHtml(entry.title)}</h3></div>${outcome}</div>
      <div class="entry-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      ${entry.summary ? `<p class="entry-summary">${escapeHtml(entry.summary)}</p>` : ''}
      ${intent}${renderAuthorization(entry.authorization)}${action}${compare}${observation}${renderKnowledgeCandidates(report, entry.candidates)}${retry}${renderArtifacts(report, entry.artifacts)}
    </div>
  </article>`;
}

function renderPhaseGroups(report, entries) {
  if (!entries.length) return '<p class="empty">暂无执行轨迹。</p>';
  const groups = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (!last || last.phase !== entry.phase) groups.push({ phase: entry.phase, entries: [entry] });
    else last.entries.push(entry);
  }
  return groups.map((group) => `<section class="phase-group" data-phase="${escapeHtml(group.phase)}">
    <header class="phase-head"><span>阶段</span><h2>${escapeHtml(label(PHASE_LABELS, group.phase))}</h2><b>${group.entries.length}</b></header>
    ${group.entries.map((entry) => renderEntry(report, entry)).join('')}
  </section>`).join('');
}

function renderRecoveryAnchor(report, anchor) {
  const last = anchor.lastTrustedScreenshot;
  return `<aside class="recovery-anchor">
    <div class="aside-title"><span>恢复锚点</span><b>${anchor.pendingOrUncertainOperation ? '需关注' : '现场已记录'}</b></div>
    ${renderScreenshot(report, last, '最后可信现场')}
    <dl>
      <div><dt>阶段</dt><dd>${escapeHtml(label(PHASE_LABELS, anchor.phase))}</dd></div>
      <div><dt>检查点</dt><dd>${escapeHtml(anchor.checkpointId || '-')}</dd></div>
      <div><dt>计划版本</dt><dd>${escapeHtml(anchor.planRevision || '-')}</dd></div>
      <div><dt>最后操作</dt><dd>${escapeHtml(anchor.lastCompletedOperation?.operationId || '-')}</dd></div>
      <div><dt>待确认操作</dt><dd>${escapeHtml(anchor.pendingOrUncertainOperation?.operationId || '无')}</dd></div>
      <div><dt>暖会话 / 恢复</dt><dd>${escapeHtml(anchor.warmSessionGeneration ?? '-')} / ${escapeHtml(anchor.recoveryCount)}</dd></div>
    </dl>
    ${anchor.lastKnowledgeInvestigation ? `<p><b>最近知识调查</b><br>${escapeHtml(anchor.lastKnowledgeInvestigation.title)}：${escapeHtml(anchor.lastKnowledgeInvestigation.summary)}</p>` : ''}
    ${anchor.remainingUncertainties.length ? `<div class="anchor-alert"><b>剩余不确定性</b>${anchor.remainingUncertainties.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
  </aside>`;
}

function renderRequirements(report) {
  const understanding = report.understanding || {};
  const findings = new Map((report.result?.requirementFindings || []).map((item) => [item.requirementId, item]));
  const requirements = understanding.requirements || [];
  return requirements.length ? requirements.map((requirement) => {
    const finding = findings.get(requirement.id);
    return `<article class="requirement"><div><span>验证要求</span><b>${escapeHtml(label(REQUIREMENT_STATUS_LABELS, finding?.status, '未确认'))}</b></div><h3>${escapeHtml(requirement.text)}</h3><p>${escapeHtml(label(REQUIREMENT_BASIS_LABELS, requirement.basis, ''))}</p>${finding?.evidenceRefs?.length ? `<p>证据：${finding.evidenceRefs.map((ref, index) => htmlEvidence(report, ref, `证据截图 ${index + 1}`)).join('、')}</p>` : ''}</article>`;
  }).join('') : '<p class="empty">当前理解没有可展示的需求。</p>';
}

function renderUnderstanding(report) {
  const understanding = report.understanding;
  if (!understanding) return '<p class="empty">Agent 尚未形成用例理解。</p>';
  const statements = (items, kind) => items?.length ? `<div class="statement-group"><h3>${kind}</h3>${items.map((item, index) => `<div class="statement"><span class="statement-order">${index + 1}</span><div><b>${escapeHtml(item.text)}</b><span>${escapeHtml(label(REQUIREMENT_BASIS_LABELS, item.basis, item.basis === 'assumed' ? 'Agent 假设' : ''))}</span></div></div>`).join('')}</div>` : '';
  return `<div class="understanding-summary"><span>理解版本 ${escapeHtml(understanding.revision)}</span><p>${escapeHtml(understanding.summary)}</p></div>
    <div class="understanding-columns">${statements(understanding.startConditions, '起点条件')}${statements(understanding.requirements, '验证要求')}</div>
    ${understanding.uncertainties?.length ? `<div class="uncertainties"><b>初始不确定性</b>${understanding.uncertainties.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}`;
}

function renderNarrativeEntry(report, entry, stepNumber) {
  const title = entry.category === 'CHECKPOINT' ? '形成检查点结论' : entry.title;
  const outcomeText = entry.outcome?.status === 'SUCCEEDED' && entry.category === 'OBSERVATION'
    ? '现场采集成功'
    : entry.outcome?.status === 'SUCCEEDED' && entry.category === 'ACTION' ? '操作成功' : label(OUTCOME_LABELS, entry.outcome?.status);
  const outcome = entry.outcome ? `<span class="outcome ${outcomeClass(entry.outcome.status)}">${escapeHtml(outcomeText)}</span>` : '';
  const meta = [formatDisplayTime(entry.time), entry.durationMs !== null ? formatDuration(entry.durationMs) : null].filter(Boolean);
  const action = renderActionSpec(entry.action);
  const screenshots = entry.category === 'ACTION'
    ? `<div class="shot-pair"><div><small>操作前</small>${renderScreenshot(report, entry.beforeScreenshot, '操作前现场')}</div><div><small>操作后</small>${renderScreenshot(report, entry.afterScreenshot, '操作后现场')}</div></div>`
    : entry.category === 'OBSERVATION' ? `<div class="single-shot">${renderScreenshot(report, entry.screenshot, label(OBSERVATION_PURPOSE_LABELS, entry.observationPurpose, '现场截图'))}</div>` : '';
  return `<div class="work-step">
    <div class="work-step-marker"><span>${escapeHtml(stepNumber)}</span></div>
    <div class="work-step-body"><div class="work-step-head"><div><span class="category ${className(entry.category)}">${escapeHtml(CATEGORY_LABELS[entry.category] || '记录')}</span><h4>${escapeHtml(title)}</h4></div>${outcome}</div>
      <div class="entry-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      ${entry.intent ? `<p><b>执行意图：</b>${escapeHtml(entry.intent)}</p>` : ''}${entry.expectedOutcome ? `<p><b>${entry.category === 'OBSERVATION' ? '观察目标' : '操作目标'}：</b>${escapeHtml(entry.expectedOutcome)}</p>` : ''}${entry.category === 'OBSERVATION' ? `<p class="entry-summary"><b>采集结果：</b>${entry.observation?.usable ? '现场证据可用' : '现场证据不可用'}</p>` : entry.summary ? `<p class="entry-summary">${escapeHtml(entry.summary)}</p>` : ''}
      ${action}${screenshots}${renderKnowledgeCandidates(report, entry.candidates)}${renderArtifacts(report, entry.artifacts)}
      <details class="technical-meta"><summary>技术标识</summary><code>全局记录序号 ${escapeHtml(entry.sequence)}</code><code>${escapeHtml(entry.operationId || '无操作标识')}</code>${entry.authorization?.planRevision ? `<code>计划版本 ${escapeHtml(entry.authorization.planRevision)}</code>` : ''}</details>
    </div>
  </div>`;
}

function renderOverviewPlan(report, narrative) {
  const plan = narrative.latestPlan;
  if (!plan) return '<p class="empty">Agent 尚未生成动态计划。</p>';
  return `<div class="overview-plan-head"><div><span>最新版本</span><b>${escapeHtml(plan.revision)}</b></div><div><span>调整原因</span><b>${escapeHtml(plan.reason)}</b></div></div>
    <ol class="overview-plan-list">${narrative.checkpoints.filter((item) => item.current).map((checkpoint) => `<li><span class="checkpoint-state ${className(checkpoint.executionStatus)}">${escapeHtml(label(CHECKPOINT_STATUS_LABELS, checkpoint.executionStatus, '未知'))}</span><div><b>${escapeHtml(checkpoint.goal)}</b><small>${checkpoint.actions.length} 次操作 · ${checkpoint.observations.length} 次观察 · ${checkpoint.requirementFindings.length || checkpoint.findings.length ? '已形成检查结果' : '尚未形成检查结果'}</small></div></li>`).join('')}</ol>`;
}

function renderStartPreparation(report, entries) {
  return entries.length ? `<div class="work-log">${entries.map((entry, index) => renderNarrativeEntry(report, entry, index + 1)).join('')}</div>` : '<p class="empty">本次执行没有单独记录起点恢复操作，Agent 从当前现场直接开始业务检查。</p>';
}

function renderCheckpointExecution(report, checkpoint) {
  const requirementText = checkpoint.requirements.length
    ? checkpoint.requirements.map((item, index) => `<li><span class="requirement-order">${index + 1}</span><span>${escapeHtml(item.text)}</span></li>`).join('')
    : '<li><span>未关联具体原文要求</span></li>';
  const result = checkpoint.findings.at(-1);
  const resultText = result?.summary || checkpoint.requirementFindings.map((item) => label(REQUIREMENT_STATUS_LABELS, item.status, '未确认')).join('、') || '尚未形成检查点结论';
  const findingStatuses = new Set(checkpoint.requirementFindings.map((item) => item.status));
  const incomplete = ['PENDING', 'ACTIVE', 'NOT_EXECUTED', 'SUPERSEDED'].includes(checkpoint.executionStatus);
  const tone = incomplete ? className(checkpoint.executionStatus)
    : findingStatuses.has('NOT_SATISFIED') ? 'fail' : findingStatuses.has('BLOCKED') || findingStatuses.has('UNRESOLVED')
      ? 'blocked' : findingStatuses.size && [...findingStatuses].every((item) => item === 'SATISFIED') ? 'pass' : className(checkpoint.executionStatus);
  const open = ['fail', 'blocked', 'active'].includes(tone);
  const recordVersions = checkpoint.recordPlanRevisions.length
    ? `<span>执行记录来自版本 ${checkpoint.recordPlanRevisions.map((item) => escapeHtml(item)).join('、')}</span>` : '';
  return `<details class="checkpoint-accordion ${tone}${checkpoint.current ? '' : ' historical'}"${open ? ' open' : ''}>
    <summary><div class="checkpoint-number">${escapeHtml(checkpoint.order)}</div><div class="checkpoint-summary-main"><div class="checkpoint-labels"><span>${checkpoint.current ? '当前计划' : '已移出当前计划'} · 版本 ${escapeHtml(checkpoint.planRevision ?? '-')}</span>${recordVersions}</div><h3>${escapeHtml(checkpoint.goal)}</h3><small>${checkpoint.actions.length} 次操作 · ${checkpoint.observations.length} 次观察</small></div><span class="checkpoint-result ${tone}">${escapeHtml(resultText)}</span><span class="fold-icon" aria-hidden="true"></span></summary>
    <div class="checkpoint-accordion-body"><div class="checkpoint-context"><div><span>关联原文要求</span><ul>${requirementText}</ul></div><div><span>检查结果</span><b>${escapeHtml(resultText)}</b></div><div><span>执行记录</span><b>${checkpoint.actions.length} 次操作 · ${checkpoint.observations.length} 次观察</b></div></div>
    ${checkpoint.entries.length ? `<div class="work-log">${checkpoint.entries.map((entry, index) => renderNarrativeEntry(report, entry, index + 1)).join('')}</div>` : '<p class="empty checkpoint-empty">该检查点尚无执行记录。</p>'}</div>
  </details>`;
}

function renderInvestigation(report, entries) {
  return entries.length ? `<div class="work-log">${entries.map((entry, index) => renderNarrativeEntry(report, entry, index + 1)).join('')}</div>` : '<p class="empty">本次执行没有触发异常调查、知识查询或恢复。</p>';
}

function renderConclusion(report, narrative) {
  const display = narrative.conclusion.display || {};
  return `<div class="conclusion"><div class="conclusion-primary"><span>最终结论</span><strong class="${className(display.status)}">${escapeHtml(label(VERDICT_LABELS, display.status, '未知'))}</strong><p>${escapeHtml(display.summary || '暂无结论')}</p><small>结论依据：${escapeHtml(label(BASIS_LABELS, display.verdictBasis))}</small></div><div class="conclusion-requirements"><h3>逐项要求结果</h3>${renderRequirements(report)}</div></div>${display.uncertainties?.length ? `<div class="uncertainties"><b>剩余不确定性</b>${display.uncertainties.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}`;
}

function renderStoryCard({ number, title, subtitle, meta, body, open = false, className: extraClass = '' }) {
  return `<details class="story-card ${extraClass}"${open ? ' open' : ''}><summary><span class="story-number">${escapeHtml(number)}</span><div class="story-title"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><span class="story-meta">${escapeHtml(meta)}</span><span class="fold-icon" aria-hidden="true"></span></summary><div class="story-card-body">${body}</div></details>`;
}

function renderExecutionOverview(report, trace) {
  const narrative = trace.narrative;
  const currentCheckpoints = narrative.checkpoints.filter((item) => item.current);
  const historicalCheckpoints = narrative.checkpoints.filter((item) => !item.current);
  const issueCheckpoints = currentCheckpoints.filter((checkpoint) => checkpoint.requirementFindings.some((item) => ['NOT_SATISFIED', 'BLOCKED', 'UNRESOLVED'].includes(item.status)));
  const understanding = narrative.understanding || {};
  const display = narrative.conclusion.display || {};
  const cards = [
    renderStoryCard({ number: '01', title: '原始用例', subtitle: '执行输入的原始内容', meta: `${markdownText(narrative.source.text).split('\n').length} 行`, body: `<div class="source-rendered">${renderSourceMarkdown(narrative.source.text || '')}</div>`, className: 'source-card' }),
    renderStoryCard({ number: '02', title: '用例理解', subtitle: '从原文提取的起点条件与验证要求', meta: `${(understanding.startConditions || []).length} 个起点 · ${(understanding.requirements || []).length} 项要求`, body: renderUnderstanding(report) }),
    renderStoryCard({ number: '03', title: '执行计划', subtitle: '本次执行最终采用的检查点集合', meta: `${currentCheckpoints.length} 个检查点`, body: renderOverviewPlan(report, narrative) }),
    renderStoryCard({ number: '04', title: '起点准备', subtitle: '进入并确认本用例所需起点', meta: `${narrative.startPreparation.length} 条记录`, body: renderStartPreparation(report, narrative.startPreparation) }),
    renderStoryCard({ number: '05', title: '检查点执行', subtitle: '当前计划中每个检查点的观察、操作、证据与结果', meta: issueCheckpoints.length ? `${currentCheckpoints.length} 个 · ${issueCheckpoints.length} 个需关注` : `${currentCheckpoints.length} 个 · 全部正常`, body: `<div class="checkpoint-executions">${currentCheckpoints.map((checkpoint) => renderCheckpointExecution(report, checkpoint)).join('') || '<p class="empty">暂无检查点执行记录。</p>'}</div>${historicalCheckpoints.length ? `<details class="plan-history"><summary>计划修订记录 <span>${historicalCheckpoints.length} 个已移除检查点</span></summary><p>以下记录属于执行过程中曾采用、但已不在当前计划中的检查点。</p><div class="checkpoint-executions">${historicalCheckpoints.map((checkpoint) => renderCheckpointExecution(report, checkpoint)).join('')}</div></details>` : ''}`, open: issueCheckpoints.length > 0, className: issueCheckpoints.length ? 'attention' : '' }),
    renderStoryCard({ number: '06', title: '异常调查', subtitle: '知识查询、结论复核与受控恢复', meta: narrative.investigation.length ? `${narrative.investigation.length} 条记录` : '未触发', body: renderInvestigation(report, narrative.investigation), open: narrative.investigation.length > 0, className: narrative.investigation.length ? 'attention' : '' }),
    renderStoryCard({ number: '07', title: '执行结论', subtitle: '结合现场证据与知识调查形成的结果', meta: label(VERDICT_LABELS, display.status, '未知'), body: renderConclusion(report, narrative), open: true, className: `conclusion-card ${className(display.status)}` }),
  ];
  return `<div class="overview-controls"><span>执行内容</span><div><button type="button" class="overview-control" id="expand-overview" title="展开全部内容"><span aria-hidden="true">＋</span>全部展开</button><button type="button" class="overview-control" id="collapse-overview" title="收起全部内容"><span aria-hidden="true">−</span>全部收起</button></div></div><div class="execution-story">${cards.join('')}</div>`;
}

function renderCurrentContextHtml(caseJson, report) {
  const display = report.display || {};
  const trace = buildExecutionTrace(report);
  const statusClass = className(display.status);
  const screenshotsJson = JSON.stringify(trace.screenshots.map((shot) => ({
    ...shot,
    time: formatDisplayTime(shot.time),
    phaseLabel: label(PHASE_LABELS, shot.phase),
    src: evidenceHref(report, shot.ref),
  }))).replace(/</g, '\\u003c');
  const filterCategories = ['ALL', 'ACTION', 'OBSERVATION', 'PLAN', 'KNOWLEDGE', 'RECOVERY', 'GUARD', 'PROTOCOL'];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(caseJson.identity?.title || '未命名用例')} - 执行详情</title>
<style>
:root{color-scheme:light;--bg:#f3f5f7;--surface:#fff;--text:#17212b;--muted:#65717e;--line:#d8dee5;--accent:#006d77;--accent-soft:#e5f2f2;--pass:#087f5b;--pass-soft:#e7f5ef;--fail:#c92a2a;--fail-soft:#fff0f0;--warn:#9c6500;--warn-soft:#fff7df;--ink:#334155}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font:inherit}a{color:var(--accent);font-weight:650;text-decoration:none}a:hover{text-decoration:underline}.page{width:min(1440px,calc(100vw - 32px));margin:20px auto 48px}.summary-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:18px 0 20px;border-bottom:1px solid var(--line)}h1{margin:0 0 5px;font-size:25px;line-height:1.3;overflow-wrap:anywhere;letter-spacing:0}.execution-id{color:var(--muted);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.verdict{flex:0 0 auto;padding:7px 11px;border-radius:5px;color:#fff;font-weight:800}.verdict.pass{background:var(--pass)}.verdict.fail{background:var(--fail)}.verdict.blocked{background:var(--warn)}.verdict.inconclusive,.verdict.unknown{background:#52606d}.summary-strip{display:grid;grid-template-columns:minmax(220px,2fr) repeat(5,minmax(110px,1fr));border-bottom:1px solid var(--line);background:var(--surface)}.summary-strip>div{min-width:0;padding:13px 15px;border-right:1px solid var(--line)}.summary-strip>div:last-child{border-right:0}.summary-strip span{display:block;color:var(--muted);font-size:11px}.summary-strip b{display:block;margin-top:2px;overflow-wrap:anywhere}.summary-strip .result-summary b{font-size:15px}.tabs{display:flex;gap:3px;margin-top:18px;border-bottom:1px solid var(--line)}.tab{min-height:40px;padding:8px 14px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);cursor:pointer;font-weight:750}.tab[aria-selected="true"]{border-color:var(--accent);color:var(--accent)}.panel{display:none}.panel.active{display:block}.trace-tools{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0}.filters{display:flex;flex-wrap:wrap;gap:6px}.filter{min-height:32px;padding:5px 10px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink);cursor:pointer}.filter.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:750}.trace-count{color:var(--muted);font-size:12px}.trace-layout{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:24px;align-items:start}.phase-group{margin:0 0 16px}.phase-head{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--line);border-left:4px solid var(--accent);background:#eaf0f2}.phase-head span{color:var(--accent);font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}.phase-head h2{margin:0;font-size:15px;letter-spacing:0}.phase-head b{color:var(--muted);font-size:12px}.trace-entry{display:grid;grid-template-columns:46px minmax(0,1fr);background:var(--surface);border:1px solid var(--line);border-top:0}.trace-entry[hidden]{display:none}.trace-rail{position:relative;display:flex;justify-content:center;padding-top:18px}.trace-rail:after{content:"";position:absolute;top:42px;bottom:-1px;width:1px;background:var(--line)}.trace-rail span{display:grid;place-items:center;width:25px;height:25px;border:1px solid var(--line);border-radius:50%;background:#f8fafc;color:var(--muted);font-size:11px;font-weight:800}.trace-body{min-width:0;padding:14px 15px 16px 0}.entry-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.entry-head>div{min-width:0}.entry-head h3{display:inline;margin:0 0 0 8px;font-size:15px;overflow-wrap:anywhere;letter-spacing:0}.category{display:inline-block;padding:2px 6px;border-radius:4px;background:#edf1f5;color:#455466;font-size:10px;font-weight:800}.category.action{background:#e7f0ff;color:#2456a6}.category.observation{background:var(--pass-soft);color:var(--pass)}.category.knowledge{background:#f3eefa;color:#6941a5}.category.guard,.category.recovery{background:var(--warn-soft);color:var(--warn)}.outcome{flex:0 0 auto;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:850}.outcome.pass{background:var(--pass-soft);color:var(--pass)}.outcome.fail{background:var(--fail-soft);color:var(--fail)}.outcome.blocked{background:var(--warn-soft);color:var(--warn)}.outcome.unknown{background:#edf1f5;color:#52606d}.entry-meta{display:flex;flex-wrap:wrap;gap:5px 12px;margin:6px 0;color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.entry-summary{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.decision-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:11px 0}.decision-fields div{min-width:0;padding-left:9px;border-left:2px solid var(--line)}dt{color:var(--muted);font-size:11px}dd{margin:1px 0 0;overflow-wrap:anywhere}.binding{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}.binding span{padding:2px 6px;border:1px solid var(--line);border-radius:4px;background:#f8fafc;color:var(--ink);font-size:10px}.action-spec{display:flex;align-items:flex-start;gap:10px;margin-top:11px;padding:8px 10px;border-left:3px solid #4f7dbd;background:#f6f8fb}.action-spec b{flex:0 0 auto}.action-spec code{min-width:0;color:#344256;overflow-wrap:anywhere;white-space:pre-wrap}.shot-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.shot-pair>div>small{display:block;margin-bottom:5px;color:var(--muted);font-weight:700}.shot-trigger{display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;gap:10px;width:100%;min-height:166px;padding:3px;border:1px solid var(--line);border-radius:5px;background:#f8fafc;color:var(--ink);cursor:pointer;text-align:left}.shot-trigger:hover,.shot-trigger:focus-visible{border-color:var(--accent);outline:2px solid transparent;background:var(--accent-soft)}.shot-trigger img{width:96px;height:160px;object-fit:contain;background:#111827;border-radius:3px}.shot-trigger span{padding-right:6px;overflow-wrap:anywhere;font-size:12px}.empty-shot{display:grid;place-items:center;min-height:166px;border:1px dashed var(--line);border-radius:5px;color:var(--muted);background:#f8fafc}.observation-row{display:grid;grid-template-columns:minmax(180px,290px) minmax(0,1fr);gap:13px;align-items:center;margin-top:11px}.observation-row p{margin:4px 0}.muted{color:var(--muted)}.retry{margin:10px 0 0;padding:8px 10px;background:var(--warn-soft);color:#654400}.artifacts{margin-top:10px}.artifacts summary{cursor:pointer;color:var(--accent);font-weight:700}.artifacts div{display:flex;flex-wrap:wrap;gap:10px;margin-top:7px}.recovery-anchor{position:sticky;top:14px;padding:14px;border:1px solid var(--line);background:var(--surface)}.aside-title{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}.aside-title span{font-size:16px;font-weight:800}.aside-title b{color:var(--warn);font-size:11px}.recovery-anchor>.shot-trigger{grid-template-columns:110px minmax(0,1fr);min-height:188px}.recovery-anchor>.shot-trigger img{width:110px;height:184px}.recovery-anchor dl{margin:12px 0}.recovery-anchor dl div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid #edf0f3}.recovery-anchor p{margin:12px 0 0;overflow-wrap:anywhere}.anchor-alert{margin-top:12px;padding:9px;background:var(--warn-soft)}.anchor-alert b,.anchor-alert span{display:block}.anchor-alert span{margin-top:4px}.empty{padding:24px;border:1px dashed var(--line);color:var(--muted);text-align:center}.result-layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:24px;padding-top:18px}.result-section{padding:0 0 18px;border-bottom:1px solid var(--line)}.result-section h2{margin:0 0 10px;font-size:17px;letter-spacing:0}.result-section pre,.raw-panel pre{max-height:520px;margin:0;padding:13px;border:1px solid var(--line);background:var(--surface);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.requirement{padding:12px 0;border-bottom:1px solid var(--line)}.requirement>div{display:flex;justify-content:space-between;gap:10px}.requirement span{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.requirement h3{margin:6px 0 2px;font-size:14px;letter-spacing:0}.requirement p{margin:4px 0;color:var(--muted)}.raw-panel{padding-top:18px}.raw-note{margin:0 0 10px;color:var(--muted)}dialog{width:min(1100px,calc(100vw - 28px));height:min(92vh,900px);padding:0;border:1px solid var(--line);background:#111827;color:#fff}dialog::backdrop{background:rgba(15,23,42,.74)}.viewer-head,.viewer-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:48px;padding:8px 12px;background:#1f2937}.viewer-head b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.viewer-actions{display:flex;gap:5px}.icon-button{display:grid;place-items:center;width:34px;height:34px;border:1px solid #4b5563;border-radius:4px;background:#273446;color:#fff;cursor:pointer;font-size:18px}.icon-button:hover{background:#374151}.viewer-stage{height:calc(100% - 96px);overflow:auto}.viewer-canvas{display:grid;place-items:center;min-width:100%;min-height:100%}.viewer-stage img{display:block;max-width:none;max-height:none;object-fit:contain}.viewer-foot{color:#d1d5db;font-size:12px}.mobile-viewer-hint{display:none}.hidden{display:none!important}
.action-spec{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start}.action-spec>b{white-space:nowrap}.action-spec dl{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0}.action-spec dl div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px;min-width:120px}.action-spec dd{color:#344256}.knowledge-list{display:grid;gap:7px;margin-top:10px}.knowledge-list>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:9px 10px;border-left:3px solid #6941a5;background:#faf8fc}.knowledge-list b{overflow-wrap:anywhere}.knowledge-list span{grid-column:1;color:var(--muted);font-size:11px}.knowledge-list a{grid-column:2;grid-row:1/3;align-self:center;white-space:nowrap}
@media(max-width:1050px){.summary-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.summary-strip .result-summary{grid-column:1/-1}.trace-layout{grid-template-columns:minmax(0,1fr) 300px}.shot-trigger{grid-template-columns:78px minmax(0,1fr);min-height:134px}.shot-trigger img{width:78px;height:128px}.recovery-anchor>.shot-trigger{grid-template-columns:90px minmax(0,1fr);min-height:154px}.recovery-anchor>.shot-trigger img{width:90px;height:150px}}
@media(max-width:760px){.page{width:calc(100vw - 20px);margin-top:10px}.summary-head{gap:10px;padding-top:8px}h1{font-size:21px}.summary-strip{grid-template-columns:1fr 1fr}.summary-strip .result-summary{grid-column:1/-1}.summary-strip>div{border-bottom:1px solid var(--line)}.tabs{overflow:auto}.tab{flex:0 0 auto}.trace-tools{align-items:flex-start;flex-direction:column}.trace-layout{display:block}.recovery-anchor{position:static;margin-bottom:15px}.trace-main{display:flex;flex-direction:column}.trace-main .recovery-anchor{order:-1}.trace-entry{grid-template-columns:36px minmax(0,1fr)}.trace-body{padding-right:10px}.decision-fields,.shot-pair,.observation-row,.result-layout{grid-template-columns:1fr}.shot-trigger,.recovery-anchor>.shot-trigger{grid-template-columns:72px minmax(0,1fr);min-height:126px}.shot-trigger img,.recovery-anchor>.shot-trigger img{width:72px;height:120px}.shot-trigger span{font-size:11px}.entry-head h3{display:block;margin:5px 0 0}.mobile-viewer-hint{display:block;color:var(--muted);font-size:11px}.recovery-anchor dl div{grid-template-columns:100px minmax(0,1fr)}}
@media(max-width:760px){.action-spec{grid-template-columns:1fr}.action-spec dl{display:grid;grid-template-columns:1fr 1fr}.action-spec dl div{min-width:0}}
.summary-strip{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px;border:0;background:transparent}.summary-strip>div{min-height:84px;padding:13px 15px;border:1px solid var(--line);border-radius:6px;background:var(--surface)}.summary-strip>div:last-child{border-right:1px solid var(--line)}.summary-strip .result-summary{grid-column:span 2;border-left:4px solid var(--accent)}.summary-strip.pass .result-summary{border-left-color:var(--pass)}.summary-strip.fail .result-summary{border-left-color:var(--fail)}.summary-strip.blocked .result-summary,.summary-strip.inconclusive .result-summary{border-left-color:var(--warn)}.summary-strip .result-summary b{max-width:680px}.category.protocol{background:var(--warn-soft);color:var(--warn)}@media(max-width:760px){.summary-strip{grid-template-columns:1fr 1fr;gap:7px}.summary-strip .result-summary{grid-column:1/-1}.summary-strip>div{min-height:76px;padding:11px 12px}}
.overview-panel{padding-top:22px}.execution-story{display:grid;gap:28px}.story-section{min-width:0;padding:0 0 28px;border-bottom:1px solid var(--line)}.story-section:last-child{border-bottom:0}.section-heading{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}.section-heading>span{display:grid;place-items:center;flex:0 0 auto;width:32px;height:32px;border:1px solid var(--accent);border-radius:50%;color:var(--accent);font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.section-heading h2{margin:0;font-size:18px;letter-spacing:0}.section-heading p{margin:2px 0 0;color:var(--muted);font-size:12px}.source-rendered{padding:16px 18px;border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--surface);overflow-wrap:anywhere}.source-rendered>:first-child{margin-top:0}.source-rendered>:last-child{margin-bottom:0}.source-rendered h3,.source-rendered h4,.source-rendered h5,.source-rendered h6{margin:18px 0 8px;letter-spacing:0}.source-rendered h3{font-size:18px}.source-rendered h4{font-size:15px}.source-rendered p{margin:8px 0;line-height:1.7}.source-rendered ol,.source-rendered ul{margin:8px 0;padding-left:24px}.source-rendered li{padding:3px 0;line-height:1.65}.source-rendered code{padding:1px 4px;border-radius:3px;background:#edf1f5;font-size:12px}.source-rendered pre{max-height:360px;padding:12px;background:#f7f8fa;overflow:auto;white-space:pre-wrap}.source-rendered blockquote{margin:10px 0;padding:8px 12px;border-left:3px solid var(--line);color:var(--muted)}.source-rendered hr{border:0;border-top:1px solid var(--line)}.understanding-summary{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;padding:13px 15px;background:#eef4f5}.understanding-summary span{color:var(--accent);font-size:11px;font-weight:800}.understanding-summary p{margin:0;font-weight:700}.understanding-columns{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:16px}.statement-group h3{margin:0 0 8px;font-size:13px}.statement{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;padding:10px 0;border-top:1px solid var(--line)}.statement .statement-order,.requirement-order{display:grid;place-items:center;width:20px;height:20px;margin:0;border-radius:50%;background:#e7eff0;color:var(--accent);font-size:10px;font-weight:800}.statement b,.statement div>span{display:block;overflow-wrap:anywhere}.statement div>span{margin-top:3px;color:var(--muted);font-size:11px}.uncertainties{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px;padding:10px 12px;background:var(--warn-soft)}.uncertainties b{margin-right:5px}.uncertainties span{padding-left:8px;border-left:1px solid #d8b86f}.overview-plan-head{display:grid;grid-template-columns:130px minmax(0,1fr);border:1px solid var(--line);background:var(--surface)}.overview-plan-head>div{padding:11px 13px}.overview-plan-head>div+div{border-left:1px solid var(--line)}.overview-plan-head span,.overview-plan-head b{display:block}.overview-plan-head span{color:var(--muted);font-size:11px}.overview-plan-head b{margin-top:3px}.overview-plan-list{margin:0;padding:0;border:1px solid var(--line);border-top:0;list-style:none}.overview-plan-list li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;padding:11px 13px;border-top:1px solid #edf0f3}.overview-plan-list li:first-child{border-top:0}.overview-plan-list b,.overview-plan-list small{display:block}.overview-plan-list small{margin-top:4px;color:var(--muted)}.checkpoint-state{align-self:start;padding:2px 6px;border-radius:4px;background:#edf1f5;color:var(--muted);font-size:10px;font-weight:800}.checkpoint-state.completed{background:var(--pass-soft);color:var(--pass)}.checkpoint-state.active{background:var(--accent-soft);color:var(--accent)}.checkpoint-executions{display:grid;gap:22px}.checkpoint-execution{border:1px solid var(--line);background:var(--surface)}.checkpoint-execution.historical{border-style:dashed}.checkpoint-execution-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:start;padding:14px 15px;background:#edf3f4;border-bottom:1px solid var(--line)}.checkpoint-execution.historical .checkpoint-execution-head{background:#f5f6f7}.checkpoint-number{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;font-weight:850}.checkpoint-labels{display:flex;flex-wrap:wrap;gap:6px 10px;color:var(--muted);font-size:11px}.checkpoint-execution-head h3{margin:4px 0 0;font-size:16px;letter-spacing:0}.checkpoint-context{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(160px,.8fr) minmax(150px,.7fr);border-bottom:1px solid var(--line)}.checkpoint-context>div{min-width:0;padding:11px 13px;border-right:1px solid var(--line)}.checkpoint-context>div:last-child{border-right:0}.checkpoint-context>div>span{display:block;color:var(--muted);font-size:11px}.checkpoint-context b{display:block;margin-top:4px;overflow-wrap:anywhere}.checkpoint-context ul{display:grid;gap:4px;margin:5px 0 0;padding:0;list-style:none}.checkpoint-context li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;font-size:12px}.work-log{padding:0 15px}.work-step{display:grid;grid-template-columns:34px minmax(0,1fr)}.work-step-marker{position:relative;display:flex;justify-content:center;padding-top:17px}.work-step-marker:after{content:"";position:absolute;top:43px;bottom:0;width:1px;background:var(--line)}.work-step:last-child .work-step-marker:after{display:none}.work-step-marker span{position:relative;z-index:1;display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--line);border-radius:50%;background:#fff;color:var(--muted);font-size:10px;font-weight:800}.work-step-body{min-width:0;padding:15px 0 18px 8px;border-bottom:1px solid #edf0f3}.work-step:last-child .work-step-body{border-bottom:0}.work-step-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.work-step-head>div{min-width:0}.work-step-head h4{display:inline;margin:0 0 0 8px;font-size:14px;overflow-wrap:anywhere;letter-spacing:0}.work-step-body>p{margin:7px 0 0;overflow-wrap:anywhere}.single-shot{width:min(100%,360px);margin-top:11px}.technical-meta{margin-top:10px;color:var(--muted);font-size:11px}.technical-meta summary{cursor:pointer}.technical-meta code{display:inline-block;margin:5px 10px 0 0}.checkpoint-empty{margin:14px}.conclusion{display:grid;grid-template-columns:minmax(240px,.65fr) minmax(0,1.35fr);gap:24px}.conclusion-primary{padding:16px;border-left:4px solid var(--accent);background:#eef4f5}.conclusion-primary>span{display:block;color:var(--muted);font-size:11px}.conclusion-primary strong{display:block;margin-top:4px;font-size:24px}.conclusion-primary strong.pass{color:var(--pass)}.conclusion-primary strong.fail{color:var(--fail)}.conclusion-primary strong.blocked{color:var(--warn)}.conclusion-primary p{margin:12px 0}.conclusion-primary small{color:var(--muted)}.conclusion-requirements h3{margin:0 0 5px;font-size:14px}.technical-panel{padding-top:18px}.technical-panel>.trace-tools{margin-top:0}
.overview-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.overview-controls>span{color:var(--muted);font-size:12px;font-weight:700}.overview-controls>div{display:flex;gap:6px}.overview-control{display:flex;align-items:center;gap:5px;min-height:32px;padding:5px 9px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink);cursor:pointer}.overview-control:hover,.overview-control:focus-visible{border-color:var(--accent);color:var(--accent)}.overview-control span{font-size:16px;line-height:1}.execution-story{gap:12px}.story-card{min-width:0;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:6px;background:var(--surface);overflow:hidden}.story-card.attention{border-left-color:var(--warn)}.story-card.conclusion-card.pass{border-left-color:var(--pass)}.story-card.conclusion-card.fail{border-left-color:var(--fail)}.story-card.conclusion-card.blocked,.story-card.conclusion-card.inconclusive{border-left-color:var(--warn)}.story-card>summary,.checkpoint-accordion>summary{list-style:none;cursor:pointer}.story-card>summary::-webkit-details-marker,.checkpoint-accordion>summary::-webkit-details-marker{display:none}.story-card>summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto 26px;align-items:center;gap:12px;min-height:70px;padding:12px 15px}.story-card[open]>summary{border-bottom:1px solid var(--line);background:#fafbfc}.story-number{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--accent);border-radius:50%;color:var(--accent);font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.story-title h2{margin:0;font-size:17px;letter-spacing:0}.story-title p{margin:2px 0 0;color:var(--muted);font-size:11px}.story-meta{justify-self:end;padding:3px 7px;border-radius:4px;background:#edf1f5;color:var(--ink);font-size:11px;font-weight:750;text-align:right}.fold-icon{display:grid;place-items:center;width:24px;height:24px;color:var(--muted);font-size:18px}.fold-icon:before{content:"+"}.story-card[open]>summary .fold-icon:before,.checkpoint-accordion[open]>summary .fold-icon:before{content:"−"}.story-card-body{padding:18px}.source-card .story-card-body{padding:0}.source-rendered{border:0}.checkpoint-executions{display:block;border-top:1px solid var(--line)}.checkpoint-accordion{border-bottom:1px solid var(--line);background:#fff}.checkpoint-accordion:last-child{border-bottom:0}.checkpoint-accordion.fail{border-left:3px solid var(--fail)}.checkpoint-accordion.blocked,.checkpoint-accordion.unresolved{border-left:3px solid var(--warn)}.checkpoint-accordion.pass,.checkpoint-accordion.verified{border-left:3px solid var(--pass)}.checkpoint-accordion.not-executed,.checkpoint-accordion.pending,.checkpoint-accordion.superseded{border-left:3px solid var(--line)}.checkpoint-accordion>summary{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(120px,auto) 26px;align-items:start;gap:12px;padding:14px 15px}.checkpoint-accordion[open]>summary{background:#f7f9fa;border-bottom:1px solid var(--line)}.checkpoint-summary-main{min-width:0}.checkpoint-summary-main h3{margin:4px 0 0;font-size:15px;letter-spacing:0;overflow-wrap:anywhere}.checkpoint-summary-main small{display:block;margin-top:4px;color:var(--muted)}.checkpoint-result{align-self:center;justify-self:end;max-width:280px;padding:3px 7px;border-radius:4px;background:#edf1f5;color:var(--ink);font-size:11px;font-weight:750;text-align:right;overflow-wrap:anywhere}.checkpoint-result.pass,.checkpoint-result.verified{background:var(--pass-soft);color:var(--pass)}.checkpoint-result.fail,.checkpoint-result.not-satisfied{background:var(--fail-soft);color:var(--fail)}.checkpoint-result.blocked,.checkpoint-result.unresolved{background:var(--warn-soft);color:var(--warn)}.checkpoint-state.verified{background:var(--pass-soft);color:var(--pass)}.checkpoint-state.not-satisfied{background:var(--fail-soft);color:var(--fail)}.checkpoint-state.blocked,.checkpoint-state.unresolved{background:var(--warn-soft);color:var(--warn)}.checkpoint-accordion-body{background:#fff}.checkpoint-context{border-top:0}.story-card-body>.understanding-summary:first-child,.story-card-body>.overview-plan-head:first-child{margin-top:0}.plan-history{margin-top:14px;border:1px solid var(--line);background:#f8fafc}.plan-history>summary{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;cursor:pointer;font-weight:750}.plan-history>summary span{color:var(--muted);font-size:11px}.plan-history>p{margin:0;padding:0 12px 10px;color:var(--muted);font-size:12px}.action-spec{margin-top:12px;padding:10px 12px;border:1px solid #d8e0ea;border-left:3px solid #4f7dbd;border-radius:4px;background:#f8fafc}.action-kind{display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #d8e0ea}.action-kind span{color:var(--muted);font-size:10px}.action-kind b{color:#24496f;font-size:14px}.action-spec dl{display:flex;flex-wrap:wrap;gap:7px 22px;margin:9px 0 0}.action-spec .action-field{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px;align-items:start;min-width:0;max-width:100%}.action-spec .action-field.wide{flex-basis:100%}.action-spec dt{font-size:10px;line-height:1.55}.action-spec dd{margin:0;color:#26384a;font-size:12px;line-height:1.55;overflow-wrap:anywhere}.shot-pair{display:flex;flex-wrap:wrap;align-items:flex-start;gap:14px;margin-top:12px}.shot-pair>div{flex:0 0 auto}.shot-pair>div>small{margin-bottom:5px}.shot-trigger{display:inline-flex;flex-direction:column;align-items:center;gap:5px;width:auto;min-width:104px;min-height:0;padding:4px 4px 7px}.shot-trigger img{display:block;width:auto;height:180px;max-width:min(150px,50vw);object-fit:contain}.shot-trigger span{padding:0 6px;font-size:11px}.single-shot{width:auto}.empty-shot{width:104px;min-height:120px}.checkpoint-labels span+span:before{content:"·";margin-right:10px;color:var(--line)}
@media(max-width:760px){.understanding-columns,.conclusion{grid-template-columns:1fr}.overview-plan-head,.checkpoint-context{grid-template-columns:1fr}.overview-plan-head>div+div{border-left:0;border-top:1px solid var(--line)}.checkpoint-context>div{border-right:0;border-bottom:1px solid var(--line)}.checkpoint-context>div:last-child{border-bottom:0}.work-log{padding:0 10px}.work-step{grid-template-columns:29px minmax(0,1fr)}.work-step-body{padding-left:5px}.work-step-head h4{display:block;margin:5px 0 0}.overview-controls{align-items:flex-start}.overview-controls>span{display:none}.story-card>summary{grid-template-columns:auto minmax(0,1fr) 24px;gap:9px;padding:11px 10px}.story-meta{grid-column:2;justify-self:start;text-align:left}.story-card-body{padding:13px}.story-title h2{font-size:15px}.checkpoint-accordion>summary{grid-template-columns:auto minmax(0,1fr) 24px;gap:9px;padding:12px 10px}.checkpoint-result{grid-column:2;justify-self:start;text-align:left}.checkpoint-number{width:27px;height:27px}.source-rendered{padding:14px}.action-spec{padding:9px 10px}.action-spec dl{gap:6px 14px}.action-spec .action-field{flex-basis:100%}.shot-trigger img{height:160px;max-width:42vw}.section-heading p{font-size:11px}}
</style></head><body><main class="page">
<header class="summary-head"><div><h1>${escapeHtml(caseJson.identity?.title || '未命名用例')}</h1><div class="execution-id">${caseJson.identity?.caseNo ? `用例 ${escapeHtml(caseJson.identity.caseNo)} · ` : ''}${escapeHtml(report.execution?.executionId || '-')}</div></div><span class="verdict ${escapeHtml(statusClass)}">${escapeHtml(label(VERDICT_LABELS, display.status, '未知'))}</span></header>
<section class="summary-strip ${escapeHtml(statusClass)}"><div class="result-summary"><span>执行结论</span><b>${escapeHtml(display.summary || '暂无结论')}</b></div><div><span>结论依据</span><b>${escapeHtml(label(BASIS_LABELS, display.verdictBasis))}</b></div><div><span>执行状态</span><b>${escapeHtml(label(EXECUTION_STATUS_LABELS, display.executionStatus))}</b></div><div><span>总耗时</span><b>${escapeHtml(formatDuration(display.durationMs))}</b></div><div><span>Agent 决策间隔</span><b>${escapeHtml(formatDuration(report.metrics?.timing?.agentDecisionGapMs))}</b></div><div><span>设备适配器工作</span><b>${escapeHtml(formatDuration(report.metrics?.timing?.adapterActiveMs))}</b></div><div><span>协议读取 / 拒绝</span><b>${escapeHtml(statusReadCount(report, trace))} / ${escapeHtml(report.metrics?.timing?.contractRejections ?? trace.counts.protocolRejections ?? 0)}</b></div><div><span>操作 / 观察</span><b>${trace.counts.actions} / ${trace.counts.observations}</b></div><div><span>暖会话 / 恢复</span><b>${escapeHtml(trace.recoveryAnchor.warmSessionGeneration ?? '-')} / ${escapeHtml(trace.recoveryAnchor.recoveryCount)}</b></div></section>
<nav class="tabs" aria-label="报告视图"><button class="tab" role="tab" aria-selected="true" data-panel="overview-panel">执行详情</button><button class="tab" role="tab" aria-selected="false" data-panel="technical-panel">技术记录</button><button class="tab" role="tab" aria-selected="false" data-panel="raw-panel">原始数据</button></nav>
<section id="overview-panel" class="panel active overview-panel" role="tabpanel">${renderExecutionOverview(report, trace)}</section>
<section id="technical-panel" class="panel technical-panel" role="tabpanel"><div class="trace-tools"><div class="filters">${filterCategories.map((category) => `<button type="button" class="filter${category === 'ALL' ? ' active' : ''}" data-filter="${category}">${category === 'ALL' ? '全部' : CATEGORY_LABELS[category]}</button>`).join('')}</div><span class="trace-count">显示 <b id="visible-count">${trace.entries.length}</b> / ${trace.entries.length}</span></div><div class="trace-layout"><div class="trace-main">${renderPhaseGroups(report, trace.entries)}</div>${renderRecoveryAnchor(report, trace.recoveryAnchor)}</div></section>
<section id="raw-panel" class="panel raw-panel" role="tabpanel"><p class="raw-note">底层协议数据的只读投影，字段名和枚举保留协议原值；时间按本地时区展示，输入类动作已脱敏。</p><pre>${jsonText(trace.raw)}</pre></section>
</main>
<dialog id="shot-dialog" aria-label="截图查看器"><div class="viewer-head"><b id="viewer-title">截图</b><div class="viewer-actions"><button type="button" class="icon-button" id="zoom-out" title="缩小" aria-label="缩小">−</button><button type="button" class="icon-button" id="zoom-in" title="放大" aria-label="放大">＋</button><button type="button" class="icon-button" id="fit-image" title="完整显示" aria-label="完整显示">⌗</button><button type="button" class="icon-button" id="actual-image" title="原始尺寸" aria-label="原始尺寸">1:1</button><button type="button" class="icon-button" id="close-viewer" title="关闭" aria-label="关闭">×</button></div></div><div class="viewer-stage" id="viewer-stage"><div class="viewer-canvas" id="viewer-canvas"><img id="viewer-image" alt="执行截图"></div></div><div class="viewer-foot"><button type="button" class="icon-button" id="previous-shot" title="上一张" aria-label="上一张">‹</button><span id="viewer-meta"></span><button type="button" class="icon-button" id="next-shot" title="下一张" aria-label="下一张">›</button></div></dialog>
<script>
const screenshots=${screenshotsJson};let currentShot=0;let scale=1;let viewMode='fit';const dialog=document.getElementById('shot-dialog');const stage=document.getElementById('viewer-stage');const canvas=document.getElementById('viewer-canvas');const image=document.getElementById('viewer-image');
function centerViewer(){stage.scrollLeft=Math.max(0,(canvas.scrollWidth-stage.clientWidth)/2);stage.scrollTop=Math.max(0,(canvas.scrollHeight-stage.clientHeight)/2);}
function applyScale(){const stageWidth=stage.clientWidth;const stageHeight=stage.clientHeight;if(!stageWidth||!stageHeight)return;const canvasScale=Math.max(1,scale);canvas.style.width=(stageWidth*canvasScale)+'px';canvas.style.height=(stageHeight*canvasScale)+'px';image.style.width=(stageWidth*scale)+'px';image.style.height=(stageHeight*scale)+'px';image.style.objectFit='contain';requestAnimationFrame(centerViewer);}
function applyActualSize(){const stageWidth=stage.clientWidth;const stageHeight=stage.clientHeight;if(!stageWidth||!stageHeight||!image.naturalWidth||!image.naturalHeight)return;canvas.style.width=Math.max(stageWidth,image.naturalWidth)+'px';canvas.style.height=Math.max(stageHeight,image.naturalHeight)+'px';image.style.width=image.naturalWidth+'px';image.style.height=image.naturalHeight+'px';image.style.objectFit='fill';requestAnimationFrame(centerViewer);}
function showShot(index,open){if(!screenshots.length)return;currentShot=(Number(index)+screenshots.length)%screenshots.length;const shot=screenshots[currentShot];scale=1;viewMode='fit';image.src=shot.src;image.alt=shot.title||'执行截图';document.getElementById('viewer-title').textContent=shot.title||shot.ref;document.getElementById('viewer-meta').textContent=(currentShot+1)+' / '+screenshots.length+' · '+(shot.phaseLabel||'')+' · '+(shot.time||'');if(open&&!dialog.open)dialog.showModal();requestAnimationFrame(applyScale);}
image.addEventListener('load',()=>{if(dialog.open){if(viewMode==='actual')applyActualSize();else applyScale();}});
document.querySelectorAll('.shot-trigger[data-shot]').forEach(button=>button.addEventListener('click',()=>showShot(button.dataset.shot,true)));
const overviewFolds=()=>document.querySelectorAll('#overview-panel details.story-card,#overview-panel details.checkpoint-accordion');
document.getElementById('expand-overview').addEventListener('click',()=>overviewFolds().forEach(item=>{item.open=true}));
document.getElementById('collapse-overview').addEventListener('click',()=>overviewFolds().forEach(item=>{item.open=false}));
document.getElementById('close-viewer').addEventListener('click',()=>dialog.close());document.getElementById('previous-shot').addEventListener('click',()=>showShot(currentShot-1,false));document.getElementById('next-shot').addEventListener('click',()=>showShot(currentShot+1,false));document.getElementById('zoom-in').addEventListener('click',()=>{const fromActual=viewMode==='actual';viewMode='zoom';scale=Math.min(4,fromActual?1.25:scale+.25);applyScale()});document.getElementById('zoom-out').addEventListener('click',()=>{const fromActual=viewMode==='actual';viewMode='zoom';scale=Math.max(.25,fromActual?.75:scale-.25);applyScale()});document.getElementById('fit-image').addEventListener('click',()=>{viewMode='fit';scale=1;applyScale()});document.getElementById('actual-image').addEventListener('click',()=>{viewMode='actual';scale=1;applyActualSize()});dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});window.addEventListener('resize',()=>{if(dialog.open){if(viewMode==='actual')applyActualSize();else applyScale();}});
document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(item=>item.setAttribute('aria-selected',String(item===tab)));document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===tab.dataset.panel));}));
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach(item=>item.classList.toggle('active',item===button));const filter=button.dataset.filter;let count=0;document.querySelectorAll('.trace-entry').forEach(entry=>{const visible=filter==='ALL'||entry.dataset.category===filter;entry.hidden=!visible;if(visible)count++});document.querySelectorAll('.phase-group').forEach(group=>group.classList.toggle('hidden',!group.querySelector('.trace-entry:not([hidden])')));document.getElementById('visible-count').textContent=count;}));
document.addEventListener('keydown',event=>{if(!dialog.open)return;if(event.key==='ArrowLeft')showShot(currentShot-1,false);if(event.key==='ArrowRight')showShot(currentShot+1,false)});
</script></body></html>\n`;
}

module.exports = { renderCurrentContextHtml, renderCurrentContextMarkdown, renderSourceMarkdown };
