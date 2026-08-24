#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectIndexCases,
  renderIndexForRoot,
  writeCaseReports,
} = require('../report/report-service');
const { readExecutionReport, selectExecutionDir } = require('../lib/execution-reader');
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
  assert.strictEqual(report.display.executionStatus, fixture.result.executionStatus);
  assert.strictEqual(report.display.summary, fixture.result.summary);
  assert.deepStrictEqual(report.display.uncertainties, fixture.result.uncertainties);
  const paths = writeCaseReports(fixture.caseDir, fixture.caseJson, {}, [], report, { platform: 'harmony', skipRootOverview: true });
  const markdown = fs.readFileSync(paths.context, 'utf8');
  const html = fs.readFileSync(paths.contextHtml, 'utf8');
  const reportMetadata = JSON.parse(fs.readFileSync(path.join(path.dirname(paths.context), 'report-metadata.json'), 'utf8'));
  assert.strictEqual(reportMetadata.artifacts['CONTEXT.md'].sha256, crypto.createHash('sha256').update(markdown).digest('hex'));
  assert.strictEqual(reportMetadata.artifacts['CONTEXT.html'].sha256, crypto.createHash('sha256').update(html).digest('hex'));
  assert.strictEqual(fs.existsSync(path.join(path.dirname(paths.context), 'report-publication.draft.json')), false);
  assert.ok(markdown.includes(`执行结论：${{ PASS: '通过', FAIL: '失败', INCONCLUSIVE: '无法判断', BLOCKED: '阻塞' }[verdict]}`));
  assert.ok(markdown.includes(fixture.result.summary));
  assert.ok(markdown.includes('## 完整执行轨迹'));
  assert.ok(markdown.includes('## 恢复锚点'));
  assert.ok(markdown.includes('操作前'));
  assert.ok(markdown.includes('操作后'));
  assert.ok(markdown.includes(verdict === 'PASS' ? '操作：输入文本' : '操作：点击'));
  assert.ok(markdown.includes('定位依据：视觉识别'));
  if (verdict === 'PASS') assert.ok(markdown.includes('输入方式：替换原内容'));
  assert.strictEqual(markdown.includes('"coordinateSource"'), false);
  assert.ok(markdown.includes('直接证据') || markdown.includes('证据不足') || markdown.includes('技术约束'));
  assert.ok(html.includes('执行详情'));
  assert.ok(html.includes('检查点执行'));
  assert.ok(html.includes('技术记录'));
  assert.ok(html.includes('恢复锚点'));
  assert.ok(html.includes('shot-dialog'));
  assert.ok(html.includes('data-shot='));
  assert.ok(html.includes('控件树'));
  assert.ok(html.includes('输入类动作已脱敏'));
  assert.ok(html.includes('执行状态'));
  assert.ok(html.includes('结论依据'));
  assert.ok(html.includes('计划版本'));
  assert.ok(html.includes('执行计划'));
  assert.ok(html.includes('最新版本'));
  assert.ok(html.includes('1 个检查点'));
  assert.ok(html.includes('形成可展示结论'));
  assert.strictEqual(html.includes('data-panel="plan-panel"'), false);
  const actionSpec = html.match(/<div class="action-spec">[\s\S]*?<\/dl><\/div>/)?.[0] || '';
  assert.ok(actionSpec.includes('<dt>目标</dt>'));
  assert.ok(actionSpec.includes('<dt>定位依据</dt><dd>视觉识别</dd>'));
  if (verdict === 'PASS') {
    assert.ok(actionSpec.includes('<b>输入文本</b>'));
    assert.ok(actionSpec.includes('<dt>输入内容</dt><dd>[已脱敏]</dd>'));
    assert.ok(actionSpec.includes('<dt>输入方式</dt><dd>替换原内容</dd>'));
    assert.strictEqual(html.includes('不应出现在报告中的输入'), false);
  }
  assert.strictEqual(actionSpec.includes('coordinateSource'), false);
  assert.strictEqual(actionSpec.includes('<code>'), false);
  for (const text of ['>Execution status<', '>Verdict basis<', '>Plan revision<', '>Checkpoint<', '>Requirement 结果<']) assert.strictEqual(html.includes(text), false, text);
  assert.ok(html.includes(fixture.result.summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
  assert.ok(!html.includes('<script>alert("title")</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('<b>不是 HTML</b>'));
}

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
assert.strictEqual(fs.existsSync(path.join(workspace, 'report-publication.draft.json')), false);
assert.ok(indexHtml.includes('直接证据'));
assert.ok(indexHtml.includes('知识支持'));
assert.ok(indexHtml.includes('计划修订'));
assert.ok(indexHtml.includes('知识查询'));

const passFixture = fixtures.get('PASS');
const passRuntimeDir = path.join(passFixture.caseDir, 'platforms', 'harmony');
const activeDir = path.join(passRuntimeDir, 'executions', 'execution-active-newer');
fs.mkdirSync(activeDir, { recursive: true });
fs.writeFileSync(path.join(activeDir, 'execution.json'), JSON.stringify({
  ...passFixture.execution,
  executionId: 'execution-active-newer',
  finalized: false,
  lifecycle: 'RUNNING',
  phase: 'EXECUTE',
  startedAt: '2026-08-18T12:00:00.000Z',
  endedAt: undefined,
}));
fs.copyFileSync(path.join(passFixture.execDir, 'source.snapshot.md'), path.join(activeDir, 'source.snapshot.md'));
fs.writeFileSync(path.join(activeDir, 'case.snapshot.json'), JSON.stringify(passFixture.caseJson));
assert.strictEqual(selectExecutionDir(passRuntimeDir).state, 'ACTIVE');
assert.strictEqual(selectExecutionDir(passRuntimeDir).execDir, activeDir);
assert.strictEqual(readExecutionReport(activeDir).display.status, 'RUNNING');

const extraArtifact = path.join(passFixture.execDir, 'screenshots', 'extra-after-publication.png');
fs.writeFileSync(extraArtifact, Buffer.from('not part of the published artifact set'));
const changedSet = readExecutionReport(passFixture.execDir);
assert.ok(changedSet.completionError.includes('EXECUTION_ARTIFACT_SET_CHANGED'));
assert.strictEqual(changedSet.sourceText, '');
assert.strictEqual(changedSet.understanding, null);
assert.strictEqual(changedSet.plan, null);
assert.strictEqual(changedSet.events.length, 0);
fs.unlinkSync(extraArtifact);

fs.appendFileSync(path.join(passFixture.execDir, 'metrics.json'), '\n');
const damaged = readExecutionReport(passFixture.execDir);
assert.strictEqual(damaged.completion, null);
assert.ok(damaged.completionError.includes('artifact hash mismatch'));
assert.strictEqual(damaged.display.status, 'BLOCKED');
assert.strictEqual(damaged.display.executionStatus, 'TECHNICALLY_BLOCKED');

const unknownDir = path.join(temp, 'unknown-execution');
fs.mkdirSync(unknownDir);
fs.writeFileSync(path.join(unknownDir, 'execution.json'), JSON.stringify({ schemaVersion: 99, executionId: 'unknown' }));
fs.writeFileSync(path.join(unknownDir, 'result.json'), JSON.stringify({ schemaVersion: 99, executionId: 'unknown' }));
assert.throws(() => readExecutionReport(unknownDir), (error) => error?.code === 'EXECUTION_SCHEMA_UNSUPPORTED');

const historicalDir = path.join(temp, 'historical-execution');
fs.mkdirSync(historicalDir);
fs.writeFileSync(path.join(historicalDir, 'execution.json'), JSON.stringify({ schemaVersion: 2, executionId: 'execution-historical' }));
fs.writeFileSync(path.join(historicalDir, 'case.snapshot.json'), JSON.stringify({ identity: { caseKey: 'ck-historical' }, steps: [] }));
fs.writeFileSync(path.join(historicalDir, 'result.json'), JSON.stringify({ executionId: 'execution-historical', status: 'PASS', reason: '历史结果' }));
fs.writeFileSync(path.join(historicalDir, 'metrics.json'), JSON.stringify({ executionId: 'execution-historical', durationMs: 100, steps: { passed: 1, total: 1 } }));
const historical = readExecutionReport(historicalDir);
assert.strictEqual(historical.schemaFamily, 'historical');
assert.strictEqual(historical.display.status, 'PASS');
assert.strictEqual(historical.display.stepsSummary, '1/1');

const pendingWorkspace = path.join(temp, 'pending-workspace');
createTestWorkspace(pendingWorkspace);
const pendingFixture = createCurrentFixture(pendingWorkspace, { verdict: 'PASS', title: '未发布当前用例' });
fs.unlinkSync(path.join(pendingFixture.execDir, 'completion.json'));
const pending = readExecutionReport(pendingFixture.execDir);
assert.strictEqual(pending.schemaFamily, 'current');
assert.strictEqual(pending.pendingCompletion, true);
assert.strictEqual(pending.rawResult.verdict, 'PASS');
assert.strictEqual(pending.result, null);
assert.strictEqual(pending.display.status, 'PENDING_PUBLICATION');
assert.strictEqual(pending.display.executionStatus, 'PENDING_PUBLICATION');
assert.strictEqual(pending.display.requestedVerdict, 'PASS');
assert.ok(pending.display.summary.includes('等待框架'));

const finalizingWorkspace = path.join(temp, 'finalizing-workspace');
createTestWorkspace(finalizingWorkspace);
const finalizingFixture = createCurrentFixture(finalizingWorkspace, { verdict: 'PASS', title: '收尾恢复用例' });
fs.unlinkSync(path.join(finalizingFixture.execDir, 'completion.json'));
const finalizingExecution = JSON.parse(fs.readFileSync(path.join(finalizingFixture.execDir, 'execution.json'), 'utf8'));
fs.writeFileSync(path.join(finalizingFixture.execDir, 'execution.json'), JSON.stringify({
  ...finalizingExecution, finalized: false, lifecycle: 'FINALIZING', phase: 'CONCLUDE', endedAt: null,
}));
fs.writeFileSync(path.join(finalizingFixture.execDir, 'finalization.draft.json'), JSON.stringify({ schemaVersion: 1 }));
const finalizing = readExecutionReport(finalizingFixture.execDir);
assert.strictEqual(selectExecutionDir(path.dirname(path.dirname(finalizingFixture.execDir))).state, 'FINALIZATION_RECOVERY_REQUIRED');
assert.strictEqual(finalizing.finalizationPending, true);
assert.strictEqual(finalizing.result, null);
assert.strictEqual(finalizing.display.status, 'FINALIZATION_RECOVERY_REQUIRED');
assert.strictEqual(finalizing.display.failureCode, 'RESUME_FINALIZE');

const realWorkspace = path.join(temp, 'real-workspace');
fs.mkdirSync(realWorkspace);
fs.writeFileSync(path.join(realWorkspace, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: 'mobile-ai-visual-test-workspace' }));
assert.throws(() => createCurrentFixture(realWorkspace), /CURRENT_FIXTURE_TEST_ONLY/);
delete process.env.MAVT_SELF_TEST;
assert.throws(() => createCurrentFixture(workspace), /CURRENT_FIXTURE_TEST_ONLY/);

fs.rmSync(temp, { recursive: true, force: true });
console.log('report-reader passed');
