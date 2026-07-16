#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, writeJsonAtomic, nextId, now, commitEvent, output, main, fail, safeSegment } = require('./lib/common');
const { activeContextId } = require('./lib/run-protocol');
const { bridge } = require('./lib/runtime-client');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { assessAction } = require('./lib/safety');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { recordDeviceAction, recordNavigationMode } = require('./lib/action-metrics');
const { cursorLease, assertCursorEpoch, establishCursor, invalidateCursor } = require('./lib/live-cursor');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');

function runObserve(scanDir, contextId, trigger) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'observe-runner.js'), '--scan-dir', scanDir, '--context', contextId, '--purpose', 'navigation', '--trigger', trigger], { encoding: 'utf8' });
  if (child.status !== 0) fail((child.stderr || child.stdout || 'Navigation observation failed').trim(), 'NAVIGATION_OBSERVATION_FAILED');
  return JSON.parse(child.stdout).observation;
}

function compareState(scanDir, graph, stateId, observationId) {
  const state = graph.reachableStates.find(item => item.id === stateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId); if (!visual) fail(`Navigation state missing: ${stateId}`, 'GRAPH_REFERENCE_MISSING');
  const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json')); const layout = readJson(path.join(scanDir, observation.layoutPath)); return compareFingerprint(visual.fingerprint, buildFingerprint(layout, observation.foreground, observationVisual(observation)));
}

