#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, writeJsonAtomic, writeTextAtomic, contextDir, output, main } = require('./lib/common');
const { contextMetrics } = require('./lib/metrics');
const { runContextIds } = require('./lib/run-protocol');
const { loadVerificationQueue } = require('./lib/verification-store');

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true }); const target = readJson(path.join(scanDir, 'target.json'));
  const rows = []; const stabilityRows = []; const verificationRows = []; const metricsByContext = {};
  for (const contextId of runContextIds(scan)) {
    const graph = loadGraph(scanDir, contextId); const frontier = loadFrontier(scanDir, contextId); const runtime = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json'), {});
    const metrics = contextMetrics(graph, frontier, runtime); metricsByContext[contextId] = metrics; writeJsonAtomic(path.join(contextDir(scanDir, contextId), 'metrics.json'), metrics);
    rows.push(`| ${contextId} | ${metrics.logicalScreenCount} | ${metrics.visualStateCount} | ${metrics.reachableStateCount} | ${metrics.edgeCount} | ${metrics.pathCount} | ${metrics.safeCandidateCoverage === null ? '-' : `${(metrics.safeCandidateCoverage * 100).toFixed(1)}%`} |`);
    stabilityRows.push(`| ${contextId} | ${metrics.observations} | ${metrics.observationSamples} | ${metrics.averageSamplesPerObservation === null ? '-' : metrics.averageSamplesPerObservation.toFixed(1)} | ${(metrics.observationStabilityWaitMs / 1000).toFixed(1)} 秒 | ${metrics.dynamicVisualObservations} | ${metrics.noStateChangeActions} |`);
    const tasks = loadVerificationQueue(scanDir, contextId).items; const count = status => tasks.filter(item => item.status === status).length; verificationRows.push(`| ${contextId} | ${tasks.length} | ${count('PENDING')} | ${count('RUNNING')} | ${count('SUCCEEDED')} | ${count('FAILED')} | ${count('SUPERSEDED')} |`);
  }
  const goalResult = scan.scanMode === 'goal-directed' ? readJson(path.join(scanDir, 'goal', 'match-result.json'), null) : null;
  const effectiveStatus = args.status || scan.status;
  const navigationFiles = fs.existsSync(path.join(scanDir, 'evidence', 'navigations')) ? fs.readdirSync(path.join(scanDir, 'evidence', 'navigations')).filter(name => name.endsWith('.json')) : []; const navigations = navigationFiles.map(name => readJson(path.join(scanDir, 'evidence', 'navigations', name))); const fallbackCount = navigations.filter(item => item.fallbackFrom).length; const unresolved = readJson(path.join(scanDir, 'merged', 'unresolved.json'), { items: [] });
  const lines = [`# App 路径扫描报告`, '', `- Run：${scan.scanId}`, `- 状态：${effectiveStatus}`, `- 模式：${scan.scanMode} / ${scan.scanScope}`, `- 目标：${target.bundleName} / ${target.entryAbility}`, `- 设备：${target.deviceId}`, `- 版本：${target.buildVersion || target.appVersion || '未知'}`, '', '| 上下文 | 逻辑页面 | 视觉状态 | 可达状态 | 边 | 路径 | 安全候选覆盖率 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows, '', '> 安全候选覆盖率仅表示已发现 SAFE 候选组的探索比例，不代表 App 的绝对页面覆盖率。', '', '## 观测稳定性', '', '| 上下文 | 正式观测 | 原子采样 | 平均采样/观测 | 稳定等待合计 | 动态视觉降级 | 无状态变化操作 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...stabilityRows, '', '## 验证与导航', '', '| 上下文 | 验证任务 | 待执行 | 执行中 | 成功 | 失败 | 已替代 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...verificationRows, '', `- NavigationExecution：${navigations.length}`, `- 冷重放降级：${fallbackCount}`, `- 未解决项：${unresolved.items.length}`];
  if (goalResult) lines.push('', '## 目标扫描', '', `- 目标状态：${goalResult.status || '未评估'}`, `- 已验证路径：${goalResult.verifiedPathIds?.length || 0}`, `- 候选决策：${goalResult.candidateDecisionIds?.length || 0}`);
  lines.push('', '## 继续建议', '', effectiveStatus === 'PARTIAL' ? '- 使用当前 Run 作为 parentScanId 创建 continuation Run，并显式提高预算。' : '- 如需更深覆盖，创建新的 Run；终态 Run 保持不可变。', '');
  writeTextAtomic(path.join(scanDir, 'report.md'), `${lines.join('\n')}\n`); output({ schemaVersion: 1, ok: true, reportPath: path.join(scanDir, 'report.md'), metricsByContext });
});
