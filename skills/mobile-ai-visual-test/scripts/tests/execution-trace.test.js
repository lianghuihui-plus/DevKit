#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readExecutionReport } = require('../lib/execution-reader');
const { formatDisplayTime } = require('../lib/display-format');
const { buildObservationView } = require('../lib/observation-model');
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
const artifactManifest = JSON.parse(fs.readFileSync(path.join(fixture.execDir, 'artifact-manifest.json'), 'utf8'));
assert.ok(artifactManifest.files.some((entry) => entry.path === 'coordinate-audits/action-tap.svg'));
assert.strictEqual(trace.counts.actions, 1);
assert.strictEqual(trace.counts.observations, 3);
assert.strictEqual(trace.counts.statusReads, 1);
assert.strictEqual(trace.screenshots.length, 4);
const action = trace.entries.find((entry) => entry.category === 'ACTION');
assert.strictEqual(action.beforeScreenshot.ref, 'screenshots/observe-before.png');
assert.strictEqual(action.afterScreenshot.ref, 'screenshots/observe-after.png');
assert.strictEqual(action.coordinateOverlayScreenshot.ref, 'coordinate-audits/action-tap.svg');
assert.strictEqual(action.coordinateAudit.consistency, 'MATCHED');
assert.strictEqual(action.actionEffect.status, 'CHANGED');
assert.strictEqual(action.intent, '打开目标内容');
assert.strictEqual(action.expectedOutcome, '页面展示验证结果');
assert.strictEqual(action.expectationAssessment.status, 'MATCHED');
assert.strictEqual(action.agentAnalysis.status, 'EXPLICIT');
const after = trace.entries.find((entry) => entry.operationId === 'observe-after');
assert.strictEqual(after.relatedOperationId, 'action-tap');
assert.strictEqual(after.artifacts.layout, 'layouts/observe-after.json');
assert.deepStrictEqual(after.artifacts.logs, ['logs/observe-after-errors.txt']);
assert.ok(trace.pathEntries.includes(action));
assert.strictEqual(trace.pathEntries.includes(after), false);
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
const secretAction = secretTrace.entries.find((entry) => entry.category === 'ACTION');
assert.strictEqual(secretAction.action.text, '[已脱敏]');
assert.strictEqual(secretAction.inputEffect.expectedText, '[已脱敏]');
assert.strictEqual(secretAction.inputEffect.actualText, '[已脱敏]');
assert.strictEqual(secretAction.expectationAssessment.status, 'MATCHED');
assert.strictEqual(JSON.stringify(secretTrace.raw).includes(secret), false);
const html = renderCurrentContextHtml(secretFixture.caseJson, secretReport);
const businessHtml = html.match(/<section id="result-panel"[\s\S]*?<section id="technical-panel"/)?.[0] || '';
assert.strictEqual(html.includes(secret), false);
assert.ok(html.includes(formatDisplayTime(secretReport.execution.startedAt)));
assert.strictEqual(html.includes(secretReport.execution.startedAt), false);
assert.ok(html.includes('时间按本地时区展示'));
for (const expected of ['执行结果', '用例与计划', '执行过程', '技术记录', '原始用例', '用例理解', '执行计划', '执行路径', '原始数据', 'shot-dialog', 'previous-shot', 'next-shot', 'fit-image', 'actual-image', 'data-filter="ACTION"']) assert.ok(html.includes(expected), expected);
for (const removed of ['data-panel="overview-panel"', 'data-panel="raw-panel"', '>最新计划</button>', '>执行概览</button>', '>技术详情</button>']) assert.strictEqual(html.includes(removed), false, removed);
for (const expected of ['<div class="source-rendered"><h3>测试用例</h3>', '<strong>模块</strong>：搜索', 'class="process-workspace"', 'class="process-step', 'class="process-detail-panel', '执行目的', 'Agent 预期', '执行结果', '操作后现场', '预期判断', 'Agent 明确结论', '符合预期']) assert.ok(businessHtml.includes(expected), expected);
for (const expected of ['class="case-outcome pass"', 'class="action-kind"', 'class="action-field', 'class="detail-shot-pair"', 'class="coordinate-audit"', '真实执行坐标', '页面已变化', '操作前现场与坐标落点']) assert.ok(html.includes(expected), expected);
for (const expected of ['.process-workspace{display:grid', '.detail-shot-pair{display:grid', 'object-fit:contain', '关联要求']) assert.ok(html.includes(expected), expected);
for (const expected of ['class="viewer-canvas"', "image.style.objectFit='contain'", 'canvas.scrollWidth-stage.clientWidth']) assert.ok(html.includes(expected), expected);
for (const removed of ['image.style.transform=', '.viewer-stage img{max-width:100%;max-height:100%']) assert.strictEqual(html.includes(removed), false, removed);
for (const hidden of ['cp-001', 'req-001', 'Agent 意图：']) assert.strictEqual(businessHtml.includes(hidden), false, hidden);
assert.strictEqual((html.match(/class="process-detail-panel active"/g) || []).length, 1);
for (const removed of ['id="expand-overview"', 'id="collapse-overview"', 'class="story-card', 'class="checkpoint-accordion', 'id="overview-panel"']) assert.strictEqual(html.includes(removed), false, removed);

