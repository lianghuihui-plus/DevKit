#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { initializeBatch } = require('../batch/core');
const { createCaseContract } = require('../execution/contracts/case-contract');
const { formatDisplayTime, formatDuration } = require('../lib/display-format');
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

function runIndexFilters(html) {
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'dashboard inline script');
  const listeners = new Map();
  const statusButtons = [...html.matchAll(/<button[^>]*data-case-filter="([^"]+)"[^>]*>/g)].map((match) => ({
    dataset: { caseFilter: match[1] },
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(`status:${match[1]}:${type}`, listener); },
  }));
  const platformButtons = [...html.matchAll(/<button[^>]*data-platform-filter="([^"]+)"[^>]*>/g)].map((match) => ({
    dataset: { platformFilter: match[1] },
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(`platform:${match[1]}:${type}`, listener); },
  }));
  const attribute = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
  const cards = [...html.matchAll(/<section class="case-row"[^>]*>/g)].map((match) => ({
    dataset: {
      caseStatus: attribute(match[0], 'data-case-status'),
      casePlatforms: attribute(match[0], 'data-case-platforms'),
      caseResults: attribute(match[0], 'data-case-results'),
      caseSearch: attribute(match[0], 'data-case-search'),
    },
    hidden: false,
  }));
  const search = { value: '', addEventListener() {} };
  const result = { textContent: '' };
  const empty = { hidden: true };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-case-filter]') return statusButtons;
      if (selector === '[data-platform-filter]') return platformButtons;
      return cards;
    },
    querySelector(selector) { return selector === '.search' ? search : selector === '.filter-result' ? result : empty; },
  };
  vm.runInNewContext(script, { document });
  return {
    clickStatus(status) {
      listeners.get(`status:${status}:click`)();
      return cards.filter((card) => !card.hidden).length;
    },
    clickPlatform(platform) {
      listeners.get(`platform:${platform}:click`)();
      return cards.filter((card) => !card.hidden).length;
    },
  };
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
const caseContractsBeforeRender = new Map(fixtures.map((fixture) => [
  fixture.caseDir,
  fs.readFileSync(path.join(fixture.caseDir, 'case.json')),
]));

