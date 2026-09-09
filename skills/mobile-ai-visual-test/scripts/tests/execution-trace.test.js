#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readExecutionReport } = require('../lib/execution-reader');
const { formatDisplayTime } = require('../lib/display-format');
const { buildExecutionTrace } = require('../report/execution-trace');
const { renderCurrentContextHtml } = require('../report/current-report');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-execution-trace-'));
const workspace = path.join(temp, 'workspace');
createTestWorkspace(workspace);

const fixture = createCurrentFixture(workspace, { verdict: 'PASS', suffix: 'trace', includePreparation: true });
const report = readExecutionReport(fixture.execDir);
const trace = buildExecutionTrace(report);
assert.strictEqual(trace.counts.actions, 1);
assert.strictEqual(trace.counts.observations, 2);
assert.strictEqual(trace.screenshots.length, 3);

const action = trace.entries.find((entry) => entry.category === 'ACTION');
assert.strictEqual(action.beforeScreenshot.ref, 'screenshots/scene-0001.png');
assert.strictEqual(action.afterScreenshot.ref, 'screenshots/scene-0002.png');
assert.strictEqual(action.spatialEvidence.consistency, 'MATCHED');
assert.strictEqual(action.spatialEvidence.certainty, 'DISPATCH_ONLY');
assert.strictEqual(action.spatialEvidenceScreenshot.ref, 'action-spatial-evidence/action-0001.svg');
assert.strictEqual(action.spatialEvidenceScreenshot.baseRef, undefined);
assert.strictEqual(action.actionEffect.status, 'UNCHANGED');
assert.strictEqual(action.intent, '打开目标并验证结果');
assert.strictEqual(action.expectedOutcome, '页面展示目标结果');
assert.strictEqual(action.expectationAssessment.status, 'MATCHED');
assert.strictEqual(action.agentAnalysis.status, 'EXPLICIT');

const after = trace.entries.find((entry) => entry.sceneId === 'scene-0002');
assert.strictEqual(after.relatedOperationId, 'action-0001');
assert.strictEqual(after.artifacts.layout, 'layouts/scene-0002.json');
assert.ok(trace.pathEntries.includes(action));
assert.strictEqual(trace.pathEntries.includes(after), false);
assert.strictEqual(trace.recoveryAnchor.lastTrustedScreenshot.ref, 'screenshots/scene-0002.png');
assert.strictEqual(trace.recoveryAnchor.pendingOrUncertainOperation, null);
assert.strictEqual(trace.narrative.understanding.summary, '理解 PASS 用例');
assert.strictEqual(trace.narrative.steps.length, 1);
assert.strictEqual(trace.narrative.finalDecision.conclusion, '验证结果为 PASS');
assert.strictEqual(trace.narrative.coverage.covered, 1);

const secret = 'super-secret-input';
const secretFixture = createCurrentFixture(workspace, {
  verdict: 'PASS', suffix: 'trace-secret', sourceText: '# 测试用例\n\n**模块**：搜索',
  action: { type: 'inputText', text: secret, mode: 'replace', x: 120, y: 240, coordinateSource: 'visual', targetBounds: [80, 210, 160, 270], coordinateEvidence: '输入框位置' },
});
const secretReport = readExecutionReport(secretFixture.execDir);
const secretTrace = buildExecutionTrace(secretReport);
const secretAction = secretTrace.entries.find((entry) => entry.category === 'ACTION');
assert.strictEqual(secretAction.action.text, '[已脱敏]');
assert.strictEqual(JSON.stringify(secretTrace.raw).includes(secret), false);
const html = renderCurrentContextHtml(secretFixture.caseJson, secretReport);
assert.strictEqual(html.includes(secret), false);
assert.ok(html.includes(formatDisplayTime(secretReport.execution.startedAt)));
assert.strictEqual(html.includes(secretReport.execution.startedAt), false);
for (const expected of ['结果概览', '原始用例', '用例理解', '执行计划', '执行过程', '详细日志', '本次执行未触发知识库查询', '验证点结果', '执行记录', '查看原始数据', 'shot-dialog', 'previous-shot', 'next-shot', 'data-log-filter="ACTION"', 'pointerdown', 'setPointerCapture']) {
  assert.ok(html.includes(expected), expected);
}
assert.strictEqual((html.match(/role="tab"/g) || []).length, 6);
for (const expected of ['class="verdict-banner', 'class="action-kind"', 'class="step-detail"', 'class="shot-compare', '输入测试内容', '页面展示目标结果']) {
  assert.ok(html.includes(expected), expected);
}
for (const removed of ['data-panel="raw-panel"', 'class="story-card', 'class="checkpoint-accordion']) {
  assert.strictEqual(html.includes(removed), false, removed);
}

const degradedFixture = createCurrentFixture(workspace, {
  verdict: 'PASS', suffix: 'trace-layout-degraded', afterLayoutAvailable: false,
  afterTechnicalSignals: { layoutCapture: { status: 'UNAVAILABLE', code: 'ANDROID_LAYOUT_NOT_IDLE', message: '页面持续变化，控件树未进入可采集状态', durationMs: 4012, fallback: 'SCREENSHOT' } },
});
const degradedTrace = buildExecutionTrace(readExecutionReport(degradedFixture.execDir));
const degradedAfter = degradedTrace.entries.find((entry) => entry.sceneId === 'scene-0002');
assert.strictEqual(degradedAfter.observation.usable, true);
assert.strictEqual(degradedAfter.observation.technicalSignals.layoutCapture.code, 'ANDROID_LAYOUT_NOT_IDLE');

const failedFixture = createCurrentFixture(workspace, { verdict: 'FAIL', suffix: 'trace-fail' });
const failedReport = readExecutionReport(failedFixture.execDir);
const failedTrace = buildExecutionTrace(failedReport);
assert.strictEqual(failedTrace.entries.find((entry) => entry.category === 'ACTION').expectationAssessment.status, 'NOT_MATCHED');
assert.strictEqual(failedTrace.counts.knowledge, 2);
const failedHtml = renderCurrentContextHtml(failedFixture.caseJson, failedReport);
assert.ok(failedHtml.includes('FAIL'));
assert.ok(failedHtml.includes('knowledge-0001'));
assert.ok(failedHtml.includes('NO_MATCH'));

const protocolDir = path.join(temp, 'protocol-trace');
fs.mkdirSync(path.join(protocolDir, 'telemetry'), { recursive: true });
fs.writeFileSync(path.join(protocolDir, 'telemetry', 'invocations.jsonl'), [
  JSON.stringify({ phase: 'START', invocationId: 'invocation-0001', operation: 'act', at: '2026-08-13T10:00:00.000Z' }),
  JSON.stringify({ phase: 'END', invocationId: 'invocation-0001', operation: 'act', at: '2026-08-13T10:00:00.100Z', durationMs: 100, status: 'REQUEST_INVALID', error: true, code: 'CASE_RUNTIME_REQUEST_INVALID' }),
].join('\n') + '\n');
const protocolTrace = buildExecutionTrace({ latest: protocolDir, events: [], execution: {}, result: null, metrics: null, display: {} });
const protocolEntry = protocolTrace.entries.find((entry) => entry.category === 'PROTOCOL');
assert.strictEqual(protocolEntry.time, '2026-08-13T10:00:00.100Z');
assert.strictEqual(protocolEntry.outcome.code, 'CASE_RUNTIME_REQUEST_INVALID');

fs.rmSync(temp, { recursive: true, force: true });
console.log('execution-trace passed');