const rejectedFixture = createCurrentFixture(workspace, {
  suffix: 'trace-protocol-rejection',
  attempts: [{
    schemaVersion: 1,
    attemptId: 'inspect-rejected',
    entrypoint: 'inspect',
    startedAt: '2026-08-13T10:00:00.000+08:00',
    endedAt: '2026-08-13T10:00:00.010+08:00',
    durationMs: 10,
    ok: false,
    error: { code: 'AGENT_FACADE_INVALID', message: '请求字段不符合契约' },
  }],
});
const rejectedHtml = renderCurrentContextHtml(rejectedFixture.caseJson, readExecutionReport(rejectedFixture.execDir));
const rejectedProcess = rejectedHtml.match(/<section id="process-panel"[\s\S]*?<section id="technical-panel"/)?.[0] || '';
const rejectedTechnical = rejectedHtml.match(/<section id="technical-panel"[\s\S]*?<\/main>/)?.[0] || '';
assert.strictEqual(rejectedProcess.includes('协议请求未通过'), false);
assert.ok(rejectedTechnical.includes('协议请求被拒绝：inspect'));

const degradedFixture = createCurrentFixture(workspace, {
  verdict: 'PASS',
  suffix: 'trace-layout-degraded',
  afterLayoutAvailable: false,
  afterTechnicalSignals: {
    layoutCapture: {
      status: 'UNAVAILABLE',
      code: 'ANDROID_LAYOUT_NOT_IDLE',
      message: '页面持续变化，uiautomator 未进入可采集状态',
      durationMs: 4012,
      fallback: 'SCREENSHOT',
    },
  },
});
const degradedReport = readExecutionReport(degradedFixture.execDir);
const degradedTrace = buildExecutionTrace(degradedReport);
const degradedAfter = degradedTrace.entries.find((entry) => entry.operationId === 'observe-after');
assert.strictEqual(degradedAfter.observation.usable, true);
assert.strictEqual(degradedAfter.observation.technicalSignals.layoutCapture.code, 'ANDROID_LAYOUT_NOT_IDLE');
const degradedEvent = degradedReport.events.find((event) => event.type === 'observation' && event.operationId === 'observe-after');
const degradedView = buildObservationView(degradedFixture.execDir, degradedEvent);
assert.strictEqual(degradedView.usable, true);
assert.strictEqual(degradedView.layout.usable, false);
assert.strictEqual(degradedView.layout.diagnostics[0].code, 'ANDROID_LAYOUT_NOT_IDLE');
assert.strictEqual(degradedView.elements.length, 0);
const degradedHtml = renderCurrentContextHtml(degradedFixture.caseJson, degradedReport);
assert.ok(degradedHtml.includes('控件树降级'));
assert.ok(degradedHtml.includes('已使用截图继续执行'));

const failedFixture = createCurrentFixture(workspace, { verdict: 'FAIL', suffix: 'trace-accordion-fail' });
const failedHtml = renderCurrentContextHtml(failedFixture.caseJson, readExecutionReport(failedFixture.execDir));
assert.ok(failedHtml.includes('不符合预期'));
const selectedFailedStep = failedHtml.match(/<section id="process-step-\d+" class="process-detail-panel active">[\s\S]*?<\/section>/)?.[0] || '';
assert.ok(selectedFailedStep.includes('不符合预期'));
for (const text of ['>Execution status<', '>Verdict basis<', '>Plan revision<', '>Checkpoint<', '>Requirement 结果<', '>SUCCEEDED<']) assert.strictEqual(html.includes(text), false, text);

fs.rmSync(temp, { recursive: true, force: true });
console.log('execution-trace passed');
