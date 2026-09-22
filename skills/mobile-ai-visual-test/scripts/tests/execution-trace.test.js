#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readExecutionReport } = require('../lib/execution-reader');
const { formatDisplayTime } = require('../lib/display-format');
const { buildExecutionTrace } = require('../report/execution-trace');
const { flowMermaid, projectCaseFlowViews } = require('../report/case-flow-projection');
const { renderCurrentContextHtml } = require('../report/current-report');
const { createCurrentFixture, createTestWorkspace } = require('./support/workspace-fixture');

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
assert.strictEqual(action.spatialEvidence.coordinateTransform, 'MATCHED');
assert.strictEqual(action.spatialEvidence.certainty, 'DISPATCH_ONLY');
assert.strictEqual(action.spatialEvidenceScreenshot.ref, 'action-spatial-evidence/action-0001.svg');
assert.strictEqual(action.spatialEvidenceScreenshot.baseRef, undefined);
assert.strictEqual(action.screenComparison, undefined);
assert.deepStrictEqual(action.evidence.sceneRefs, {
  before: 'scene-0001',
  after: 'scene-0002',
});
assert.strictEqual(action.intent, '打开目标并验证结果');
assert.strictEqual(action.expectedOutcome, '页面展示目标结果');
assert.deepStrictEqual(action.expectationAssessment, {
  status: 'TARGETED', summary: 'N2', basis: '当时关联目标',
});
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

