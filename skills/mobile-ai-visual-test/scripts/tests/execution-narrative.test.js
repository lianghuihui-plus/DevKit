#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildExecutionNarrative } = require('../report/execution-narrative');
const { renderCurrentContextHtml, renderCurrentContextMarkdown } = require('../report/current-report');

const report = {
  execution: { executionId: 'execution-narrative' },
  events: [
    { sequence: 1, time: '2026-09-04T01:00:00.000Z', type: 'caseContextRecorded', contextVersion: 1, reason: 'INITIAL_UNDERSTANDING', caseContext: {
      summary: '验证目标页面内容', preconditions: ['App 已启动'],
      expectations: [{ id: 'E1', text: '目标内容显示' }], initialPlan: ['进入目标页面', '验证内容'], uncertainties: [],
    } },
    { sequence: 2, time: '2026-09-04T01:00:01.000Z', type: 'sceneObserved', sceneId: 'scene-0001', screenshotRef: 'screenshots/scene-0001.png', app: { inTargetApp: true } },
    { sequence: 3, time: '2026-09-04T01:00:02.000Z', type: 'agentDecisionRecorded', decisionId: 'decision-0001', requestedOperation: 'act', sceneId: 'scene-0001', decision: {
      observation: '当前页面显示目标入口', conclusion: '可以进入目标页', purpose: '打开目标页面', expectedOutcome: '目标内容出现', expectationRefs: ['E1'],
      planUpdate: { reason: '入口已直接出现', next: ['打开目标页面', '验证内容'] },
    } },
    { sequence: 4, time: '2026-09-04T01:00:02.100Z', type: 'actionRequested', operationId: 'action-0001', decisionId: 'decision-0001', sceneId: 'scene-0001', action: { type: 'tap', target: '目标入口' } },
    { sequence: 5, time: '2026-09-04T01:00:02.200Z', type: 'actionCompleted', operationId: 'action-0001', decisionId: 'decision-0001', lifecycle: { status: 'COMPLETED' }, command: { status: 'ACCEPTED' }, deviceExecution: { status: 'UNVERIFIED' }, observedEffect: { status: 'CHANGED' } },
    { sequence: 6, time: '2026-09-04T01:00:03.000Z', type: 'sceneObserved', sceneId: 'scene-0002', relatedOperationId: 'action-0001', screenshotRef: 'screenshots/scene-0002.png', app: { inTargetApp: true } },
    { sequence: 7, time: '2026-09-04T01:00:03.200Z', type: 'agentDecisionRecorded', decisionId: 'decision-0002', requestedOperation: 'knowledge', sceneId: 'scene-0002', decision: {
      observation: '目标内容已显示但状态说明需要确认', conclusion: '查询本地经验辅助解释', purpose: '确认当前状态说明', expectedOutcome: '获得相关候选信息', expectationRefs: ['E1'],
    } },
    { sequence: 8, time: '2026-09-04T01:00:03.300Z', type: 'knowledgeQueried', decisionId: 'decision-0002', queryId: 'knowledge-0001', query: '目标状态说明', candidateCount: 1, expectationRefs: ['E1'], candidates: [
      { entryId: 'K-target-001', title: '目标状态规则', snapshotRef: 'knowledge/example.md', metadata: { platform: ['harmony'] } },
    ] },
    { sequence: 8.5, time: '2026-09-04T01:00:03.350Z', type: 'knowledgeReviewed', decisionId: 'decision-0003', queryId: 'knowledge-0001', conclusion: 'APPLICABLE_FOUND', expectationRefs: ['E1'], assessments: [
      { entryId: 'K-target-001', status: 'APPLICABLE', reason: '当前平台和现象一致' },
    ] },
    { sequence: 9, time: '2026-09-04T01:00:03.400Z', type: 'agentDecisionRecorded', decisionId: 'decision-0003', requestedOperation: 'recover', sceneId: 'scene-0002', decision: {
      observation: '目标内容仍可见', conclusion: '恢复 App 后复核稳定性', purpose: '恢复并再次观察', expectedOutcome: '目标内容恢复后仍显示', expectationRefs: ['E1'],
    } },
    { sequence: 10, time: '2026-09-04T01:00:03.500Z', type: 'appRecovered', decisionId: 'decision-0003', operationId: 'recovery-0001', reason: '恢复并再次观察' },
    { sequence: 10.5, time: '2026-09-04T01:00:03.800Z', type: 'sceneObserved', sceneId: 'scene-0003', relatedOperationId: 'recovery-0001', decisionId: 'decision-0003', screenshotRef: 'screenshots/scene-0003.png', app: { inTargetApp: true } },
    { sequence: 11, time: '2026-09-04T01:00:04.000Z', type: 'agentDecisionRecorded', decisionId: 'decision-0004', requestedOperation: 'finish', sceneId: 'scene-0003', decision: {
      observation: '目标内容已经显示', conclusion: 'E1 已满足', purpose: '提交最终结论', expectedOutcome: '验证点由当前 Scene 支持', expectationRefs: ['E1'],
    } },
    { sequence: 12, time: '2026-09-04T01:00:05.000Z', type: 'caseFinished', verdict: 'PASS', decisionId: 'decision-0004' },
  ],
  result: {
    verdict: 'PASS', summary: '目标内容正常显示',
    checks: [{ expectationRef: 'E1', status: 'PASS', actual: '目标内容已显示', sceneRefs: ['scene-0002'], knowledgeRefs: ['K-target-001'] }], uncertainties: [],
  },
};

