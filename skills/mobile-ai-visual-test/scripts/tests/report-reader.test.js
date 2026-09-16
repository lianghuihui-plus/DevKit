#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatDuration } = require('../lib/display-format');
const { collectIndexCases, renderIndexForRoot, writeCaseReports } = require('../report/report-service');
const { assertCurrentExecution, currentDisplayModel, readExecutionReport, selectExecutionDir } = require('../lib/execution-reader');
const { findActiveExecutions } = require('../lib/execution-lifecycle');
const { createExecutionClosure } = require('../lib/execution-closure');
const { completionPaths, sha256File } = require('../lib/completion-contract');
const { buildExecutionArtifactManifest } = require('../lib/execution-artifact-manifest');
const { createCurrentFixture, createTestWorkspace } = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-report-reader-'));
const workspace = path.join(temp, 'workspace');
createTestWorkspace(workspace);

const fixtures = new Map();
for (const verdict of ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']) {
  const malicious = verdict === 'PASS';
  fixtures.set(verdict, createCurrentFixture(workspace, {
    verdict,
    title: malicious ? '<script>alert("title")</script> 中文当前用例' : `${verdict} 当前用例`,
    sourceText: malicious ? '<img src=x onerror=alert(1)> 原始用例中文' : `验证 ${verdict} 当前结果`,
    summary: malicious ? '<b>不是 HTML</b> ' + '很长的结论文本'.repeat(40) : `${verdict} 当前报告结论`,
    uncertainties: malicious ? ['<script>alert("uncertainty")</script>'] : undefined,
    action: malicious ? { type: 'inputText', target: '搜索框', x: 120, y: 240, text: '不应出现在报告中的输入', mode: 'replace', coordinateSource: 'visual', targetBounds: [80, 210, 160, 270], coordinateEvidence: '操作前截图中的搜索框' } : undefined,
  }));
}

