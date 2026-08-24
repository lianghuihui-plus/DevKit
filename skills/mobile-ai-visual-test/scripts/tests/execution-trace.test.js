#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readExecutionReport } = require('../lib/execution-reader');
const { formatDisplayTime } = require('../lib/display-format');
const { buildExecutionNarrative, buildExecutionTrace } = require('../report/execution-trace');
const { renderCurrentContextHtml } = require('../report/current-report');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-execution-trace-'));
const workspace = path.join(temp, 'workspace');
createTestWorkspace(workspace);

const fixture = createCurrentFixture(workspace, {
  verdict: 'PASS', suffix: 'trace', includePreparation: true,
  attempts: [
    { entrypoint: 'status', durationMs: 1, ok: true },
    { entrypoint: 'observe', durationMs: 2, ok: true },
  ],
});
const report = readExecutionReport(fixture.execDir);
const trace = buildExecutionTrace(report);
assert.strictEqual(trace.counts.actions, 1);
assert.strictEqual(trace.counts.observations, 3);
assert.strictEqual(trace.counts.statusReads, 1);
assert.strictEqual(trace.screenshots.length, 3);
const action = trace.entries.find((entry) => entry.category === 'ACTION');
assert.strictEqual(action.beforeScreenshot.ref, 'screenshots/observe-before.png');
assert.strictEqual(action.afterScreenshot.ref, 'screenshots/observe-after.png');
assert.strictEqual(action.intent, '打开目标内容');
assert.strictEqual(action.expectedOutcome, '页面展示验证结果');
const after = trace.entries.find((entry) => entry.operationId === 'observe-after');
assert.strictEqual(after.relatedOperationId, 'action-tap');
assert.strictEqual(after.artifacts.layout, 'layouts/observe-after.json');
assert.deepStrictEqual(after.artifacts.logs, ['logs/observe-after-errors.txt']);
assert.strictEqual(trace.recoveryAnchor.lastTrustedScreenshot.ref, 'screenshots/observe-after.png');
assert.strictEqual(trace.recoveryAnchor.pendingOrUncertainOperation, null);
assert.strictEqual(trace.narrative.source.text, '验证当前报告 PASS');
assert.strictEqual(trace.narrative.startPreparation.length, 1);
assert.strictEqual(trace.narrative.checkpoints.length, 1);
assert.strictEqual(trace.narrative.checkpoints[0].actions.length, 1);
assert.strictEqual(trace.narrative.checkpoints[0].observations.length, 2);
assert.strictEqual(trace.narrative.checkpoints[0].findings[0].summary, '检查点已完成，结果为 SATISFIED');

// Stable checkpoint IDs retain their execution records across plan revisions.
const revisedEntries = structuredClone(trace.entries);
for (const entry of revisedEntries.filter((item) => item.authorization?.checkpointId === 'cp-001')) {
  entry.authorization.planRevision = 2;
}
for (const entry of revisedEntries.filter((item) => item.checkpointId === 'cp-001')) entry.planRevision = 2;
const revisedNarrative = buildExecutionNarrative({
  ...report,
  plan: { ...report.plan, revision: 4 },
}, revisedEntries);
assert.strictEqual(revisedNarrative.checkpoints.length, 1);
assert.strictEqual(revisedNarrative.checkpoints[0].current, true);
assert.strictEqual(revisedNarrative.checkpoints[0].planRevision, 4);
assert.deepStrictEqual(revisedNarrative.checkpoints[0].recordPlanRevisions, [2]);
assert.strictEqual(revisedNarrative.checkpoints[0].actions.length, 1);
assert.strictEqual(revisedNarrative.checkpoints[0].observations.length, 2);

const secret = 'super-secret-input';
const secretFixture = createCurrentFixture(workspace, {
  verdict: 'PASS', suffix: 'trace-secret',
  sourceText: '# 测试用例\n\n**模块**：搜索',
  action: { type: 'inputText', text: secret, mode: 'replace', x: 120, y: 240, coordinateSource: 'visual', targetBounds: [80, 210, 160, 270], coordinateEvidence: '输入框位置' },
});
const secretReport = readExecutionReport(secretFixture.execDir);
const secretTrace = buildExecutionTrace(secretReport);
assert.strictEqual(secretTrace.entries.find((entry) => entry.category === 'ACTION').action.text, '[已脱敏]');
assert.strictEqual(JSON.stringify(secretTrace.raw).includes(secret), false);
const html = renderCurrentContextHtml(secretFixture.caseJson, secretReport);
const overviewHtml = html.match(/<section id="overview-panel"[\s\S]*?<section id="technical-panel"/)?.[0] || '';
assert.strictEqual(html.includes(secret), false);
assert.ok(html.includes(formatDisplayTime(secretReport.execution.startedAt)));
assert.strictEqual(html.includes(secretReport.execution.startedAt), false);
assert.ok(html.includes('时间按本地时区展示'));
for (const expected of ['执行详情', '原始用例', '用例理解', '执行计划', '起点准备', '检查点执行', '异常调查', '执行结论', '技术记录', '原始数据', 'shot-dialog', 'previous-shot', 'next-shot', 'fit-image', 'actual-image', 'data-filter="ACTION"']) assert.ok(html.includes(expected), expected);
for (const removed of ['data-panel="plan-panel"', '>最新计划</button>', '>执行概览</button>', '>技术详情</button>']) assert.strictEqual(html.includes(removed), false, removed);
for (const expected of ['<div class="source-rendered"><h3>测试用例</h3>', '<strong>模块</strong>：搜索', '<div class="work-step-marker"><span>1</span>', '现场采集成功', '观察目标']) assert.ok(overviewHtml.includes(expected), expected);
for (const expected of ['class="summary-strip pass"', 'class="action-kind"', 'class="action-field', 'class="story-card source-card"']) assert.ok(html.includes(expected), expected);
for (const expected of ['.action-spec dl{display:flex', '.shot-pair{display:flex', 'height:180px', '当前计划']) assert.ok(html.includes(expected), expected);
for (const expected of ['class="viewer-canvas"', "image.style.objectFit='contain'", 'canvas.scrollWidth-stage.clientWidth']) assert.ok(html.includes(expected), expected);
for (const removed of ['image.style.transform=', '.viewer-stage img{max-width:100%;max-height:100%']) assert.strictEqual(html.includes(removed), false, removed);
for (const hidden of ['cp-001', 'req-001', 'Agent 意图：']) assert.strictEqual(overviewHtml.includes(hidden), false, hidden);
assert.strictEqual((overviewHtml.match(/<details class="story-card/g) || []).length, 7);
for (const expected of ['id="expand-overview"', 'id="collapse-overview"', '<details class="story-card source-card"><summary', '<details class="story-card conclusion-card pass" open', '<details class="checkpoint-accordion pass">']) assert.ok(overviewHtml.includes(expected), expected);

const failedFixture = createCurrentFixture(workspace, { verdict: 'FAIL', suffix: 'trace-accordion-fail' });
const failedHtml = renderCurrentContextHtml(failedFixture.caseJson, readExecutionReport(failedFixture.execDir));
assert.ok(failedHtml.includes('<details class="story-card attention" open'));
assert.ok(failedHtml.includes('<details class="checkpoint-accordion fail" open'));
for (const text of ['>Execution status<', '>Verdict basis<', '>Plan revision<', '>Checkpoint<', '>Requirement 结果<', '>SUCCEEDED<']) assert.strictEqual(html.includes(text), false, text);

fs.rmSync(temp, { recursive: true, force: true });
console.log('execution-trace passed');