function center(action) { const b = action.fallbackBounds; return b ? { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) } : { x: action.x, y: action.y }; }

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true }); const contextId = args.context || activeContextId(scan);
  if (scan.status !== 'SCANNING' || contextId !== activeContextId(scan)) fail('Navigation requires the active SCANNING context', 'RUN_STATE_INVALID');
  const navigationExecutionId = args.navigationExecutionId || args.navigationPlanId; if (!navigationExecutionId || navigationExecutionId === true) fail('--navigation-execution-id is required', 'ARG_REQUIRED'); const planFile = path.join(scanDir, 'evidence', 'navigations', `${navigationExecutionId}.json`); const plan = readJson(planFile); const planId = plan.navigationPlanId; if (plan.contextId !== contextId || plan.status !== 'PLANNED') fail('Navigation execution is not executable', 'NAVIGATION_PLAN_INVALID');
  assertCursorEpoch(scanDir, contextId, plan.cursorEpoch); const graph = loadGraph(scanDir, contextId); const result = { ...plan, actualMode: plan.mode, status: 'IN_PROGRESS', startedAt: now(), finishedAt: null, terminalObservationId: null, executedSteps: [] }; commitEvent(scanDir, 'navigationExecutionStarted', { contextId, navigationPlanId: planId, navigationExecutionId, navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]);
  try {
    const foreground = bridge('foreground', { device: scan.target.deviceId }); if (foreground.foreground?.bundleName !== scan.target.bundleName) fail('Target App is not in foreground before navigation', 'APP_LEFT_FOREGROUND');
    if (plan.mode === 'LIVE_CURSOR') {
      const lease = cursorLease(scanDir, contextId, scan, plan.toReachableStateId); let observationId = lease.cursor.observationId;
      if (!lease.valid || lease.requiresRecheck) { const observed = runObserve(scanDir, contextId, 'RECHECK'); observationId = observed.observationId; if (compareState(scanDir, graph, plan.toReachableStateId, observationId) !== 'EXACT') fail('Live Cursor recheck did not match the source state', 'CURSOR_RECHECK_MISMATCH'); }
      result.terminalObservationId = observationId;
    } else {
      const initialLease = cursorLease(scanDir, contextId, scan); let currentObservationId = initialLease.cursor.observationId;
      if (initialLease.requiresRecheck) { const observed = runObserve(scanDir, contextId, 'RECHECK'); if (compareState(scanDir, graph, plan.fromReachableStateId, observed.observationId) !== 'EXACT') fail('Navigation source recheck did not match the planned start state', 'CURSOR_RECHECK_MISMATCH'); currentObservationId = observed.observationId; establishCursor(scanDir, contextId, { reachableStateId: plan.fromReachableStateId, observationId: currentObservationId, status: 'EXACT', establishedBy: 'NAVIGATION_RECHECK' }); }
      for (const step of plan.steps) {
        const action = step.kind === 'BACK' ? { type: 'keyEvent', key: 'BACK' } : graph.edges.find(item => item.id === step.edgeId)?.action; const expectedStateId = step.kind === 'BACK' ? step.expectedReachableStateId : graph.edges.find(item => item.id === step.edgeId)?.toReachableStateId;
        if (!action || !expectedStateId || !assessAction(action, scan.target).allowed) fail('Navigation step is missing or unsafe', 'NAVIGATION_STEP_INVALID');
        const metrics = readJson(path.join(scanDir, 'contexts', contextId, 'metrics.json')); assertExecutionWindow(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics); assertCapacity(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics, 'actions');
        const actionId = nextId(scanDir, 'action', 'act'); const point = center(action); const startedAt = now(); const operationOwner = args.attemptId ? { type: 'ATTEMPT', id: safeSegment(args.attemptId, 'attemptId') } : { type: 'NAVIGATION_EXECUTION', id: navigationExecutionId }; const operation = startDeviceOperation(scanDir, contextId, { kind: 'NAVIGATION_ACTION', owner: operationOwner, idempotency: 'UNKNOWN' }); recordDeviceAction(scanDir, contextId, 'navigation'); let deviceResult;
        try { deviceResult = bridge('action', { device: scan.target.deviceId, actionType: action.type, x: point.x, y: point.y, fromX: action.fromX, fromY: action.fromY, toX: action.toX, toY: action.toY, value: action.value, key: action.key, durationMs: action.durationMs }); }
        catch (error) { finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { reasonCode: error.code || 'NAVIGATION_ACTION_FAILED' }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error; }
        const after = runObserve(scanDir, contextId, 'ACTION'); const comparison = compareState(scanDir, graph, expectedStateId, after.observationId); const actionResult = { schemaVersion: 1, actionId, role: 'NAVIGATION', contextId, navigationPlanId: planId, navigationExecutionId, beforeObservationId: currentObservationId, afterObservationId: after.observationId, action, locatorResolution: step.kind === 'BACK' ? 'SYSTEM_KEY' : 'COORDINATE_ONLY', startedAt, finishedAt: now(), status: 'SUCCEEDED', deviceResult };
        writeJsonAtomic(path.join(scanDir, 'evidence', 'actions', `${actionId}.json`), actionResult); finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: `evidence/actions/${actionId}.json` }); result.executedSteps.push({ ...step, actionResultId: actionId, beforeObservationId: currentObservationId, afterObservationId: after.observationId, expectedReachableStateId: expectedStateId, verificationStatus: comparison }); commitEvent(scanDir, 'navigationStepCompleted', { contextId, navigationPlanId: planId, navigationExecutionId, step: result.executedSteps.at(-1), navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]);
        if (comparison !== 'EXACT') fail(`Navigation step reached ${comparison} instead of EXACT`, 'NAVIGATION_STATE_MISMATCH'); currentObservationId = after.observationId;
      }
      result.terminalObservationId = currentObservationId;
    }
    result.status = 'SUCCEEDED'; result.finishedAt = now(); recordNavigationMode(scanDir, contextId, plan.mode); const cursor = establishCursor(scanDir, contextId, { reachableStateId: plan.toReachableStateId, observationId: result.terminalObservationId, status: 'EXACT', establishedBy: `NAVIGATION_${plan.mode}` }); commitEvent(scanDir, 'sourceStateAcquired', { contextId, navigationPlanId: planId, navigationExecutionId, mode: plan.mode, reachableStateId: plan.toReachableStateId, observationId: result.terminalObservationId, cursorEpoch: cursor.epoch, navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]); output({ schemaVersion: 1, ok: true, navigationResult: result, cursor });
  } catch (error) {
    result.status = 'FAILED'; result.reasonCode = error.code || 'NAVIGATION_FAILED'; result.finishedAt = now(); commitEvent(scanDir, 'navigationExecutionFailed', { contextId, navigationPlanId: planId, navigationExecutionId, reasonCode: result.reasonCode, navigationExecution: result }, [{ path: `evidence/navigations/${navigationExecutionId}.json`, op: 'REPLACE', value: result }]); invalidateCursor(scanDir, contextId, result.reasonCode); throw error;
  }
});
