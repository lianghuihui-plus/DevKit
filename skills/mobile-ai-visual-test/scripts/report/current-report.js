'use strict';

const { displayAction, formatDuration } = require('../lib/display-format');
const { buildExecutionNarrative } = require('./execution-narrative');
const { renderCurrentContextHtml } = require('./current-report-html');
const { renderSourceMarkdown } = require('./source-markdown');

const VERDICT_LABELS = Object.freeze({
  PASS: '通过',
  FAIL: '失败',
  BLOCKED: '阻塞',
  INCONCLUSIVE: '无法判断',
  NOT_RUN: '未执行',
  RUNNING: '执行中',
  CANCELLED: '已取消',
  ABANDONED: '执行已废弃',
  FINALIZATION_RECOVERY_REQUIRED: '收尾待恢复',
  PENDING_PUBLICATION: '待发布',
});
const KNOWLEDGE_FIELD_LABELS = Object.freeze({
  app: 'App',
  platform: '平台',
  version: '版本',
  page: '页面',
  operation: '操作',
});

function label(mapping, value, empty = '-') {
  return mapping[value] || empty;
}

function actionLabel(value) {
  const displayed = displayAction(value);
  return displayed && displayed !== value ? displayed : '未知操作';
}

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

module.exports = { renderCurrentContextHtml, renderCurrentContextMarkdown, renderSourceMarkdown };
