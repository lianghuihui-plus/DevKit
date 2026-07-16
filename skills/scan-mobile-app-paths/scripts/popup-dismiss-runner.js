#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, nextId, jsonArg, writeJsonAtomic, readJson, contextDir, now, event, output, main, fail, safeSegment } = require('./lib/common');
const { assertCapacity } = require('./lib/budget');
const { validateDismissAction } = require('./lib/popup-policy');
const { bridge } = require('./lib/runtime-client');
const { runContextIds } = require('./lib/run-protocol');
const { recordDeviceAction } = require('./lib/action-metrics');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');

function center(bounds) { return bounds && bounds.length === 4 ? { x: Math.round((Number(bounds[0]) + Number(bounds[2])) / 2), y: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2) } : {}; }

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (!['PLAN_CONFIRMED', 'SCANNING', 'PAUSED'].includes(scan.status)) fail('Popup dismissal is not allowed in the current Run state', 'RUN_STATE_INVALID');
  const contextId = required(args, 'context'); if (!runContextIds(scan).includes(contextId)) fail('Popup context is not planned', 'CONTEXT_INVALID');
  const observationId = safeSegment(required(args, 'observationId'), 'observationId'); const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json'));
  if (observation.contextId !== contextId || observation.foreground?.bundleName !== scan.target.bundleName) fail('Popup dismissal observation is outside the target context/App', 'CONTEXT_EVIDENCE_INVALID');
  const ownerType = required(args, 'ownerType'); if (!['CONTEXT_PREPARATION', 'ATTEMPT'].includes(ownerType)) fail('Invalid popup dismissal owner type', 'POPUP_OWNER_INVALID'); const ownerId = safeSegment(required(args, 'ownerId'), 'ownerId');
  if (ownerType === 'CONTEXT_PREPARATION') {
    const owner = readJson(path.join(scanDir, 'evidence', 'preparations', `${ownerId}.json`)); if (owner.contextId !== contextId || owner.status !== 'EVIDENCE_CAPTURED' || owner.observationId !== observationId) fail('Popup dismissal is not bound to the active context preparation observation', 'POPUP_OWNER_INVALID');
  } else {
    const owner = readJson(path.join(scanDir, 'attempts', `${ownerId}.json`)); if (owner.contextId !== contextId || !['AWAITING_RESTORE_REVIEW', 'AWAITING_OUTCOME_REVIEW'].includes(owner.status) || owner.reviewObservationId !== observationId) fail('Popup dismissal is not bound to the active Attempt review observation', 'POPUP_OWNER_INVALID');
  }
  const { action, safety } = validateDismissAction(jsonArg(required(args, 'action'), null, 'dismiss action JSON'), scan.target);
  const metricsFile = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(metricsFile); assertCapacity(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), metrics, 'actions');
  const actionId = nextId(scanDir, 'action', 'act'); const startedAt = now(); const point = center(action.fallbackBounds);
  const operation = startDeviceOperation(scanDir, contextId, { kind: 'POPUP_DISMISSAL', owner: { type: ownerType, id: ownerId }, idempotency: 'SAFE_RETRY_AFTER_OBSERVATION' }); recordDeviceAction(scanDir, contextId, 'interruption'); let deviceResult;
  try { deviceResult = bridge('action', { device: scan.target.deviceId, actionType: action.type, x: action.x ?? point.x, y: action.y ?? point.y, key: action.key }); }
  catch (error) { finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { reasonCode: error.code || 'POPUP_DISMISSAL_FAILED' }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error; }
  const actionResult = { schemaVersion: 1, actionId, role: 'POPUP_DISMISSAL', contextId, owner: { type: ownerType, id: ownerId }, beforeObservationId: observationId, action, safety, locatorResolution: 'COORDINATE_ONLY', startedAt, finishedAt: now(), status: 'SUCCEEDED', deviceResult };
  writeJsonAtomic(path.join(scanDir, 'evidence', 'actions', `${actionId}.json`), actionResult);
  finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: `evidence/actions/${actionId}.json` });
  event(scanDir, 'popupDismissalActionResult', { contextId, ownerType, ownerId, observationId, actionId, status: 'SUCCEEDED' }); output({ schemaVersion: 1, ok: true, actionResult });
});