const narrative = buildExecutionNarrative(report);
assert.strictEqual(narrative.available, true);
assert.strictEqual(narrative.recordingStatus, 'COMPLETE');
assert.strictEqual(narrative.recordingComplete, undefined);
assert.strictEqual(narrative.understanding.summary, '验证目标页面内容');
assert.strictEqual(narrative.understandingHistory.length, 1);
assert.deepStrictEqual(narrative.initialPlan.items, ['进入目标页面', '验证内容']);
assert.strictEqual(narrative.plan.version, 2);
assert.strictEqual(narrative.plan.reason, '入口已直接出现');
assert.deepStrictEqual(narrative.plan.items, ['打开目标页面', '验证内容']);
assert.strictEqual(narrative.planHistory.length, 2);
assert.strictEqual(narrative.steps.length, 3);
assert.strictEqual(narrative.steps[0].action.status, 'OBSERVED');
assert.strictEqual(narrative.steps[0].action.result.command.status, 'ACCEPTED');
assert.strictEqual(narrative.steps[0].action.result.deviceExecution.status, 'UNVERIFIED');
assert.strictEqual(narrative.steps[0].action.result.observedEffect.status, 'CHANGED');
assert.strictEqual(narrative.steps[0].beforeScene.sceneId, 'scene-0001');
assert.strictEqual(narrative.steps[0].afterScene.sceneId, 'scene-0002');
assert.strictEqual(narrative.steps[0].postAssessment.conclusion, '查询本地经验辅助解释');
assert.deepStrictEqual(narrative.steps[0].expectations[0], {
  ref: 'E1', text: '目标内容显示', status: 'PASS', actual: '目标内容已显示', sceneRefs: ['scene-0002'],
});
assert.strictEqual(narrative.steps[1].knowledge.queryId, 'knowledge-0001');
assert.strictEqual(narrative.steps[1].knowledge.review.conclusion, 'APPLICABLE_FOUND');
assert.strictEqual(narrative.steps[2].recovery.status, 'SUCCEEDED');
assert.strictEqual(narrative.steps[2].afterScene.sceneId, 'scene-0003');
assert.strictEqual(narrative.finalDecision.conclusion, 'E1 已满足');
assert.deepStrictEqual(narrative.finalDecision.expectationRefs, ['E1']);
assert.strictEqual(narrative.checks[0].expectation, '目标内容显示');
assert.strictEqual(narrative.checks[0].knowledge[0].entryId, 'K-target-001');
assert.deepStrictEqual(narrative.checks[0].relatedSteps.map((step) => step.number), [1, 2, 3]);
assert.deepStrictEqual(narrative.coverage, { total: 1, covered: 1, missing: [] });
const markdown = renderCurrentContextMarkdown({ identity: { title: '知识支持用例' } }, {
  ...report,
  display: { verdict: 'PASS', durationMs: 5000 },
});
assert.match(markdown, /K-target-001 \[APPLICABLE\]/);
assert.match(markdown, /知识依据：K-target-001/);
assert.match(markdown, /## 最终判断/);
assert.match(markdown, /关联验证点：E1 目标内容显示 \[PASS\]/);
assert.match(markdown, /相关步骤：步骤 1、步骤 2、步骤 3/);

const filterDiagnostics = {
  scannedCount: 1,
  compatibleCount: 0,
  eligibleCount: 0,
  noRelevantMatchCount: 0,
  excludedBy: { app: 1 },
  rejected: [{
    entryId: 'K-target-001', title: '目标状态规则',
    mismatches: [{ field: 'app', query: 'com.example.target', declared: ['com.example.other'] }],
  }],
};
const knowledgeMissReport = {
  ...report,
  latest: '/tmp/execution-knowledge-miss',
  events: report.events.map((event) => {
    if (event.type === 'knowledgeQueried') return {
      ...event, candidateCount: 0, candidates: [], filterDiagnostics,
    };
    if (event.type === 'knowledgeReviewed') return {
      ...event, conclusion: 'NO_MATCH', assessments: [], automatic: true,
    };
    return event;
  }),
  result: {
    ...report.result,
    checks: report.result.checks.map((check) => ({ ...check, knowledgeRefs: [] })),
  },
};
const knowledgeMissNarrative = buildExecutionNarrative(knowledgeMissReport);
assert.deepStrictEqual(knowledgeMissNarrative.steps[1].knowledge.filterDiagnostics, filterDiagnostics);
assert.match(renderCurrentContextMarkdown({ identity: { title: '知识未命中用例' } }, {
  ...knowledgeMissReport, display: { verdict: 'PASS', durationMs: 5000 },
}), /未命中诊断：扫描 1 条知识；App 不匹配 1 条；K-target-001：查询值 com\.example\.target，知识值 com\.example\.other/);
assert.match(renderCurrentContextHtml({ identity: { title: '知识未命中用例' } }, {
  ...knowledgeMissReport, display: { verdict: 'PASS', durationMs: 5000 },
}), /未命中诊断：扫描 1 条知识/);

const reportWithGap = {
  ...report,
  events: [...report.events, {
    sequence: 13, time: '2026-09-04T01:00:05.100Z', type: 'narrativeGap',
    message: '本次操作未记录业务判断', fields: ['decision'],
  }],
};
const narrativeWithGap = buildExecutionNarrative(reportWithGap);
assert.strictEqual(narrativeWithGap.recordingStatus, 'PARTIAL');
assert.strictEqual(narrativeWithGap.gaps.length, 1);
const markdownWithGap = renderCurrentContextMarkdown({ identity: { title: '记录缺口用例' } }, {
  ...reportWithGap,
  display: { verdict: 'PASS', durationMs: 5000 },
});
assert.match(markdownWithGap, /执行记录：部分缺失/);
assert.match(markdownWithGap, /本次操作未记录业务判断/);
assert.match(markdownWithGap, /## 最终判断/);

const incomplete = buildExecutionNarrative({ execution: {}, events: [], result: { checks: [] } });
assert.strictEqual(incomplete.available, false);
assert.strictEqual(incomplete.recordingStatus, 'UNAVAILABLE');

const emptyPlan = buildExecutionNarrative({
  execution: { executionId: 'execution-empty-plan' },
  events: [{
    sequence: 1, type: 'caseContextRecorded', contextVersion: 1, reason: 'INITIAL_UNDERSTANDING',
    caseContext: { ...report.events[0].caseContext, initialPlan: [] },
  }],
  result: { checks: [] },
});
assert.strictEqual(emptyPlan.recordingStatus, 'PARTIAL');

const understandingRevisionReport = {
  latest: '/tmp/execution-understanding-revision',
  execution: { executionId: 'execution-understanding-revision' },
  events: [
    report.events[0],
    {
      ...report.events[0], sequence: 2, contextVersion: 2, reason: 'CLARIFIED_EXPECTATION',
      caseContext: {
        ...report.events[0].caseContext,
        summary: '补充理解目标页面内容',
        initialPlan: ['这不是显式计划调整'],
      },
    },
  ],
  result: { verdict: 'PASS', summary: '目标内容正常显示', checks: [], uncertainties: [] },
  display: { verdict: 'PASS', durationMs: 5000 },
  sourceText: '验证目标页面内容',
};
const understandingRevision = buildExecutionNarrative(understandingRevisionReport);
assert.strictEqual(understandingRevision.understandingHistory.length, 2);
assert.strictEqual(understandingRevision.planHistory.length, 1);
assert.strictEqual(understandingRevision.plan.version, 1);
assert.deepStrictEqual(understandingRevision.plan.items, ['进入目标页面', '验证内容']);
assert.strictEqual(renderCurrentContextHtml({ identity: { title: '理解修订用例' } }, understandingRevisionReport)
  .includes('<h3>计划调整</h3>'), false);

const technicalNarrative = buildExecutionNarrative({
  execution: { executionId: 'execution-technical', warmSessionGeneration: 1 },
  events: [...report.events, {
    sequence: 11.5, time: '2026-09-04T01:00:04.500Z', type: 'technicalIssue',
    executionId: 'execution-technical', technicalFactRef: 'technical-fact-0011', code: 'ADAPTER_DISCONNECTED', message: '设备连接中断',
    operation: 'observe', decisionId: 'decision-0004', expectationRefs: ['E1'], sceneId: 'scene-0003', generation: 1,
  }],
  result: {
    verdict: 'BLOCKED', summary: '连接中断',
    checks: [{ expectationRef: 'E1', status: 'BLOCKED', actual: '无法继续观察', technicalRefs: ['technical-fact-0011'] }],
  },
});
assert.deepStrictEqual(technicalNarrative.checks[0].technicalFacts[0], {
  ref: 'technical-fact-0011', type: 'technicalIssue', code: 'ADAPTER_DISCONNECTED', message: '设备连接中断',
  time: '2026-09-04T01:00:04.500Z', operation: 'observe', operationId: null, decisionId: 'decision-0004',
  sceneId: 'scene-0003', generation: 1, state: 'VALID', stateReason: '当前技术事实仍直接阻止该验证点',
});
const technicalReport = {
  latest: '/tmp/execution-technical',
  execution: { executionId: 'execution-technical', warmSessionGeneration: 1 },
  events: technicalNarrative.events || [...report.events, {
    sequence: 11.5, time: '2026-09-04T01:00:04.500Z', type: 'technicalIssue',
    executionId: 'execution-technical', technicalFactRef: 'technical-fact-0011', code: 'ADAPTER_DISCONNECTED', message: '设备连接中断',
    operation: 'observe', decisionId: 'decision-0004', expectationRefs: ['E1'], sceneId: 'scene-0003', generation: 1,
  }],
  result: { verdict: 'BLOCKED', summary: '连接中断', checks: [{ expectationRef: 'E1', status: 'BLOCKED', actual: '无法继续观察', technicalRefs: ['technical-fact-0011'] }] },
  display: { verdict: 'BLOCKED', durationMs: 5000 }, sourceText: '验证目标页面内容',
};
const technicalMarkdown = renderCurrentContextMarkdown({ identity: { title: '技术阻塞用例' } }, technicalReport);
assert.match(technicalMarkdown, /计划调整/);
assert.match(technicalMarkdown, /ADAPTER_DISCONNECTED/);
assert.match(technicalMarkdown, /设备连接中断/);
assert.match(technicalMarkdown, /有效/);
const technicalHtml = renderCurrentContextHtml({ identity: { title: '技术阻塞用例' } }, technicalReport);
for (const text of ['计划调整', 'ADAPTER_DISCONNECTED', '设备连接中断', 'observe', '有效']) assert.ok(technicalHtml.includes(text), text);

const observeNarrative = buildExecutionNarrative({
  execution: { executionId: 'execution-observe' },
  events: [
    report.events[0],
    report.events[1],
    { sequence: 3, type: 'agentDecisionRecorded', decisionId: 'decision-observe', requestedOperation: 'observe', sceneId: 'scene-0001', decision: { observation: '页面正在变化', conclusion: '重新采集现场', purpose: '确认页面稳定', expectedOutcome: '获得稳定页面', expectationRefs: ['E1'] } },
    { sequence: 4, type: 'sceneObserved', sceneId: 'scene-observe-after', decisionId: 'decision-observe', screenshotRef: 'screenshots/scene-observe-after.png' },
  ],
  result: report.result,
});
assert.strictEqual(observeNarrative.steps[0].afterScene.sceneId, 'scene-observe-after');

console.log('execution narrative passed');
