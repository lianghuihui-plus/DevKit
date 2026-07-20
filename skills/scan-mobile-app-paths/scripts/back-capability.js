#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, output, main, fail } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { cursorLease, establishCursor, invalidateCursor } = require('./lib/live-cursor');
const { recordBackCapability, loadBackCapabilities } = require('./lib/back-capability-store');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { executeDeviceAction, completeDeviceActionSuccess, completeDeviceActionUnknownOutcome } = require('./lib/device-action-executor');

function observe(scanDir, contextId) { const child = spawnSync(process.execPath, [path.join(__dirname, 'observe-runner.js'), '--scan-dir', scanDir, '--context', contextId, '--purpose', 'navigation', '--trigger', 'ACTION'], { encoding: 'utf8' }); if (child.status !== 0) fail((child.stderr || child.stdout || 'BACK observation failed').trim(), 'BACK_OBSERVATION_FAILED'); return JSON.parse(child.stdout).observation; }
function compareState(scanDir, graph, stateId, observation) { const state = graph.reachableStates.find(item => item.id === stateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId); if (!visual) fail('BACK target state is missing', 'GRAPH_REFERENCE_MISSING'); return compareFingerprint(visual.fingerprint, buildFingerprint(readJson(path.join(scanDir, observation.layoutPath)), observation.foreground, observationVisual(observation))); }

main(() => {
  const args = parseArgs(); const command = args._[0] || 'list'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: command === 'verify' }); const contextId = args.context || runContextId(scan); if (command === 'list') return output(loadBackCapabilities(scanDir, contextId)); if (command !== 'verify') fail(`Unknown back-capability command: ${command}`, 'COMMAND_INVALID');
  if (scan.status !== 'SCANNING') fail('BACK verification requires SCANNING', 'RUN_STATE_INVALID'); const fromId = required(args, 'fromReachableStateId'); const toId = required(args, 'toReachableStateId'); const lease = cursorLease(scanDir, contextId, scan, fromId); if (!lease.valid || lease.requiresRecheck) fail('BACK verification requires a fresh EXACT Cursor at the source state', 'CURSOR_RECHECK_REQUIRED');
  const graph = loadGraph(scanDir, contextId); const metrics = readJson(path.join(scanDir, 'contexts', contextId, 'metrics.json')); assertExecutionWindow(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics); assertCapacity(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics, 'actions');
  const action = { type: 'keyEvent', key: 'BACK' };
  const executed = executeDeviceAction(scanDir, { scan, contextId, beforeObservationId: lease.cursor.observationId, action, role: 'BACK_CAPABILITY_PROBE', category: 'navigation', owner: { type: 'BACK_CAPABILITY', id: `${fromId}:${toId}` }, idempotency: 'SAFE_RETRY_AFTER_OBSERVATION', locatorResolution: 'SYSTEM_KEY', actionResultExtra: { role: 'BACK_CAPABILITY_PROBE' }, failureReasonCode: 'BACK_ACTION_FAILED', emitActionResultEvents: false, writeUnknownEvidence: false, writeSuccessEvidence: false, includeSafetyInResult: false });
  let after; let comparison; let actionResult;
  try {
    after = observe(scanDir, contextId); comparison = compareState(scanDir, graph, toId, after); actionResult = { ...executed.actionResult, afterObservationId: after.observationId };
    completeDeviceActionSuccess(scanDir, executed.operation, actionResult, { eventType: null, writeEvidence: true });
  } catch (error) {
    completeDeviceActionUnknownOutcome(scanDir, executed.operation, { ...executed.actionResult, afterObservationId: after?.observationId || null }, { reasonCode: error.code || 'BACK_AFTER_ACTION_EVIDENCE_FAILED', writeEvidence: true });
    error.code = 'OPERATION_OUTCOME_UNKNOWN';
    throw error;
  }
  const capability = recordBackCapability(scanDir, contextId, { fromReachableStateId: fromId, toReachableStateId: toId, beforeObservationId: lease.cursor.observationId, actionResultId: actionResult.actionId, afterObservationId: after.observationId, verificationStatus: comparison }); if (comparison !== 'EXACT') { invalidateCursor(scanDir, contextId, 'BACK_TARGET_MISMATCH'); fail('BACK did not reach the expected state', 'BACK_TARGET_MISMATCH'); } const cursor = establishCursor(scanDir, contextId, { reachableStateId: toId, observationId: after.observationId, status: 'EXACT', establishedBy: 'BACK_CAPABILITY' }); output({ schemaVersion: 1, ok: true, backCapability: capability, cursor });
});
