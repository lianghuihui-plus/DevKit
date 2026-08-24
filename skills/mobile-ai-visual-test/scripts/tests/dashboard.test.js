#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeBatch } = require('../batch/core');
const { formatDisplayTime } = require('../lib/display-format');
const { renderIndexForRoot } = require('../report/report-service');
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
  implementationSha: executionRequest.implementationSha,
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
assert.match(reportMetadata.rendererSha, /^report-renderer-[0-9a-f]{16}$/);
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
  '计划修订',
  '知识查询',
  '搜索用例名称或用例标识',
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
assert.ok(html.includes('查看报告'));
assert.strictEqual(html.includes('>报告</a>'), false);
for (const text of ['>执行平台</span>', '>结论依据</span>', '>Agent 轨迹</span>', '>耗时</span>', '>执行报告</span>']) assert.ok(html.includes(text), text);
assert.strictEqual((html.match(/class="case-facts"/g) || []).length, fixtures.length);
for (const verdict of ['pass', 'fail', 'blocked', 'inconclusive']) assert.strictEqual((html.match(new RegExp(`class="verdict ${verdict}"`, 'g')) || []).length, 1, verdict);
for (const removed of ['class="platform-run"', 'class="case-outcome"', 'class="case-basis"', '暂无平台执行记录']) assert.strictEqual(html.includes(removed), false, removed);

const multiPlatformHtml = renderCurrentIndexHtml(root, [{
  caseNo: '99', title: '多平台结果用例', caseKey: 'ck-multi-platform', status: 'FAIL', verdict: 'FAIL',
  executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', reason: '不同平台结果需要分别展示。',
  durationMs: 3000, contextHref: 'cases/multi/CONTEXT.html',
  platforms: [
    { platform: 'harmony', status: 'PASS', verdict: 'PASS', executionStatus: 'COMPLETED', verdictBasis: 'DIRECT_EVIDENCE', durationMs: 1000, contextHref: 'cases/multi/platforms/harmony/CONTEXT.html', schemaFamily: 'current', currentMetrics: { counts: { planRevisions: 1, knowledgeQueries: 2 }, recoveryCount: 0 } },
    { platform: 'android', status: 'FAIL', verdict: 'FAIL', executionStatus: 'COMPLETED', verdictBasis: 'TECHNICAL_CONSTRAINT', durationMs: 2000, contextHref: 'cases/multi/platforms/android/CONTEXT.html', schemaFamily: 'current', currentMetrics: { counts: { planRevisions: 3, knowledgeQueries: 4 }, recoveryCount: 1 } },
  ],
}]);
assert.strictEqual((multiPlatformHtml.match(/class="platform-breakdown-row"/g) || []).length, 2);
assert.strictEqual((multiPlatformHtml.match(/class="case-facts"/g) || []).length, 0);
assert.strictEqual((multiPlatformHtml.match(/class="report-link"/g) || []).length, 2);
assert.ok(multiPlatformHtml.includes('2 个平台'));
assert.ok(multiPlatformHtml.includes('平台明细'));
for (const text of ['平台结果', '结论依据', 'Agent 轨迹', '耗时', '>报告</span>']) assert.ok(multiPlatformHtml.includes(text), text);
for (const text of ['计划 1 · 知识 2 · 恢复 0', '计划 3 · 知识 4 · 恢复 1', '直接证据', '技术约束', '1 秒', '2 秒']) assert.ok(multiPlatformHtml.includes(text), text);

fs.rmSync(temp, { recursive: true, force: true });
console.log('dashboard passed');
