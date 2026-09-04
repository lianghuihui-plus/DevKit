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
const { buildExecutionNarrative } = require('./execution-narrative');

const CATEGORY_LABELS = Object.freeze({
  UNDERSTANDING: '理解', DECISION: '决策', ACTION: '操作', OBSERVATION: '观察', GUARD: '完整性',
  PROTOCOL: '协议', KNOWLEDGE: '知识', RECOVERY: '恢复', RESULT: '结论',
});
const PHASE_LABELS = Object.freeze({
  UNDERSTAND: '理解用例', EXECUTE: '执行与检查', INVESTIGATE: '调查异常', RECOVERY: '恢复现场', CONCLUDE: '形成结论', FINALIZED: '执行完成', FRAMEWORK_CHECK: '框架校验', UNKNOWN: '未归类',
});
const VERDICT_LABELS = Object.freeze({ PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', INCONCLUSIVE: '无法判断', NOT_RUN: '未执行', RUNNING: '执行中', ABANDONED: '执行已废弃', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布' });
const BASIS_LABELS = Object.freeze({ DIRECT_EVIDENCE: '直接证据', INSUFFICIENT_EVIDENCE: '证据不足', TECHNICAL_CONSTRAINT: '技术约束' });
const EXECUTION_STATUS_LABELS = Object.freeze({ RUNNING: '执行中', FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复', PENDING_PUBLICATION: '待发布', COMPLETED: '执行完成', STOPPED_BY_BUDGET: '达到时限后停止', TECHNICALLY_BLOCKED: '技术阻塞', INTERRUPTED: '执行中断' });
const OUTCOME_LABELS = Object.freeze({ SUCCEEDED: '成功', FAILED: '失败', REJECTED: '已拒绝', UNCERTAIN: '结果待确认', UNKNOWN: '未知' });
const RETRY_LABELS = Object.freeze({ SAFE: '可安全重试', OBSERVE_FIRST: '先观察现场', AGENT_DECIDES: '由 Agent 判断', UNKNOWN: '未知' });
const OBSERVATION_PURPOSE_LABELS = Object.freeze({ INITIAL_SCENE: '初始现场', CURRENT_SCENE: '当前现场', POST_ACTION: '操作后', AFTER_UNKNOWN_ACTION: '未知动作后复核', POST_RECOVERY: '恢复后', AFTER_UNKNOWN_RECOVERY: '未知恢复后复核' });
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

const KNOWLEDGE_FIELD_LABELS = Object.freeze({ app: 'App', platform: '平台', version: '版本', page: '页面', operation: '操作' });

function knowledgeFilterSummary(value) {
  if (!value) return '';
  const counts = Object.entries(value.excludedBy || {})
    .map(([field, count]) => `${KNOWLEDGE_FIELD_LABELS[field] || field} 不匹配 ${count} 条`);
  const examples = (value.rejected || []).flatMap((item) => (item.mismatches || []).map((mismatch) =>
    `${item.entryId}：查询值 ${mismatch.query}，知识值 ${(mismatch.declared || []).join(', ')}`));
  const parts = [`扫描 ${value.scannedCount || 0} 条知识`];
  if (counts.length) parts.push(counts.join('、'));
  if (value.noRelevantMatchCount) parts.push(`词面和适用范围均未形成候选 ${value.noRelevantMatchCount} 条`);
  if (examples.length) parts.push(examples.join('；'));
  return parts.join('；');
}

function runtimeTiming(report, field) {
  return report.metrics?.[field] ?? null;
}

function agentTiming(report, field) {
  return report.metrics?.agentTiming?.[field] ?? null;
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

function htmlEvidence(report, ref, label = ref) {
  const href = evidenceHref(report, ref);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function renderCurrentContextMarkdown(caseJson, report) {
  const display = report.display || {};
  const narrative = buildExecutionNarrative(report);
  const lines = [
    `# ${caseJson.identity?.caseNo ? `${caseJson.identity.caseNo} · ` : ''}${caseJson.identity?.title || '未命名用例'}`, '',
    `- 执行结论：${label(VERDICT_LABELS, display.verdict || display.status, '未执行')}`,
    `- 执行标识：${report.execution?.executionId || '-'}`,
    `- 耗时：${formatDuration(display.durationMs)}`,
    `- 验证点覆盖：${narrative.coverage.covered}/${narrative.coverage.total}`,
    `- 执行记录：${{ COMPLETE: '完整', PARTIAL: '部分缺失', UNAVAILABLE: '不可用' }[narrative.recordingStatus] || '不可用'}`, '',
    '## 原始用例', '', report.sourceText || '未记录', '',
    '## Agent 用例理解', '', narrative.understanding?.summary || '未记录', '',
    `- 前置条件：${narrative.understanding?.preconditions?.join('；') || '无'}`,
    `- 验证点：${narrative.understanding?.expectations?.map((item) => `${item.id} ${item.text}`).join('；') || '未记录'}`,
    `- 不确定项：${narrative.understanding?.uncertainties?.join('；') || '无'}`,
    `- 理解记录：${narrative.understandingHistory.length} 个版本`, '',
    '## 初始计划', '',
    ...(narrative.initialPlan?.items?.length ? narrative.initialPlan.items.map((item, index) => `${index + 1}. ${item}`) : ['- 未记录']),
  ];
  const planUpdates = narrative.planHistory.slice(1);
  if (planUpdates.length) {
    lines.push('', '## 计划调整', '');
    for (const update of planUpdates) {
      lines.push(`- 版本 ${update.version}：${update.reason || 'Agent 调整计划'}`,
        `  - ${update.items.join('；') || '未记录后续计划'}`);
    }
  }
  lines.push('', '## 执行过程', '');
  for (const step of narrative.steps) {
    lines.push(`${step.number}. ${step.purpose || step.operation}`,
      `   - 操作前观察：${step.observation || '未记录'}`,
      `   - 当时结论：${step.conclusion || '未记录'}`,
      `   - 关联验证点：${step.expectations.map((item) => `${item.ref} ${item.text} [${item.status}]`).join('；') || '未关联'}`,
      `   - 期望结果：${step.expectedOutcome || '未记录'}`,
      `   - 实际操作：${step.action ? actionLabel(step.action.value?.type) : step.operation}`,
      `   - 操作结果：${step.action?.status || step.recovery?.status || (step.knowledge ? `知识候选 ${step.knowledge.candidateCount}` : '-')}`,
      `   - 操作后观察：${step.postAssessment?.observation || '由后续步骤继续判断'}`,
      `   - 操作后结论：${step.postAssessment?.conclusion || '未单独记录'}`);
    if (step.knowledge?.review) {
      lines.push(`   - 知识复核：${step.knowledge.review.conclusion}`,
        ...step.knowledge.review.assessments.map((item) => `     - ${item.entryId} [${item.status}] ${item.reason}`));
    }
    if (step.knowledge?.candidateCount === 0 && step.knowledge.filterDiagnostics) {
      lines.push(`   - 未命中诊断：${knowledgeFilterSummary(step.knowledge.filterDiagnostics)}`);
    }
    if (step.planUpdate) lines.push(`   - 计划调整：${step.planUpdate.reason}；${step.planUpdate.next.join('；')}`);
  }
  lines.push('', '## 最终判断', '',
    `- 现场观察：${narrative.finalDecision?.observation || '未记录'}`,
    `- 判断结论：${narrative.finalDecision?.conclusion || '未记录'}`,
    `- 收口目的：${narrative.finalDecision?.purpose || '未记录'}`,
    '', '## 最终检查', '');
  for (const check of narrative.checks) {
    lines.push(`- [${check.status}] ${check.expectation}`, `  - 实际结果：${check.actual || check.reason || '未记录'}`, `  - 相关步骤：${(check.relatedSteps || []).map((step) => `步骤 ${step.number}`).join('、') || '无'}`, `  - 现场证据：${(check.sceneRefs || []).join('、') || '无'}`, `  - 知识依据：${(check.knowledgeRefs || []).join('、') || '无'}`);
    if (check.technicalFacts.length) {
      for (const fact of check.technicalFacts) {
        lines.push(`  - 技术事实：${fact.ref} [${fact.state === 'VALID' ? '有效' : '无效'}] ${fact.code} · ${fact.message}`,
          `    - 时间：${fact.time || '-'}；操作：${fact.operation || '-'}${fact.operationId ? ` / ${fact.operationId}` : ''}；Scene：${fact.sceneId || '-'}；generation：${fact.generation ?? '-'}`,
          `    - 状态说明：${fact.stateReason}`);
      }
    } else lines.push('  - 技术事实：无');
  }
  if (narrative.gaps.length) lines.push('', '## 记录缺口', '', ...narrative.gaps.map((gap) => `- ${gap.message}`));
  return `${lines.join('\n')}\n`;
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
  const baseSrc = shot.baseRef ? evidenceHref(report, shot.baseRef) : null;
  const media = baseSrc
    ? `<span class="shot-media"><img class="shot-base" src="${escapeHtml(baseSrc)}" alt="${escapeHtml(label)}" loading="lazy"><img class="shot-overlay" src="${escapeHtml(src)}" alt="" loading="lazy"></span>`
    : `<span class="shot-media"><img class="shot-base" src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy"></span>`;
  return `<button type="button" class="shot-trigger" data-shot="${escapeHtml(shot.index)}" title="在当前页面查看 ${escapeHtml(label)}">
    ${media}
    <span>${escapeHtml(label)}</span>
  </button>`;
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
    const assessment = candidate.assessment
      ? `<span><b>${escapeHtml(candidate.assessment.status)}</b> · ${escapeHtml(candidate.assessment.reason)}</span>` : '';
    return `<div><b>${escapeHtml(candidate.entryId)} ${escapeHtml(candidate.title || '')}</b>${scope ? `<span>${escapeHtml(scope)}</span>` : ''}${assessment}${candidate.snapshotRef ? htmlEvidence(report, candidate.snapshotRef, '查看冻结知识') : ''}</div>`;
  }).join('')}</div>`;
}

function renderKnowledgeInvestigation(report, investigation) {
  const assessments = new Map((investigation.review?.assessments || []).map((item) => [item.entryId, item]));
  const candidates = investigation.candidates.map((candidate) => ({ ...candidate, assessment: assessments.get(candidate.entryId) || null }));
  const conclusion = investigation.review?.conclusion || '待复核';
  return `<article class="knowledge-investigation"><header><div><b>${escapeHtml(investigation.query)}</b><span>${escapeHtml(investigation.queryId)} · ${escapeHtml((investigation.expectationRefs || []).join('、') || '未关联验证点')}</span></div><strong>${escapeHtml(conclusion)}</strong></header>${candidates.length ? renderKnowledgeCandidates(report, candidates) : '<p>未检索到候选，调查已闭合。</p>'}</article>`;
}

function coordinateText(value) {
  if (!value) return '-';
  if (value.point) return `(${value.point.x}, ${value.point.y})`;
  if (value.from && value.to) return `(${value.from.x}, ${value.from.y}) -> (${value.to.x}, ${value.to.y})`;
  return '-';
}

function renderCoordinateAudit(audit, coordinateScreenshot = null) {
  if (!audit) return '';
  const overlay = coordinateScreenshot
    ? `<button type="button" class="coordinate-overlay-button" data-shot="${escapeHtml(coordinateScreenshot.index)}">查看坐标标记</button>`
    : '';
  return `<div class="coordinate-audit"><div><span>定位来源</span><b>${escapeHtml(label(ACTION_VALUE_LABELS, audit.source, audit.source))}</b></div><div><span>请求坐标</span><b>${escapeHtml(coordinateText(audit.requested))}</b></div><div><span>真实执行坐标</span><b>${escapeHtml(coordinateText(audit.executed))}</b></div><div><span>传递校验</span><b class="audit-matched">一致</b>${overlay}</div></div>`;
}

function renderActionSpec(action, coordinateAudit = null, coordinateScreenshot = null) {
  if (!action) return '';
  const fields = actionDetails(action).map((detail) => {
    const wide = ['坐标证据', '操作原因'].includes(detail.label) || String(detail.value).length > 56;
    return `<div class="action-field${wide ? ' wide' : ''}"><dt>${escapeHtml(detail.label)}</dt><dd>${escapeHtml(detail.value)}</dd></div>`;
  }).join('');
  return `<div class="action-spec"><div class="action-kind"><span>执行操作</span><b>${escapeHtml(actionLabel(action.type))}</b></div><dl>${fields}</dl></div>${renderCoordinateAudit(coordinateAudit, coordinateScreenshot)}`;
}

function renderEntry(report, entry) {
  const outcome = entry.outcome ? `<span class="outcome ${outcomeClass(entry.outcome.status)}">${escapeHtml(label(OUTCOME_LABELS, entry.outcome.status))}</span>` : '';
  const meta = [formatDisplayTime(entry.time), entry.durationMs !== null ? formatDuration(entry.durationMs) : null, entry.operationId].filter(Boolean);
  const intent = entry.intent || entry.expectedOutcome ? `<dl class="decision-fields">${entry.intent ? `<div><dt>Agent 意图</dt><dd>${escapeHtml(entry.intent)}</dd></div>` : ''}${entry.expectedOutcome ? `<div><dt>预期结果</dt><dd>${escapeHtml(entry.expectedOutcome)}</dd></div>` : ''}</dl>` : '';
  const action = renderActionSpec(entry.action, entry.coordinateAudit, entry.coordinateScreenshot);
  const compare = entry.category === 'ACTION' ? `<div class="shot-pair"><div><small>操作前</small>${renderScreenshot(report, entry.beforeScreenshot, '操作前现场')}</div><div><small>操作后</small>${renderScreenshot(report, entry.afterScreenshot, '操作后现场')}</div></div>` : '';
  const observation = entry.category === 'OBSERVATION' ? `<div class="observation-row">${renderScreenshot(report, entry.screenshot, label(OBSERVATION_PURPOSE_LABELS, entry.observationPurpose, '现场截图'))}<div><b>${entry.observation?.usable ? '证据可用' : '证据不可用'}</b><p>${escapeHtml(entry.observation?.app?.foregroundApp || '未记录前台 App')}</p><p class="muted">${escapeHtml(label(OBSERVATION_PURPOSE_LABELS, entry.observationPurpose, 'Agent 自主观察'))}${entry.relatedOperationId ? ` · 关联操作 ${escapeHtml(entry.relatedOperationId)}` : ''}</p></div></div>` : '';
  const retry = entry.retrySafety ? `<p class="retry"><b>重试策略</b> ${escapeHtml(label(RETRY_LABELS, entry.retrySafety.status))}：${escapeHtml(entry.retrySafety.reason)}</p>` : '';
  return `<article class="trace-entry" data-category="${escapeHtml(entry.category)}">
    <div class="trace-rail"><span>${escapeHtml(entry.sequence)}</span></div>
    <div class="trace-body">
      <div class="entry-head"><div><span class="category ${className(entry.category)}">${escapeHtml(CATEGORY_LABELS[entry.category] || '未归类')}</span><h3>${escapeHtml(entry.title)}</h3></div>${outcome}</div>
      <div class="entry-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      ${entry.summary ? `<p class="entry-summary">${escapeHtml(entry.summary)}</p>` : ''}
      ${intent}${action}${compare}${observation}${renderKnowledgeCandidates(report, entry.candidates)}${retry}${renderArtifacts(report, entry.artifacts)}
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
      <div><dt>最后操作</dt><dd>${escapeHtml(anchor.lastCompletedOperation?.operationId || '-')}</dd></div>
      <div><dt>待确认操作</dt><dd>${escapeHtml(anchor.pendingOrUncertainOperation?.operationId || '无')}</dd></div>
      <div><dt>暖会话代次</dt><dd>${escapeHtml(anchor.warmSessionGenerationStart ?? '-')} - ${escapeHtml(anchor.warmSessionGenerationEnd ?? '-')}</dd></div>
      <div><dt>本次 / 批次恢复</dt><dd>${escapeHtml(anchor.executionRecoveryCount)} / ${escapeHtml(anchor.batchRecoveryCountAtStart)}-${escapeHtml(anchor.batchRecoveryCountAtEnd)}</dd></div>
    </dl>
    ${anchor.lastKnowledgeInvestigation ? `<p><b>最近知识调查</b><br>${escapeHtml(anchor.lastKnowledgeInvestigation.title)}：${escapeHtml(anchor.lastKnowledgeInvestigation.summary)}</p>` : ''}
    ${anchor.remainingUncertainties.length ? `<div class="anchor-alert"><b>剩余不确定性</b>${anchor.remainingUncertainties.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
  </aside>`;
}

function renderOutcomeSummary(report, trace) {
  const display = report.display || {};
  return `<section class="case-outcome ${className(display.status)}"><div class="outcome-copy"><span>执行结果</span><div><strong>${escapeHtml(label(VERDICT_LABELS, display.status, '未知'))}</strong><small>${escapeHtml(label(BASIS_LABELS, display.verdictBasis))}</small></div><p>${escapeHtml(display.summary || '暂无结论')}</p></div><dl class="outcome-stats"><div><dt>总耗时</dt><dd>${escapeHtml(formatDuration(display.durationMs))}</dd></div><div><dt>操作</dt><dd>${trace.counts.actions}</dd></div><div><dt>观察</dt><dd>${trace.counts.observations}</dd></div></dl></section>
    <details class="run-info"><summary>运行信息</summary><dl><div><dt>执行状态</dt><dd>${escapeHtml(label(EXECUTION_STATUS_LABELS, display.executionStatus))}</dd></div><div><dt>Runtime 工作</dt><dd>${escapeHtml(formatDuration(runtimeTiming(report, 'runtimeActiveMs')))}</dd></div><div><dt>Agent 与调度间隔（估算）</dt><dd>${escapeHtml(formatDuration(runtimeTiming(report, 'agentAndSchedulingGapMs')))}</dd></div><div><dt>首次准备间隔</dt><dd>${escapeHtml(formatDuration(agentTiming(report, 'firstPreparationMs')))}</dd></div><div><dt>步骤决策间隔</dt><dd>${escapeHtml(formatDuration(agentTiming(report, 'stepDecisionMs')))}</dd></div><div><dt>结论整理间隔</dt><dd>${escapeHtml(formatDuration(agentTiming(report, 'conclusionPreparationMs')))}</dd></div><div><dt>未归类间隔</dt><dd>${escapeHtml(formatDuration(agentTiming(report, 'unclassifiedGapMs')))}</dd></div><div><dt>设备适配器工作</dt><dd>${escapeHtml(formatDuration(runtimeTiming(report, 'adapterActiveMs')))}</dd></div><div><dt>动作 / 现场采集</dt><dd>${escapeHtml(formatDuration(runtimeTiming(report, 'actionDeviceMs')))} / ${escapeHtml(formatDuration(runtimeTiming(report, 'observationCaptureMs')))}</dd></div><div><dt>稳定等待 / 显式等待</dt><dd>${escapeHtml(formatDuration(runtimeTiming(report, 'postActionSettleMs')))} / ${escapeHtml(formatDuration(runtimeTiming(report, 'explicitWaitMs')))}</dd></div><div><dt>知识 / 恢复控制 / 其他</dt><dd>${escapeHtml(formatDuration(runtimeTiming(report, 'knowledgeQueryMs')))} / ${escapeHtml(formatDuration(runtimeTiming(report, 'recoveryControlMs')))} / ${escapeHtml(formatDuration(runtimeTiming(report, 'runtimeOverheadMs')))}</dd></div><div><dt>Runtime 调用 / 格式错误</dt><dd>${escapeHtml(runtimeTiming(report, 'invocationCount') ?? 0)} / ${escapeHtml(runtimeTiming(report, 'invocationErrorCount') ?? 0)}</dd></div><div><dt>暖会话</dt><dd>${report.metrics?.warmSessionReused ? '已复用批次 App 状态' : '批次首用例'}</dd></div><div><dt>暖会话代次</dt><dd>${escapeHtml(trace.recoveryAnchor.warmSessionGenerationStart ?? '-')} - ${escapeHtml(trace.recoveryAnchor.warmSessionGenerationEnd ?? '-')}</dd></div><div><dt>本次恢复</dt><dd>${escapeHtml(trace.recoveryAnchor.executionRecoveryCount)}</dd></div></dl></details>`;
}

function sceneShot(trace, scene) {
  if (!scene?.screenshotRef) return null;
  return trace.screenshots.find((shot) => shot.ref === scene.screenshotRef) || null;
}

function renderNarrativeChecks(report, narrative) {
  if (!narrative.checks.length) return '<p class="empty">尚未形成最终检查。</p>';
  return `<div class="narrative-checks">${narrative.checks.map((check) => {
    const tone = check.status === 'PASS' ? 'pass' : check.status === 'FAIL' ? 'fail' : 'blocked';
    const sceneLinks = (check.sceneRefs || []).map((ref, index) => htmlEvidence(report, `scenes/${ref}.json`, `现场 ${index + 1}`));
    const knowledgeLinks = (check.knowledge || []).map((item) => item.snapshotRef
      ? htmlEvidence(report, item.snapshotRef, `知识 ${item.entryId}`) : `知识 ${escapeHtml(item.entryId)}`);
    const stepLinks = (check.relatedSteps || []).map((step) => `<span>步骤 ${escapeHtml(step.number)}</span>`);
    const evidence = [...stepLinks, ...sceneLinks, ...knowledgeLinks];
    const technicalFactsHtml = (check.technicalFacts || []).map((fact) => `<details class="technical-fact ${fact.state === 'VALID' ? 'valid' : 'invalid'}"><summary><b>${escapeHtml(fact.code)}</b><span>${fact.state === 'VALID' ? '有效' : '无效'}</span></summary><p>${escapeHtml(fact.message)}</p><dl><div><dt>引用</dt><dd>${escapeHtml(fact.ref)}</dd></div><div><dt>时间</dt><dd>${escapeHtml(formatDisplayTime(fact.time))}</dd></div><div><dt>操作</dt><dd>${escapeHtml(fact.operation || '-')}${fact.operationId ? ` / ${escapeHtml(fact.operationId)}` : ''}</dd></div><div><dt>现场</dt><dd>${escapeHtml(fact.sceneId || '-')}</dd></div><div><dt>generation</dt><dd>${escapeHtml(fact.generation ?? '-')}</dd></div><div><dt>状态说明</dt><dd>${escapeHtml(fact.stateReason)}</dd></div></dl></details>`).join('');
    return `<article class="narrative-check ${tone}"><header><span>${escapeHtml(check.expectationRef || '-')}</span><b>${escapeHtml(check.expectation)}</b><strong>${escapeHtml(label(VERDICT_LABELS, check.status, check.status))}</strong></header><p>${escapeHtml(check.actual || check.reason || '未记录实际结果')}</p><div>${evidence.join('') || '<span>无现场、步骤或知识证据</span>'}</div>${technicalFactsHtml}</article>`;
  }).join('')}</div>`;
}

function renderNarrativeSteps(report, trace, narrative) {
  if (!narrative.steps.length) return '<p class="empty">尚未记录业务执行步骤。</p>';
  return `<div class="narrative-steps">${narrative.steps.map((step) => {
    const before = sceneShot(trace, step.beforeScene);
    const after = sceneShot(trace, step.afterScene);
    const outcome = step.action?.status || step.recovery?.status || (step.knowledge ? `知识候选 ${step.knowledge.candidateCount}` : step.operation);
    const coordinateScreenshot = trace.screenshots.find((shot) => shot.operationId === step.action?.operationId && shot.purpose === 'COORDINATE_AUDIT') || null;
    const expectations = step.expectations.length
      ? `<div class="step-expectations">${step.expectations.map((item) => `<div class="${className(item.status)}"><b>${escapeHtml(item.ref)} ${escapeHtml(item.text)}</b><span>${escapeHtml(label(VERDICT_LABELS, item.status, item.status === 'NOT_ASSESSED' ? '未形成最终检查' : item.status))}${item.actual ? ` · ${escapeHtml(item.actual)}` : ''}</span></div>`).join('')}</div>`
      : '';
    const knowledgeDiagnosis = step.knowledge?.candidateCount === 0 && step.knowledge.filterDiagnostics
      ? `<p>未命中诊断：${escapeHtml(knowledgeFilterSummary(step.knowledge.filterDiagnostics))}</p>` : '';
    return `<article class="narrative-step" id="step-${step.number}"><header><span>${step.number}</span><div><small>${escapeHtml(formatDisplayTime(step.time))} · ${escapeHtml(step.operation)}</small><h3>${escapeHtml(step.purpose || '未记录操作目的')}</h3></div><b>${escapeHtml(outcome || '-')}</b></header>${expectations}<div class="narrative-decision"><div><span>操作前观察</span><p>${escapeHtml(step.observation || '未记录')}</p></div><div><span>当时结论</span><p>${escapeHtml(step.conclusion || '未记录')}</p></div><div><span>期望结果</span><p>${escapeHtml(step.expectedOutcome || '未记录')}</p></div></div>${step.action ? `<div class="narrative-action"><span>实际操作</span>${renderActionSpec(step.action.value, step.action.coordinateAudit, coordinateScreenshot)}</div>` : step.knowledge ? `<div class="narrative-action"><b>知识调查</b> ${escapeHtml(step.knowledge.query)} · ${step.knowledge.candidateCount} 个候选${step.knowledge.review ? `<p>复核结论：${escapeHtml(step.knowledge.review.conclusion)}</p>` : '<p>候选尚未复核</p>'}${knowledgeDiagnosis}</div>` : step.recovery ? `<p class="narrative-action"><b>现场恢复</b> ${escapeHtml(step.recovery.reason)}</p>` : ''}<div class="narrative-shots"><div><small>操作前现场</small>${renderScreenshot(report, before, '操作前现场')}</div><div><small>操作后现场</small>${renderScreenshot(report, after, '操作后现场')}</div></div><div class="post-assessment"><span>操作后的结论</span><p>${escapeHtml(step.postAssessment?.observation || '未单独记录操作后观察')}</p><b>${escapeHtml(step.postAssessment?.conclusion || '由后续步骤继续判断')}</b></div>${step.planUpdate ? `<div class="plan-update"><span>计划调整</span><b>${escapeHtml(step.planUpdate.reason)}</b><p>${escapeHtml(step.planUpdate.next.join('；'))}</p></div>` : ''}</article>`;
  }).join('')}</div>`;
}

function renderFinalDecision(narrative) {
  const decision = narrative.finalDecision;
  if (!decision) return '<p class="empty">未记录最终判断。</p>';
  return `<div class="final-decision"><div><span>最终现场观察</span><p>${escapeHtml(decision.observation || '未记录')}</p></div><div><span>判断结论</span><p>${escapeHtml(decision.conclusion || '未记录')}</p></div><div><span>收口目的</span><p>${escapeHtml(decision.purpose || '未记录')}</p></div></div>`;
}

function renderNarrativeReview(report, trace, narrative) {
  const understanding = narrative.understanding;
  const recording = narrative.recordingStatus === 'COMPLETE'
    ? '<span class="recording-state pass">执行记录完整</span>'
    : narrative.recordingStatus === 'PARTIAL'
      ? `<span class="recording-state blocked">执行记录部分缺失${narrative.gaps.length ? ` · ${narrative.gaps.length} 处缺口` : ''}</span>`
      : '<span class="recording-state unavailable">执行记录不可用</span>';
  const investigations = narrative.knowledgeInvestigations.length
    ? narrative.knowledgeInvestigations.map((item) => renderKnowledgeInvestigation(report, item)).join('')
    : '<p class="empty">本次执行未触发知识调查。</p>';
  const understandingHistory = narrative.understandingHistory.length > 1
    ? `<details class="understanding-history"><summary>查看 ${narrative.understandingHistory.length} 个理解版本</summary>${narrative.understandingHistory.map((item) => `<div><b>版本 ${escapeHtml(item.version)} · ${escapeHtml(item.reason || 'Agent 更新')}</b><p>${escapeHtml(item.caseContext.summary)}</p><small>${escapeHtml(formatDisplayTime(item.time))}</small></div>`).join('')}</details>`
    : '';
  const planUpdates = narrative.planHistory.slice(1);
  const planHistory = planUpdates.length
    ? `<div class="plan-history"><h3>计划调整</h3>${planUpdates.map((item) => `<div><header><b>版本 ${escapeHtml(item.version)}</b><span>${escapeHtml(formatDisplayTime(item.time))}</span></header><p>${escapeHtml(item.reason || 'Agent 调整计划')}</p><ol>${item.items.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ol></div>`).join('')}</div>`
    : '';
  const understandingHtml = understanding
    ? `<p class="understanding-lead">${escapeHtml(understanding.summary)}</p><div class="understanding-grid"><div><span>前置条件</span>${understanding.preconditions.length ? `<ul>${understanding.preconditions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>无</p>'}</div><div><span>验证点</span><ol>${understanding.expectations.map((item) => `<li><b>${escapeHtml(item.id)}</b>${escapeHtml(item.text)}</li>`).join('')}</ol></div><div><span>不确定项</span>${understanding.uncertainties.length ? `<ul>${understanding.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>无</p>'}</div></div>${understandingHistory}`
    : '<p class="empty">未记录用例理解。</p>';
  const initialPlanHtml = narrative.initialPlan?.items?.length
    ? `<ol class="initial-plan">${narrative.initialPlan.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`
    : '<p class="empty">未记录初始计划。</p>';
  return `<div class="narrative-review"><section class="review-section"><div class="review-heading"><div><span>原始输入</span><h2>原始用例</h2></div>${recording}</div><div class="source-rendered">${renderSourceMarkdown(report.sourceText || '')}</div></section><section class="review-section"><div class="review-heading"><div><span>Agent 判断</span><h2>用例理解</h2></div><small>第 ${escapeHtml(narrative.contextVersion || '-')} 次记录</small></div>${understandingHtml}</section><section class="review-section"><div class="review-heading"><div><span>执行策略</span><h2>初始计划</h2></div></div>${initialPlanHtml}${planHistory}</section><section class="review-section"><div class="review-heading"><div><span>现场时间线</span><h2>执行过程</h2></div><small>${narrative.steps.length} 个业务决策</small></div>${renderNarrativeSteps(report, trace, narrative)}</section><section class="review-section"><div class="review-heading"><div><span>异常调查</span><h2>知识调查与复核</h2></div><small>${narrative.knowledgeInvestigations.length} 次查询</small></div>${investigations}</section><section class="review-section"><div class="review-heading"><div><span>Agent 收口</span><h2>最终判断</h2></div></div>${renderFinalDecision(narrative)}</section><section class="review-section"><div class="review-heading"><div><span>结果闭环</span><h2>最终检查与证据</h2></div><small>覆盖 ${narrative.coverage.covered}/${narrative.coverage.total}</small></div>${renderNarrativeChecks(report, narrative)}</section>${narrative.gaps.length ? `<section class="review-section narrative-gaps"><div class="review-heading"><div><span>完整性</span><h2>记录缺口</h2></div></div>${narrative.gaps.map((gap) => `<p>${escapeHtml(gap.message)}</p>`).join('')}</section>` : ''}</div>`;
}

function renderEvidenceWorkspace(report, trace, narrative) {
  return `<div class="evidence-workspace"><section class="review-section"><div class="review-heading"><div><span>现场证据</span><h2>执行截图与坐标标记</h2></div><small>${trace.screenshots.length} 项</small></div>${trace.screenshots.length ? `<div class="evidence-gallery">${trace.screenshots.map((shot) => renderScreenshot(report, shot, shot.title || shot.ref)).join('')}</div>` : '<p class="empty">没有可展示的截图。</p>'}</section><section class="review-section"><div class="review-heading"><div><span>验证关系</span><h2>验证点与步骤、证据</h2></div></div>${renderNarrativeChecks(report, narrative)}</section></div>`;
}

function renderCurrentContextHtml(caseJson, report) {
  const trace = buildExecutionTrace(report);
  const narrative = trace.narrative;
  const screenshotsJson = JSON.stringify(trace.screenshots.map((shot) => ({
    ...shot,
    time: formatDisplayTime(shot.time),
    phaseLabel: label(PHASE_LABELS, shot.phase),
    src: evidenceHref(report, shot.baseRef || shot.ref),
    overlaySrc: shot.baseRef ? evidenceHref(report, shot.ref) : null,
  }))).replace(/</g, '\\u003c');
  const filterCategories = ['ALL', 'UNDERSTANDING', 'DECISION', 'ACTION', 'OBSERVATION', 'KNOWLEDGE', 'RECOVERY', 'GUARD', 'PROTOCOL'];
  const narrativePanels = `
<nav class="tabs" aria-label="报告视图"><button class="tab" role="tab" aria-selected="true" data-panel="review-panel">执行复盘</button><button class="tab" role="tab" aria-selected="false" data-panel="evidence-panel">证据</button><button class="tab" role="tab" aria-selected="false" data-panel="technical-panel">技术信息</button></nav>
<section id="review-panel" class="panel active" role="tabpanel">${renderNarrativeReview(report, trace, narrative)}</section>
<section id="evidence-panel" class="panel" role="tabpanel">${renderEvidenceWorkspace(report, trace, narrative)}</section>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(caseJson.identity?.title || '未命名用例')} - 执行详情</title>
<style>
:root{color-scheme:light;--bg:#f3f5f7;--surface:#fff;--text:#17212b;--muted:#65717e;--line:#d8dee5;--accent:#006d77;--accent-soft:#e5f2f2;--pass:#087f5b;--pass-soft:#e7f5ef;--fail:#c92a2a;--fail-soft:#fff0f0;--warn:#9c6500;--warn-soft:#fff7df;--ink:#334155}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button{font:inherit}
a{color:var(--accent);font-weight:650;text-decoration:none}
a:hover{text-decoration:underline}
.page{width:min(1440px,calc(100vw - 32px));margin:20px auto 48px}
.summary-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:18px 0 20px;border-bottom:1px solid var(--line)}
h1{margin:0 0 5px;font-size:25px;line-height:1.3;overflow-wrap:anywhere;letter-spacing:0}
.execution-id{color:var(--muted);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.verdict{flex:0 0 auto;padding:7px 11px;border-radius:5px;color:#fff;font-weight:800}
.verdict.pass{background:var(--pass)}
.verdict.fail{background:var(--fail)}
.verdict.blocked{background:var(--warn)}
.verdict.inconclusive,.verdict.unknown{background:#52606d}
.summary-strip{display:grid;grid-template-columns:minmax(220px,2fr) repeat(5,minmax(110px,1fr));border-bottom:1px solid var(--line);background:var(--surface)}
.summary-strip>div{min-width:0;padding:13px 15px;border-right:1px solid var(--line)}
.summary-strip>div:last-child{border-right:0}
.summary-strip span{display:block;color:var(--muted);font-size:11px}
.summary-strip b{display:block;margin-top:2px;overflow-wrap:anywhere}
.summary-strip .result-summary b{font-size:15px}
.tabs{display:flex;gap:3px;margin-top:18px;border-bottom:1px solid var(--line)}
.tab{min-height:40px;padding:8px 14px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);cursor:pointer;font-weight:750}
.tab[aria-selected="true"]{border-color:var(--accent);color:var(--accent)}
.panel{display:none}
.panel.active{display:block}
.trace-tools{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 0}
.filters{display:flex;flex-wrap:wrap;gap:6px}
.filter{min-height:32px;padding:5px 10px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink);cursor:pointer}
.filter.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:750}
.trace-count{color:var(--muted);font-size:12px}
.trace-layout{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:24px;align-items:start}
.phase-group{margin:0 0 16px}
.phase-head{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--line);border-left:4px solid var(--accent);background:#eaf0f2}
.phase-head span{color:var(--accent);font:700 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}
.phase-head h2{margin:0;font-size:15px;letter-spacing:0}
.phase-head b{color:var(--muted);font-size:12px}
.trace-entry{display:grid;grid-template-columns:46px minmax(0,1fr);background:var(--surface);border:1px solid var(--line);border-top:0}
.trace-entry[hidden]{display:none}
.trace-rail{position:relative;display:flex;justify-content:center;padding-top:18px}
.trace-rail:after{content:"";position:absolute;top:42px;bottom:-1px;width:1px;background:var(--line)}
.trace-rail span{display:grid;place-items:center;width:25px;height:25px;border:1px solid var(--line);border-radius:50%;background:#f8fafc;color:var(--muted);font-size:11px;font-weight:800}
.trace-body{min-width:0;padding:14px 15px 16px 0}
.entry-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.entry-head>div{min-width:0}
.entry-head h3{display:inline;margin:0 0 0 8px;font-size:15px;overflow-wrap:anywhere;letter-spacing:0}
.category{display:inline-block;padding:2px 6px;border-radius:4px;background:#edf1f5;color:#455466;font-size:10px;font-weight:800}
.category.action{background:#e7f0ff;color:#2456a6}
.category.observation{background:var(--pass-soft);color:var(--pass)}
.category.knowledge{background:#f3eefa;color:#6941a5}
.category.guard,.category.recovery{background:var(--warn-soft);color:var(--warn)}
.outcome{flex:0 0 auto;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:850}
.outcome.pass{background:var(--pass-soft);color:var(--pass)}
.outcome.fail{background:var(--fail-soft);color:var(--fail)}
.outcome.blocked{background:var(--warn-soft);color:var(--warn)}
.outcome.unknown{background:#edf1f5;color:#52606d}
.entry-meta{display:flex;flex-wrap:wrap;gap:5px 12px;margin:6px 0;color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.entry-summary{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.decision-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:11px 0}
.decision-fields div{min-width:0;padding-left:9px;border-left:2px solid var(--line)}
dt{color:var(--muted);font-size:11px}
dd{margin:1px 0 0;overflow-wrap:anywhere}
.binding{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
.binding span{padding:2px 6px;border:1px solid var(--line);border-radius:4px;background:#f8fafc;color:var(--ink);font-size:10px}
.action-spec{display:flex;align-items:flex-start;gap:10px;margin-top:11px;padding:8px 10px;border-left:3px solid #4f7dbd;background:#f6f8fb}
.action-spec b{flex:0 0 auto}
.action-spec code{min-width:0;color:#344256;overflow-wrap:anywhere;white-space:pre-wrap}
.shot-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.shot-pair>div>small{display:block;margin-bottom:5px;color:var(--muted);font-weight:700}
.shot-trigger{display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;gap:10px;width:100%;min-height:166px;padding:3px;border:1px solid var(--line);border-radius:5px;background:#f8fafc;color:var(--ink);cursor:pointer;text-align:left}
.shot-trigger:hover,.shot-trigger:focus-visible{border-color:var(--accent);outline:2px solid transparent;background:var(--accent-soft)}
.shot-trigger img{width:96px;height:160px;object-fit:contain;background:#111827;border-radius:3px}
.shot-trigger span{padding-right:6px;overflow-wrap:anywhere;font-size:12px}
.empty-shot{display:grid;place-items:center;min-height:166px;border:1px dashed var(--line);border-radius:5px;color:var(--muted);background:#f8fafc}
.observation-row{display:grid;grid-template-columns:minmax(180px,290px) minmax(0,1fr);gap:13px;align-items:center;margin-top:11px}
.observation-row p{margin:4px 0}
.muted{color:var(--muted)}
.retry{margin:10px 0 0;padding:8px 10px;background:var(--warn-soft);color:#654400}
.artifacts{margin-top:10px}
.artifacts summary{cursor:pointer;color:var(--accent);font-weight:700}
.artifacts div{display:flex;flex-wrap:wrap;gap:10px;margin-top:7px}
.recovery-anchor{position:sticky;top:14px;padding:14px;border:1px solid var(--line);background:var(--surface)}
.aside-title{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}
.aside-title span{font-size:16px;font-weight:800}
.aside-title b{color:var(--warn);font-size:11px}
.recovery-anchor>.shot-trigger{grid-template-columns:110px minmax(0,1fr);min-height:188px}
.recovery-anchor>.shot-trigger img{width:110px;height:184px}
.recovery-anchor dl{margin:12px 0}
.recovery-anchor dl div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid #edf0f3}
.recovery-anchor p{margin:12px 0 0;overflow-wrap:anywhere}
.anchor-alert{margin-top:12px;padding:9px;background:var(--warn-soft)}
.anchor-alert b,.anchor-alert span{display:block}
.anchor-alert span{margin-top:4px}
.empty{padding:24px;border:1px dashed var(--line);color:var(--muted);text-align:center}
.result-layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr);gap:24px;padding-top:18px}
.result-section{padding:0 0 18px;border-bottom:1px solid var(--line)}
.result-section h2{margin:0 0 10px;font-size:17px;letter-spacing:0}
.result-section pre,.raw-panel pre{max-height:520px;margin:0;padding:13px;border:1px solid var(--line);background:var(--surface);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.requirement{padding:12px 0;border-bottom:1px solid var(--line)}
.requirement>div{display:flex;justify-content:space-between;gap:10px}
.requirement span{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.requirement h3{margin:6px 0 2px;font-size:14px;letter-spacing:0}
.requirement p{margin:4px 0;color:var(--muted)}
.raw-panel{padding-top:18px}
.raw-note{margin:0 0 10px;color:var(--muted)}
dialog{width:min(1100px,calc(100vw - 28px));height:min(92vh,900px);padding:0;border:1px solid var(--line);background:#111827;color:#fff}
dialog::backdrop{background:rgba(15,23,42,.74)}
.viewer-head,.viewer-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:48px;padding:8px 12px;background:#1f2937}
.viewer-head b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.viewer-actions{display:flex;gap:5px}
.icon-button{display:grid;place-items:center;width:34px;height:34px;border:1px solid #4b5563;border-radius:4px;background:#273446;color:#fff;cursor:pointer;font-size:18px}
.icon-button:hover{background:#374151}
.viewer-stage{height:calc(100% - 96px);overflow:auto}
.viewer-canvas{display:grid;place-items:center;min-width:100%;min-height:100%}
.viewer-stage img{display:block;max-width:none;max-height:none;object-fit:contain}
.viewer-foot{color:#d1d5db;font-size:12px}
.mobile-viewer-hint{display:none}
.hidden{display:none!important}

.action-spec{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start}
.action-spec>b{white-space:nowrap}
.action-spec dl{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0}
.action-spec dl div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px;min-width:120px}
.action-spec dd{color:#344256}
.knowledge-list{display:grid;gap:7px;margin-top:10px}
.knowledge-list>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:9px 10px;border-left:3px solid #6941a5;background:#faf8fc}
.knowledge-list b{overflow-wrap:anywhere}
.knowledge-list span{grid-column:1;color:var(--muted);font-size:11px}
.knowledge-list a{grid-column:2;grid-row:1/3;align-self:center;white-space:nowrap}

@media(max-width:1050px){.summary-strip{grid-template-columns:repeat(3,minmax(0,1fr))}
.summary-strip .result-summary{grid-column:1/-1}
.trace-layout{grid-template-columns:minmax(0,1fr) 300px}
.shot-trigger{grid-template-columns:78px minmax(0,1fr);min-height:134px}
.shot-trigger img{width:78px;height:128px}
.recovery-anchor>.shot-trigger{grid-template-columns:90px minmax(0,1fr);min-height:154px}
.recovery-anchor>.shot-trigger img{width:90px;height:150px}
}

@media(max-width:760px){.page{width:calc(100vw - 20px);margin-top:10px}
.summary-head{gap:10px;padding-top:8px}
h1{font-size:21px}
.summary-strip{grid-template-columns:1fr 1fr}
.summary-strip .result-summary{grid-column:1/-1}
.summary-strip>div{border-bottom:1px solid var(--line)}
.tabs{overflow:auto}
.tab{flex:0 0 auto}
.trace-tools{align-items:flex-start;flex-direction:column}
.trace-layout{display:block}
.recovery-anchor{position:static;margin-bottom:15px}
.trace-main{display:flex;flex-direction:column}
.trace-main .recovery-anchor{order:-1}
.trace-entry{grid-template-columns:36px minmax(0,1fr)}
.trace-body{padding-right:10px}
.decision-fields,.shot-pair,.observation-row,.result-layout{grid-template-columns:1fr}
.shot-trigger,.recovery-anchor>.shot-trigger{grid-template-columns:72px minmax(0,1fr);min-height:126px}
.shot-trigger img,.recovery-anchor>.shot-trigger img{width:72px;height:120px}
.shot-trigger span{font-size:11px}
.entry-head h3{display:block;margin:5px 0 0}
.mobile-viewer-hint{display:block;color:var(--muted);font-size:11px}
.recovery-anchor dl div{grid-template-columns:100px minmax(0,1fr)}
}

@media(max-width:760px){.action-spec{grid-template-columns:1fr}
.action-spec dl{display:grid;grid-template-columns:1fr 1fr}
.action-spec dl div{min-width:0}
}

.summary-strip{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px;border:0;background:transparent}
.summary-strip>div{min-height:84px;padding:13px 15px;border:1px solid var(--line);border-radius:6px;background:var(--surface)}
.summary-strip>div:last-child{border-right:1px solid var(--line)}
.summary-strip .result-summary{grid-column:span 2;border-left:4px solid var(--accent)}
.summary-strip.pass .result-summary{border-left-color:var(--pass)}
.summary-strip.fail .result-summary{border-left-color:var(--fail)}
.summary-strip.blocked .result-summary,.summary-strip.inconclusive .result-summary{border-left-color:var(--warn)}
.summary-strip .result-summary b{max-width:680px}
.category.protocol{background:var(--warn-soft);color:var(--warn)}
@media(max-width:760px){.summary-strip{grid-template-columns:1fr 1fr;gap:7px}
.summary-strip .result-summary{grid-column:1/-1}
.summary-strip>div{min-height:76px;padding:11px 12px}
}

.source-rendered{padding:16px 18px;border:1px solid var(--line);border-left:4px solid var(--accent);background:var(--surface);overflow-wrap:anywhere}
.source-rendered>:first-child{margin-top:0}
.source-rendered>:last-child{margin-bottom:0}
.source-rendered h3,.source-rendered h4,.source-rendered h5,.source-rendered h6{margin:18px 0 8px;letter-spacing:0}
.source-rendered h3{font-size:18px}
.source-rendered h4{font-size:15px}
.source-rendered p{margin:8px 0;line-height:1.7}
.source-rendered ol,.source-rendered ul{margin:8px 0;padding-left:24px}
.source-rendered li{padding:3px 0;line-height:1.65}
.source-rendered code{padding:1px 4px;border-radius:3px;background:#edf1f5;font-size:12px}
.source-rendered pre{max-height:360px;padding:12px;background:#f7f8fa;overflow:auto;white-space:pre-wrap}
.source-rendered blockquote{margin:10px 0;padding:8px 12px;border-left:3px solid var(--line);color:var(--muted)}
.source-rendered hr{border:0;border-top:1px solid var(--line)}
.technical-panel{padding-top:18px}
.technical-panel>.trace-tools{margin-top:0}

.action-spec{margin-top:12px;padding:10px 12px;border:1px solid #d8e0ea;border-left:3px solid #4f7dbd;border-radius:4px;background:#f8fafc}
.action-kind{display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #d8e0ea}
.action-kind span{color:var(--muted);font-size:10px}
.action-kind b{color:#24496f;font-size:14px}
.action-spec dl{display:flex;flex-wrap:wrap;gap:7px 22px;margin:9px 0 0}
.action-spec .action-field{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px;align-items:start;min-width:0;max-width:100%}
.action-spec .action-field.wide{flex-basis:100%}
.action-spec dt{font-size:10px;line-height:1.55}
.action-spec dd{margin:0;color:#26384a;font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.shot-pair{display:flex;flex-wrap:wrap;align-items:flex-start;gap:14px;margin-top:12px}
.shot-pair>div{flex:0 0 auto}
.shot-pair>div>small{margin-bottom:5px}
.shot-trigger{display:inline-flex;flex-direction:column;align-items:center;gap:5px;width:auto;min-width:104px;min-height:0;padding:4px 4px 7px}
.shot-trigger img{display:block;width:auto;height:180px;max-width:min(150px,50vw);object-fit:contain}
.shot-trigger span{padding:0 6px;font-size:11px}
.single-shot{width:auto}
.empty-shot{width:104px;min-height:120px}
@media(max-width:760px){
.source-rendered{padding:14px}
.action-spec{padding:9px 10px}
.action-spec dl{gap:6px 14px}
.action-spec .action-field{flex-basis:100%}
.shot-trigger img{height:160px;max-width:42vw}
}


/* Report workspace: result first, details on demand. */
body{background:#f6f7f8}
.page{width:min(1360px,calc(100vw - 40px));margin:0 auto 48px}
.summary-head{padding:26px 2px 16px;border:0}
.summary-head h1{font-size:23px}
.case-outcome{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:center;padding:20px 22px;border:1px solid var(--line);border-left:5px solid #52606d;border-radius:6px;background:var(--surface)}
.case-outcome.pass{border-left-color:var(--pass)}
.case-outcome.fail{border-left-color:var(--fail)}
.case-outcome.blocked,.case-outcome.inconclusive{border-left-color:var(--warn)}
.outcome-copy>span{display:block;margin-bottom:5px;color:var(--muted);font-size:11px;font-weight:750}
.outcome-copy>div{display:flex;align-items:baseline;gap:10px}
.outcome-copy strong{font-size:25px;line-height:1.2}
.case-outcome.pass .outcome-copy strong{color:var(--pass)}
.case-outcome.fail .outcome-copy strong{color:var(--fail)}
.case-outcome.blocked .outcome-copy strong,.case-outcome.inconclusive .outcome-copy strong{color:var(--warn)}
.outcome-copy small{color:var(--muted)}
.outcome-copy p{max-width:850px;margin:9px 0 0;font-size:15px;overflow-wrap:anywhere}
.outcome-stats{display:grid;grid-template-columns:repeat(3,minmax(74px,1fr));margin:0}
.outcome-stats>div{padding:3px 16px;border-left:1px solid var(--line)}
.outcome-stats dt{font-size:10px}
.outcome-stats dd{margin-top:2px;font-size:15px;font-weight:800;white-space:nowrap}
.run-info{margin:8px 0 0;color:var(--muted)}
.run-info>summary{width:max-content;padding:5px 2px;cursor:pointer;font-size:12px;font-weight:700}
.run-info dl{display:flex;flex-wrap:wrap;gap:10px 28px;margin:6px 0 0;padding:12px 15px;border-top:1px solid var(--line);background:rgba(255,255,255,.55)}
.run-info dl>div{display:flex;gap:7px}
.run-info dd{color:var(--ink);font-size:12px}
.tabs{gap:22px;margin-top:14px}
.tab{padding:9px 2px}
.panel{padding-top:24px}

.subtabs{display:flex;gap:4px;width:max-content;max-width:100%;margin:0 0 22px;padding:3px;border-radius:6px;background:#e9edf0}
.subtab{min-height:34px;padding:6px 14px;border:0;border-radius:4px;background:transparent;color:var(--muted);cursor:pointer;font-weight:750}
.subtab.active{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(23,33,43,.12)}
.subpanel{display:none}
.subpanel.active{display:block}
.technical-panel{padding-top:24px}
.technical-subtabs{margin-bottom:0}
.technical-panel .subpanel{padding-top:0}
.raw-panel{padding-top:18px}

.coordinate-audit{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-top:14px;border:1px solid var(--line);border-radius:4px;background:#fafbfc;overflow:hidden}
.coordinate-audit>div{min-width:0;padding:9px 11px;border-left:1px solid var(--line)}
.coordinate-audit>div:first-child{border-left:0}
.coordinate-audit span,.coordinate-audit b{display:block}
.coordinate-audit span{color:var(--muted);font-size:10px;font-weight:800}
.coordinate-audit b{margin-top:3px;font-size:12px;overflow-wrap:anywhere}
.coordinate-audit .audit-matched{color:var(--pass)}

.coordinate-overlay-button{margin-top:7px;padding:4px 7px;border:1px solid var(--accent);border-radius:4px;background:var(--surface);color:var(--accent);cursor:pointer;font-size:11px;font-weight:750}
.coordinate-overlay-button:hover,.coordinate-overlay-button:focus-visible{background:var(--accent-soft)}

@media(max-width:900px){.case-outcome{grid-template-columns:1fr}
.outcome-stats{width:max-content}
.outcome-stats>div:first-child{padding-left:0;border-left:0}
.coordinate-audit{grid-template-columns:1fr 1fr}
.coordinate-audit>div:nth-child(3){border-top:1px solid var(--line);border-left:0}
.coordinate-audit>div:nth-child(4){border-top:1px solid var(--line)}
}

@media(max-width:700px){.page{width:calc(100vw - 20px);margin-bottom:24px}
.summary-head{padding:16px 2px 10px}
.summary-head h1{font-size:20px}
.case-outcome{gap:17px;padding:16px}
.outcome-copy strong{font-size:22px}
.outcome-copy p{font-size:14px}
.outcome-stats{width:100%}
.outcome-stats>div{padding:3px 10px}
.run-info dl{display:grid;grid-template-columns:1fr}
.tabs{gap:16px;overflow:auto}
.panel{padding-top:18px}
.subtabs{width:100%;overflow:auto}
.subtab{flex:1 0 auto;padding:6px 10px}
.trace-layout{display:block}
}

.shot-media{position:relative;display:block;width:96px;height:160px;overflow:hidden;border-radius:3px;background:#111827}
.shot-media img{position:absolute;inset:0;display:block;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:contain!important;border-radius:0!important;background:transparent!important}
.shot-overlay{pointer-events:none}
.recovery-anchor>.shot-trigger .shot-media{width:110px;height:184px}
.viewer-frame{position:relative}
.viewer-frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.viewer-frame #viewer-overlay{pointer-events:none}

.narrative-review,.evidence-workspace{max-width:1120px}
.review-section{padding:24px 0;border-bottom:1px solid var(--line)}
.review-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:13px}
.review-heading span,.review-heading small{color:var(--muted);font-size:11px}
.review-heading h2{margin:2px 0 0;font-size:18px}
.recording-state{padding:4px 7px;border-radius:4px;font-weight:750}
.recording-state.pass{background:var(--pass-soft);color:var(--pass)}
.recording-state.blocked{background:var(--warn-soft);color:var(--warn)}
.understanding-lead{margin:0 0 14px;padding:11px 13px;border-left:3px solid var(--accent);background:var(--accent-soft)}
.understanding-grid{display:grid;grid-template-columns:1fr 1.3fr 1fr;border:1px solid var(--line);background:var(--surface)}
.understanding-grid>div{min-width:0;padding:14px}
.understanding-grid>div+div{border-left:1px solid var(--line)}
.understanding-grid span,.narrative-decision span,.post-assessment span,.plan-update span,.narrative-action>span{color:var(--muted);font-size:10px;font-weight:800}
.understanding-grid ul,.understanding-grid ol{margin:8px 0 0;padding-left:20px}
.understanding-grid li+li{margin-top:6px}
.understanding-grid li b{margin-right:7px;color:var(--accent)}
.initial-plan{display:grid;gap:0;margin:0;padding:0;list-style:none;counter-reset:plan}
.initial-plan li{counter-increment:plan;padding:11px 12px;border-bottom:1px solid var(--line);background:var(--surface)}
.initial-plan li:before{content:counter(plan);display:inline-grid;place-items:center;width:22px;height:22px;margin-right:9px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:10px;font-weight:800}
.narrative-steps{display:grid;gap:12px}
.narrative-step{border:1px solid var(--line);border-radius:6px;background:var(--surface);overflow:hidden}
.narrative-step>header{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line);background:#fafbfc}
.narrative-step>header>span{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:800}
.narrative-step h3{margin:2px 0 0;font-size:14px}
.narrative-step small{color:var(--muted)}
.narrative-step>header>b{font-size:11px}
.narrative-decision{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--line)}
.narrative-decision>div{min-width:0;padding:12px 14px}
.narrative-decision>div+div{border-left:1px solid var(--line)}
.narrative-decision p,.post-assessment p,.plan-update p{margin:4px 0 0;overflow-wrap:anywhere}
.narrative-action{margin:0;padding:12px 14px;border-bottom:1px solid var(--line)}
.narrative-action .action-spec{margin-top:6px}
.narrative-shots{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px;border-bottom:1px solid var(--line)}
.narrative-shots small{display:block;margin-bottom:5px;color:var(--muted);font-size:10px;font-weight:800}
.narrative-shots .shot-trigger{grid-template-columns:78px minmax(0,1fr);min-height:132px}
.narrative-shots .shot-media{width:78px;height:126px}
.post-assessment,.plan-update{padding:12px 14px}
.post-assessment b,.plan-update b{display:block;margin-top:4px}
.plan-update{border-top:1px solid var(--line);background:var(--accent-soft)}
.narrative-checks{display:grid;gap:8px}
.narrative-check{border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:5px;background:var(--surface);padding:11px 13px}
.narrative-check.pass{border-left-color:var(--pass)}
.narrative-check.fail{border-left-color:var(--fail)}
.narrative-check header{display:grid;grid-template-columns:35px minmax(0,1fr) auto;gap:9px;align-items:center}
.narrative-check header span{color:var(--accent);font-size:11px;font-weight:800}
.narrative-check p{margin:6px 0}
.narrative-check>div{display:flex;flex-wrap:wrap;gap:10px}
.narrative-gaps p{margin:7px 0;padding:9px 11px;background:var(--warn-soft)}
.evidence-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.evidence-gallery .shot-trigger{grid-template-columns:80px minmax(0,1fr);min-height:138px}
.evidence-gallery .shot-media{width:80px;height:132px}

.understanding-history,.technical-fact{margin-top:12px;border:1px solid var(--line);background:#fafbfc}
.understanding-history>summary,.technical-fact>summary{padding:9px 11px;cursor:pointer}
.understanding-history>div{padding:10px 12px;border-top:1px solid var(--line)}
.understanding-history p{margin:4px 0}
.understanding-history small{color:var(--muted)}
.plan-history{margin-top:18px}
.plan-history>h3{margin:0 0 8px;font-size:14px}
.plan-history>div{padding:11px 12px;border-left:3px solid var(--accent);background:var(--accent-soft)}
.plan-history>div+div{margin-top:8px}
.plan-history header{display:flex;justify-content:space-between;gap:12px}
.plan-history header span{color:var(--muted);font-size:10px}
.plan-history p{margin:5px 0}
.plan-history ol{margin:6px 0 0;padding-left:20px}
.technical-fact{width:100%}
.technical-fact.valid{border-left:3px solid var(--pass)}
.technical-fact.invalid{border-left:3px solid var(--warn)}
.technical-fact summary{display:flex;justify-content:space-between;gap:12px}
.technical-fact>p{margin:0;padding:0 11px 9px}
.technical-fact dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;border-top:1px solid var(--line)}
.technical-fact dl>div{min-width:0;padding:8px 10px}
.technical-fact dt{color:var(--muted);font-size:10px}
.technical-fact dd{margin:3px 0 0;overflow-wrap:anywhere}
.recording-state.unavailable{background:#edf1f5;color:var(--muted)}

.step-expectations{display:grid;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);background:#f8fafc}
.step-expectations>div{display:flex;justify-content:space-between;gap:12px;padding-left:8px;border-left:3px solid var(--line)}
.step-expectations>div.pass{border-left-color:var(--pass)}
.step-expectations>div.fail{border-left-color:var(--fail)}
.step-expectations>div.blocked,.step-expectations>div.inconclusive{border-left-color:var(--warn)}
.step-expectations b{min-width:0;overflow-wrap:anywhere}
.step-expectations span{flex:0 1 48%;color:var(--muted);font-size:11px;text-align:right;overflow-wrap:anywhere}

@media(max-width:1050px){.shot-media{width:78px;height:128px}
.recovery-anchor>.shot-trigger .shot-media{width:90px;height:150px}
}

@media(max-width:760px){.shot-media{width:72px;height:120px}
.recovery-anchor>.shot-trigger .shot-media{width:72px;height:120px}
}

.knowledge-investigation{margin-top:9px;border:1px solid var(--line);border-left:4px solid #6941a5;background:var(--surface)}
.knowledge-investigation>header{display:flex;justify-content:space-between;gap:16px;padding:11px 13px;border-bottom:1px solid var(--line)}
.knowledge-investigation>header b,.knowledge-investigation>header span{display:block}
.knowledge-investigation>header span{margin-top:3px;color:var(--muted);font-size:10px}
.knowledge-investigation>header strong{font-size:11px}
.knowledge-investigation>p{margin:0;padding:11px 13px}
.knowledge-investigation .knowledge-list{margin:0;padding:10px 12px}
.final-decision{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);background:var(--surface)}
.final-decision>div{min-width:0;padding:13px}
.final-decision>div+div{border-left:1px solid var(--line)}
.final-decision span{color:var(--muted);font-size:10px;font-weight:800}
.final-decision p{margin:4px 0 0;overflow-wrap:anywhere}
@media(max-width:700px){.final-decision{grid-template-columns:1fr}
.final-decision>div+div{border-top:1px solid var(--line);border-left:0}
}

</style></head><body><main class="page">
<header class="summary-head"><div><h1>${escapeHtml(caseJson.identity?.title || '未命名用例')}</h1><div class="execution-id">${caseJson.identity?.caseNo ? `用例 ${escapeHtml(caseJson.identity.caseNo)} · ` : ''}${escapeHtml(report.execution?.executionId || '-')}</div></div></header>
${renderOutcomeSummary(report, trace)}${narrativePanels}
<section id="technical-panel" class="panel technical-panel" role="tabpanel"><nav class="subtabs technical-subtabs" aria-label="技术记录内容"><button type="button" class="subtab active" data-subtab-group="technical" data-subpanel="technical-trace-panel">执行记录</button><button type="button" class="subtab" data-subtab-group="technical" data-subpanel="raw-data-panel">原始数据</button></nav><section id="technical-trace-panel" class="subpanel active" data-subtab-group="technical"><div class="trace-tools"><div class="filters">${filterCategories.map((category) => `<button type="button" class="filter${category === 'ALL' ? ' active' : ''}" data-filter="${category}">${category === 'ALL' ? '全部' : CATEGORY_LABELS[category]}</button>`).join('')}</div><span class="trace-count">显示 <b id="visible-count">${trace.entries.length}</b> / ${trace.entries.length}</span></div><div class="trace-layout"><div class="trace-main">${renderPhaseGroups(report, trace.entries)}</div>${renderRecoveryAnchor(report, trace.recoveryAnchor)}</div></section><section id="raw-data-panel" class="subpanel raw-panel" data-subtab-group="technical"><p class="raw-note">底层协议数据的只读投影，字段名和枚举保留协议原值；时间按本地时区展示，输入类动作已脱敏。</p><pre>${jsonText(trace.raw)}</pre></section></section>
</main>
<dialog id="shot-dialog" aria-label="截图查看器"><div class="viewer-head"><b id="viewer-title">截图</b><div class="viewer-actions"><button type="button" class="icon-button" id="zoom-out" title="缩小" aria-label="缩小">−</button><button type="button" class="icon-button" id="zoom-in" title="放大" aria-label="放大">＋</button><button type="button" class="icon-button" id="fit-image" title="完整显示" aria-label="完整显示">⌗</button><button type="button" class="icon-button" id="actual-image" title="原始尺寸" aria-label="原始尺寸">1:1</button><button type="button" class="icon-button" id="close-viewer" title="关闭" aria-label="关闭">×</button></div></div><div class="viewer-stage" id="viewer-stage"><div class="viewer-canvas" id="viewer-canvas"><div class="viewer-frame" id="viewer-frame"><img id="viewer-image" alt="执行截图"><img id="viewer-overlay" alt="" hidden></div></div></div><div class="viewer-foot"><button type="button" class="icon-button" id="previous-shot" title="上一张" aria-label="上一张">‹</button><span id="viewer-meta"></span><button type="button" class="icon-button" id="next-shot" title="下一张" aria-label="下一张">›</button></div></dialog>
<script>
const screenshots=${screenshotsJson};let currentShot=0;let scale=1;let viewMode='fit';const dialog=document.getElementById('shot-dialog');const stage=document.getElementById('viewer-stage');const canvas=document.getElementById('viewer-canvas');const frame=document.getElementById('viewer-frame');const image=document.getElementById('viewer-image');const overlay=document.getElementById('viewer-overlay');
function centerViewer(){stage.scrollLeft=Math.max(0,(canvas.scrollWidth-stage.clientWidth)/2);stage.scrollTop=Math.max(0,(canvas.scrollHeight-stage.clientHeight)/2);}
function applyScale(){const stageWidth=stage.clientWidth;const stageHeight=stage.clientHeight;if(!stageWidth||!stageHeight)return;const canvasScale=Math.max(1,scale);canvas.style.width=(stageWidth*canvasScale)+'px';canvas.style.height=(stageHeight*canvasScale)+'px';frame.style.width=(stageWidth*scale)+'px';frame.style.height=(stageHeight*scale)+'px';requestAnimationFrame(centerViewer);}
function applyActualSize(){const stageWidth=stage.clientWidth;const stageHeight=stage.clientHeight;if(!stageWidth||!stageHeight||!image.naturalWidth||!image.naturalHeight)return;canvas.style.width=Math.max(stageWidth,image.naturalWidth)+'px';canvas.style.height=Math.max(stageHeight,image.naturalHeight)+'px';frame.style.width=image.naturalWidth+'px';frame.style.height=image.naturalHeight+'px';requestAnimationFrame(centerViewer);}
function showShot(index,open){if(!screenshots.length)return;currentShot=(Number(index)+screenshots.length)%screenshots.length;const shot=screenshots[currentShot];scale=1;viewMode='fit';image.src=shot.src;image.alt=shot.title||'执行截图';if(shot.overlaySrc){overlay.src=shot.overlaySrc;overlay.hidden=false}else{overlay.removeAttribute('src');overlay.hidden=true}document.getElementById('viewer-title').textContent=shot.title||shot.ref;document.getElementById('viewer-meta').textContent=(currentShot+1)+' / '+screenshots.length+' · '+(shot.phaseLabel||'')+' · '+(shot.time||'');if(open&&!dialog.open)dialog.showModal();requestAnimationFrame(applyScale);}
image.addEventListener('load',()=>{if(dialog.open){if(viewMode==='actual')applyActualSize();else applyScale();}});
document.querySelectorAll('[data-shot]').forEach(button=>button.addEventListener('click',()=>showShot(button.dataset.shot,true)));
document.getElementById('close-viewer').addEventListener('click',()=>dialog.close());document.getElementById('previous-shot').addEventListener('click',()=>showShot(currentShot-1,false));document.getElementById('next-shot').addEventListener('click',()=>showShot(currentShot+1,false));document.getElementById('zoom-in').addEventListener('click',()=>{const fromActual=viewMode==='actual';viewMode='zoom';scale=Math.min(4,fromActual?1.25:scale+.25);applyScale()});document.getElementById('zoom-out').addEventListener('click',()=>{const fromActual=viewMode==='actual';viewMode='zoom';scale=Math.max(.25,fromActual?.75:scale-.25);applyScale()});document.getElementById('fit-image').addEventListener('click',()=>{viewMode='fit';scale=1;applyScale()});document.getElementById('actual-image').addEventListener('click',()=>{viewMode='actual';scale=1;applyActualSize()});dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});window.addEventListener('resize',()=>{if(dialog.open){if(viewMode==='actual')applyActualSize();else applyScale();}});
document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(item=>item.setAttribute('aria-selected',String(item===tab)));document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===tab.dataset.panel));}));
document.querySelectorAll('.subtab').forEach(tab=>tab.addEventListener('click',()=>{const group=tab.dataset.subtabGroup;document.querySelectorAll('.subtab[data-subtab-group="'+group+'"]').forEach(item=>item.classList.toggle('active',item===tab));document.querySelectorAll('.subpanel[data-subtab-group="'+group+'"]').forEach(panel=>panel.classList.toggle('active',panel.id===tab.dataset.subpanel));}));
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach(item=>item.classList.toggle('active',item===button));const filter=button.dataset.filter;let count=0;document.querySelectorAll('.trace-entry').forEach(entry=>{const visible=filter==='ALL'||entry.dataset.category===filter;entry.hidden=!visible;if(visible)count++});document.querySelectorAll('.phase-group').forEach(group=>group.classList.toggle('hidden',!group.querySelector('.trace-entry:not([hidden])')));document.getElementById('visible-count').textContent=count;}));
document.addEventListener('keydown',event=>{if(!dialog.open)return;if(event.key==='ArrowLeft')showShot(currentShot-1,false);if(event.key==='ArrowRight')showShot(currentShot+1,false)});
</script></body></html>\n`;
}

module.exports = { renderCurrentContextHtml, renderCurrentContextMarkdown, renderSourceMarkdown };
