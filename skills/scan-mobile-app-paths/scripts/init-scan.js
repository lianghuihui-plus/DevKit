#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, assertAbsolute, ensureDir, exists, readJson, writeJsonAtomic, appendJsonl, now, compactLocalTimestamp, output, main, fail, safeSegment, loadScan, commitEvent } = require('./lib/common');
const { CONTEXTS, validateTarget, validateRun } = require('./lib/schema');
const { resolveBudget, assertProfileForMode } = require('./lib/budget');
const { buildPlanFromData, planHash } = require('./lib/plan');
const { buildGoalSpecFromArgs, goalPlanFromSpec, writeGoalArtifacts } = require('./lib/goal-spec');
const { buildContinuationPlan } = require('./lib/continuation-plan');
const { seedFilesForContext, ensureCanonicalContext } = require('./lib/canonical-map-store');

function makeScanId(root) {
  const stamp = compactLocalTimestamp();
  let i = 1; let id;
  do { id = `scan-${stamp}-${String(i++).padStart(3, '0')}`; } while (exists(path.join(root, 'runs', id)));
  return id;
}

main(() => {
  const args = parseArgs();
  const root = assertAbsolute(required(args, 'appMapRoot'), '--app-map-root');
  const app = readJson(path.join(root, 'app.json'));
  const scanMode = args.scanMode || 'exploration';
  const scanScope = scanMode === 'goal-directed' ? 'targeted' : 'full';
  if (args.scanScope && args.scanScope !== scanScope) fail(`${scanMode} mode only supports scanScope=${scanScope}`, 'SCAN_SCOPE_UNSUPPORTED');
  if (args.scopeSpec) fail('--scope-spec is not supported by this workflow', 'SCAN_SCOPE_UNSUPPORTED');
  const requestedContext = args.context ?? args.contexts ?? 'guest';
  const contexts = [...new Set(String(requestedContext).split(',').map(x => x.trim()).filter(Boolean))];
  if (contexts.length !== 1 || !CONTEXTS.includes(contexts[0])) fail('Run requires exactly one --context: guest or authenticated', 'CONTEXT_INVALID');
  const contextId = contexts[0];
  const navigationPolicy = args.navigationPolicy || 'adaptive';
  if (!['adaptive', 'always-replay'].includes(navigationPolicy)) fail('--navigation-policy must be adaptive or always-replay', 'NAVIGATION_POLICY_INVALID');
  const target = validateTarget({
    schemaVersion: 1, platform: 'harmony', bundleName: args.bundleName || app.bundleName,
    entryAbility: args.entryAbility || app.defaultEntryAbility, environment: args.environment || app.environment,
    displayName: args.displayName || null, moduleName: args.moduleName || null,
    appVersion: args.appVersion || null, buildVersion: args.buildVersion || null,
    deviceId: required(args, 'device')
  });
  if (target.bundleName !== app.bundleName || target.environment !== app.environment) fail('Run target does not match app.json identity', 'APP_IDENTITY_MISMATCH');
  const profile = args.profile || (scanMode === 'goal-directed' ? 'goal' : 'standard');
  assertProfileForMode(profile, scanMode);
  let overrides = {};
  if (args.budget) try { overrides = JSON.parse(String(args.budget)); } catch (error) { fail(`Invalid --budget JSON: ${error.message}`, 'BUDGET_INVALID'); }
  if (Object.keys(overrides).some(key => !['maxActiveMinutes', 'maxDepth'].includes(key))) fail('User budget may override only maxActiveMinutes and maxDepth', 'BUDGET_FIELD_INTERNAL');
  const budget = resolveBudget(profile, overrides);
  const scanId = safeSegment(args.scanId || makeScanId(root), 'scanId');
  const scanDir = path.join(root, 'runs', scanId);
  if (exists(scanDir)) fail(`Run already exists: ${scanId}`, 'RUN_EXISTS');
  const { parent, normalizedParentGraphs, continuationPlan } = buildContinuationPlan({ root, parentScanId: args.parentScanId, scanMode, contextId, target, validateParent: true });
  const createdAt = now();
  const canonicalSeeds = Object.fromEntries(contexts.map(id => {
    ensureCanonicalContext(root, id);
    return [id, seedFilesForContext(root, id)];
  }));
  const counterSeed = contexts.reduce((sum, id) => {
    const counters = canonicalSeeds[id].counters || {};
    for (const key of ['edge', 'frontier', 'verification', 'backCapability']) sum[key] = Math.max(sum[key] || 0, counters[key] || 0);
    return sum;
  }, {});
  const confirmedPlanHash = args.confirmedPlanHash ? String(args.confirmedPlanHash) : null;
  const goalInput = scanMode === 'goal-directed' && confirmedPlanHash ? buildGoalSpecFromArgs(args, contextId) : null;
  if (scanMode === 'goal-directed' && confirmedPlanHash && parent) {
    const parentGoal = readJson(path.join(root, 'runs', parent.scanId, 'goal', 'goal.json'));
    if (!goalInput?.goal?.goalSpecHash || goalInput.goal.goalSpecHash !== parentGoal.goalSpecHash) fail('Goal Continuation requires the same goalSpecHash as its parent', 'PARENT_GOAL_MISMATCH');
  }
  const scan = validateRun({
    schemaVersion: 3, scanId, parentScanId: parent?.scanId || null, mapRevisionId: safeSegment(parent?.mapRevisionId || scanId, 'mapRevisionId'), mapBaseRevisionId: canonicalSeeds[contextId]?.mapRevisionId || null, status: confirmedPlanHash ? 'PLAN_CONFIRMED' : 'CREATED', reasonCode: null,
    scanMode, scanScope, graphProtocolVersion: 3, attemptProtocolVersion: 3, planProtocolVersion: 3, visualReviewProtocolVersion: 1,
    eventProtocolVersion: 2, projectionProtocolVersion: 2, navigationProtocolVersion: 2, verificationProtocolVersion: 2,
    platform: 'harmony', target, profile, strategy: scanMode === 'goal-directed' ? 'goal-directed' : 'exploration',
    goalSpecPath: scanMode === 'goal-directed' ? 'goal/goal.json' : null,
    contextId, budget: { ...budget }, budgetRevision: 1, navigationPolicy,
    verificationRule: scanMode === 'goal-directed' ? 'CONFIRMED_TARGET_PATH' : 'CANONICAL_SCREEN_PATH',
    createdAt, startedAt: null, updatedAt: createdAt, pausedAt: null, pausedDurationMs: 0,
    counters: { event: confirmedPlanHash ? 4 : 3, observation: 0, action: 0, frontier: counterSeed.frontier || 0, edge: counterSeed.edge || 0, goalDecision: 0, attempt: 0, restore: 0, contextPreparation: 0, navigation: 0, navigationExecution: 0, verification: counterSeed.verification || 0, verificationExecution: 0, operation: 0, backCapability: counterSeed.backCapability || 0, visualReview: 0 }
  });
  const previewPlan = buildPlanFromData(scanDir, { ...scan, status: 'CREATED', counters: { event: 0 } }, target, { goal: goalInput ? goalPlanFromSpec(goalInput.goal) : null, continuation: continuationPlan });
  const expectedPlanHash = planHash(previewPlan);
  if (confirmedPlanHash && confirmedPlanHash !== expectedPlanHash) fail('Confirmed plan hash does not match the requested scan configuration; rerun preview-plan with the final inputs', 'PLAN_HASH_MISMATCH');
  ensureDir(scanDir);
  writeJsonAtomic(path.join(scanDir, 'scan.json'), scan);
  writeJsonAtomic(path.join(scanDir, 'target.json'), { ...target, detectionSource: args.detectionSource || 'confirmed-input', confirmedAt: createdAt });
  if (confirmedPlanHash) writeJsonAtomic(path.join(scanDir, 'plan.json'), { ...previewPlan, planHash: expectedPlanHash, confirmedAt: createdAt });
  appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000001', type: 'scanCreated', at: createdAt, scanId, scanMode, scanScope, contextId });
  appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000002', type: 'targetConfirmed', at: createdAt, scanId, target: { bundleName: target.bundleName, entryAbility: target.entryAbility, environment: target.environment, deviceId: target.deviceId } });
  appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000003', type: 'scanModeSelected', at: createdAt, scanId, scanMode, scanScope, strategy: scan.strategy });
  if (confirmedPlanHash) appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000004', type: 'scanPlanConfirmed', at: createdAt, scanId, planHash: expectedPlanHash, contextId, budget: scan.budget, profile: scan.profile, verificationRule: scan.verificationRule || null });
  for (const contextId of contexts) {
    const dir = path.join(scanDir, 'contexts', contextId); ensureDir(dir);
    writeJsonAtomic(path.join(dir, 'context.json'), { schemaVersion: 1, id: contextId, label: contextId === 'guest' ? '未登录' : '已登录', authState: contextId, pendingPreparationId: null, lastPreparationId: null, verification: { status: 'PENDING', source: 'PLAN_CONFIRMED', markersPresent: [], markersAbsent: [], observationId: null, preparationId: null } });
    const seed = canonicalSeeds[contextId];
    writeJsonAtomic(path.join(dir, 'graph.json'), seed.hasMap ? seed.graph : { schemaVersion: 1, contextId, logicalScreens: [], visualStates: [], reachableStates: [], edges: [], paths: [] });
    writeJsonAtomic(path.join(dir, 'frontier.json'), seed.hasMap ? seed.frontier : { schemaVersion: 1, contextId, items: [] });
    writeJsonAtomic(path.join(dir, 'metrics.json'), { schemaVersion: 3, contextId, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, interruptionActions: 0, coldStarts: 0, cursorReuseHits: 0, sourceMatchNavigations: 0, cursorInvalidations: 0, backtrackNavigations: 0, graphPathNavigations: 0, coldReplayNavigations: 0, deviceMutationSeq: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, visualVarianceObservations: 0, noStateChangeActions: 0, activeStartedAt: null, activeDurationMs: 0, restoreAttempts: 0 });
    writeJsonAtomic(path.join(dir, 'live-cursor.json'), { schemaVersion: 1, contextId, reachableStateId: null, observationId: null, status: 'UNKNOWN', equivalence: null, epoch: 0, mutationSeq: 0, establishedBy: null, lastValidatedAt: null, updatedAt: createdAt, invalidatedReason: 'NOT_ESTABLISHED' });
    writeJsonAtomic(path.join(dir, 'back-capabilities.json'), seed.hasMap ? seed.backCapabilities : { schemaVersion: 1, contextId, items: [] });
    writeJsonAtomic(path.join(dir, 'verification-queue.json'), seed.hasMap ? seed.verificationQueue : { schemaVersion: 2, contextId, items: [] });
    writeJsonAtomic(path.join(dir, 'visual-equivalence.json'), seed.hasMap ? seed.visualEquivalence : { schemaVersion: 1, contextId, rules: [] });
    writeJsonAtomic(path.join(dir, 'state-equivalence.json'), seed.hasMap ? seed.stateEquivalence : { schemaVersion: 1, contextId, rules: [] });
  }
  ensureDir(path.join(scanDir, 'evidence', 'observations'));
  ensureDir(path.join(scanDir, 'evidence', 'actions'));
  ensureDir(path.join(scanDir, 'evidence', 'visual-reviews'));
  ensureDir(path.join(scanDir, 'attempts'));
  ensureDir(path.join(scanDir, 'evidence', 'logs'));
  ensureDir(path.join(scanDir, 'evidence', 'restores'));
  ensureDir(path.join(scanDir, 'evidence', 'preparations'));
  ensureDir(path.join(scanDir, 'evidence', 'navigations'));
  ensureDir(path.join(scanDir, 'evidence', 'verifications'));
  ensureDir(path.join(scanDir, 'operations'));
  ensureDir(path.join(scanDir, 'merged'));
  if (parent) {
    const knownDir = path.join(scanDir, 'known', 'contexts'); ensureDir(knownDir);
    for (const contextId of contexts) {
      if (normalizedParentGraphs[contextId]) writeJsonAtomic(path.join(knownDir, `${contextId}.json`), normalizedParentGraphs[contextId]);
    }
    writeJsonAtomic(path.join(scanDir, 'continuation.json'), { schemaVersion: 3, parentScanId: parent.scanId, contextId, scanMode, parentGoalSpecHash: parent.goalSpecHash || null, importedFrontiers: continuationPlan.importedFrontiers, skippedImportedFrontiers: continuationPlan.skippedImportedFrontiers });
  }
  if (goalInput) writeGoalArtifacts(scanDir, goalInput.goal, goalInput.screenshotPath);
  else if (scanMode === 'goal-directed') ensureDir(path.join(scanDir, 'goal'));
  require('./lib/event-store').initialize(scanDir, confirmedPlanHash ? 4 : 3);
  const baselineFiles = ['scan.json', 'target.json'];
  if (confirmedPlanHash) baselineFiles.push('plan.json');
  if (goalInput) baselineFiles.push('goal/goal.json', 'goal/match-result.json', 'goal/verified-paths.json');
  for (const id of contexts) baselineFiles.push(...['context.json', 'graph.json', 'frontier.json', 'metrics.json', 'live-cursor.json', 'back-capabilities.json', 'verification-queue.json', 'visual-equivalence.json', 'state-equivalence.json'].map(name => `contexts/${id}/${name}`));
  if (parent) {
    baselineFiles.push('continuation.json');
    for (const id of contexts) if (exists(path.join(scanDir, 'known', 'contexts', `${id}.json`))) baselineFiles.push(`known/contexts/${id}.json`);
  }
  commitEvent(scanDir, 'projectionBaselineInitialized', { projectionProtocolVersion: 2, files: baselineFiles }, baselineFiles.map(relative => ({ path: relative, op: 'REPLACE', value: readJson(path.join(scanDir, relative)) })));
  output({ schemaVersion: 1, ok: true, scanDir, scan: loadScan(scanDir) });
});
