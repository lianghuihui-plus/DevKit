#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, jsonArg, readJson, contextDir, output, main, fail, safeSegment } = require('./lib/common');
const { assertCapacity } = require('./lib/budget');
const { validateDismissAction } = require('./lib/popup-policy');
const { runContextIds } = require('./lib/run-protocol');
const { executeDeviceAction, completeDeviceActionSuccess } = require('./lib/device-action-executor');

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
  const owner = { type: ownerType, id: ownerId };
  const { actionResult, operation } = executeDeviceAction(scanDir, {
    scan,
    contextId,
    beforeObservationId: observationId,
    action,
    safety,
    role: 'POPUP_DISMISSAL',
    category: 'interruption',
    owner,
    idempotency: 'SAFE_RETRY_AFTER_OBSERVATION',
    actionResultExtra: { role: 'POPUP_DISMISSAL', owner },
    failureReasonCode: 'POPUP_DISMISSAL_FAILED',
    emitActionResultEvents: false,
    writeUnknownEvidence: false
  });
  completeDeviceActionSuccess(scanDir, operation, actionResult, { eventType: 'popupDismissalActionResult', eventPayload: { contextId, ownerType, ownerId, observationId, actionId: actionResult.actionId, status: 'SUCCEEDED' } });
  output({ schemaVersion: 1, ok: true, actionResult });
});
