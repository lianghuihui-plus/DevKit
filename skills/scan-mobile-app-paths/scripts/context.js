#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, contextDir, readJson, jsonArg, now, event, commitEvent, transition, output, main, fail } = require('./lib/common');
const { buildPlan, planHash } = require('./lib/plan');
const { resolveBudget, assertProfileForMode } = require('./lib/budget');
const { isCurrentRun, runContextId, runBudget } = require('./lib/run-protocol');

function projectedTransition(scanDir, scan, to, reasonCode, contextId, eventType, data = {}, extraOps = []) {
  const allowed = {
    CREATED: ['PLAN_CONFIRMED', 'BLOCKED', 'FAILED'],
    PLAN_CONFIRMED: ['CONTEXT_READY', 'PAUSED', 'BLOCKED', 'FAILED'],
    CONTEXT_READY: ['SCANNING', 'PAUSED', 'BLOCKED', 'FAILED'],
    SCANNING: ['PAUSED', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'],
    PAUSED: ['SCANNING', 'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED']
  };
  if (!(allowed[scan.status] || []).includes(to)) fail(`Invalid Run transition ${scan.status} -> ${to}`, 'RUN_TRANSITION_INVALID');
  const from = scan.status; const transitionedAt = now(); const activeContext = isCurrentRun(scan) ? scan.contextId : contextId || scan.activeContextId || null; const ops = [...extraOps];
  if (!isCurrentRun(scan) && contextId) scan.activeContextId = contextId;
  if (from === 'SCANNING' && to !== 'SCANNING' && activeContext) {
    const metricsFile = path.join(contextDir(scanDir, activeContext), 'metrics.json'); const metrics = readJson(metricsFile, {});
    if (metrics.activeStartedAt) metrics.activeDurationMs = (metrics.activeDurationMs || 0) + Math.max(0, Date.parse(transitionedAt) - Date.parse(metrics.activeStartedAt));
    metrics.activeStartedAt = null; ops.push({ path: `contexts/${activeContext}/metrics.json`, op: 'REPLACE', value: metrics });
  }
  if (from !== 'SCANNING' && to === 'SCANNING' && activeContext) {
    const metricsFile = path.join(contextDir(scanDir, activeContext), 'metrics.json'); const metrics = readJson(metricsFile, {});
    metrics.activeStartedAt = transitionedAt; metrics.activeDurationMs ||= 0; ops.push({ path: `contexts/${activeContext}/metrics.json`, op: 'REPLACE', value: metrics });
  }
  scan.status = to; scan.reasonCode = reasonCode; scan.updatedAt = transitionedAt;
  if (to === 'SCANNING') scan.startedAt ||= transitionedAt;
  if (to === 'PAUSED') scan.pausedAt = transitionedAt;
  if (from === 'PAUSED' && to === 'SCANNING') { scan.pausedDurationMs = (scan.pausedDurationMs || 0) + Math.max(0, Date.parse(transitionedAt) - Date.parse(scan.pausedAt)); scan.pausedAt = null; }
  ops.push({ path: 'scan.json', op: 'REPLACE', value: scan });
  commitEvent(scanDir, eventType, { from, to, reasonCode, ...data }, ops);
  return readJson(path.join(scanDir, 'scan.json'));
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'show'; const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  if (command === 'confirm-plan') {
    const before = loadScan(scanDir, { mutable: true }); if (before.status !== 'CREATED') fail('Plan confirmation requires CREATED status', 'RUN_STATE_INVALID');
    const plan = buildPlan(scanDir); const expectedHash = planHash(plan); const confirmedHash = required(args, 'planHash');
    if (confirmedHash !== expectedHash) fail('Plan has changed or was not presented; run show-plan.js again', 'PLAN_HASH_MISMATCH');
    const confirmedAt = now(); const scan = projectedTransition(scanDir, before, 'PLAN_CONFIRMED', null, isCurrentRun(before) ? before.contextId : undefined, 'scanPlanConfirmed', { planHash: expectedHash, contextId: isCurrentRun(before) ? before.contextId : undefined, budget: isCurrentRun(before) ? before.budget : undefined, budgetsByContext: isCurrentRun(before) ? undefined : before.budgetsByContext, profile: before.profile, verificationRule: before.verificationRule || null }, [{ path: 'plan.json', op: 'REPLACE', value: { ...plan, planHash: expectedHash, confirmedAt } }]);
    return output({ schemaVersion: 1, ok: true, status: scan.status, planHash: expectedHash });
  }
  if (command === 'configure-plan') {
    const scan = loadScan(scanDir, { mutable: true }); if (scan.status !== 'CREATED') fail('Plan configuration requires CREATED status', 'RUN_STATE_INVALID');
    if (!args.profile && !args.budget) fail('Plan configuration requires --profile and/or --budget', 'PLAN_CONFIGURATION_REQUIRED');
    const profile = String(args.profile || scan.profile); assertProfileForMode(profile, scan.scanMode);
    const overrides = args.budget ? jsonArg(args.budget, null, 'budget JSON') : {};
    if (isCurrentRun(scan) && Object.keys(overrides).some(key => !['maxActiveMinutes', 'maxDepth'].includes(key))) fail('User budget may override only maxActiveMinutes and maxDepth', 'BUDGET_FIELD_INTERNAL');
    const budget = resolveBudget(profile, overrides);
    scan.profile = profile;
    if (isCurrentRun(scan)) scan.budget = budget; else scan.budgetsByContext = Object.fromEntries(scan.plannedContextIds.map(id => [id, { ...budget }]));
    scan.budgetRevision = (scan.budgetRevision || 1) + 1; scan.updatedAt = now();
    commitEvent(scanDir, 'scanPlanConfigured', { profile, budgetRevision: scan.budgetRevision, contextId: isCurrentRun(scan) ? scan.contextId : undefined, budget: isCurrentRun(scan) ? scan.budget : undefined, budgetsByContext: isCurrentRun(scan) ? undefined : scan.budgetsByContext }, [{ path: 'scan.json', op: 'REPLACE', value: scan }]);
    const plan = buildPlan(scanDir); const hash = planHash(plan); return output({ schemaVersion: 1, ok: true, planHash: hash, plan, confirmationRequired: true });
  }
  if (command === 'pause') {
    const scan = transition(scanDir, 'PAUSED', args.reasonCode || 'USER_PAUSED'); return output({ schemaVersion: 1, ok: true, status: scan.status });
  }
  const scanForContext = loadScan(scanDir); const contextId = args.context ? String(args.context) : isCurrentRun(scanForContext) ? runContextId(scanForContext) : required(args, 'context');
  if (isCurrentRun(scanForContext) && contextId !== runContextId(scanForContext)) fail('Context differs from the fixed Run context', 'CONTEXT_INVALID');
  const file = path.join(contextDir(scanDir, contextId), 'context.json');
  if (command === 'show') return output(readJson(file));
  if (command === 'mismatch') {
    const scan = loadScan(scanDir, { mutable: true }); if (!['PLAN_CONFIRMED', 'CONTEXT_READY', 'SCANNING', 'PAUSED'].includes(scan.status)) fail('Context mismatch requires an active preparation or scan', 'RUN_STATE_INVALID');
    const observationId = required(args, 'observationId'); const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json')); if (observation.contextId !== contextId || observation.foreground?.bundleName !== scan.target.bundleName) fail('Context mismatch evidence is invalid', 'CONTEXT_EVIDENCE_INVALID');
    const context = readJson(file); context.verification = { status: 'MISMATCH', source: 'AUTO_EVIDENCE', observationId, expectedContextId: contextId, rationale: args.rationale || 'Observed identity markers conflict with the confirmed plan', detectedAt: now() };
    const ops = [{ path: `contexts/${contextId}/context.json`, op: 'REPLACE', value: context }];
    if (scan.status !== 'PAUSED') projectedTransition(scanDir, scan, 'PAUSED', 'CONTEXT_MISMATCH', contextId, 'contextMismatch', { contextId, observationId, rationale: context.verification.rationale }, ops);
    else commitEvent(scanDir, 'contextMismatch', { contextId, observationId, rationale: context.verification.rationale }, ops);
    return output({ schemaVersion: 1, ok: true, status: 'PAUSED', context });
  }
  if (command === 'verify') {
    const scan = loadScan(scanDir, { mutable: true });
    if (!['PLAN_CONFIRMED', 'CONTEXT_READY', 'SCANNING', 'PAUSED'].includes(scan.status)) fail('Confirm scan plan before verifying context', 'RUN_STATE_INVALID');
    const observationId = required(args, 'observationId'); const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json'));
    if (observation.contextId !== contextId || observation.foreground?.bundleName !== scan.target.bundleName) fail('Context verification observation does not match context or target App', 'CONTEXT_EVIDENCE_INVALID');
    const context = readJson(file); const preparationId = observation.contextPreparationId; const preparation = preparationId ? readJson(path.join(scanDir, 'evidence', 'preparations', `${preparationId}.json`)) : null;
    if (!preparation || context.pendingPreparationId !== preparationId || preparation.status !== 'EVIDENCE_CAPTURED' || preparation.observationId !== observationId || preparation.restartResult?.coldStartVerified !== true) fail('Context identity evidence must come from the latest verified cold start', 'CONTEXT_PREPARATION_INVALID');
    context.verification = {
      status: 'VERIFIED', source: 'PLAN_CONFIRMED',
      markersPresent: jsonArg(args.markersPresent, []), markersAbsent: jsonArg(args.markersAbsent, []), observationId: args.observationId || null, preparationId, verifiedAt: now()
    };
    context.lastPreparationId = preparationId; context.pendingPreparationId = null;
    const ops = [{ path: `contexts/${contextId}/context.json`, op: 'REPLACE', value: context }];
    if (!isCurrentRun(scan)) scan.activeContextId = contextId;
    if (scan.status === 'PLAN_CONFIRMED') projectedTransition(scanDir, scan, 'CONTEXT_READY', null, contextId, 'contextVerified', { contextId, verification: context.verification }, ops);
    else commitEvent(scanDir, 'contextVerified', { contextId, verification: context.verification }, [...ops, { path: 'scan.json', op: 'REPLACE', value: scan }]);
    return output({ schemaVersion: 1, ok: true, context });
  }
  if (command === 'start') {
    const context = readJson(file); if (context.verification.status !== 'VERIFIED') fail('Context must be verified before scanning', 'CONTEXT_NOT_VERIFIED');
    const scan = loadScan(scanDir, { mutable: true }); if (!['CONTEXT_READY', 'PAUSED'].includes(scan.status)) fail('Context start requires CONTEXT_READY or PAUSED', 'RUN_STATE_INVALID');
    projectedTransition(scanDir, scan, 'SCANNING', null, contextId, scan.status === 'PAUSED' ? 'scanResumed' : 'scanStatusChanged', { contextId });
    return output({ schemaVersion: 1, ok: true, status: 'SCANNING', contextId });
  }
  if (command === 'manual-transition') {
    const scan = loadScan(scanDir, { mutable: true }); if (scan.status !== 'PAUSED') fail('Manual context transition requires PAUSED status', 'RUN_STATE_INVALID');
    if (isCurrentRun(scan)) fail('Run cannot switch context', 'CONTEXT_IMMUTABLE');
    event(scanDir, 'contextTransitionManual', { fromContextId: args.from || null, toContextId: contextId, source: 'PLAN_CONFIRMED' });
    return output({ schemaVersion: 1, ok: true, replayableEdgeCreated: false });
  }
  if (command === 'update-budget') {
    const scan = loadScan(scanDir, { mutable: true }); if (scan.status !== 'PAUSED') fail('Budget can only be updated while PAUSED', 'RUN_STATE_INVALID');
    const updates = jsonArg(required(args, 'budget'), null, 'budget JSON'); const current = runBudget(scan, contextId);
    if (isCurrentRun(scan) && Object.keys(updates).some(key => !['maxActiveMinutes', 'maxDepth'].includes(key))) fail('Only maxActiveMinutes and maxDepth may be increased by the user', 'BUDGET_FIELD_INTERNAL');
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in current) || !Number.isFinite(Number(value)) || Number(value) < Number(current[key])) fail(`Budget ${key} may only be increased`, 'BUDGET_UPDATE_INVALID');
      current[key] = Number(value);
    }
    scan.budgetRevision = (scan.budgetRevision || 1) + 1; scan.updatedAt = now(); commitEvent(scanDir, 'budgetUpdated', { contextId, budgetRevision: scan.budgetRevision, budget: current }, [{ path: 'scan.json', op: 'REPLACE', value: scan }]);
    return output({ schemaVersion: 1, ok: true, contextId, budgetRevision: scan.budgetRevision, budget: current });
  }
  fail(`Unknown context command: ${command}`, 'COMMAND_INVALID');
});
