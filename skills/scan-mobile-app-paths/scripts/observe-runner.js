#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, required, resolveScanDir, loadScan, nextId, readJson, writeJsonAtomic, now, event, commitEvent, contextDir, output, main, fail } = require('./lib/common');
const { captureStableObservation } = require('./lib/observation-stability');
const { activeContextId } = require('./lib/run-protocol');

const PURPOSE_TRIGGERS = {
  'context-verification': 'COLD_START',
  'attempt-after': 'ACTION',
  'restore-verification': 'RESTORE_ACTION',
  'popup-cleanup-after': 'POPUP_DISMISSAL',
  'stability-recheck': 'RECHECK'
};

main(() => {
  const args = parseArgs(); const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  const purpose = args.purpose || 'scan'; const preflight = ['PLAN_CONFIRMED', 'PAUSED'].includes(scan.status) && purpose === 'context-verification';
  if (scan.status !== 'SCANNING' && !preflight) fail('Observation requires SCANNING, or a prepared context-verification phase', 'RUN_STATE_INVALID');
  const contextId = args.context || activeContextId(scan); if (!contextId) fail('No active context', 'CONTEXT_REQUIRED');
  let preparation = null; let preparationFile = null;
  if (purpose === 'context-verification') {
    const preparationId = required(args, 'preparationId'); preparationFile = path.join(scanDir, 'evidence', 'preparations', `${preparationId}.json`); preparation = readJson(preparationFile);
    const context = readJson(path.join(contextDir(scanDir, contextId), 'context.json'));
    if (preparation.contextId !== contextId || !['COLD_STARTED', 'CLEANUP_ACTION_EXECUTED', 'STABILITY_RECHECK_REQUESTED'].includes(preparation.status) || context.pendingPreparationId !== preparationId || preparation.restartResult?.coldStartVerified !== true) fail('Context verification must follow a verified cold start and approved popup handling only', 'CONTEXT_PREPARATION_INVALID');
  }
  const observationId = nextId(scanDir, 'observation', 'obs'); const finalDir = path.join(scanDir, 'evidence', 'observations', observationId);
  const tempDir = `${finalDir}.tmp-${process.pid}`; const workingDir = `${finalDir}.sampling-${process.pid}`;
  try {
    const trigger = String(args.trigger || PURPOSE_TRIGGERS[purpose] || 'MANUAL').toUpperCase();
    const captured = captureStableObservation({ scan, observationId, workingDir, trigger, policyArgs: args });
    fs.renameSync(captured.acceptedSampleDir, tempDir); fs.rmSync(workingDir, { recursive: true, force: true });
    const result = captured.bridgeResult; const stability = captured.stability;
    const layout = readJson(path.join(tempDir, 'layout.json')); void layout;
    const bridgeLog = path.join(tempDir, 'bridge.log'); if (fs.existsSync(bridgeLog)) fs.renameSync(bridgeLog, path.join(scanDir, 'evidence', 'logs', `${observationId}-bridge.log`));
    const current = loadScan(scanDir); const observation = { schemaVersion: 2, observationId, sequence: current.counters.observation, capturedAt: stability.stabilizedAt, foreground: result.foreground,
      display: { width: args.width ? Number(args.width) : null, height: args.height ? Number(args.height) : null, orientation: args.orientation || null },
      screenshotPath: `evidence/observations/${observationId}/screenshot.png`, layoutPath: `evidence/observations/${observationId}/layout.json`, captureStatus: 'COMPLETE', contextId, purpose, trigger, stability, contextPreparationId: preparation?.preparationId || null };
    writeJsonAtomic(path.join(tempDir, 'observation.json'), observation); fs.renameSync(tempDir, finalDir);
    const metricsFile = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(metricsFile); metrics.observations = (metrics.observations || 0) + 1; metrics.observationSamples = (metrics.observationSamples || 0) + stability.sampleCount; metrics.observationStabilityWaitMs = (metrics.observationStabilityWaitMs || 0) + stability.elapsedMs; if (stability.status === 'LAYOUT_STABLE_VISUAL_VARIANCE') metrics.visualVarianceObservations = (metrics.visualVarianceObservations || 0) + 1;
    commitEvent(scanDir, 'observation', { contextId, observationId, foreground: observation.foreground, trigger, stabilityStatus: stability.status, stabilityElapsedMs: stability.elapsedMs, sampleCount: stability.sampleCount }, [{ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]);
    if (!observation.foreground.bundleName) return output({ schemaVersion: 1, ok: true, observation, inTargetApp: null, reasonCode: 'TARGET_APP_UNKNOWN' });
    if (observation.foreground.bundleName !== scan.target.bundleName) {
      event(scanDir, 'contextLost', { contextId, observationId, reasonCode: 'APP_LEFT_FOREGROUND', observedBundleName: observation.foreground.bundleName });
      return output({ schemaVersion: 1, ok: true, observation, inTargetApp: false, reasonCode: 'APP_LEFT_FOREGROUND' });
    }
    if (preparation) { preparation.status = 'EVIDENCE_CAPTURED'; preparation.observationId = observationId; preparation.evidenceCapturedAt = now(); commitEvent(scanDir, 'contextColdStartObserved', { contextId, preparationId: preparation.preparationId, observationId }, [{ path: `evidence/preparations/${preparation.preparationId}.json`, op: 'REPLACE', value: preparation }]); }
    output({ schemaVersion: 1, ok: true, observation, inTargetApp: true });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true }); fs.rmSync(workingDir, { recursive: true, force: true });
    if (error.diagnostic) { writeJsonAtomic(path.join(scanDir, 'evidence', 'logs', `${observationId}-stability-timeout.json`), error.diagnostic); event(scanDir, 'observationRejected', { contextId, observationId, purpose, trigger: error.diagnostic.policy?.trigger || null, reasonCode: error.code, elapsedMs: error.diagnostic.elapsedMs, sampleCount: error.diagnostic.samples?.length || 0 }); }
    throw error;
  }
});
