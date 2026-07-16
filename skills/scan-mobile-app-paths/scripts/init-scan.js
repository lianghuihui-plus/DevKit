#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, assertAbsolute, ensureDir, exists, readJson, writeJsonAtomic, appendJsonl, now, compactLocalTimestamp, output, main, fail, safeSegment, loadScan, commitEvent } = require('./lib/common');
const { CONTEXTS, validateTarget, validateRun } = require('./lib/schema');
const { resolveBudget, assertProfileForMode } = require('./lib/budget');
const { normalizeGraphForConsumption } = require('./lib/graph-normalization');
const { validate } = require('./validate-run');
const { runContextIds } = require('./lib/run-protocol');

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
  if (args.scopeSpec) fail('--scope-spec is not supported in the current version', 'SCAN_SCOPE_UNSUPPORTED');
  const requestedContext = args.context ?? args.contexts ?? 'guest';
  const contexts = [...new Set(String(requestedContext).split(',').map(x => x.trim()).filter(Boolean))];
  if (contexts.length !== 1 || !CONTEXTS.includes(contexts[0])) fail('Protocol v3 requires exactly one --context: guest or authenticated', 'CONTEXT_INVALID');
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
  if (Object.keys(overrides).some(key => !['maxActiveMinutes', 'maxDepth'].includes(key))) fail('V3 user budget may override only maxActiveMinutes and maxDepth', 'BUDGET_FIELD_INTERNAL');
  const budget = resolveBudget(profile, overrides);
  const scanId = safeSegment(args.scanId || makeScanId(root), 'scanId');
  const scanDir = path.join(root, 'runs', scanId);
  if (exists(scanDir)) fail(`Run already exists: ${scanId}`, 'RUN_EXISTS');
  let parent = null; const importedFrontiers = []; const skippedImportedFrontiers = []; const normalizedParentGraphs = {};
  if (args.parentScanId) {
    const parentScanId = safeSegment(args.parentScanId, 'parentScanId'); const parentDir = path.join(root, 'runs', parentScanId); parent = loadScan(parentDir);
    if (parent.status !== 'PARTIAL') fail('Continuation parent must be a finalized PARTIAL Run', 'PARENT_RUN_INVALID');
    validate(parentDir, 'PARTIAL');
    const parentContexts = runContextIds(parent);
    if (parent.scanMode !== scanMode || parentContexts.length !== 1 || parentContexts[0] !== contextId) fail('Continuation parent must have the same scanMode and single contextId', 'PARENT_RUN_INVALID');
    const parentTarget = readJson(path.join(parentDir, 'target.json'));
    if (parentTarget.bundleName !== target.bundleName || parentTarget.environment !== target.environment) fail('Parent Run App identity differs', 'PARENT_RUN_INVALID');
    const parentVersion = parentTarget.buildVersion ? `build:${parentTarget.buildVersion}` : parentTarget.appVersion ? `app:${parentTarget.appVersion}` : null;
    const targetVersion = target.buildVersion ? `build:${target.buildVersion}` : target.appVersion ? `app:${target.appVersion}` : null;
    if (parentVersion !== targetVersion) fail('Continuation parent must have the same versionKey', 'PARENT_VERSION_MISMATCH');
    for (const inheritedContextId of contexts) {
      const sourceGraph = readJson(path.join(parentDir, 'contexts', inheritedContextId, 'graph.json'), { schemaVersion: 1, contextId: inheritedContextId, logicalScreens: [], visualStates: [], reachableStates: [], edges: [], paths: [] }); const normalized = normalizeGraphForConsumption(sourceGraph, { runId: parentScanId, contextId: inheritedContextId }); normalizedParentGraphs[inheritedContextId] = normalized.graph; const retainedStateIds = new Set(normalized.graph.reachableStates.map(state => state.id));
      const parentFrontier = readJson(path.join(parentDir, 'contexts', inheritedContextId, 'frontier.json'), { items: [] });
      for (const item of parentFrontier.items.filter(x => ['PENDING', 'RETRYABLE'].includes(x.status))) {
        const reasonCode = item.candidate?.type === 'wait' ? 'NON_GRAPH_ACTION' : !retainedStateIds.has(item.fromReachableStateId) ? 'SOURCE_STATE_PRUNED' : null;
        if (reasonCode) skippedImportedFrontiers.push({ contextId: inheritedContextId, sourceFrontierId: item.id, sourceReachableStateId: item.fromReachableStateId, reasonCode });
        else importedFrontiers.push({ contextId: inheritedContextId, sourceFrontierId: item.id, sourceReachableStateId: item.fromReachableStateId, candidateGroupKey: item.candidateGroupKey, candidate: item.candidate, priority: item.priority, status: 'AWAITING_REBIND' });
      }
    }
  }
  ensureDir(scanDir);
  const createdAt = now();
  const scan = validateRun({
    schemaVersion: 3, scanId, parentScanId: parent?.scanId || null, mapRevisionId: safeSegment(parent?.mapRevisionId || scanId, 'mapRevisionId'), status: 'CREATED', reasonCode: null,
    scanMode, scanScope, graphProtocolVersion: 3, attemptProtocolVersion: 3, planProtocolVersion: 3,
    eventProtocolVersion: 2, projectionProtocolVersion: 2, navigationProtocolVersion: 2, verificationProtocolVersion: 2,
    platform: 'harmony', target, profile, strategy: scanMode === 'goal-directed' ? 'goal-directed' : 'exploration',
    goalSpecPath: scanMode === 'goal-directed' ? 'goal/goal.json' : null,
    contextId, budget: { ...budget }, budgetRevision: 1, navigationPolicy,
    verificationRule: scanMode === 'goal-directed' ? 'CONFIRMED_TARGET_PATH' : 'CANONICAL_SCREEN_PATH',
    createdAt, startedAt: null, updatedAt: createdAt, pausedAt: null, pausedDurationMs: 0,
    counters: { event: 3, observation: 0, action: 0, frontier: 0, edge: 0, goalDecision: 0, attempt: 0, restore: 0, contextPreparation: 0, navigation: 0, navigationExecution: 0, verification: 0, verificationExecution: 0, operation: 0, backCapability: 0 }
  });
  writeJsonAtomic(path.join(scanDir, 'scan.json'), scan);
  writeJsonAtomic(path.join(scanDir, 'target.json'), { ...target, detectionSource: args.detectionSource || 'confirmed-input', confirmedAt: createdAt });
  appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000001', type: 'scanCreated', at: createdAt, scanId, scanMode, scanScope, contextId });
  appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000002', type: 'targetConfirmed', at: createdAt, scanId, target: { bundleName: target.bundleName, entryAbility: target.entryAbility, environment: target.environment, deviceId: target.deviceId } });
  appendJsonl(path.join(scanDir, 'timeline.jsonl'), { schemaVersion: 1, eventId: 'evt-000003', type: 'scanModeSelected', at: createdAt, scanId, scanMode, scanScope, strategy: scan.strategy });
  for (const contextId of contexts) {
    const dir = path.join(scanDir, 'contexts', contextId); ensureDir(dir);
    writeJsonAtomic(path.join(dir, 'context.json'), { schemaVersion: 1, id: contextId, label: contextId === 'guest' ? '未登录' : '已登录', authState: contextId, pendingPreparationId: null, lastPreparationId: null, verification: { status: 'PENDING', source: 'PLAN_CONFIRMED', markersPresent: [], markersAbsent: [], observationId: null, preparationId: null } });
    writeJsonAtomic(path.join(dir, 'graph.json'), { schemaVersion: 1, contextId, logicalScreens: [], visualStates: [], reachableStates: [], edges: [], paths: [] });
    writeJsonAtomic(path.join(dir, 'frontier.json'), { schemaVersion: 1, contextId, items: [] });
    writeJsonAtomic(path.join(dir, 'metrics.json'), { schemaVersion: 3, contextId, actions: 0, explorationActions: 0, navigationActions: 0, recoveryActions: 0, verificationActions: 0, interruptionActions: 0, coldStarts: 0, cursorReuseHits: 0, cursorInvalidations: 0, backtrackNavigations: 0, graphPathNavigations: 0, coldReplayNavigations: 0, deviceMutationSeq: 0, observations: 0, observationSamples: 0, observationStabilityWaitMs: 0, dynamicVisualObservations: 0, noStateChangeActions: 0, activeStartedAt: null, activeDurationMs: 0, restoreAttempts: 0 });
    writeJsonAtomic(path.join(dir, 'live-cursor.json'), { schemaVersion: 1, contextId, reachableStateId: null, observationId: null, status: 'UNKNOWN', epoch: 0, mutationSeq: 0, establishedBy: null, lastValidatedAt: null, updatedAt: createdAt, invalidatedReason: 'NOT_ESTABLISHED' });
    writeJsonAtomic(path.join(dir, 'back-capabilities.json'), { schemaVersion: 1, contextId, items: [] });
    writeJsonAtomic(path.join(dir, 'verification-queue.json'), { schemaVersion: 2, contextId, items: [] });
  }
  ensureDir(path.join(scanDir, 'evidence', 'observations'));
  ensureDir(path.join(scanDir, 'evidence', 'actions'));
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
    writeJsonAtomic(path.join(scanDir, 'continuation.json'), { schemaVersion: 3, parentScanId: parent.scanId, contextId, scanMode, parentGoalSpecHash: parent.goalSpecHash || null, importedFrontiers, skippedImportedFrontiers });
  }
  if (scanMode === 'goal-directed') ensureDir(path.join(scanDir, 'goal'));
  require('./lib/event-store').initialize(scanDir, 3);
  const baselineFiles = ['scan.json', 'target.json'];
  for (const id of contexts) baselineFiles.push(...['context.json', 'graph.json', 'frontier.json', 'metrics.json', 'live-cursor.json', 'back-capabilities.json', 'verification-queue.json'].map(name => `contexts/${id}/${name}`));
  if (parent) {
    baselineFiles.push('continuation.json');
    for (const id of contexts) if (exists(path.join(scanDir, 'known', 'contexts', `${id}.json`))) baselineFiles.push(`known/contexts/${id}.json`);
  }
  commitEvent(scanDir, 'projectionBaselineInitialized', { projectionProtocolVersion: 2, files: baselineFiles }, baselineFiles.map(relative => ({ path: relative, op: 'REPLACE', value: readJson(path.join(scanDir, relative)) })));
  output({ schemaVersion: 1, ok: true, scanDir, scan: loadScan(scanDir) });
});
