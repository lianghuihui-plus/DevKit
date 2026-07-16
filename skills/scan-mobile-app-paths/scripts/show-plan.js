#!/usr/bin/env node
'use strict';

const { parseArgs, required, resolveScanDir, loadScan, output, main, fail } = require('./lib/common');
const { buildPlan, planHash } = require('./lib/plan');

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir);
  if (scan.status !== 'CREATED') fail('Plan may only be presented before confirmation', 'RUN_STATE_INVALID');
  const plan = buildPlan(scanDir);
  output({ schemaVersion: 1, ok: true, planHash: planHash(plan), plan, confirmationPrompt: '请在同一确认环节查看全部预设配置、当前选择、预算覆盖、各登录态实际预算和合计上限；可确认当前计划，也可改选适用预设或自定义预算。确认后才能开始扫描。' });
});
