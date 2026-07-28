#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveAppMapRoot, readJson, exists, compactLocalTimestamp, jsonArg, output, main, fail, safeSegment } = require('./lib/common');
const { CONTEXTS, validateTarget, validateRun } = require('./lib/schema');
const { resolveBudget, assertProfileForMode } = require('./lib/budget');
const { buildPlanFromData, planHash } = require('./lib/plan');
const { buildGoalSpecFromArgs, goalPlanFromSpec } = require('./lib/goal-spec');
const { buildContinuationPlan } = require('./lib/continuation-plan');
const { loadCanonicalPlanBaseline } = require('./lib/plan-baseline');
const { detectDeviceType, normalizeDeviceType } = require('./lib/device-detection');
const { modeFor, scanScopeForMode, strategyForMode, verificationRuleForMode, recommendedProfileForMode } = require('./lib/modes');
const { normalizeStartSpec } = require('./lib/exploration-start');

function makeScanId(root) {
  const stamp = compactLocalTimestamp();
  let index = 1; let id;
  do { id = `scan-${stamp}-${String(index++).padStart(3, '0')}`; } while (exists(path.join(root, 'runs', id)));
  return id;
}

main(() => {
  const args = parseArgs();
  const root = resolveAppMapRoot(args, { bundleName: args.bundleName || null, requireExisting: true });
  const app = readJson(path.join(root, 'app.json'));
  const scanMode = args.scanMode || 'exploration';
  const mode = modeFor(scanMode);
  if (args.explorationStart && scanMode !== 'exploration') fail('--exploration-start is only supported for exploration mode', 'EXPLORATION_START_UNSUPPORTED');
  const explorationStart = scanMode === 'exploration' ? normalizeStartSpec(args.explorationStart ? jsonArg(args.explorationStart, null, 'explorationStart JSON') : null) : null;
  const scanScope = scanScopeForMode(scanMode);
  if (args.scanScope && args.scanScope !== scanScope) fail(`${scanMode} mode only supports scanScope=${scanScope}`, 'SCAN_SCOPE_UNSUPPORTED');
  if (args.scopeSpec) fail('--scope-spec is not supported by this workflow', 'SCAN_SCOPE_UNSUPPORTED');
  const requestedContext = args.context ?? args.contexts ?? 'guest';
  const contexts = [...new Set(String(requestedContext).split(',').map(item => item.trim()).filter(Boolean))];
  if (contexts.length !== 1 || !CONTEXTS.includes(contexts[0])) fail('Run requires exactly one --context: guest or authenticated', 'CONTEXT_INVALID');
  const contextId = contexts[0];
  const navigationPolicy = args.navigationPolicy || 'adaptive';
  if (!['adaptive', 'always-replay'].includes(navigationPolicy)) fail('--navigation-policy must be adaptive or always-replay', 'NAVIGATION_POLICY_INVALID');
  const detectedDevice = args.deviceType ? { deviceType: normalizeDeviceType(args.deviceType), source: 'confirmed-input' } : detectDeviceType({ deviceId: required(args, 'device') });
  const target = validateTarget({
    schemaVersion: 1, platform: 'harmony', bundleName: args.bundleName || app.bundleName,
    entryAbility: args.entryAbility || app.defaultEntryAbility, environment: args.environment || app.environment,
    displayName: args.displayName || null, moduleName: args.moduleName || null,
    appVersion: args.appVersion || null, buildVersion: args.buildVersion || null,
    deviceId: required(args, 'device'), deviceType: detectedDevice.deviceType || null
  });
  if (target.bundleName !== app.bundleName || target.environment !== app.environment) fail('Run target does not match app.json identity', 'APP_IDENTITY_MISMATCH');
  const profile = args.profile || recommendedProfileForMode(scanMode);
  assertProfileForMode(profile, scanMode);
  const overrides = args.budget ? jsonArg(args.budget, null, 'budget JSON') : {};
  if (Object.keys(overrides).some(key => !['maxActiveMinutes', 'maxDepth'].includes(key))) fail('User budget may override only maxActiveMinutes and maxDepth', 'BUDGET_FIELD_INTERNAL');
  const budget = resolveBudget(profile, overrides);
  const scanId = safeSegment(args.scanId || makeScanId(root), 'scanId');
  const scanDir = path.join(root, 'runs', scanId);
  if (exists(scanDir)) fail(`Run already exists: ${scanId}`, 'RUN_EXISTS');
  const { parent, continuationPlan } = buildContinuationPlan({ root, parentScanId: args.parentScanId, scanMode, contextId, target, validateParent: true });
  const { budgetBaseline } = loadCanonicalPlanBaseline({ appRoot: root, contextId });
  const scan = validateRun({
    schemaVersion: 3, scanId, parentScanId: parent?.scanId || null, mapRevisionId: safeSegment(parent?.mapRevisionId || scanId, 'mapRevisionId'),
    status: 'CREATED', reasonCode: null, scanMode, scanScope, graphProtocolVersion: 4, attemptProtocolVersion: 4, planProtocolVersion: 3,
    eventProtocolVersion: 2, projectionProtocolVersion: 2, navigationProtocolVersion: 2, verificationProtocolVersion: 2,
    platform: 'harmony', target, profile, strategy: strategyForMode(scanMode),
    goalSpecPath: mode.goalSpecPath,
    contextId, budget: { ...budget }, budgetRevision: 1, navigationPolicy, budgetBaseline,
    verificationRule: verificationRuleForMode(scanMode),
    createdAt: null, startedAt: null, updatedAt: null, pausedAt: null, pausedDurationMs: 0,
    counters: { event: 0 }
  });
  const goalInput = scanMode === 'goal-directed' ? buildGoalSpecFromArgs(args, contextId) : null;
  if (scanMode === 'goal-directed' && parent) {
    const parentGoal = readJson(path.join(root, 'runs', parent.scanId, 'goal', 'goal.json'));
    if (!goalInput?.goal?.goalSpecHash || goalInput.goal.goalSpecHash !== parentGoal.goalSpecHash) fail('Goal Continuation requires the same goalSpecHash as its parent', 'PARENT_GOAL_MISMATCH');
  }
  const goalPlan = goalInput ? goalPlanFromSpec(goalInput.goal) : null;
  const plan = buildPlanFromData(scanDir, scan, target, { goal: goalPlan, continuation: continuationPlan, explorationStart });
  const hash = planHash(plan);
  const goalArgs = goalInput ? {
    goalSpec: goalInput.goal,
    screenshot: goalInput.screenshotPath,
    goalId: goalInput.goal.goalId,
    maxVerifiedPaths: goalInput.goal.resultPolicy.maxVerifiedPaths,
    verifyKnownPathFirst: goalInput.goal.resultPolicy.verifyKnownPathFirst
  } : null;
  const initArgs = {
    appMapRoot: root,
    scanId,
    device: target.deviceId,
    context: contextId,
    scanMode,
    profile,
    budget: overrides,
    navigationPolicy,
    appVersion: target.appVersion,
    buildVersion: target.buildVersion,
    deviceType: target.deviceType || null,
    parentScanId: parent?.scanId || null,
    confirmedPlanHash: hash,
    goal: goalArgs
  };
  if (explorationStart) initArgs.explorationStart = explorationStart;
  const initCli = [process.execPath, path.join(__dirname, 'init-scan.js'), '--app-map-root', root, '--scan-id', scanId, '--device', target.deviceId, '--context', contextId, '--scan-mode', scanMode, '--profile', profile, '--navigation-policy', navigationPolicy, '--confirmed-plan-hash', hash];
  if (Object.keys(overrides).length) initCli.push('--budget', JSON.stringify(overrides));
  if (target.appVersion) initCli.push('--app-version', target.appVersion);
  if (target.buildVersion) initCli.push('--build-version', target.buildVersion);
  if (target.deviceType) initCli.push('--device-type', target.deviceType);
  if (parent) initCli.push('--parent-scan-id', parent.scanId);
  if (explorationStart) initCli.push('--exploration-start', JSON.stringify(explorationStart));
  if (goalArgs) {
    initCli.push('--goal-spec', JSON.stringify(goalArgs.goalSpec), '--goal-id', goalArgs.goalId, '--max-verified-paths', String(goalArgs.maxVerifiedPaths), '--verify-known-path-first', String(goalArgs.verifyKnownPathFirst));
    if (goalArgs.screenshot) initCli.push('--screenshot', goalArgs.screenshot);
  }
  output({
    schemaVersion: 1,
    ok: true,
    createsRunDirectory: false,
    planHash: hash,
    plan,
    initArgs,
    initCli,
    confirmationPrompt: '请确认本计划。确认后使用 initArgs 创建正式 Run；修改任一配置时重新运行 preview-plan，不会产生废弃 Run 目录。'
  });
});