const initialFlowEvent = report.events.find((event) => event.type === 'caseFlowRevised');
const revisedFlowEvent = {
  ...initialFlowEvent,
  sequence: 100,
  revision: 2,
  reason: '现场发现版本更新弹窗',
  basedOnSceneRef: 'scene-0001',
  entryNodeRef: 'N4',
  nodes: [
    { ref: 'N4', type: 'ACTION', text: '关闭版本更新弹窗' },
    ...initialFlowEvent.nodes,
  ],
  edges: [
    { ref: 'L4', from: 'N4', to: initialFlowEvent.entryNodeRef },
    ...initialFlowEvent.edges,
  ],
};
const projectedViews = projectCaseFlowViews({
  ...report,
  events: [...report.events, revisedFlowEvent, {
    type: 'agentDecisionRecorded', sequence: 101, decisionId: 'decision-adaptation',
    requestedOperation: 'act',
    decision: { purpose: '关闭版本更新弹窗', expectationRefs: [] },
  }, {
    type: 'flowContextRecorded', sequence: 102, decisionId: 'decision-adaptation',
    requestedOperation: 'act', nodeRef: 'N4', selectedEdgeRef: 'L4',
  }],
});
assert.strictEqual(projectedViews.baselineFlow.revision, 1);
assert.strictEqual(projectedViews.baselineFlow.nodes.some((node) => node.ref === 'N4'), false);
assert.strictEqual(projectedViews.workingFlow.revision, 2);
assert.strictEqual(projectedViews.workingFlow.nodes.some((node) => node.ref === 'N4'), true);
assert.strictEqual(projectedViews.checkpointLedger[0].checkpointRef, 'N2');
assert.strictEqual(projectedViews.checkpointLedger[0].baseline, true);
assert.strictEqual(projectedViews.executionTrace.nodes.at(-1).adaptation, true);
assert.strictEqual(projectedViews.executionTrace.nodes.at(-1).flowNodeRef, 'N4');
assert.match(flowMermaid(projectedViews.baselineFlow, projectedViews.checkpointLedger), /^flowchart TB/m);
assert.match(flowMermaid(projectedViews.baselineFlow, projectedViews.checkpointLedger), /F_N3\(\[/);
assert.doesNotMatch(flowMermaid(projectedViews.baselineFlow, projectedViews.checkpointLedger), /F_N3\(\(/);
assert.doesNotMatch(flowMermaid(projectedViews.baselineFlow, projectedViews.checkpointLedger), /\bclass\s+\S+\s+end\b|\bclassDef\s+end\b/);
assert.strictEqual(flowMermaid({ ...projectedViews.baselineFlow, summary: '%%{init:恶意指令}%%' }, []).includes('%%{'), false);

const supplementalFlow = {
  ...revisedFlowEvent,
  sequence: 103,
  revision: 3,
  reason: '新增现场补充检查',
  nodes: [...revisedFlowEvent.nodes, {
    ref: 'N5', type: 'CHECK', text: '补充检查弹窗已关闭', sourceBasis: '现场适配',
    verificationKind: 'DIRECT_OBSERVATION', requirement: 'REQUIRED',
  }],
};
const retiredSupplementalFlow = {
  ...revisedFlowEvent,
  sequence: 105,
  revision: 4,
  reason: '补充检查退出当前导航',
  retiredNodeRefs: ['N5'],
};
const historicalViews = projectCaseFlowViews({
  ...report,
  events: [...report.events, revisedFlowEvent, supplementalFlow, {
    type: 'expectationResultUpdated', sequence: 104, resultUpdateId: 'result-update-supplemental',
    expectationRef: 'N5', status: 'WAIVED', actual: '现场已由其他证据覆盖', reason: '补充检查不再需要重复执行',
    evidence: { sceneRefs: ['scene-0002'], knowledgeRefs: [], technicalRefs: [] },
  }, retiredSupplementalFlow],
});
const retiredCheckpoint = historicalViews.checkpointLedger.find((item) => item.checkpointRef === 'N5');
assert.strictEqual(retiredCheckpoint.active, false);
assert.strictEqual(retiredCheckpoint.disposition, 'WAIVED');
assert.strictEqual(retiredCheckpoint.reason, '补充检查不再需要重复执行');
assert.deepStrictEqual(retiredCheckpoint.sceneRefs, ['scene-0002']);
assert.strictEqual(historicalViews.coverage.total, 1);
assert.strictEqual(historicalViews.coverage.registryTotal, 2);
assert.strictEqual(historicalViews.coverage.waived, 0);

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
for (const expected of ['结果概览', '原始用例', '用例流程', '执行轨迹', '检查点', '详细日志', '本次执行未触发知识库查询', '验证点结果', '执行记录', '查看原始数据', 'shot-dialog', 'previous-shot', 'next-shot', 'data-log-filter="ACTION"', 'pointerdown', 'setPointerCapture', 'class="mermaid"', 'securityLevel:\'strict\'', 'graph-fallback']) {
  assert.ok(html.includes(expected), expected);
}
assert.match(html, /theme:'base',htmlLabels:false,flowchart:\{useMaxWidth:true,htmlLabels:false\}/);
assert.ok(html.includes('await window.mermaid.render('));
assert.strictEqual(html.includes('await window.mermaid.run('), false);
assert.ok(html.includes('function mermaidSvgUsable(svg)'));
assert.ok(html.includes('initializeMermaid();\nasync function renderMermaidPanel'));
assert.ok(html.includes("querySelector('[data-mermaid-source]>svg')"));
for (const expected of [
  'data-mermaid-kind="baseline"',
  'data-flow-node-detail="N2"',
  'data-open-checkpoint="N2"',
  'data-checkpoint-ref="N2"',
  'data-select-checkpoint="N2"',
  'data-checkpoint-ledger',
  'function decorateMermaidNodes(stage,svg)',
  'function activateMermaidNode(node)',
]) assert.ok(html.includes(expected), expected);
assert.strictEqual(html.includes('data-mermaid-kind="trace"'), false);
assert.strictEqual(html.includes('<h2>实际执行轨迹</h2>'), false);
assert.strictEqual((html.match(/role="tab"/g) || []).length, 5);
assert.strictEqual(html.includes('data-report-tab="checkpoints"'), false);
assert.strictEqual(html.includes('data-panel-view="checkpoints"'), false);
for (const expected of ['class="verdict-banner', 'class="action-kind"', 'class="step-detail"', 'class="shot-compare', '输入测试内容', '页面展示目标结果']) {
  assert.ok(html.includes(expected), expected);
}
for (const removed of ['data-panel="raw-panel"', 'class="story-card', 'class="checkpoint-accordion']) {
  assert.strictEqual(html.includes(removed), false, removed);
}
for (const expected of [
  '.process-layout{display:grid;grid-template-columns:minmax(310px,.72fr) minmax(580px,1.28fr);height:',
  '.step-list{min-height:0;overflow-y:auto;scrollbar-gutter:stable;overscroll-behavior:contain',
  '.step-inspector{min-width:0;min-height:0;overflow-y:auto;scrollbar-gutter:stable;overscroll-behavior:contain',
  '.flow-workspace{display:grid;grid-template-columns:minmax(420px,1.15fr) minmax(360px,.85fr)',
  '.flow-information-column{min-width:0',
  '@media(max-width:920px){.flow-workspace{grid-template-columns:1fr}',
  'function revealStepInList(selected)',
  'selected.getBoundingClientRect()',
  'list.scrollTop-=listRect.top-selectedRect.top',
  'list.scrollTop+=selectedRect.bottom-listRect.bottom',
]) assert.ok(html.includes(expected), expected);
assert.strictEqual((html.match(/workspace\?\.scrollIntoView\(\{block:'start'\}\)/g) || []).length, 1, 'step jumps should reveal the execution workspace');
assert.strictEqual(html.includes("kind==='trace'"), false);
assert.ok(html.includes("document.querySelector('[data-flow-node-detail=\"'+ref+'\"]')?.scrollIntoView({block:'nearest'})"));
assert.ok(html.includes("row.scrollIntoView({block:'center'})"));
assert.ok(html.includes("document.querySelectorAll('[data-select-checkpoint]')"));
assert.ok(html.includes("tab.setAttribute('aria-selected',String(active))"));
assert.strictEqual(html.includes('&quot;stepIndex&quot;:null'), false, 'trace nodes without an inspector target must not advertise click navigation');
assert.ok(html.includes("document.querySelectorAll('[data-step]').forEach(row=>row.addEventListener('click',()=>selectStep(row.dataset.step)));"));

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
assert.strictEqual(failedTrace.entries.find((entry) => entry.category === 'ACTION').expectationAssessment.status, 'TARGETED');
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

const sourceAwareDecisionTrace = buildExecutionTrace({
  latest: protocolDir,
  execution: {},
  events: [{
    sequence: 1,
    type: 'agentDecisionRecorded',
    decisionId: 'decision-source-fallback',
    requestedOperation: 'observe',
    decision: {
      purpose: '确认目标页面', assessment: '确认目标页面', observation: '确认目标页面',
      conclusion: '确认目标页面', expectedOutcome: '确认目标页面', expectationRefs: [],
    },
  }],
  result: null,
  metrics: null,
  display: {},
});
const sourceAwareDecisionEntry = sourceAwareDecisionTrace.entries.find((entry) => entry.category === 'DECISION');
assert.strictEqual(sourceAwareDecisionEntry.title, '确认目标页面');
assert.strictEqual(sourceAwareDecisionEntry.summary, '');
assert.strictEqual(sourceAwareDecisionEntry.expectedOutcome, null);

fs.rmSync(temp, { recursive: true, force: true });
console.log('execution-trace passed');
