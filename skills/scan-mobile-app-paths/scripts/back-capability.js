#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, writeJsonAtomic, nextId, now, output, main, fail } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { cursorLease, establishCursor, invalidateCursor } = require('./lib/live-cursor');
const { recordBackCapability, loadBackCapabilities } = require('./lib/back-capability-store');
const { bridge } = require('./lib/runtime-client');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { recordDeviceAction } = require('./lib/action-metrics');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');

function observe(scanDir, contextId) { const child = spawnSync(process.execPath, [path.join(__dirname, 'observe-runner.js'), '--scan-dir', scanDir, '--context', contextId, '--purpose', 'navigation', '--trigger', 'ACTION'], { encoding: 'utf8' }); if (child.status !== 0) fail((child.stderr || child.stdout || 'BACK observation failed').trim(), 'BACK_OBSERVATION_FAILED'); return JSON.parse(child.stdout).observation; }
function compareState(scanDir, graph, stateId, observation) { const state = graph.reachableStates.find(item => item.id === stateId); const visual = state && graph.visualStates.find(item => item.id === state.visualStateId); if (!visual) fail('BACK target state is missing', 'GRAPH_REFERENCE_MISSING'); return compareFingerprint(visual.fingerprint, buildFingerprint(readJson(path.join(scanDir, observation.layoutPath)), observation.foreground, observationVisual(observation))); }

main(() => {
  const args = parseArgs(); const command = args._[0] || 'list'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: command === 'verify' }); const contextId = args.context || runContextId(scan); if (command === 'list') return output(loadBackCapabilities(scanDir, contextId)); if (command !== 'verify') fail(`Unknown back-capability command: ${command}`, 'COMMAND_INVALID');
  if (scan.status !== 'SCANNING') fail('BACK verification requires SCANNING', 'RUN_STATE_INVALID'); const fromId = required(args, 'fromReachableStateId'); const toId = required(args, 'toReachableStateId'); const lease = cursorLease(scanDir, contextId, scan, fromId); if (!lease.valid || lease.requiresRecheck) fail('BACK verification requires a fresh EXACT Cursor at the source state', 'CURSOR_RECHECK_REQUIRED');
  const graph = loadGraph(scanDir, contextId); const metrics = readJson(path.join(scanDir, 'contexts', contextId, 'metrics.json')); assertExecutionWindow(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics); assertCapacity(scan, contextId, graph, loadFrontier(scanDir, contextId), metrics, 'actions'); const actionId = nextId(scanDir, 'action', 'act'); const action = { type: 'keyEvent', key: 'BACK' }; const startedAt = now(); const operation = startDeviceOperation(scanDir, contextId, { kind: 'BACK_CAPABILITY_PROBE', owner: { type: 'BACK_CAPABILITY', id: `${fromId}:${toId}` }, idempotency: 'SAFE_RETRY_AFTER_OBSERVATION' }); recordDeviceAction(scanDir, contextId, 'navigation'); let deviceResult;
  try { deviceResult = bridge('action', { device: scan.target.deviceId, actionType: 'keyEvent', key: 'BACK' }); } catch (error) { finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { reasonCode: error.code || 'BACK_ACTION_FAILED' }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error; }
  const after = observe(scanDir, contextId); const comparison = compareState(scanDir, graph, toId, after); const actionResult = { schemaVersion: 1, actionId, operationId: operation.operationId, role: 'BACK_CAPABILITY_PROBE', contextId, beforeObservationId: lease.cursor.observationId, afterObservationId: after.observationId, action, locatorResolution: 'SYSTEM_KEY', startedAt, finishedAt: now(), status: 'SUCCEEDED', deviceResult }; writeJsonAtomic(path.join(scanDir, 'evidence', 'actions', `${actionId}.json`), actionResult); finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: `evidence/actions/${actionId}.json` }); const capability = recordBackCapability(scanDir, contextId, { fromReachableStateId: fromId, toReachableStateId: toId, beforeObservationId: lease.cursor.observationId, actionResultId: actionId, afterObservationId: after.observationId, verificationStatus: comparison }); if (comparison !== 'EXACT') { invalidateCursor(scanDir, contextId, 'BACK_TARGET_MISMATCH'); fail('BACK did not reach the expected state', 'BACK_TARGET_MISMATCH'); } const cursor = establishCursor(scanDir, contextId, { reachableStateId: toId, observationId: after.observationId, status: 'EXACT', establishedBy: 'BACK_CAPABILITY' }); output({ schemaVersion: 1, ok: true, backCapability: capability, cursor });
});
