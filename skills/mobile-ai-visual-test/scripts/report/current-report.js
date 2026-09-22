'use strict';

const { displayAction, formatDuration } = require('../lib/display-format');
const { buildExecutionNarrative } = require('./execution-narrative');
const { renderCurrentContextHtml } = require('./current-report-html');
const { renderSourceMarkdown } = require('./source-markdown');
const { projectCaseFlowViews } = require('./case-flow-projection');

const VERDICT_LABELS = Object.freeze({
  PASS: '通过',
  FAIL: '失败',
  BLOCKED: '阻塞',
  INCONCLUSIVE: '无法判断',
  NOT_RUN: '无法执行',
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
const KNOWLEDGE_INVESTIGATION_LABELS = Object.freeze({
  NOT_REQUIRED: '无需调查',
  NO_MATCH: '无匹配候选',
  NO_APPLICABLE: '无适用知识',
  INSUFFICIENT: '知识依据不足',
  CONFLICTING: '知识存在冲突',
  APPLICABLE_FOUND: '已找到适用知识',
  MISSING: '调查未完成',
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

function optionalDuration(value) {
  return value === null || value === undefined ? '-' : formatDuration(value);
}

function renderCurrentContextMarkdown(caseJson, report) {
  const display = report.display || {};
  const phases = display.phaseDurations || {};
  const narrative = buildExecutionNarrative(report);
  const views = projectCaseFlowViews(report);
  const modelLines = [
    '## 用例流程', '',
    `- 基线版本：${views.baselineFlow?.revision || '-'}`,
    `- 摘要：${views.baselineFlow?.summary || '未记录'}`,
    `- 入口：${views.baselineFlow?.entryNodeRef || '-'}`,
    `- 不确定项：${views.baselineFlow?.uncertainties?.join('；') || '无'}`, '',
    '### 节点', '',
    ...((views.baselineFlow?.nodes || []).map((node) => `- ${node.ref} [${node.type}] ${node.text}${node.requirement ? `；责任：${node.requirement}` : ''}${node.applicability ? `；适用条件：${node.applicability}` : ''}${node.sourceBasis ? `；依据：${node.sourceBasis}` : ''}`)), '',
    '### 连接与分支', '',
    ...((views.baselineFlow?.edges || []).map((edge) => `- ${edge.ref} ${edge.from} -> ${edge.to}${edge.condition ? `；条件：${edge.condition}` : ''}`)),
  ];
  const lines = [
    `# ${caseJson.identity?.caseNo ? `${caseJson.identity.caseNo} · ` : ''}${caseJson.identity?.title || '未命名用例'}`, '',
    `- 执行结论：${label(VERDICT_LABELS, display.verdict || display.status, '未执行')}`,
    `- 执行标识：${report.execution?.executionId || '-'}`,
    `- 耗时：${optionalDuration(display.durationMs)}`,
    `- 时长口径：${display.durationBasis || 'EXECUTION_TOTAL'}`,
    `- 验证点覆盖：${narrative.coverage.covered}/${narrative.coverage.total}`,
    `- 执行记录：${{ COMPLETE: '完整', PARTIAL: '部分缺失', UNAVAILABLE: '不可用' }[narrative.recordingStatus] || '不可用'}`, '',
    '## 耗时分解', '',
    `- 协调准备：${optionalDuration(phases.coordinatorPreparationMs)}`,
    `- 初始态准备：${optionalDuration(phases.initialStatePreparationMs)}`,
    `- 交接准备：${optionalDuration(phases.handoffPreparationMs)}`,
    `- 交接调度：${optionalDuration(phases.handoffSchedulingMs)}`,
    `- Agent 阶段：${optionalDuration(phases.caseAgentPhaseMs)}`,
    `- 报告发布延迟：${optionalDuration(phases.reportPublicationDelayMs)}`,
    `- Runtime 活跃：${optionalDuration(report.metrics?.runtimeActiveMs)}`,
    `- Adapter 活跃：${optionalDuration(report.metrics?.adapterActiveMs)}`,
    `- Agent 与调度间隙：${optionalDuration(report.metrics?.agentAndSchedulingGapMs)}`, '',
    '## 原始用例', '', report.sourceText || '未记录', '',
    ...modelLines,
  ];
  lines.push('', '## 执行轨迹', '');
  if (views.executionTrace.nodes.length) {
    lines.push('### 轨迹摘要', '', ...views.executionTrace.nodes.map((node) =>
      `- ${node.ref} ${node.operation}：${node.purpose}${node.baselineNodeRef ? `；基线节点：${node.baselineNodeRef}` : node.adaptation ? '；现场适配' : ''}${node.attemptCount > 1 ? `；尝试 ${node.attemptCount} 次` : ''}`), '');
  }
  lines.push('### 执行详情', '');
  for (const step of narrative.steps) {
    lines.push(`${step.number}. ${step.purpose || step.operation}`,
      `   - 操作前观察：${step.observation || '未记录'}`,
      `   - 当时结论：${step.conclusion || '未记录'}`,
      `   - 当时推进目标：${step.expectationTargets.map((item) => `${item.ref} ${item.text}`).join('；') || '未关联'}`,
      `   - 过程状态：${step.processState}`,
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
  }
  lines.push('', '## 最终判断', '',
    `- 现场观察：${narrative.finalDecision?.observation || '未记录'}`,
    `- 判断结论：${narrative.finalDecision?.conclusion || '未记录'}`,
    `- 收口目的：${narrative.finalDecision?.purpose || '未记录'}`,
    '', '## 检查点', '');
  const narrativeChecks = new Map(narrative.checks.map((check) => [check.expectationRef, check]));
  const ledger = views.checkpointLedger.length ? views.checkpointLedger : narrative.checks.map((check) => ({
    checkpointRef: check.expectationRef, text: check.expectation, disposition: check.status,
    actual: check.actual, reason: check.reason, sceneRefs: check.sceneRefs,
    knowledgeRefs: check.knowledgeRefs, technicalRefs: check.technicalRefs,
  }));
  for (const checkpoint of ledger) {
    const check = narrativeChecks.get(checkpoint.checkpointRef) || {};
    lines.push(`- [${checkpoint.disposition}] ${checkpoint.checkpointRef} ${checkpoint.text}`,
      `  - 责任：${checkpoint.requirement || 'UNKNOWN'}`,
      `  - 实际结果：${checkpoint.actual || '未记录'}`,
      ...(checkpoint.reason ? [`  - 豁免理由：${checkpoint.reason}`] : []),
      `  - 知识调查：${KNOWLEDGE_INVESTIGATION_LABELS[check.knowledgeInvestigation?.status] || '未记录'}`,
      `  - 相关步骤：${(check.relatedSteps || []).map((step) => `步骤 ${step.number}`).join('、') || '无'}`,
      `  - 现场证据：${(checkpoint.sceneRefs || []).join('、') || '无'}`,
      `  - 知识依据：${(checkpoint.knowledgeRefs || []).join('、') || '无'}`);
    const facts = check.technicalFacts || [];
    if (facts.length) {
      for (const fact of facts) {
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