const indexPath = renderIndexForRoot(root);
const indexCases = require('../report/report-service').collectIndexCases(root);
for (const fixture of fixtures) {
  assert.deepStrictEqual(fs.readFileSync(path.join(fixture.caseDir, 'case.json')), caseContractsBeforeRender.get(fixture.caseDir));
  assert.strictEqual(fs.existsSync(path.join(fixture.runtimeDir, 'CONTEXT.html')), true);
  assert.strictEqual(fs.existsSync(path.join(fixture.caseDir, 'CONTEXT.html')), true);
  const caseContentHtml = fs.readFileSync(path.join(fixture.caseDir, 'CONTEXT.html'), 'utf8');
  assert.ok(caseContentHtml.includes('用例内容'));
  assert.ok(caseContentHtml.includes('原始用例'));
  assert.ok(caseContentHtml.includes('class="product-bar"'));
  assert.ok(caseContentHtml.includes('class="case-only-meta"'));
  assert.ok(caseContentHtml.includes('class="case-document full"'));
  for (const label of ['用例编号', 'caseKey', 'sourceSha', '导入来源']) assert.ok(caseContentHtml.includes(label), label);
  assert.strictEqual(caseContentHtml.includes('平台执行'), false);
  assert.strictEqual(caseContentHtml.includes('/platforms/'), false);
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
const firstPublication = JSON.parse(fs.readFileSync(path.join(root, 'runs', fixtures[0].execution.batchId, 'report-publication.json'), 'utf8'));
const firstPublicationTiming = firstPublication.caseTimings[fixtures[0].execution.executionId];
assert.ok(Number.isFinite(firstPublicationTiming.reportPublicationDelayMs));
assert.ok(fs.readFileSync(path.join(fixtures[0].runtimeDir, 'CONTEXT.html'), 'utf8')
  .includes(formatDuration(firstPublicationTiming.reportPublicationDelayMs)), 'case detail includes publication delay');
const filters = runIndexFilters(html);
for (const status of ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE']) assert.strictEqual(filters.clickStatus(status), 1, status);
assert.strictEqual(filters.clickStatus('NOT_RUN'), 0, 'NOT_RUN');
assert.strictEqual(filters.clickStatus('ALL'), 4, 'ALL status');
assert.strictEqual(filters.clickPlatform('harmony'), 4, 'HarmonyOS platform');
assert.strictEqual(filters.clickPlatform('android'), 0, 'Android platform');
for (const text of [
  'class="product-bar"',
  'class="summary-matrix"',
  'class="matrix-intro"',
  '用例执行情况',
  '无法判断',
  '搜索用例编号、名称或标识',
]) assert.ok(html.includes(text), text);
for (const text of ['run-control-section', 'control-band', 'outcome-band', 'Agent 执行信号', 'class="case-status"', '执行中']) assert.strictEqual(html.includes(text), false, text);
assert.ok(html.includes('显示 4 / 4'));
assert.ok(html.includes('data-case-status="INCONCLUSIVE"'));
assert.ok(html.includes('batch-dashboard'));
for (let index = 1; index < indexCases.length; index += 1) {
  assert.ok(html.indexOf(indexCases[index - 1].title) < html.indexOf(indexCases[index].title));
}
assert.strictEqual(html.includes('全部步骤通过'), false);
assert.strictEqual(html.includes('按状态筛选'), false);
assert.strictEqual(html.includes('查看详情'), false);
for (const item of indexCases) {
  assert.ok(html.includes(`class="icon-button" href="${item.contextHref}"`));
}
assert.ok(html.includes('查看用例内容'));
assert.strictEqual((html.match(/class="platform-summary /g) || []).length, 3);
assert.ok(html.includes('class="summary-counts"'));
assert.ok(html.includes('25%'));
assert.ok(html.includes('未执行</small><b>4</b><em>100%</em>'));
assert.strictEqual((html.match(/class="platform-run /g) || []).length, fixtures.length);
for (const text of ['三端统计', '平均耗时', '用例总耗时', '开始时间', '结束时间', '动作 / 观察', '验证点', '恢复']) assert.ok(html.includes(text), text);
for (const text of ['时长口径', '协调准备', '初始态准备', '交接准备', '交接调度', 'Agent 阶段', '报告发布延迟', 'Runtime 活跃', 'Adapter 活跃', 'Agent 与调度间隙']) {
  assert.strictEqual(html.includes(text), false, `overview must not include ${text}`);
}
assert.match(html, /font-variant-numeric:tabular-nums/);
assert.match(html, /white-space:nowrap/);
for (const item of indexCases) assert.ok(html.includes(`用例 ${item.caseNo}`));
assert.ok(html.includes('aria-label="查看执行报告"'));
assert.strictEqual((html.match(/class="case-common"/g) || []).length, fixtures.length);
for (const removed of ['class="platform-execution-row"', 'class="case-outcome"', 'class="case-basis"', '暂无平台执行记录']) assert.strictEqual(html.includes(removed), false, removed);
const filterOrder = ['PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN'].map((value) => html.indexOf(`data-case-filter="${value}"`));
assert.ok(filterOrder.every((position) => position >= 0));
assert.deepStrictEqual(filterOrder, filterOrder.slice().sort((a, b) => a - b));
const platformFilterOrder = ['ALL', 'harmony', 'android', 'ios'].map((value) => html.indexOf(`data-platform-filter="${value}"`));
assert.ok(platformFilterOrder.every((position) => position >= 0));
assert.deepStrictEqual(platformFilterOrder, platformFilterOrder.slice().sort((a, b) => a - b));
assert.ok(html.includes('aria-label="筛选执行平台"'));

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
const activeCaseBeforeReport = fs.readFileSync(path.join(activeFixture.caseDir, 'case.json'));
const brokenCaseBeforeReport = fs.readFileSync(path.join(brokenFixture.caseDir, 'case.json'));
renderIndexForRoot(isolationRoot);
assert.deepStrictEqual(fs.readFileSync(path.join(activeFixture.caseDir, 'case.json')), activeCaseBeforeReport);
assert.deepStrictEqual(fs.readFileSync(path.join(brokenFixture.caseDir, 'case.json')), brokenCaseBeforeReport);
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
    { platform: 'harmony', status: 'PASS', verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', durationBasis: 'CASE_TOTAL_V1', durationMs: 1000, coverage: '3/3', contextHref: 'cases/multi/platforms/harmony/CONTEXT.html', schemaFamily: 'current', phaseDurations: { coordinatorPreparationMs: 100, initialStatePreparationMs: 200, handoffPreparationMs: 100, handoffSchedulingMs: 100, caseAgentPhaseMs: 500, reportPublicationDelayMs: 50 }, currentMetrics: { counts: { actions: 3, observations: 4, agentDecisions: 3, narrativeGaps: 0, knowledgeQueries: 2 }, executionRecoveryCount: 0 } },
    { platform: 'android', status: 'FAIL', verdict: 'FAIL', executionStatus: 'COMPLETED', verdictBasis: 'TECHNICAL_CONSTRAINT', durationMs: 2000, coverage: '2/3', contextHref: 'cases/multi/platforms/android/CONTEXT.html', schemaFamily: 'current', currentMetrics: { counts: { actions: 5, observations: 6, agentDecisions: 5, narrativeGaps: 1, knowledgeQueries: 4 }, warmSessionReused: true, executionRecoveryCount: 1 } },
  ],
}]);
assert.strictEqual((multiPlatformHtml.match(/class="platform-run /g) || []).length, 2);
assert.strictEqual((multiPlatformHtml.match(/class="common-stat"/g) || []).length, 2);
assert.strictEqual((multiPlatformHtml.match(/aria-label="查看执行报告"/g) || []).length, 2);
assert.ok(multiPlatformHtml.includes('1 通 · 1 失 · 0 阻 · 0 无法 · 1 未'));
assert.ok(multiPlatformHtml.includes('查看用例内容'));
for (const text of ['动作 / 观察', '验证点', '恢复', '用例总耗时', '开始时间', '结束时间']) assert.ok(multiPlatformHtml.includes(text), text);
for (const text of ['时长口径', '协调准备', '初始态准备', '交接准备', '交接调度', 'Agent 阶段', '报告发布延迟']) {
  assert.strictEqual(multiPlatformHtml.includes(text), false, text);
}
for (const text of ['3 / 4', '5 / 6', '3/3', '2/3', '直接证据', '技术约束', '1 秒', '2 秒']) assert.ok(multiPlatformHtml.includes(text), text);

const combinedFilterHtml = renderCurrentIndexHtml(root, [
  {
    caseNo: '91', title: '鸿蒙通过安卓失败', caseKey: 'ck-combined-a', contextHref: 'cases/a/CONTEXT.html',
    platforms: [
      { platform: 'harmony', status: 'PASS', verdict: 'PASS', contextHref: 'cases/a/platforms/harmony/CONTEXT.html' },
      { platform: 'android', status: 'FAIL', verdict: 'FAIL', contextHref: 'cases/a/platforms/android/CONTEXT.html' },
    ],
  },
  {
    caseNo: '92', title: '鸿蒙失败苹果通过', caseKey: 'ck-combined-b', contextHref: 'cases/b/CONTEXT.html',
    platforms: [
      { platform: 'harmony', status: 'FAIL', verdict: 'FAIL', contextHref: 'cases/b/platforms/harmony/CONTEXT.html' },
      { platform: 'ios', status: 'PASS', verdict: 'PASS', contextHref: 'cases/b/platforms/ios/CONTEXT.html' },
    ],
  },
  {
    caseNo: '93', title: '苹果失败', caseKey: 'ck-combined-c', contextHref: 'cases/c/CONTEXT.html',
    platforms: [
      { platform: 'ios', status: 'FAIL', verdict: 'FAIL', contextHref: 'cases/c/platforms/ios/CONTEXT.html' },
    ],
  },
]);
const combinedFilters = runIndexFilters(combinedFilterHtml);
assert.strictEqual(combinedFilters.clickStatus('FAIL'), 3, 'FAIL across all platforms');
assert.strictEqual(combinedFilters.clickPlatform('harmony'), 1, 'FAIL + HarmonyOS');
assert.strictEqual(combinedFilters.clickPlatform('ios'), 1, 'FAIL + iOS');
assert.strictEqual(combinedFilters.clickStatus('PASS'), 1, 'PASS + iOS');
assert.strictEqual(combinedFilters.clickPlatform('ALL'), 2, 'PASS across all platforms');
assert.strictEqual(combinedFilters.clickStatus('ALL'), 3, 'all statuses and platforms');

const detailHtml = fs.readFileSync(path.join(fixtures[0].runtimeDir, 'CONTEXT.html'), 'utf8');
for (const text of ['用例总耗时', '时长口径', '协调准备', '初始态准备', '交接准备', '交接调度', 'Agent 阶段', '报告发布延迟', 'Runtime 活跃', 'Adapter 活跃', 'Agent 与调度间隙', '开始时间', '结束时间']) {
  assert.ok(detailHtml.includes(text), `detail must include ${text}`);
}
assert.match(detailHtml, /font-variant-numeric:tabular-nums/);
assert.match(detailHtml, /timing-breakdown dd\{[^}]*white-space:nowrap/);

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
assert.ok(fs.readFileSync(path.join(staleFixture.caseDir, 'CONTEXT.html'), 'utf8').includes(updatedSource));

const historicalIsolationRoot = path.join(temp, 'historical-platform-isolation');
createTestWorkspace(historicalIsolationRoot);
const currentIosFixture = createCurrentFixture(historicalIsolationRoot, {
  verdict: 'PASS', suffix: 'current-ios-with-history', platform: 'ios',
});
const oldHarmonyDir = path.join(
  currentIosFixture.caseDir,
  'platforms',
  'harmony',
  'executions',
  'execution-schema-10',
);
fs.mkdirSync(oldHarmonyDir, { recursive: true });
const oldHarmonyExecution = `${JSON.stringify({
  schemaVersion: 10,
  runtime: 'case-runtime',
  executionId: 'execution-schema-10',
  platform: 'harmony',
  startedAt: '2026-08-12T09:00:00.000Z',
  endedAt: '2026-08-12T09:01:00.000Z',
  finalized: true,
}, null, 2)}\n`;
fs.writeFileSync(path.join(oldHarmonyDir, 'execution.json'), oldHarmonyExecution);
const historicalIndex = renderIndexForRoot(historicalIsolationRoot);
const historicalProjection = require('../report/report-service').collectIndexCases(historicalIsolationRoot)[0];
assert.strictEqual(historicalProjection.status, 'PASS');
assert.strictEqual(historicalProjection.platforms.length, 2);
assert.strictEqual(historicalProjection.platforms.find((item) => item.platform === 'ios').status, 'PASS');
const historicalHarmony = historicalProjection.platforms.find((item) => item.platform === 'harmony');
assert.strictEqual(historicalHarmony.status, 'NEEDS_RERUN');
assert.strictEqual(historicalHarmony.readability, 'FORMAT_UNSUPPORTED');
assert.strictEqual(historicalHarmony.reason, '历史结果格式不支持，需要重跑');
assert.ok(fs.readFileSync(historicalIndex, 'utf8').includes('历史结果格式不支持，需要重跑'));
assert.strictEqual(fs.readFileSync(path.join(oldHarmonyDir, 'execution.json'), 'utf8'), oldHarmonyExecution);

const historyOnlyRoot = path.join(temp, 'history-only');
createTestWorkspace(historyOnlyRoot);
const historyOnlyFixture = createCurrentFixture(historyOnlyRoot, { verdict: 'PASS', suffix: 'history-only' });
const historyOnlyExecutionPath = path.join(historyOnlyFixture.execDir, 'execution.json');
const historyOnlyExecution = `${JSON.stringify({
  schemaVersion: 10,
  runtime: 'case-runtime',
  executionId: historyOnlyFixture.execution.executionId,
  platform: 'harmony',
  startedAt: historyOnlyFixture.execution.startedAt,
  endedAt: historyOnlyFixture.execution.endedAt,
  finalized: true,
}, null, 2)}\n`;
fs.writeFileSync(historyOnlyExecutionPath, historyOnlyExecution);
const historyOnlyIndex = renderIndexForRoot(historyOnlyRoot);
const historyOnlySummary = require('../report/report-service').collectIndexCases(historyOnlyRoot)[0];
assert.strictEqual(historyOnlySummary.status, 'NEEDS_RERUN');
assert.strictEqual(historyOnlySummary.reportErrorCode, undefined);
assert.ok(fs.readFileSync(historyOnlyIndex, 'utf8').includes('需重新执行'));
assert.strictEqual(fs.readFileSync(historyOnlyExecutionPath, 'utf8'), historyOnlyExecution);

const corruptFixture = createCurrentFixture(root, { verdict: 'PASS', suffix: 'corrupt-dashboard' });
const corruptExecutionDir = path.join(corruptFixture.runtimeDir, 'executions', 'execution-corrupt-json');
fs.mkdirSync(corruptExecutionDir, { recursive: true });
fs.writeFileSync(path.join(corruptExecutionDir, 'execution.json'), '{ invalid json');
const isolatedIndexPath = renderIndexForRoot(root);
const isolatedHtml = fs.readFileSync(isolatedIndexPath, 'utf8');
const isolatedMetadata = JSON.parse(fs.readFileSync(path.join(root, 'report-metadata.json'), 'utf8'));
assert.ok(isolatedHtml.includes('报告数据异常'));
assert.ok(isolatedHtml.includes(corruptFixture.caseJson.identity.title));
assert.ok(fs.readFileSync(path.join(corruptFixture.runtimeDir, 'CONTEXT.html'), 'utf8').includes('报告数据异常'));
assert.ok(fs.readFileSync(path.join(corruptFixture.caseDir, 'CONTEXT.html'), 'utf8').includes('原始用例'));
assert.strictEqual(require('../report/report-service').collectIndexCases(root)
  .find((item) => item.caseKey === corruptFixture.caseJson.identity.caseKey).status, 'REPORT_DATA_INVALID');
assert.strictEqual(isolatedMetadata.reportErrors.length, 0);
for (const fixture of fixtures) assert.strictEqual(fs.existsSync(path.join(fixture.runtimeDir, 'CONTEXT.html')), true);

fs.rmSync(temp, { recursive: true, force: true });
console.log('dashboard passed');
