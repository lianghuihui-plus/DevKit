#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeBatch } = require('../batch/core');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { formatDisplayTime } = require('../lib/display-format');
const { refreshCommittedCaseReports, renderIndexForRoot } = require('../report/report-service');
const { renderCurrentIndexHtml } = require('../report/current-index');
const {
  createCurrentFixture,
  createTestExecutionRequest,
  createTestWorkspace,
} = require('./current-fixture');

process.env.MAVT_SELF_TEST = '1';

function expectedLocalTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const utcTime = '2026-08-21T06:18:13.721Z';
const offsetTime = '2026-08-21T14:18:13.721+08:00';
assert.strictEqual(formatDisplayTime(utcTime), expectedLocalTime(utcTime));
assert.strictEqual(formatDisplayTime(offsetTime), expectedLocalTime(offsetTime));
assert.strictEqual(formatDisplayTime(utcTime), formatDisplayTime(offsetTime));
assert.strictEqual(formatDisplayTime('2026-08-21T14:18:13'), '2026-08-21 14:18:13');
assert.strictEqual(formatDisplayTime('not-a-time'), 'not-a-time');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-dashboard-'));
const root = path.join(temp, 'workspace');
createTestWorkspace(root);

const fixtures = [
  createCurrentFixture(root, { verdict: 'PASS', suffix: 'pass-dashboard', warmSessionReused: true }),
  createCurrentFixture(root, { verdict: 'FAIL', suffix: 'fail-dashboard', recoveryCount: 1 }),
  createCurrentFixture(root, { verdict: 'BLOCKED', suffix: 'blocked-dashboard' }),
  createCurrentFixture(root, { verdict: 'INCONCLUSIVE', suffix: 'inconclusive-dashboard' }),
];
const targets = fixtures.map((fixture) => ({ caseKey: fixture.caseJson.identity.caseKey, caseDir: fixture.caseDir }));
const binding = { platform: 'harmony', deviceId: 'dashboard-device', appId: 'com.example.dashboard', entry: 'EntryAbility' };
const executionRequest = createTestExecutionRequest(root, 'batch-dashboard', binding, targets, {
  mode: 'BATCH',
  userInstruction: '按顺序批量执行四个看板用例',
  now: '2026-08-18T12:00:00.000Z',
});
initializeBatch({
  workspaceRoot: root,
  batchId: 'batch-dashboard',
  runtimeSha: executionRequest.runtimeSha,
  adapterSha: executionRequest.adapterSha,
  coordinatorSha: executionRequest.coordinatorSha,
  now: '2026-08-18T12:00:00.000Z',
});
for (const fixture of fixtures) {
  assert.strictEqual(fs.existsSync(path.join(fixture.runtimeDir, 'CONTEXT.html')), false);
  assert.strictEqual(fs.existsSync(path.join(fixture.caseDir, 'CONTEXT.html')), false);
}

