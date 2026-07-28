'use strict';

const path = require('path');
const { loadScan, readJson, exists, hashObject, fail } = require('./common');
const { PRESETS, PROFILE_META, profileCatalog, budgetOverrides } = require('./budget');
const { isCurrentRun, runContextIds, runContextId, runBudget, activeLimitMinutes } = require('./run-protocol');
const { goalPlanFromSpec } = require('./goal-spec');
const { modeForScan } = require('./modes');
const { loadExplorationStart, normalizeStartSpec } = require('./exploration-start');

function goalPlan(scanDir, scan) {
  if (scan.scanMode !== 'goal-directed') return null;
  if (!exists(path.join(scanDir, 'goal', 'goal.json'))) fail('Goal-directed plan requires a parsed GoalSpec before presentation', 'GOAL_SPEC_REQUIRED');
  const spec = readJson(path.join(scanDir, 'goal', 'goal.json'));
  return goalPlanFromSpec(spec);
}

function commonPlan(scanDir, scan, target, goal, continuation, explorationStart) {
  const appMapRoot = path.dirname(path.dirname(scanDir));
  return {
    scanId: scan.scanId,
    target: { platform: target.platform, bundleName: target.bundleName, entryAbility: target.entryAbility, environment: target.environment, deviceId: target.deviceId, deviceType: target.deviceType || null, appVersion: target.appVersion || null, buildVersion: target.buildVersion || null },
    profileSelection: { selectedProfile: scan.profile, selectedLabel: PROFILE_META[scan.profile].label, selectedDescription: PROFILE_META[scan.profile].description, recommendedProfile: modeForScan(scan).recommendedProfile, availableProfiles: profileCatalog(scan.scanMode, scan.profile), configurableBeforeConfirmation: true },
    safety: { environment: target.environment, hardBlocked: ['支付或转账', '账号注销或永久删除', '真实发布或外发', '密码、验证码及其他敏感凭证输入'], overrideAllowed: false },
    artifacts: { scanDir, runRelativePath: `runs/${scan.scanId}`, reportPath: path.join(scanDir, 'report.md'), snapshotPointer: path.join(appMapRoot, 'snapshots', 'current.json') },
    goal,
    explorationStart,
    continuation: continuation ? { parentScanId: continuation.parentScanId, importedFrontierCount: continuation.importedFrontiers?.length || 0, skippedImportedFrontierCount: continuation.skippedImportedFrontiers?.length || 0, skippedImportedFrontiers: continuation.skippedImportedFrontiers || [] } : null,
    confirmationRequired: true
  };
}