for (const [verdict, fixture] of fixtures) {
  const report = readExecutionReport(fixture.execDir);
  assert.strictEqual(report.schemaFamily, 'current');
  assert.strictEqual(report.readerFamily, 'current-execution');
  assert.strictEqual(report.display.verdict, verdict);
  assert.strictEqual(report.display.executionStatus, fixture.metrics.executionStatus);
  assert.strictEqual(report.display.summary, fixture.result.summary);
  assert.deepStrictEqual(report.display.uncertainties, fixture.result.uncertainties);

  const paths = writeCaseReports(fixture.caseDir, fixture.caseJson, {}, [], report, { platform: 'harmony', skipRootOverview: true });
  const markdown = fs.readFileSync(paths.context, 'utf8');
  const html = fs.readFileSync(paths.contextHtml, 'utf8');
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(inlineScripts.length > 0);
  for (const script of inlineScripts) assert.doesNotThrow(() => new Function(script));
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(paths.context), 'report-metadata.json'), 'utf8'));
  assert.strictEqual(metadata.artifacts['CONTEXT.md'].sha256, crypto.createHash('sha256').update(markdown).digest('hex'));
  assert.strictEqual(metadata.artifacts['CONTEXT.html'].sha256, crypto.createHash('sha256').update(html).digest('hex'));
  assert.strictEqual(fs.existsSync(path.join(path.dirname(paths.context), 'report-publication.draft.json')), false);
  const publication = JSON.parse(fs.readFileSync(path.join(workspace, 'runs', report.execution.batchId, 'report-publication.json'), 'utf8'));
  const publicationTiming = publication.caseTimings[report.execution.executionId];
  assert.ok(Number.isFinite(publicationTiming.reportPublicationDelayMs));
  assert.ok(html.includes(formatDuration(publicationTiming.reportPublicationDelayMs)), 'first publication includes its delay');

  for (const text of ['## 原始用例', '## Agent 用例理解', '## 初始计划', '## 执行过程', '## 最终检查', '操作前观察', '操作后结论']) {
    assert.ok(markdown.includes(text), text);
  }
  for (const text of ['时长口径', '协调准备', '初始态准备', '交接准备', '交接调度', 'Agent 阶段', '报告发布延迟', 'Runtime 活跃', 'Adapter 活跃', 'Agent 与调度间隙']) {
    assert.ok(markdown.includes(text), `markdown ${text}`);
  }
  assert.ok(markdown.includes(`执行结论：${{ PASS: '通过', FAIL: '失败', INCONCLUSIVE: '无法判断', BLOCKED: '阻塞' }[verdict]}`));
  for (const text of ['结果概览', '原始用例', '用例理解', '执行计划', '执行过程', '详细日志', '验证点结果', '执行记录', 'Runtime 请求错误', '用例总耗时', '时长口径', '协调准备', '初始态准备', '交接准备', '交接调度', 'Agent 阶段', '报告发布延迟', 'Runtime 活跃', 'Adapter 活跃', 'Agent 与调度间隙']) {
    assert.ok(html.includes(text), text);
  }
  assert.strictEqual((html.match(/role="tab"/g) || []).length, 6);
  for (const hook of ['class="product-bar"', 'class="report-head"', 'class="report-tabs"', 'class="verdict-banner', 'class="metric-strip"', 'class="summary-columns"', 'class="process-layout"', 'class="step-list"', 'class="step-inspector"', 'class="logs-toolbar"']) {
    assert.ok(html.includes(hook), hook);
  }
  assert.ok(html.includes('shot-dialog'));
  assert.ok(html.includes('data-shot='));
  assert.ok(html.includes('class="step-expectations"'), verdict);
  assert.ok(html.includes('步骤 1'));
  assert.ok(html.includes('查看动作落点'));
  assert.ok(html.includes('action-spatial-evidence/action-0001.svg'));
  assert.ok(html.includes('overlaySrc'));
  assert.ok(html.includes('pointerdown'));
  assert.ok(html.includes('setPointerCapture'));
  assert.ok(html.includes('输入类动作已脱敏'));
  assert.ok(html.includes('data-panel="plan-panel"'));
  assert.strictEqual(html.includes('data-panel="raw-panel"'), false);
  assert.ok(html.includes('data-log-filter="KNOWLEDGE"'));
  assert.ok(html.includes('data-log-search'));
  assert.ok(html.includes('data-export-logs'));
  assert.ok(html.includes('data-log-context'));
  assert.ok(html.includes('data-step="0"'));
  assert.ok(html.includes('data-step-detail="0"'));
  assert.strictEqual(html.includes('technical-subtabs'), false);

  if (verdict === 'PASS') {
    assert.ok(html.includes('输入文本'));
    assert.ok(html.includes('[已脱敏]'));
    assert.strictEqual(html.includes('不应出现在报告中的输入'), false);
    assert.ok(html.includes('本次执行未触发知识库查询'));
    assert.ok(html.includes('知识调查 · 无需调查'));
  } else {
    assert.ok(html.includes('class="knowledge-process-status"'));
    assert.ok(html.includes('知识调查'));
    assert.ok(html.includes('查询内容'));
    assert.ok(html.includes('知识调查 · 无匹配候选'));
  }
  assert.ok(html.includes(fixture.result.summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
  assert.strictEqual(html.includes('<script>alert("title")</script>'), false);
  assert.strictEqual(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.strictEqual(html.includes('<b>不是 HTML</b>'), false);
}

const timingFixture = fixtures.get('PASS');
const timingExecutionPath = path.join(timingFixture.execDir, 'execution.json');
const timingExecution = JSON.parse(fs.readFileSync(timingExecutionPath, 'utf8'));
fs.writeFileSync(timingExecutionPath, JSON.stringify({
  ...timingExecution,
  caseProcessingStartedAt: '2026-08-13T09:59:55.000+08:00',
  initialStateCompletedAt: '2026-08-13T10:00:02.000+08:00',
  handoffReadyAt: '2026-08-13T10:00:03.000+08:00',
  handoffConsumedAt: '2026-08-13T10:00:04.000+08:00',
}, null, 2));
fs.unlinkSync(path.join(timingFixture.execDir, 'artifact-manifest.json'));
buildExecutionArtifactManifest(timingFixture.execDir, { now: timingExecution.endedAt });
const timingCompletionPath = path.join(timingFixture.execDir, 'completion.json');
fs.writeFileSync(timingCompletionPath, JSON.stringify({
  ...timingFixture.completion,
  artifactManifestSha256: sha256File(completionPaths(timingFixture.execDir).artifactManifest),
}, null, 2));
fs.mkdirSync(path.join(workspace, 'runs', timingFixture.execution.batchId), { recursive: true });
fs.writeFileSync(path.join(workspace, 'runs', timingFixture.execution.batchId, 'report-publication.json'), JSON.stringify({
  schemaVersion: 1,
  batchId: timingFixture.execution.batchId,
  status: 'PENDING',
  attempts: [],
  caseTimings: {
    [timingFixture.execution.executionId]: { caseReportPublishedAt: '2026-08-13T10:00:06.000+08:00' },
  },
}, null, 2));
const timingReport = readExecutionReport(timingFixture.execDir);
assert.strictEqual(timingReport.display.durationBasis, 'CASE_TOTAL');
assert.strictEqual(timingReport.display.startedAt, '2026-08-13T09:59:55.000+08:00');
assert.strictEqual(timingReport.display.durationMs, 10000);
assert.deepStrictEqual(timingReport.display.phaseDurations, {
  coordinatorPreparationMs: 5000,
  initialStatePreparationMs: 2000,
  handoffPreparationMs: 1000,
  handoffSchedulingMs: 1000,
  caseAgentPhaseMs: 1000,
  reportPublicationDelayMs: 1000,
});
const persistedTimingDisplay = currentDisplayModel({ verdict: 'PASS', checks: [], summary: 'persisted timing' }, {
  executionStatus: 'COMPLETED', elapsedMs: 5, caseTotalElapsedMs: 99,
  coordinatorPreparationMs: 10, initialStatePreparationMs: null, handoffPreparationMs: 20,
  handoffSchedulingMs: null, caseAgentPhaseMs: 30,
}, { executionId: 'execution-persisted-timing', startedAt: '2026-08-13T10:00:00.000Z' });
assert.strictEqual(persistedTimingDisplay.durationBasis, 'CASE_TOTAL');
assert.strictEqual(persistedTimingDisplay.durationMs, 99);
assert.strictEqual(persistedTimingDisplay.phaseDurations.caseAgentPhaseMs, 30);

const displayExecution = { executionId: 'execution-display', warmSessionGeneration: 1, startedAt: '2026-08-13T10:00:00.000Z' };
const blockedWithoutTechnicalFact = currentDisplayModel({ verdict: 'BLOCKED', checks: [], summary: '前置条件不足' },
  { executionStatus: 'COMPLETED' }, displayExecution, []);
assert.strictEqual(blockedWithoutTechnicalFact.verdictBasis, 'INSUFFICIENT_EVIDENCE');
assert.strictEqual(blockedWithoutTechnicalFact.failureCode, null);
const blockedByRuntime = currentDisplayModel({ verdict: 'BLOCKED', checks: [], summary: '设备连接中断' },
  { executionStatus: 'COMPLETED' }, displayExecution, [
    { sequence: 1, executionId: displayExecution.executionId, type: 'technicalIssue', technicalFactRef: 'technical-fact-0001', code: 'AUTOMATION_CONNECTION_LOST', expectationRefs: ['E1'], generation: 1 },
  ]);
assert.strictEqual(blockedByRuntime.verdictBasis, 'INSUFFICIENT_EVIDENCE');
const blockedByReferencedRuntime = currentDisplayModel({
  verdict: 'BLOCKED', summary: '设备连接中断',
  checks: [{ expectationRef: 'E1', status: 'BLOCKED', actual: '连接中断', technicalRefs: ['technical-fact-0001'] }],
}, { executionStatus: 'COMPLETED' }, displayExecution, [
  { sequence: 1, executionId: displayExecution.executionId, type: 'technicalIssue', technicalFactRef: 'technical-fact-0001', code: 'AUTOMATION_CONNECTION_LOST', expectationRefs: ['E1'], generation: 1 },
]);
assert.strictEqual(blockedByReferencedRuntime.verdictBasis, 'TECHNICAL_CONSTRAINT');
assert.strictEqual(blockedByReferencedRuntime.failureCode, 'AUTOMATION_CONNECTION_LOST');

const indexCases = collectIndexCases(workspace);
assert.strictEqual(indexCases.length, 4);
assert.ok(indexCases.some((item) => item.status === 'PASS'));
assert.ok(indexCases.some((item) => item.status === 'FAIL'));
assert.ok(indexCases.some((item) => item.status === 'BLOCKED'));
assert.ok(indexCases.some((item) => item.status === 'UNKNOWN' && item.reason && !item.reason.startsWith('INCONCLUSIVE：')));
const indexPath = renderIndexForRoot(workspace);
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const indexMetadata = JSON.parse(fs.readFileSync(path.join(workspace, 'report-metadata.json'), 'utf8'));
assert.strictEqual(indexMetadata.artifacts['index.html'].sha256, crypto.createHash('sha256').update(indexHtml).digest('hex'));
  for (const text of ['测试执行总览', '三平台执行分布', '用例执行情况']) assert.ok(indexHtml.includes(text), text);
  assert.strictEqual(indexHtml.includes('Agent 执行信号'), false);

const passFixture = fixtures.get('PASS');
const passRuntimeDir = path.join(passFixture.caseDir, 'platforms', 'harmony');
const oldCancelledDir = path.join(passRuntimeDir, 'executions', 'execution-cancelled-older');
fs.mkdirSync(oldCancelledDir, { recursive: true });
fs.writeFileSync(path.join(oldCancelledDir, 'execution.json'), JSON.stringify({
  ...passFixture.execution,
  executionId: 'execution-cancelled-older',
  status: 'CANCELLED',
  lifecycle: 'CANCELLED',
  finalized: true,
  startedAt: '2026-08-12T10:00:00.000+08:00',
  endedAt: '2026-08-12T10:01:00.000+08:00',
}));
assert.strictEqual(selectExecutionDir(passRuntimeDir).state, 'PUBLISHED');
assert.strictEqual(selectExecutionDir(passRuntimeDir).execDir, passFixture.execDir);

const activeDir = path.join(passRuntimeDir, 'executions', 'execution-active-newer');
fs.mkdirSync(activeDir, { recursive: true });
fs.writeFileSync(path.join(activeDir, 'execution.json'), JSON.stringify({
  ...passFixture.execution,
  executionId: 'execution-active-newer', finalized: false, lifecycle: 'RUNNING', phase: 'EXECUTE',
  startedAt: '2026-08-18T12:00:00.000Z', endedAt: undefined,
}));
fs.copyFileSync(path.join(passFixture.execDir, 'source.snapshot.md'), path.join(activeDir, 'source.snapshot.md'));
fs.writeFileSync(path.join(activeDir, 'case.snapshot.json'), JSON.stringify(passFixture.caseJson));
assert.strictEqual(selectExecutionDir(passRuntimeDir).state, 'ACTIVE');
assert.strictEqual(selectExecutionDir(passRuntimeDir).execDir, activeDir);
assert.deepStrictEqual(findActiveExecutions(workspace).map((entry) => entry.execDir), [activeDir]);
assert.strictEqual(readExecutionReport(activeDir).display.status, 'RUNNING');
createExecutionClosure(workspace, activeDir, {
  closedByRuntimeSha: `runtime-${'f'.repeat(16)}`,
  closedByAdapterSha: `adapter-${'e'.repeat(16)}`,
  replacementBatchId: 'batch-report-replacement',
  now: '2026-08-18T12:01:00.000Z',
});
assert.strictEqual(readExecutionReport(activeDir).display.status, 'ABANDONED');
assert.strictEqual(selectExecutionDir(passRuntimeDir).state, 'PUBLISHED');
assert.strictEqual(findActiveExecutions(workspace).length, 0);

const unsupportedNewerDir = path.join(passRuntimeDir, 'executions', 'execution-unsupported-newest');
fs.mkdirSync(unsupportedNewerDir, { recursive: true });
fs.writeFileSync(path.join(unsupportedNewerDir, 'execution.json'), JSON.stringify({
  schemaVersion: 99, executionId: 'execution-unsupported-newest', finalized: false,
  startedAt: '2026-08-19T12:00:00.000Z',
}));
assert.strictEqual(selectExecutionDir(passRuntimeDir).readability, 'FORMAT_UNSUPPORTED');
assert.strictEqual(selectExecutionDir(passRuntimeDir).execDir, unsupportedNewerDir);
const unsupportedNewestReport = readExecutionReport(selectExecutionDir(passRuntimeDir).execDir);
assert.strictEqual(unsupportedNewestReport.readability, 'FORMAT_UNSUPPORTED');
assert.strictEqual(unsupportedNewestReport.display.status, 'NEEDS_RERUN');
assert.strictEqual(unsupportedNewestReport.display.failureCode, 'FORMAT_UNSUPPORTED');
const isolatedCases = collectIndexCases(workspace);
assert.strictEqual(isolatedCases.length, fixtures.size);
assert.strictEqual(isolatedCases.filter((item) => item.status === 'REPORT_ERROR').length, 0);
assert.strictEqual(isolatedCases.find((item) => item.caseKey === passFixture.caseJson.identity.caseKey).status, 'NEEDS_RERUN');

const extraArtifact = path.join(passFixture.execDir, 'screenshots', 'extra-after-publication.png');
fs.writeFileSync(extraArtifact, Buffer.from('not part of the published artifact set'));
const changedSet = readExecutionReport(passFixture.execDir);
assert.ok(changedSet.completionError.includes('EXECUTION_ARTIFACT_SET_CHANGED'));
assert.strictEqual(changedSet.sourceText, '');
assert.strictEqual(changedSet.events.length, 0);
fs.unlinkSync(extraArtifact);

fs.appendFileSync(path.join(passFixture.execDir, 'metrics.json'), '\n');
const damaged = readExecutionReport(passFixture.execDir);
assert.strictEqual(damaged.completion, null);
assert.ok(damaged.completionError.includes('artifact hash mismatch'));
assert.strictEqual(damaged.display.status, 'BLOCKED');
assert.strictEqual(damaged.display.executionStatus, 'TECHNICALLY_BLOCKED');

const unsupportedDir = path.join(temp, 'unsupported-execution');
fs.mkdirSync(unsupportedDir);
fs.writeFileSync(path.join(unsupportedDir, 'execution.json'), JSON.stringify({ schemaVersion: 99, executionId: 'unsupported' }));
const unsupportedReport = readExecutionReport(unsupportedDir);
assert.strictEqual(unsupportedReport.readability, 'FORMAT_UNSUPPORTED');
assert.strictEqual(unsupportedReport.execution.schemaVersion, 99);
assert.strictEqual(unsupportedReport.display.status, 'NEEDS_RERUN');

const previousSchemaDir = path.join(temp, 'previous-schema-execution');
fs.mkdirSync(previousSchemaDir);
fs.writeFileSync(path.join(previousSchemaDir, 'execution.json'), JSON.stringify({ schemaVersion: 10, runtime: 'case-runtime', executionId: 'previous-schema' }));
const previousSchemaReport = readExecutionReport(previousSchemaDir);
assert.strictEqual(previousSchemaReport.readability, 'FORMAT_UNSUPPORTED');
assert.strictEqual(previousSchemaReport.display.summary, '历史结果格式不支持，需要重跑');

const invalidRuntimeDir = path.join(temp, 'invalid-runtime');
const invalidExecutionDir = path.join(invalidRuntimeDir, 'executions', 'invalid-execution');
fs.mkdirSync(invalidExecutionDir, { recursive: true });
fs.writeFileSync(path.join(invalidExecutionDir, 'execution.json'), '{ invalid json');
const invalidSelection = selectExecutionDir(invalidRuntimeDir);
assert.strictEqual(invalidSelection.readability, 'DATA_INVALID');
assert.strictEqual(invalidSelection.execDir, invalidExecutionDir);
const invalidReport = readExecutionReport(invalidExecutionDir);
assert.strictEqual(invalidReport.readability, 'DATA_INVALID');
assert.strictEqual(invalidReport.display.status, 'REPORT_DATA_INVALID');

const historicalWorkspace = path.join(temp, 'historical-workspace');
createTestWorkspace(historicalWorkspace);
const historicalFixture = createCurrentFixture(historicalWorkspace, { verdict: 'PASS', suffix: 'historical-bindings' });
const historicalExecutionPath = path.join(historicalFixture.execDir, 'execution.json');
const historicalExecution = {
  ...historicalFixture.execution,
  caseProtocolSha: 'agent-protocol-historical0001',
  runtimeSha: 'case-runtime-historical0001',
  adapterSha: 'adapter-historical0001',
};
fs.writeFileSync(historicalExecutionPath, `${JSON.stringify(historicalExecution, null, 2)}\n`);
fs.unlinkSync(path.join(historicalFixture.execDir, 'artifact-manifest.json'));
buildExecutionArtifactManifest(historicalFixture.execDir, { now: historicalExecution.endedAt });
const historicalCompletionPath = path.join(historicalFixture.execDir, 'completion.json');
const historicalCompletion = {
  ...historicalFixture.completion,
  runtimeSha: historicalExecution.runtimeSha,
  adapterSha: historicalExecution.adapterSha,
  artifactManifestSha256: sha256File(completionPaths(historicalFixture.execDir).artifactManifest),
};
fs.writeFileSync(historicalCompletionPath, `${JSON.stringify(historicalCompletion, null, 2)}\n`);
const historicalReport = readExecutionReport(historicalFixture.execDir);
assert.strictEqual(historicalReport.display.verdict, 'PASS');
assert.strictEqual(historicalReport.completionError, null);

const staleActiveExecution = {
  ...historicalExecution,
  finalized: false,
  lifecycle: 'RUNNING',
  status: 'RUNNING',
  endedAt: undefined,
};
assert.throws(() => assertCurrentExecution(staleActiveExecution), (error) => error?.code === 'AGENT_PROTOCOL_MISMATCH');

const pendingWorkspace = path.join(temp, 'pending-workspace');
createTestWorkspace(pendingWorkspace);
const pendingFixture = createCurrentFixture(pendingWorkspace, { verdict: 'PASS', title: '未发布当前用例' });
fs.unlinkSync(path.join(pendingFixture.execDir, 'completion.json'));
const pending = readExecutionReport(pendingFixture.execDir);
assert.strictEqual(pending.pendingCompletion, true);
assert.strictEqual(pending.result, null);
assert.strictEqual(pending.display.status, 'PENDING_PUBLICATION');
assert.strictEqual(pending.display.requestedVerdict, 'PASS');

const finalizingWorkspace = path.join(temp, 'finalizing-workspace');
createTestWorkspace(finalizingWorkspace);
const finalizingFixture = createCurrentFixture(finalizingWorkspace, { verdict: 'PASS', title: '收尾恢复用例' });
fs.unlinkSync(path.join(finalizingFixture.execDir, 'completion.json'));
const executionPath = path.join(finalizingFixture.execDir, 'execution.json');
const finalizingExecution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
fs.writeFileSync(executionPath, JSON.stringify({ ...finalizingExecution, finalized: false, lifecycle: 'FINALIZING', phase: 'CONCLUDE', endedAt: null }));
fs.mkdirSync(path.join(finalizingFixture.execDir, 'transactions'), { recursive: true });
fs.writeFileSync(path.join(finalizingFixture.execDir, 'transactions', 'finish.draft.json'), JSON.stringify({ schemaVersion: 1 }));
const finalizing = readExecutionReport(finalizingFixture.execDir);
assert.strictEqual(selectExecutionDir(path.dirname(path.dirname(finalizingFixture.execDir))).state, 'FINALIZATION_RECOVERY_REQUIRED');
assert.strictEqual(finalizing.finalizationPending, true);
assert.strictEqual(finalizing.display.failureCode, 'RESUME_FINALIZE');

const realWorkspace = path.join(temp, 'real-workspace');
fs.mkdirSync(realWorkspace);
fs.writeFileSync(path.join(realWorkspace, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: 'mobile-ai-visual-test-workspace' }));
assert.throws(() => createCurrentFixture(realWorkspace), /CURRENT_FIXTURE_TEST_ONLY/);
delete process.env.MAVT_SELF_TEST;
assert.throws(() => createCurrentFixture(workspace), /CURRENT_FIXTURE_TEST_ONLY/);

fs.rmSync(temp, { recursive: true, force: true });
console.log('report-reader passed');
