#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, now, commitEvent, output, main, fail, safeSegment } = require('./lib/common');
const { activeContextId } = require('./lib/run-protocol');
const { bridge } = require('./lib/runtime-client');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { recordNavigationMode } = require('./lib/action-metrics');
const { cursorLease, assertCursorEpoch, establishCursor, invalidateCursor } = require('./lib/live-cursor');
const { matchSourceState, sourceAccepted, cursorStatusFor, sourceEquivalence } = require('./lib/source-matcher');
const { assessReplayableAction, executePathStepAction, navigationStepAction, resolveReplayAction } = require('./lib/path-replay-engine');
const { completeDeviceActionSuccess, completeDeviceActionUnknownOutcome } = require('./lib/device-action-executor');

function runObserve(scanDir, contextId, trigger) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'observe-runner.js'), '--scan-dir', scanDir, '--context', contextId, '--purpose', 'navigation', '--trigger', trigger], { encoding: 'utf8' });
  if (child.status !== 0) fail((child.stderr || child.stdout || 'Navigation observation failed').trim(), 'NAVIGATION_OBSERVATION_FAILED');
  return JSON.parse(child.stdout).observation;
}

function compareState(scanDir, graph, stateId, observationId) {
  const state = graph.reachableStates.find(item => item.id === stateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId); if (!visual) fail(`Navigation state missing: ${stateId}`, 'GRAPH_REFERENCE_MISSING');
  const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json')); const layout = readJson(path.join(scanDir, observation.layoutPath)); return compareFingerprint(visual.fingerprint, buildFingerprint(layout, observation.foreground, observationVisual(observation)));
}

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true }); const contextId = args.context || activeContextId(scan);
  if (scan.status !== 'SCANNING' || contextId !== activeContextId(scan)) fail('Navigation requires the active SCANNING context', 'RUN_STATE_INVALID');
  const navigationExecutionId = args.navigationExecutionId || args.navigationPlanId; if (!navigationExecutionId || navigationExecutionId === true) fail('--navigation-execution-id is required', 'ARG_REQUIRED'); const planFile = path.join(scanDir, 'evidence', 'navigations', `${navigationExecutionId}.json`); const plan = readJson(planFile); const planId = plan.navigationPlanId; if (plan.contextId !== contextId || plan.status !== 'PLANNED') fail('Navigation execution is not executable', 'NAVIGATION_PLAN_INVALID');
  assertCursorEpoch(scanDir, contextId, plan.cursorEpoch); const graph = loadGraph(scanDir, contextId); const result = { ...plan, actualMode: plan.mode, status: 'IN_PROGRESS', startedAt: now(), finishedAt: null, terminalObservationId: null, executedSteps: [] }; commitEvent(scanDir, 'navigationExecutionStarted', { contextId, navigationPlanId: planId, navigationExecutionId, navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]);
  try {
    const foreground = bridge('foreground', { device: scan.target.deviceId }); if (foreground.foreground?.bundleName !== scan.target.bundleName) fail('Target App is not in foreground before navigation', 'APP_LEFT_FOREGROUND');
    let terminalMatch = null;
    if (plan.mode === 'LIVE_CURSOR') {
      const lease = cursorLease(scanDir, contextId, scan, plan.toReachableStateId); let observationId = lease.cursor.observationId;
      if (!lease.valid || lease.requiresRecheck) { const observed = runObserve(scanDir, contextId, 'RECHECK'); observationId = observed.observationId; terminalMatch = matchSourceState({ scanDir, scan, contextId, graph, reachableStateId: plan.toReachableStateId, observationId }); if (!sourceAccepted(terminalMatch)) fail('Live Cursor recheck did not match the source state', 'CURSOR_RECHECK_MISMATCH'); }
      else terminalMatch = { status: lease.cursor.status, observationId, expectedReachableStateId: plan.toReachableStateId, evidence: { reusedCursor: true } };
      result.terminalObservationId = observationId;
    } else {
      const initialLease = cursorLease(scanDir, contextId, scan); let currentObservationId = initialLease.cursor.observationId;
      if (initialLease.requiresRecheck) { const observed = runObserve(scanDir, contextId, 'RECHECK'); const startMatch = matchSourceState({ scanDir, scan, contextId, graph, reachableStateId: plan.fromReachableStateId, observationId: observed.observationId }); if (!sourceAccepted(startMatch)) fail('Navigation source recheck did not match the planned start state', 'CURSOR_RECHECK_MISMATCH'); currentObservationId = observed.observationId; establishCursor(scanDir, contextId, { reachableStateId: plan.fromReachableStateId, observationId: currentObservationId, status: cursorStatusFor(startMatch), establishedBy: 'NAVIGATION_RECHECK', equivalence: sourceEquivalence(startMatch) }); }
      for (const step of plan.steps) {
        const { edge, action: staticAction, intent, expectedReachableStateId: expectedStateId, locatorResolution } = navigationStepAction(graph, step);
        const action = staticAction || resolveReplayAction(scanDir, contextId, currentObservationId, edge || intent);
        if (!action || !expectedStateId) fail('Navigation step is missing or unsafe', 'NAVIGATION_STEP_INVALID');
        const safety = assessReplayableAction(action, scan, null, 'NAVIGATION_STEP_INVALID');
        const metrics = readJson(path.join(scanDir, 'contexts', contextId, 'metrics.json')); assertExecutionWindow(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics); assertCapacity(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics, 'actions');
        const operationOwner = args.attemptId ? { type: 'ATTEMPT', id: safeSegment(args.attemptId, 'attemptId') } : { type: 'NAVIGATION_EXECUTION', id: navigationExecutionId };
        const executed = executePathStepAction(scanDir, { scan, contextId, beforeObservationId: currentObservationId, action, safety, owner: operationOwner, role: 'NAVIGATION_ACTION', category: 'navigation', locatorResolution, idempotency: 'UNKNOWN', actionResultExtra: { role: 'NAVIGATION', navigationPlanId: planId, navigationExecutionId }, failureReasonCode: 'NAVIGATION_ACTION_FAILED' });
        let after; let sourceMatch; let comparison; let actionResult;
        try {
          after = runObserve(scanDir, contextId, 'ACTION'); sourceMatch = matchSourceState({ scanDir, scan, contextId, graph, reachableStateId: expectedStateId, observationId: after.observationId, candidate: action }); comparison = sourceMatch.status; actionResult = { ...executed.actionResult, afterObservationId: after.observationId, finishedAt: now() };
          completeDeviceActionSuccess(scanDir, executed.operation, actionResult, { eventType: null, writeEvidence: true });
        } catch (error) {
          completeDeviceActionUnknownOutcome(scanDir, executed.operation, { ...executed.actionResult, afterObservationId: after?.observationId || null }, { reasonCode: error.code || 'NAVIGATION_AFTER_ACTION_EVIDENCE_FAILED', writeEvidence: true });
          error.code = 'OPERATION_OUTCOME_UNKNOWN';
          throw error;
        }
        result.executedSteps.push({ ...step, actionResultId: actionResult.actionId, beforeObservationId: currentObservationId, afterObservationId: after.observationId, expectedReachableStateId: expectedStateId, verificationStatus: comparison }); commitEvent(scanDir, 'navigationStepCompleted', { contextId, navigationPlanId: planId, navigationExecutionId, step: result.executedSteps.at(-1), navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]);
        if (!sourceAccepted(sourceMatch)) fail(`Navigation step reached ${comparison} instead of an accepted source state`, 'NAVIGATION_STATE_MISMATCH'); currentObservationId = after.observationId; terminalMatch = sourceMatch;
      }
      result.terminalObservationId = currentObservationId;
    }
    result.status = 'SUCCEEDED'; result.finishedAt = now(); recordNavigationMode(scanDir, contextId, plan.mode); const cursor = establishCursor(scanDir, contextId, { reachableStateId: plan.toReachableStateId, observationId: result.terminalObservationId, status: cursorStatusFor(terminalMatch), establishedBy: `NAVIGATION_${plan.mode}`, equivalence: sourceEquivalence(terminalMatch) }); commitEvent(scanDir, 'sourceStateAcquired', { contextId, navigationPlanId: planId, navigationExecutionId, mode: plan.mode, reachableStateId: plan.toReachableStateId, observationId: result.terminalObservationId, cursorEpoch: cursor.epoch, sourceMatch: terminalMatch, navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]); output({ schemaVersion: 1, ok: true, navigationResult: result, cursor, sourceMatch: terminalMatch });
  } catch (error) {
    result.status = 'FAILED'; result.reasonCode = error.code || 'NAVIGATION_FAILED'; result.finishedAt = now(); commitEvent(scanDir, 'navigationExecutionFailed', { contextId, navigationPlanId: planId, navigationExecutionId, reasonCode: result.reasonCode, navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]); invalidateCursor(scanDir, contextId, result.reasonCode); throw error;
  }
});