const indexPath = renderIndexForRoot(root);
const indexCases = require('../report/report-service').collectIndexCases(root);
for (const fixture of fixtures) {
  assert.strictEqual(fs.existsSync(path.join(fixture.runtimeDir, 'CONTEXT.html')), true);
  assert.strictEqual(fs.existsSync(path.join(fixture.caseDir, 'CONTEXT.html')), true);
}
for (const item of indexCases) {
  for (const href of [item.contextHref, ...item.platforms.map((platform) => platform.contextHref)]) {
    assert.strictEqual(fs.existsSync(path.resolve(root, href)), true, href);
  }
}
const reportMetadata = JSON.parse(fs.readFileSync(path.join(root, 'report-metadata.json'), 'utf8'));
assert.match(reportMetadata.reportRendererSha, /^report-renderer-[0-9a-f]{16}$/);
assert.ok(reportMetadata.rendererFiles.includes('scripts/report/current-report.js'));
const html = fs.readFileSync(indexPath, 'utf8');
for (const text of [
  '运行控制状态',
  '当前运行',
  '仅展示最近一次执行批次',
  '累计 1 个批次',
  '环境确认',
  '执行授权',
  '批次进度',
  '暖会话',
  '无人值守',
  '按最终结论统计',
  '无法判断',
  '直接证据',
  '业务决策',
  '记录缺口',
  '知识查询',
  '搜索用例编号、名称或标识',
]) assert.ok(html.includes(text), text);
for (const text of ['Unattended agent execution', '>UNATTENDED<', '以最终 verdict 统计', '搜索用例名称或 caseKey']) assert.strictEqual(html.includes(text), false, text);
assert.ok(html.includes('显示 4 / 4'));
assert.ok(html.includes('data-case-status="INCONCLUSIVE"'));
assert.ok(html.includes('batch-dashboard'));
for (let index = 1; index < indexCases.length; index += 1) {
  assert.ok(html.indexOf(indexCases[index - 1].title) < html.indexOf(indexCases[index].title));
}
assert.strictEqual(html.includes('全部步骤通过'), false);
assert.strictEqual(html.includes('按状态筛选'), false);
assert.ok(html.includes('查看详情'));
for (const item of indexCases) {
  assert.ok(html.includes(`class="case-detail" href="${item.platforms[0].contextHref}"`));
}
for (const item of indexCases) assert.ok(html.includes(`用例 ${item.caseNo}`));
assert.ok(html.includes('查看报告'));
assert.strictEqual(html.includes('>报告</a>'), false);
for (const text of ['>执行平台</span>', '>结论依据</span>', '>Agent 轨迹</span>', '>耗时</span>', '>执行报告</span>']) assert.ok(html.includes(text), text);
assert.strictEqual((html.match(/class="case-facts"/g) || []).length, fixtures.length);
for (const verdict of ['pass', 'fail', 'blocked', 'inconclusive']) assert.strictEqual((html.match(new RegExp(`class="verdict ${verdict}"`, 'g')) || []).length, 1, verdict);
for (const removed of ['class="platform-run"', 'class="case-outcome"', 'class="case-basis"', '暂无平台执行记录']) assert.strictEqual(html.includes(removed), false, removed);

const unrelatedContext = path.join(fixtures[1].caseDir, 'CONTEXT.html');
const metricsPath = path.join(fixtures[0].execDir, 'metrics.json');
const metricsBeforeRefresh = fs.readFileSync(metricsPath);
const fixedTime = new Date('2026-08-01T00:00:00.000Z');
fs.utimesSync(unrelatedContext, fixedTime, fixedTime);
const incremental = refreshCommittedCaseReports(fixtures[0].caseDir, 'harmony');
const metricsAfterRefresh = fs.readFileSync(metricsPath);
assert.strictEqual(incremental.status, 'UPDATED');
assert.strictEqual(fs.existsSync(incremental.indexHtml), true);
assert.strictEqual(fs.existsSync(incremental.platformContextHtml), true);
assert.strictEqual(fs.statSync(unrelatedContext).mtimeMs, fixedTime.getTime());
assert.deepStrictEqual(metricsAfterRefresh, metricsBeforeRefresh);

const isolationRoot = path.join(temp, 'incremental-isolation');
createTestWorkspace(isolationRoot);
const activeFixture = createCurrentFixture(isolationRoot, { verdict: 'PASS', suffix: 'active-refresh' });
const brokenFixture = createCurrentFixture(isolationRoot, { verdict: 'FAIL', suffix: 'broken-refresh' });
renderIndexForRoot(isolationRoot);
const brokenExecutionDir = path.join(brokenFixture.runtimeDir, 'executions', 'execution-corrupt-json');
fs.mkdirSync(brokenExecutionDir, { recursive: true });
fs.writeFileSync(path.join(brokenExecutionDir, 'execution.json'), '{ invalid json');
const brokenContext = path.join(brokenFixture.caseDir, 'CONTEXT.html');
fs.utimesSync(brokenContext, fixedTime, fixedTime);
const isolatedIncremental = refreshCommittedCaseReports(activeFixture.caseDir, 'harmony');
assert.strictEqual(isolatedIncremental.status, 'UPDATED');
assert.strictEqual(fs.statSync(brokenContext).mtimeMs, fixedTime.getTime());
assert.ok(fs.readFileSync(isolatedIncremental.indexHtml, 'utf8').includes('报告数据异常'));

