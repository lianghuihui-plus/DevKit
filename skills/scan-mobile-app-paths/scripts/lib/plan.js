'use strict';

const path = require('path');
const { loadScan, readJson, exists, hashObject, fail } = require('./common');
const { PRESETS, PROFILE_META, profileCatalog, budgetOverrides } = require('./budget');
const { isV3, runContextIds, runContextId, runBudget, activeLimitMinutes } = require('./run-protocol');

function goalPlan(scanDir, scan) {
  if (scan.scanMode !== 'goal-directed') return null;
  if (!exists(path.join(scanDir, 'goal', 'goal.json'))) fail('Goal-directed plan requires a parsed GoalSpec before presentation', 'GOAL_SPEC_REQUIRED');
  const spec = readJson(path.join(scanDir, 'goal', 'goal.json'));
  return { goalId: spec.goalId, goalSpecHash: spec.goalSpecHash || hashObject({ description: spec.description, contextId: spec.contextId, referenceScreenshotSha256: spec.referenceScreenshotSha256, successCriteria: spec.successCriteria }), description: spec.description, contextId: spec.contextId, referenceScreenshot: spec.referenceScreenshot, referenceScreenshotSha256: spec.referenceScreenshotSha256, requiredTexts: spec.successCriteria?.requiredTexts || [], maxVerifiedPaths: spec.resultPolicy?.maxVerifiedPaths || 1 };
}

function commonPlan(scanDir, scan, target, goal, continuation) {
  return {
    scanId: scan.scanId,
    target: { platform: target.platform, bundleName: target.bundleName, entryAbility: target.entryAbility, environment: target.environment, deviceId: target.deviceId, appVersion: target.appVersion || null, buildVersion: target.buildVersion || null },
    profileSelection: { selectedProfile: scan.profile, selectedLabel: PROFILE_META[scan.profile].label, selectedDescription: PROFILE_META[scan.profile].description, recommendedProfile: scan.scanMode === 'goal-directed' ? 'goal' : 'standard', availableProfiles: profileCatalog(scan.scanMode, scan.profile), configurableBeforeConfirmation: true },
    safety: { environment: target.environment, hardBlocked: ['支付或转账', '账号注销或永久删除', '真实发布或外发', '密码、验证码及其他敏感凭证输入'], overrideAllowed: false },
    artifacts: { scanDir, runRelativePath: `runs/${scan.scanId}`, reportPath: path.join(scanDir, 'report.md'), snapshotPointer: path.join(path.dirname(path.dirname(scanDir)), 'snapshots', 'current.json') },
    goal,
    continuation: continuation ? { parentScanId: continuation.parentScanId, importedFrontierCount: continuation.importedFrontiers?.length || 0, skippedImportedFrontierCount: continuation.skippedImportedFrontiers?.length || 0, skippedImportedFrontiers: continuation.skippedImportedFrontiers || [] } : null,
    confirmationRequired: true
  };
}

function buildPlan(scanDir) {
  const scan = loadScan(scanDir); const target = readJson(path.join(scanDir, 'target.json')); const goal = goalPlan(scanDir, scan); const continuation = exists(path.join(scanDir, 'continuation.json')) ? readJson(path.join(scanDir, 'continuation.json')) : null;
  const base = commonPlan(scanDir, scan, target, goal, continuation);
  if (isV3(scan)) {
    const contextId = runContextId(scan); const budget = runBudget(scan, contextId); const overrides = budgetOverrides(scan.profile, budget); const verificationRule = scan.scanMode === 'goal-directed' ? 'CONFIRMED_TARGET_PATH' : 'CANONICAL_SCREEN_PATH';
    return {
      schemaVersion: 3,
      ...base,
      execution: { scanMode: scan.scanMode, scanScope: scan.scanScope, strategy: scan.strategy, profile: scan.profile, contextId, verificationRule, navigationPolicy: scan.navigationPolicy || 'adaptive' },
      context: { id: contextId, label: contextId === 'guest' ? '未登录' : '已登录', preparation: contextId === 'guest' ? '确保已退出登录，然后受控冷启动并自动核对未登录证据' : '人工完成登录，然后受控冷启动并自动核对登录证据' },
      userConfiguration: { profile: scan.profile, maxActiveMinutes: budget.maxActiveMinutes, maxDepth: budget.maxDepth },
      derivedExecutionLimits: { ...budget },
      profileSelection: { ...base.profileSelection, hasBudgetOverrides: overrides.length > 0, budgetOverrides: overrides },
      timeExpectation: { activeScanHardLimitMinutes: activeLimitMinutes(budget), meaning: `本 Run 自动扫描活动时间最多 ${activeLimitMinutes(budget)} 分钟。`, wallClockGuarantee: false, excludedFromActiveLimit: ['人工登录或退出时间', '计划确认等待时间', '目标候选人工确认时间', 'Run 结束后的 Snapshot 与 Dashboard 构建时间'] },
      interactionPoints: ['开始前确认本计划', `开始${contextId === 'guest' ? '未登录' : '已登录'}扫描前受控冷启动并自动核对上下文证据`, ...(scan.scanMode === 'goal-directed' ? ['发现候选时暂停并等待人工判断'] : []), '身份漂移、风险动作或环境异常时暂停'],
      stoppingRules: { exploration: scan.scanMode === 'exploration' ? '已发现安全 Frontier 与必要验证均收敛，或统一硬预算耗尽' : null, goalDirected: scan.scanMode === 'goal-directed' ? '确认目标路径强验证成功，或统一硬预算耗尽/人工停止' : null },
      confirmationOptions: { acceptCurrentPlan: `按 ${PROFILE_META[scan.profile].label} 执行`, changeProfile: '改为 <quick|standard|deep|goal>', customizeBudget: '覆盖 maxActiveMinutes 和/或 maxDepth' }
    };
  }

  const contexts = runContextIds(scan).map(id => ({ id, label: id === 'guest' ? '未登录' : '已登录', presetBudget: null, budget: { ...runBudget(scan, id) }, budgetOverrides: [] }));
  const sum = key => contexts.reduce((total, context) => total + Number(context.budget[key] || 0), 0);
  return { schemaVersion: 2, ...base, execution: { scanMode: scan.scanMode, scanScope: scan.scanScope, strategy: scan.strategy, profile: scan.profile, budgetPolicy: scan.budgetPolicy, contextOrder: runContextIds(scan) }, contexts, aggregateLimits: { maxActiveDurationMinutes: sum('maxDurationMinutes'), maxActions: sum('maxActions'), maxNodes: sum('maxNodes'), maxEdges: sum('maxEdges') } };
}

function planHash(plan) { return hashObject(plan); }

module.exports = { buildPlan, planHash };
