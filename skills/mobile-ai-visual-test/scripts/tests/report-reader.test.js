#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectIndexCases, renderIndexForRoot, writeCaseReports } = require('../report/report-service');
const { currentDisplayModel, readExecutionReport, selectExecutionDir } = require('../lib/execution-reader');
const { findActiveExecutions } = require('../lib/execution-lifecycle');
const { createExecutionClosure } = require('../lib/execution-closure');
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
  assert.strictEqual(report.display.verdict, verdict);
  assert.strictEqual(report.display.executionStatus, fixture.metrics.executionStatus);
  assert.strictEqual(report.display.summary, fixture.result.summary);
  assert.deepStrictEqual(report.display.uncertainties, fixture.result.uncertainties);

  const paths = writeCaseReports(fixture.caseDir, fixture.caseJson, {}, [], report, { platform: 'harmony', skipRootOverview: true });
  const markdown = fs.readFileSync(paths.context, 'utf8');
  const html = fs.readFileSync(paths.contextHtml, 'utf8');
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(paths.context), 'report-metadata.json'), 'utf8'));
  assert.strictEqual(metadata.artifacts['CONTEXT.md'].sha256, crypto.createHash('sha256').update(markdown).digest('hex'));
  assert.strictEqual(metadata.artifacts['CONTEXT.html'].sha256, crypto.createHash('sha256').update(html).digest('hex'));
  assert.strictEqual(fs.existsSync(path.join(path.dirname(paths.context), 'report-publication.draft.json')), false);

  for (const text of ['## 原始用例', '## Agent 用例理解', '## 初始计划', '## 执行过程', '## 最终检查', '操作前观察', '操作后结论']) {
    assert.ok(markdown.includes(text), text);
  }
  assert.ok(markdown.includes(`执行结论：${{ PASS: '通过', FAIL: '失败', INCONCLUSIVE: '无法判断', BLOCKED: '阻塞' }[verdict]}`));
  for (const text of ['执行复盘', '原始用例', '用例理解', '初始计划', '执行过程', '最终检查与证据', '证据', '技术信息', '原始数据', 'Runtime 调用 / 格式错误']) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes('shot-dialog'));
  assert.ok(html.includes('data-shot='));
  assert.ok(html.includes('class="step-expectations"'));
  assert.ok(html.includes('步骤 1'));
  assert.ok(html.includes('查看坐标标记'));
  assert.ok(html.includes('coordinate-audits/action-0001.svg'));
  assert.ok(html.includes('overlaySrc'));
  assert.ok(html.includes('输入类动作已脱敏'));
  assert.strictEqual(html.includes('data-panel="plan-panel"'), false);
  assert.strictEqual(html.includes('data-panel="raw-panel"'), false);

  if (verdict === 'PASS') {
    assert.ok(html.includes('输入文本'));
    assert.ok(html.includes('[已脱敏]'));
    assert.strictEqual(html.includes('不应出现在报告中的输入'), false);
  }
  assert.ok(html.includes(fixture.result.summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
  assert.strictEqual(html.includes('<script>alert("title")</script>'), false);
  assert.strictEqual(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.strictEqual(html.includes('<b>不是 HTML</b>'), false);
}

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
  for (const text of ['直接证据', '业务决策', '记录缺口', '知识查询']) assert.ok(indexHtml.includes(text), text);
  assert.strictEqual(indexHtml.includes('知识支持'), false);

const passFixture = fixtures.get('PASS');
const passRuntimeDir = path.join(passFixture.caseDir, 'platforms', 'harmony');
const activeDir = path.join(passRuntimeDir, 'executions', 'execution-active-newer');
fs.mkdirSync(activeDir, { recursive: true });
fs.writeFileSync(path.join(activeDir, 'execution.json'), JSON.stringify({
  ...passFixture.execution,
  executionId: 'execution-active-newer', finalized: false, lifecycle: 'RUNNING', phase: 'EXECUTE',
  startedAt: '2026-08-18T12:00:00.000Z', endedAt: undefined,
}));
fs.copyFileSync(path.join(passFixture.execDir, 'source.snapshot.md'), path.join(activeDir, 'source.snapshot.md'));
fs.writeFileSync(path.join(activeDir, 'case.snapshot.json'), JSON.stringify(passFixture.caseJson));
const unsupportedNewerDir = path.join(passRuntimeDir, 'executions', 'execution-unsupported-newest');
fs.mkdirSync(unsupportedNewerDir, { recursive: true });
fs.writeFileSync(path.join(unsupportedNewerDir, 'execution.json'), JSON.stringify({
  schemaVersion: 99, executionId: 'execution-unsupported-newest', finalized: false,
  startedAt: '2026-08-19T12:00:00.000Z',
}));
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
assert.throws(() => readExecutionReport(unsupportedDir), (error) => error?.code === 'EXECUTION_SCHEMA_UNSUPPORTED' && /run again/.test(error.message));

const staleProtocolDir = path.join(temp, 'stale-protocol-execution');
fs.mkdirSync(staleProtocolDir);
fs.writeFileSync(path.join(staleProtocolDir, 'execution.json'), JSON.stringify({
  ...passFixture.execution,
  executionId: 'stale-protocol-execution',
  caseProtocolSha: 'agent-protocol-stale000000',
}));
assert.throws(() => readExecutionReport(staleProtocolDir), (error) => error?.code === 'AGENT_PROTOCOL_MISMATCH' && /run again/.test(error.message));

const staleRuntimeDir = path.join(temp, 'stale-runtime-execution');
fs.mkdirSync(staleRuntimeDir);
fs.writeFileSync(path.join(staleRuntimeDir, 'execution.json'), JSON.stringify({
  ...passFixture.execution,
  executionId: 'stale-runtime-execution',
  runtimeSha: 'case-runtime-stale000000',
}));
assert.throws(() => readExecutionReport(staleRuntimeDir), (error) => error?.code === 'AGENT_PROTOCOL_MISMATCH' && /run again/.test(error.message));

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