const multiPlatformHtml = renderCurrentIndexHtml(root, [{
  caseNo: '99', title: '多平台结果用例', caseKey: 'ck-multi-platform', status: 'FAIL', verdict: 'FAIL',
  executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', reason: '不同平台结果需要分别展示。',
  durationMs: 3000, contextHref: 'cases/multi/CONTEXT.html',
  platforms: [
    { platform: 'harmony', status: 'PASS', verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', durationMs: 1000, contextHref: 'cases/multi/platforms/harmony/CONTEXT.html', schemaFamily: 'current', currentMetrics: { counts: { agentDecisions: 3, narrativeGaps: 0, knowledgeQueries: 2 }, executionRecoveryCount: 0 } },
    { platform: 'android', status: 'FAIL', verdict: 'FAIL', executionStatus: 'COMPLETED', verdictBasis: 'TECHNICAL_CONSTRAINT', durationMs: 2000, contextHref: 'cases/multi/platforms/android/CONTEXT.html', schemaFamily: 'current', currentMetrics: { counts: { agentDecisions: 5, narrativeGaps: 1, knowledgeQueries: 4 }, warmSessionReused: true, executionRecoveryCount: 1 } },
  ],
}]);
assert.strictEqual((multiPlatformHtml.match(/class="platform-breakdown-row"/g) || []).length, 2);
assert.strictEqual((multiPlatformHtml.match(/class="case-facts"/g) || []).length, 0);
assert.strictEqual((multiPlatformHtml.match(/class="report-link"/g) || []).length, 2);
assert.ok(multiPlatformHtml.includes('2 个平台'));
assert.ok(multiPlatformHtml.includes('平台明细'));
for (const text of ['平台结果', '结论依据', 'Agent 轨迹', '耗时', '>报告</span>']) assert.ok(multiPlatformHtml.includes(text), text);
for (const text of ['决策 3 · 知识 2 · 暖状态 首用例 · 恢复 0', '决策 5 · 知识 4 · 暖状态 复用 · 恢复 1', '直接证据', '技术约束', '1 秒', '2 秒']) assert.ok(multiPlatformHtml.includes(text), text);

const staleRoot = path.join(temp, 'source-change');
createTestWorkspace(staleRoot);
const staleFixture = createCurrentFixture(staleRoot, { verdict: 'PASS', suffix: 'source-changed' });
renderIndexForRoot(staleRoot);
const currentCase = JSON.parse(fs.readFileSync(path.join(staleFixture.caseDir, 'case.json'), 'utf8'));
const updatedSource = '原文已经更新，历史结论需要重新执行';
const updatedCase = createCaseContract({
  caseKey: currentCase.identity.caseKey,
  caseNo: currentCase.identity.caseNo,
  title: currentCase.identity.title,
  sourceText: updatedSource,
  importPath: currentCase.identity.importSource.path,
});
fs.writeFileSync(path.join(staleFixture.caseDir, 'source.md'), updatedSource);
fs.writeFileSync(path.join(staleFixture.caseDir, 'case.json'), `${JSON.stringify(updatedCase, null, 2)}\n`);
const staleIndexPath = renderIndexForRoot(staleRoot);
const staleSummary = require('../report/report-service').collectIndexCases(staleRoot)[0];
assert.strictEqual(staleSummary.status, 'NEEDS_RERUN');
assert.strictEqual(staleSummary.verdict, null);
assert.strictEqual(staleSummary.platforms[0].sourceCurrent, false);
assert.ok(fs.readFileSync(staleIndexPath, 'utf8').includes('需重新执行'));
assert.ok(fs.readFileSync(path.join(staleFixture.caseDir, 'CONTEXT.html'), 'utf8').includes('用例原文已更新'));

const corruptFixture = createCurrentFixture(root, { verdict: 'PASS', suffix: 'corrupt-dashboard' });
const corruptExecutionDir = path.join(corruptFixture.runtimeDir, 'executions', 'execution-corrupt-json');
fs.mkdirSync(corruptExecutionDir, { recursive: true });
fs.writeFileSync(path.join(corruptExecutionDir, 'execution.json'), '{ invalid json');
const isolatedIndexPath = renderIndexForRoot(root);
const isolatedHtml = fs.readFileSync(isolatedIndexPath, 'utf8');
const isolatedMetadata = JSON.parse(fs.readFileSync(path.join(root, 'report-metadata.json'), 'utf8'));
assert.ok(isolatedHtml.includes('报告数据异常'));
assert.ok(isolatedHtml.includes(corruptFixture.caseJson.identity.title));
assert.ok(fs.readFileSync(path.join(corruptFixture.caseDir, 'CONTEXT.html'), 'utf8').includes('报告数据异常'));
assert.strictEqual(isolatedMetadata.reportErrors.length, 1);
for (const fixture of fixtures) assert.strictEqual(fs.existsSync(path.join(fixture.runtimeDir, 'CONTEXT.html')), true);

fs.rmSync(temp, { recursive: true, force: true });
console.log('dashboard passed');