function buildPlanFromData(scanDir, scan, target, { goal = null, continuation = null, explorationStart = null } = {}) {
  const normalizedExplorationStart = scan.scanMode === 'exploration' ? normalizeStartSpec(explorationStart) : null;
  const base = commonPlan(scanDir, scan, target, goal, continuation, normalizedExplorationStart);
  if (isCurrentRun(scan)) {
    const mode = modeForScan(scan); const contextId = runContextId(scan); const budget = runBudget(scan, contextId); const overrides = budgetOverrides(scan.profile, budget); const verificationRule = mode.verificationRule;
    const baseline = scan.budgetBaseline || { schemaVersion: 1, contextId, source: 'CANONICAL_SEED', baselineReachableStates: 0, baselineVisualStates: 0, baselineEdges: 0 };
    return {
      schemaVersion: 3,
      ...base,
      execution: { scanMode: scan.scanMode, scanScope: scan.scanScope, strategy: scan.strategy, profile: scan.profile, contextId, verificationRule, navigationPolicy: scan.navigationPolicy || 'adaptive' },
      context: { id: contextId, label: contextId === 'guest' ? '未登录' : '已登录', preparation: contextId === 'guest' ? '确保已退出登录，然后受控冷启动并自动核对未登录证据' : '人工完成登录，然后受控冷启动并自动核对登录证据' },
      userConfiguration: { profile: scan.profile, maxActiveMinutes: budget.maxActiveMinutes, maxDepth: budget.maxDepth, depthBasis: normalizedExplorationStart ? 'START_PAGE' : 'MODE_DEFAULT' },
      derivedExecutionLimits: { ...budget },
      budgetBaseline: baseline,
      stateBudgetSemantics: { scope: 'RUN_DELTA', baselineReachableStates: Number(baseline.baselineReachableStates || 0), maxNewReachableStates: Number(budget.maxStates || 0), projectedMaxTotalReachableStates: Number(baseline.baselineReachableStates || 0) + Number(budget.maxStates || 0), explanation: `本次 ${PROFILE_META[scan.profile].label} 计划最多新增 ${Number(budget.maxStates || 0)} 个可达状态；当前地图已有 ${Number(baseline.baselineReachableStates || 0)} 个可达状态，不占用本 Run 新增状态预算。` },
      depthSemantics: normalizedExplorationStart ? { basis: 'START_PAGE', startKind: normalizedExplorationStart.kind, maxDepth: budget.maxDepth, explanation: normalizedExplorationStart.kind === 'app-root' ? '本次探索从 App 冷启动根页面开始，maxDepth 与全局 pathDepth 等价。' : '本次探索从用户确认的指定页面开始，maxDepth 按该起点的局部 depthFromStart 计算；canonical map 仍保留 App root 的全局 pathDepth。' } : null,
      profileSelection: { ...base.profileSelection, hasBudgetOverrides: overrides.length > 0, budgetOverrides: overrides },
      timeExpectation: { activeScanHardLimitMinutes: activeLimitMinutes(budget), meaning: `本 Run 自动扫描活动时间最多 ${activeLimitMinutes(budget)} 分钟。`, wallClockGuarantee: false, excludedFromActiveLimit: ['人工登录或退出时间', '计划确认等待时间', '目标候选人工确认时间', 'Run 结束后的 Snapshot 与 Dashboard 构建时间'] },
      interactionPoints: ['开始前确认本计划', `开始${contextId === 'guest' ? '未登录' : '已登录'}扫描前受控冷启动并自动核对上下文证据`, ...(mode.interactionPoints || []), '身份漂移、风险动作或环境异常时暂停'],
      stoppingRules: { ...mode.stoppingRules },
      confirmationOptions: { acceptCurrentPlan: `按 ${PROFILE_META[scan.profile].label} 执行`, changeProfile: '改为 <quick|standard|deep|goal>', customizeBudget: '覆盖 maxActiveMinutes 和/或 maxDepth' }
    };
  }

  const contexts = runContextIds(scan).map(id => ({ id, label: id === 'guest' ? '未登录' : '已登录', presetBudget: null, budget: { ...runBudget(scan, id) }, budgetOverrides: [] }));
  const sum = key => contexts.reduce((total, context) => total + Number(context.budget[key] || 0), 0);
  return { schemaVersion: 2, ...base, execution: { scanMode: scan.scanMode, scanScope: scan.scanScope, strategy: scan.strategy, profile: scan.profile, budgetPolicy: scan.budgetPolicy, contextOrder: runContextIds(scan) }, contexts, aggregateLimits: { maxActiveDurationMinutes: sum('maxDurationMinutes'), maxActions: sum('maxActions'), maxNodes: sum('maxNodes'), maxEdges: sum('maxEdges') } };
}

function buildPlan(scanDir) {
  const scan = loadScan(scanDir); const target = readJson(path.join(scanDir, 'target.json')); const goal = goalPlan(scanDir, scan); const continuation = exists(path.join(scanDir, 'continuation.json')) ? readJson(path.join(scanDir, 'continuation.json')) : null;
  const explorationStart = scan.scanMode === 'exploration' ? loadExplorationStart(scanDir, runContextId(scan)).spec : null;
  return buildPlanFromData(scanDir, scan, target, { goal, continuation, explorationStart });
}

function planHash(plan) { return hashObject(plan); }

module.exports = { buildPlan, buildPlanFromData, planHash };
