#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, nextId, contextDir, readJson, writeJsonAtomic, jsonArg, now, event, commitEvent, output, main, fail, safeSegment } = require('./lib/common');
const { bridge } = require('./lib/runtime-client');
const { runContextIds } = require('./lib/run-protocol');
const { assertCapacity } = require('./lib/budget');
const { recordColdStart } = require('./lib/action-metrics');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');

function runJson(script, args) {
  const child = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
  if (child.status !== 0) fail((child.stderr || child.stdout || `${script} failed`).trim(), 'CONTEXT_PREPARATION_STEP_FAILED');
  try { return JSON.parse(child.stdout); } catch (error) { fail(`${script} returned invalid JSON: ${error.message}`, 'CONTEXT_PREPARATION_PROTOCOL_INVALID'); }
}

function capture(scanDir, contextId, preparationId, trigger) {
  const observed = runJson('observe-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--purpose', 'context-verification', '--preparation-id', preparationId, '--trigger', trigger]);
  if (observed.inTargetApp !== true) fail('Cold-start observation is outside the target App', 'APP_LEFT_FOREGROUND'); return observed.observation;
}

function markHandlingFailed(scanDir, preparationFile, contextId, preparationId, error) {
  const failed = readJson(preparationFile); failed.status = 'FAILED'; failed.reasonCode = error.code || 'CONTEXT_POPUP_HANDLING_FAILED'; failed.finishedAt = now(); writeJsonAtomic(preparationFile, failed); event(scanDir, 'contextPreparationFailed', { contextId, preparationId, reasonCode: failed.reasonCode });
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'prepare'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (!['PLAN_CONFIRMED', 'PAUSED'].includes(scan.status)) fail('Context preparation requires PLAN_CONFIRMED or PAUSED status', 'RUN_STATE_INVALID');
  const contextId = required(args, 'context'); if (!runContextIds(scan).includes(contextId)) fail('Context is not planned by this Run', 'CONTEXT_INVALID');
  const contextFile = path.join(contextDir(scanDir, contextId), 'context.json');
  if (command === 'prepare') {
    const preparationId = nextId(scanDir, 'contextPreparation', 'prep'); const preparationFile = path.join(scanDir, 'evidence', 'preparations', `${preparationId}.json`); const startedAt = now();
    let preparation = { schemaVersion: 1, preparationId, contextId, startedAt, finishedAt: null, status: 'STARTING', restartResult: null, observationId: null, interruptions: [], stabilityChecks: [] };
    writeJsonAtomic(preparationFile, preparation);
    try {
      const graph = require('./lib/common').loadGraph(scanDir, contextId); const frontier = require('./lib/common').loadFrontier(scanDir, contextId); const metrics = readJson(path.join(contextDir(scanDir, contextId), 'metrics.json')); assertCapacity(scan, contextId, graph, frontier, metrics, 'coldStarts');
      const operation = startDeviceOperation(scanDir, contextId, { kind: 'CONTEXT_COLD_START', owner: { type: 'CONTEXT_PREPARATION', id: preparationId }, idempotency: 'SAFE_RETRY_AFTER_OBSERVATION' }); recordColdStart(scanDir, contextId); let restartResult;
      try { restartResult = bridge('restart', { device: scan.target.deviceId, bundleName: scan.target.bundleName, entryAbility: scan.target.entryAbility, settleMs: args.settleMs || process.env.SMAP_RESTART_SETTLE_MS || 1200 }); }
      catch (error) { finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { reasonCode: error.code || 'CONTEXT_COLD_START_FAILED' }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error; }
      if (restartResult.coldStartVerified !== true || restartResult.foreground?.bundleName !== scan.target.bundleName) fail('Cold start could not verify the target App in foreground', 'COLD_START_UNVERIFIED');
      preparation.restartResult = restartResult; preparation.status = 'COLD_STARTED'; preparation.finishedAt = now(); writeJsonAtomic(preparationFile, preparation); finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: `evidence/preparations/${preparationId}.json` });
      const context = readJson(contextFile); context.pendingPreparationId = preparationId; context.verification = { status: 'PENDING', source: 'PLAN_CONFIRMED', markersPresent: [], markersAbsent: [], observationId: null, preparationId: null };
      commitEvent(scanDir, 'contextColdStarted', { contextId, preparationId, foreground: restartResult.foreground, stopMethod: restartResult.stopMethod, launchMethod: restartResult.launchMethod }, [{ path: `contexts/${contextId}/context.json`, op: 'REPLACE', value: context }]);
      const observation = capture(scanDir, contextId, preparationId, 'COLD_START'); preparation = readJson(preparationFile);
      return output({ schemaVersion: 1, ok: true, preparation, observation, popupReview: { dispositions: ['PAGE', 'BUSINESS_MODAL', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN'], maxDismissals: 3, maxStabilityChecks: 3 }, nextStep: 'VERIFY_CONTEXT_EVIDENCE' });
    } catch (error) {
      preparation = readJson(preparationFile, preparation); if (preparation.status !== 'EVIDENCE_CAPTURED') { preparation.status = 'FAILED'; preparation.reasonCode = error.code || 'CONTEXT_PREPARATION_FAILED'; preparation.finishedAt = now(); writeJsonAtomic(preparationFile, preparation); }
      event(scanDir, 'contextPreparationFailed', { contextId, preparationId, reasonCode: preparation.reasonCode || error.code || 'CONTEXT_PREPARATION_FAILED' }); throw error;
    }
  }
  if (command === 'dismiss-popup') {
    const preparationId = safeSegment(required(args, 'preparationId'), 'preparationId'); const preparationFile = path.join(scanDir, 'evidence', 'preparations', `${preparationId}.json`); const preparation = readJson(preparationFile); const context = readJson(contextFile);
    if (preparation.contextId !== contextId || context.pendingPreparationId !== preparationId || preparation.status !== 'EVIDENCE_CAPTURED') fail('Context preparation is not awaiting popup review', 'CONTEXT_PREPARATION_INVALID');
    if ((preparation.interruptions || []).length >= 3) fail('Context popup dismissal limit reached', 'POPUP_DISMISS_LIMIT');
    const observationId = safeSegment(required(args, 'observationId'), 'observationId'); if (preparation.observationId !== observationId) fail('Popup review observation is stale', 'POPUP_REVIEW_STALE');
    const dismissal = runJson('popup-dismiss-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--observation-id', observationId, '--owner-type', 'CONTEXT_PREPARATION', '--owner-id', preparationId, '--action', JSON.stringify(jsonArg(required(args, 'dismissAction'), null, 'dismissAction JSON'))]);
    preparation.interruptions ||= []; preparation.interruptions.push({ beforeObservationId: observationId, dismissalActionResultId: dismissal.actionResult.actionId, handledAt: now() }); preparation.status = 'CLEANUP_ACTION_EXECUTED'; preparation.observationId = null; writeJsonAtomic(preparationFile, preparation);
    try {
      const observation = capture(scanDir, contextId, preparationId, 'POPUP_DISMISSAL'); const updated = readJson(preparationFile); updated.interruptions[updated.interruptions.length - 1].afterObservationId = observation.observationId; writeJsonAtomic(preparationFile, updated); event(scanDir, 'contextPopupDismissed', { contextId, preparationId, dismissalActionResultId: dismissal.actionResult.actionId, afterObservationId: observation.observationId, dismissalCount: updated.interruptions.length });
      return output({ schemaVersion: 1, ok: true, preparation: updated, observation, popupReview: { dispositions: ['PAGE', 'BUSINESS_MODAL', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN'], remainingDismissals: 3 - updated.interruptions.length, remainingStabilityChecks: 3 - (updated.stabilityChecks || []).length }, nextStep: 'VERIFY_CONTEXT_EVIDENCE' });
    } catch (error) { markHandlingFailed(scanDir, preparationFile, contextId, preparationId, error); throw error; }
  }
  if (command === 'observe-again') {
    const preparationId = safeSegment(required(args, 'preparationId'), 'preparationId'); const preparationFile = path.join(scanDir, 'evidence', 'preparations', `${preparationId}.json`); const preparation = readJson(preparationFile); const context = readJson(contextFile);
    if (preparation.contextId !== contextId || context.pendingPreparationId !== preparationId || preparation.status !== 'EVIDENCE_CAPTURED') fail('Context preparation is not awaiting stability review', 'CONTEXT_PREPARATION_INVALID');
    const observationId = safeSegment(required(args, 'observationId'), 'observationId'); if (preparation.observationId !== observationId) fail('Stability review observation is stale', 'POPUP_REVIEW_STALE');
    preparation.stabilityChecks ||= []; if (preparation.stabilityChecks.length >= 3) fail('Context stability recheck limit reached', 'POPUP_REVIEW_LIMIT');
    preparation.status = 'STABILITY_RECHECK_REQUESTED'; preparation.observationId = null; writeJsonAtomic(preparationFile, preparation);
    try {
      const observation = capture(scanDir, contextId, preparationId, 'RECHECK'); const updated = readJson(preparationFile); updated.stabilityChecks.push({ beforeObservationId: observationId, afterObservationId: observation.observationId, checkedAt: now() }); writeJsonAtomic(preparationFile, updated); event(scanDir, 'contextStabilityRechecked', { contextId, preparationId, beforeObservationId: observationId, afterObservationId: observation.observationId, checkCount: updated.stabilityChecks.length });
      return output({ schemaVersion: 1, ok: true, preparation: updated, observation, popupReview: { dispositions: ['PAGE', 'BUSINESS_MODAL', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN'], remainingDismissals: 3 - (updated.interruptions || []).length, remainingStabilityChecks: 3 - updated.stabilityChecks.length }, nextStep: 'VERIFY_CONTEXT_EVIDENCE' });
    } catch (error) { markHandlingFailed(scanDir, preparationFile, contextId, preparationId, error); throw error; }
  }
  fail(`Unknown prepare-context command: ${command}`, 'COMMAND_INVALID');
});
