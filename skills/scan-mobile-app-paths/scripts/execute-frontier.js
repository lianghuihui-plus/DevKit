#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, nextId, hashObject, jsonArg, safeSegment, now, readJson, event, commitEvent, commitEventLocked, transition, output, main, fail, withRunLock } = require('./lib/common');
const { validatePopupDisposition } = require('./lib/popup-policy');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { isV3, activeContextId } = require('./lib/run-protocol');
const { establishCursor, invalidateCursor, projectedCursor } = require('./lib/live-cursor');
const { recordNavigationMode } = require('./lib/action-metrics');

function runJson(script, args) {
  const child = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
  if (child.status !== 0) { let detail = null; try { detail = JSON.parse(child.stderr || child.stdout || '{}').error; } catch {} fail(detail?.message || (child.stderr || child.stdout || `${script} failed`).trim(), detail?.code || 'SCAN_ENGINE_STEP_FAILED'); }
  try { return JSON.parse(child.stdout); } catch (error) { fail(`${script} returned invalid JSON: ${error.message}`, 'SCAN_ENGINE_PROTOCOL_INVALID'); }
}

function compareObservations(scanDir, beforeId, afterId) {
  const beforeDir = path.join(scanDir, 'evidence', 'observations', beforeId); const afterDir = path.join(scanDir, 'evidence', 'observations', afterId);
  const before = readJson(path.join(beforeDir, 'observation.json')); const after = readJson(path.join(afterDir, 'observation.json'));
  return compareFingerprint(
    buildFingerprint(readJson(path.join(beforeDir, 'layout.json')), before.foreground, observationVisual(before)),
    buildFingerprint(readJson(path.join(afterDir, 'layout.json')), after.foreground, observationVisual(after))
  );
}

function canReviewRestoreEquivalence(scanDir, attempt) {
  const mismatch = attempt.restoreMismatch;
  if (mismatch?.comparison !== 'PROBABLE' || !mismatch.expectedReachableStateId || !attempt.reviewObservationId) return false;
  const graph = loadGraph(scanDir, attempt.contextId);
  const state = graph.reachableStates.find(item => item.id === mismatch.expectedReachableStateId);
  const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
  if (visual?.fingerprint?.visualDynamic !== true) return false;
  const observation = readJson(path.join(scanDir, 'evidence', 'observations', attempt.reviewObservationId, 'observation.json'));
  const layout = readJson(path.join(scanDir, observation.layoutPath));
  return visual.fingerprint.layoutHash === buildFingerprint(layout, observation.foreground, observationVisual(observation)).layoutHash;
}

function reviewRequest(scanDir, attempt, phase) {
  const observationId = attempt.reviewObservationId; const observation = readJson(path.join(scanDir, 'evidence', 'observations', observationId, 'observation.json'));
  const restoreDispositions = ['DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN'];
  const equivalenceAvailable = phase === 'RESTORE' && canReviewRestoreEquivalence(scanDir, attempt); if (equivalenceAvailable) restoreDispositions.unshift('EXPECTED_STATE_EQUIVALENT');
  return { phase, observationId, screenshotPath: path.join(scanDir, observation.screenshotPath), layoutPath: path.join(scanDir, observation.layoutPath), dispositions: phase === 'RESTORE' ? restoreDispositions : ['PAGE', 'BUSINESS_MODAL', 'NO_STATE_CHANGE', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN'], sourceComparison: phase === 'OUTCOME' ? attempt.sourceComparison || null : null, restoreComparison: phase === 'RESTORE' ? attempt.restoreMismatch?.comparison || null : null, expectedReachableStateId: phase === 'RESTORE' ? attempt.restoreMismatch?.expectedReachableStateId || null : null, recommendedDisposition: phase === 'OUTCOME' && attempt.sourceComparison === 'EXACT' ? 'NO_STATE_CHANGE' : equivalenceAvailable ? 'EXPECTED_STATE_EQUIVALENT' : null, goalHint: '如果弹窗与目标截图匹配，选择 BUSINESS_MODAL，不要关闭。' };
}

function failAttempt(scanDir, contextId, attempt, error) {
  const result = withRunLock(scanDir, () => {
    const current = readJson(path.join(scanDir, 'attempts', `${attempt.attemptId}.json`), attempt);
    current.status = 'FAILED'; current.reasonCode = error.code || 'ATTEMPT_FAILED'; current.error = error.message; current.updatedAt = now();
    const frontier = loadFrontier(scanDir, contextId); const item = frontier.items.find(x => x.id === current.frontierId);
    if (item?.status === 'CLAIMED' && (!item.claimedAttemptId || item.claimedAttemptId === current.attemptId)) {
      item.status = item.attempts < 3 ? 'RETRYABLE' : 'FAILED'; item.reasonCode = current.reasonCode; item.resolvedAt = now(); item.lastAttemptId = current.attemptId; item.claimToken = null; item.claimedAttemptId = null;
    }
    const ops = [{ path: `attempts/${current.attemptId}.json`, op: 'REPLACE', value: current }]; if (item) ops.push({ path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item }); let navigationExecution = null; if (current.navigationExecutionId) { const file = path.join(scanDir, 'evidence', 'navigations', `${current.navigationExecutionId}.json`); navigationExecution = readJson(file, null); if (navigationExecution?.status === 'PLANNED') { navigationExecution.status = 'CANCELLED'; navigationExecution.reasonCode = current.reasonCode; navigationExecution.finishedAt = now(); ops.push({ path: `evidence/navigations/${current.navigationExecutionId}.json`, op: 'REPLACE', value: navigationExecution }); } } commitEventLocked(scanDir, 'attemptFailed', { contextId, attemptId: current.attemptId, frontierId: current.frontierId, reasonCode: current.reasonCode, attempt: current, frontierItem: item || null, navigationExecution }, ops); return { attempt: current, frontierItem: item || null };
  });
  return result.attempt;
}

function commitAttempt(scanDir, type, data, attempt) {
  commitEvent(scanDir, type, { ...data, attempt }, [
    { path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }
  ]);
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'prepare'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: true });
  if (scan.status !== 'SCANNING') fail('Frontier execution requires SCANNING', 'RUN_STATE_INVALID'); const contextId = args.context || activeContextId(scan);
  if (contextId !== activeContextId(scan)) fail('Frontier context must be active', 'CONTEXT_INVALID');
  const performRestore = (attempt, resume = null) => {
    try {
      const restoreArgs = resume
        ? ['resume', '--scan-dir', scanDir, '--context', contextId, '--restore-id', resume.restoreId, '--observation-id', resume.observationId, '--allow-interruption', 'true', '--attempt-id', attempt.attemptId, ...(resume.equivalenceAssessment ? ['--equivalence-assessment', JSON.stringify(resume.equivalenceAssessment)] : [])]
        : ['--scan-dir', scanDir, '--context', contextId, '--reachable-state-id', attempt.fromReachableStateId, '--allow-interruption', 'true', '--attempt-id', attempt.attemptId];
      const restored = runJson('restore-node.js', restoreArgs).restoreResult;
      attempt.restoreResults ||= []; const restoreIndex = attempt.restoreResults.findIndex(item => item.restoreId === restored.restoreId); if (restoreIndex >= 0) attempt.restoreResults[restoreIndex] = restored; else attempt.restoreResults.push(restored); attempt.updatedAt = now();
      if (restored.status === 'REVIEW_REQUIRED') {
        if (isV3(scan)) invalidateCursor(scanDir, contextId, 'RESTORE_REVIEW_REQUIRED');
        attempt.status = 'AWAITING_RESTORE_REVIEW'; attempt.activeRestoreId = restored.restoreId; attempt.reviewObservationId = restored.terminalObservationId; attempt.restoreMismatch = restored.mismatch;
        commitAttempt(scanDir, 'popupReviewRequested', { contextId, attemptId: attempt.attemptId, phase: 'RESTORE', observationId: attempt.reviewObservationId, mismatch: restored.mismatch }, attempt);
        return output({ schemaVersion: 1, ok: true, attempt, reviewRequest: reviewRequest(scanDir, attempt, 'RESTORE') });
      }
      if (isV3(scan)) { const cursor = establishCursor(scanDir, contextId, { reachableStateId: attempt.fromReachableStateId, observationId: restored.terminalObservationId, status: 'EXACT', establishedBy: 'COLD_REPLAY' }, { incrementEpoch: true }); attempt.cursorEpoch = cursor.epoch; attempt.sourceAcquisitionMode = 'COLD_REPLAY'; }
      if (attempt.navigationExecutionId) { const navigationFile = path.join(scanDir, 'evidence', 'navigations', `${attempt.navigationExecutionId}.json`); const navigation = readJson(navigationFile, null); if (navigation) { navigation.actualMode = 'COLD_REPLAY'; navigation.fallbackFrom = attempt.navigationFallbackFrom || (navigation.requestedMode !== 'COLD_REPLAY' ? navigation.requestedMode : null); navigation.fallbackReason = attempt.navigationFallbackReason || (scan.navigationPolicy === 'always-replay' && navigation.requestedMode !== 'COLD_REPLAY' ? 'ALWAYS_REPLAY_POLICY' : null); navigation.restoreId = restored.restoreId; navigation.terminalObservationId = restored.terminalObservationId; navigation.status = 'SUCCEEDED'; navigation.startedAt ||= restored.startedAt; navigation.finishedAt = now(); commitEvent(scanDir, 'sourceStateAcquired', { contextId, navigationPlanId: navigation.navigationPlanId, navigationExecutionId: navigation.navigationExecutionId, mode: 'COLD_REPLAY', fallbackFrom: navigation.fallbackFrom, restoreId: restored.restoreId, reachableStateId: attempt.fromReachableStateId, observationId: restored.terminalObservationId, cursorEpoch: attempt.cursorEpoch, navigationExecution: navigation }, [{ path: `evidence/navigations/${navigation.navigationExecutionId}.json`, op: 'REPLACE', value: navigation }]); recordNavigationMode(scanDir, contextId, 'COLD_REPLAY'); } }
      attempt.beforeObservationId = restored.terminalObservationId; attempt.sourceObservationId = restored.terminalObservationId; attempt.sourceVerification = 'EXACT'; attempt.activeRestoreId = null; attempt.reviewObservationId = null; attempt.restoreMismatch = null; attempt.status = 'READY_FOR_ACTION';
      commitAttempt(scanDir, 'attemptReadyForAction', { contextId, attemptId: attempt.attemptId, frontierId: attempt.frontierId, beforeObservationId: attempt.beforeObservationId, restoreId: restored.restoreId }, attempt);
      return output({ schemaVersion: 1, ok: true, attempt });
    } catch (error) { if (error.code === 'OPERATION_OUTCOME_UNKNOWN' || loadScan(scanDir).status === 'PAUSED') throw error; failAttempt(scanDir, contextId, attempt, Object.assign(error, { code: error.code || 'RESTORE_FAILED' })); throw error; }
  };
  const performSourceAcquisition = attempt => {
    if (!isV3(scan) || !attempt.navigationPlanId || attempt.sourceAcquisitionMode === 'COLD_REPLAY' || scan.navigationPolicy === 'always-replay') { if (scan.navigationPolicy === 'always-replay' && attempt.sourceAcquisitionMode !== 'COLD_REPLAY') { attempt.navigationFallbackFrom = attempt.sourceAcquisitionMode; attempt.navigationFallbackReason = 'ALWAYS_REPLAY_POLICY'; } return performRestore(attempt); }
    try {
      const navigated = runJson('navigate-source.js', ['--scan-dir', scanDir, '--context', contextId, '--navigation-execution-id', attempt.navigationExecutionId, '--attempt-id', attempt.attemptId]); const result = navigated.navigationResult; attempt.navigationResults ||= []; attempt.navigationResults.push(result); attempt.beforeObservationId = result.terminalObservationId; attempt.sourceObservationId = result.terminalObservationId; attempt.sourceVerification = 'EXACT'; attempt.cursorEpoch = navigated.cursor.epoch; attempt.status = 'READY_FOR_ACTION'; attempt.updatedAt = now(); commitAttempt(scanDir, 'attemptReadyForAction', { contextId, attemptId: attempt.attemptId, frontierId: attempt.frontierId, beforeObservationId: attempt.beforeObservationId, navigationPlanId: attempt.navigationPlanId, navigationExecutionId: attempt.navigationExecutionId, sourceAcquisitionMode: attempt.sourceAcquisitionMode }, attempt); return output({ schemaVersion: 1, ok: true, attempt });
    } catch (error) {
      const pauseRequired = ['POPUP_REVIEW_REQUIRED', 'CONTEXT_MISMATCH', 'RISK_REVIEW_REQUIRED', 'OPERATION_OUTCOME_UNKNOWN'].includes(error.code) || loadScan(scanDir).status === 'PAUSED'; if (attempt.sourceAcquisitionMode !== 'COLD_REPLAY' && !pauseRequired) { event(scanDir, 'navigationFallbackSelected', { contextId, attemptId: attempt.attemptId, fromMode: attempt.sourceAcquisitionMode, toMode: 'COLD_REPLAY', reasonCode: error.code || 'NAVIGATION_FAILED' }); attempt.navigationFallbackFrom = attempt.sourceAcquisitionMode; attempt.navigationFallbackReason = error.code || 'NAVIGATION_FAILED'; attempt.sourceAcquisitionMode = 'COLD_REPLAY'; return performRestore(attempt); }
      if (pauseRequired) throw error;
      failAttempt(scanDir, contextId, attempt, Object.assign(error, { code: error.code || 'NAVIGATION_FAILED' })); throw error;
    }
  };
  if (command === 'prepare') {
    const frontierId = required(args, 'frontierId'); const claimToken = required(args, 'claimToken'); const reservedAttemptId = nextId(scanDir, 'attempt', 'attempt');
    const prepared = withRunLock(scanDir, () => {
      const frontier = loadFrontier(scanDir, contextId); const item = frontier.items.find(x => x.id === frontierId);
      if (!item || item.status !== 'CLAIMED') fail('Frontier must be CLAIMED before execution', 'FRONTIER_STATUS_INVALID');
      if (item.claimToken !== claimToken) fail('Frontier claim token is stale', 'FRONTIER_CLAIM_STALE');
      if (item.claimedAttemptId) return { attempt: readJson(path.join(scanDir, 'attempts', `${item.claimedAttemptId}.json`)), created: false };
      const attempt = { schemaVersion: isV3(scan) ? 3 : 1, attemptId: reservedAttemptId, contextId, frontierId, claimToken, fromReachableStateId: item.fromReachableStateId, candidateHash: hashObject(item.candidate), candidate: item.candidate, status: 'CLAIMED', createdAt: now(), updatedAt: now(), restoreResults: [], navigationResults: [], navigationPlanId: item.navigationPlanId || null, navigationExecutionId: item.navigationExecutionId || null, sourceAcquisitionMode: item.navigationPlan?.mode || 'COLD_REPLAY', cursorEpoch: item.cursorEpoch ?? null, sourceObservationId: null, sourceVerification: null, beforeObservationId: null, actionResultId: null, afterObservationId: null, reviewObservationId: null, outcomeKind: null, interruptions: [] };
      item.claimedAttemptId = attempt.attemptId; commitEventLocked(scanDir, 'attemptStarted', { contextId, attemptId: attempt.attemptId, frontierId, fromReachableStateId: attempt.fromReachableStateId, navigationPlanId: attempt.navigationPlanId, sourceAcquisitionMode: attempt.sourceAcquisitionMode, cursorEpoch: attempt.cursorEpoch, attempt, item }, [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }, { path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item }]); return { attempt, created: true };
    });
    if (!prepared.created) return output({ schemaVersion: 1, ok: true, attempt: prepared.attempt, reused: true });
    return performSourceAcquisition(prepared.attempt);
  }
  const attemptId = safeSegment(required(args, 'attemptId'), 'attemptId'); const attemptFile = path.join(scanDir, 'attempts', `${attemptId}.json`); const attempt = readJson(attemptFile);
  if (attempt.contextId !== contextId) fail('Attempt belongs to another context', 'ATTEMPT_CAUSALITY_INVALID');
  if (command === 'review-restore') {
    if (attempt.status !== 'AWAITING_RESTORE_REVIEW') fail('Attempt is not awaiting restore review', 'ATTEMPT_STATE_INVALID'); const observationId = safeSegment(required(args, 'observationId'), 'observationId'); if (attempt.reviewObservationId !== observationId) fail('Popup review observation is stale', 'POPUP_REVIEW_STALE');
    const disposition = String(required(args, 'disposition')).toUpperCase(); if (disposition !== 'EXPECTED_STATE_EQUIVALENT') validatePopupDisposition(disposition); if (!['EXPECTED_STATE_EQUIVALENT', 'DISMISSIBLE_POPUP', 'TRANSIENT', 'SYSTEM_OR_UNKNOWN'].includes(disposition)) fail('Restore review only accepts expected-state equivalence, dismissible popup, transient, or unknown popup', 'POPUP_DISPOSITION_INVALID');
    const restoreId = attempt.activeRestoreId || (attempt.restoreResults || []).at(-1)?.restoreId; if (!restoreId) fail('Attempt has no active restore checkpoint', 'RESTORE_CHECKPOINT_INVALID');
    if (disposition === 'SYSTEM_OR_UNKNOWN') { attempt.lastReview = { phase: 'RESTORE', disposition, observationId, reviewedAt: now() }; commitAttempt(scanDir, 'attemptReviewDeferred', { contextId, attemptId, phase: 'RESTORE', observationId, disposition }, attempt); if (isV3(scan)) invalidateCursor(scanDir, contextId, 'POPUP_REVIEW_REQUIRED'); transition(scanDir, 'PAUSED', 'POPUP_REVIEW_REQUIRED'); return output({ schemaVersion: 1, ok: true, attempt, runStatus: 'PAUSED' }); }
    if (disposition === 'EXPECTED_STATE_EQUIVALENT') {
      const visualAssessment = jsonArg(required(args, 'visualAssessment'), null, 'visualAssessment JSON');
      return performRestore(attempt, { restoreId, observationId, equivalenceAssessment: visualAssessment });
    }
    if (disposition === 'TRANSIENT') {
      attempt.stabilityChecks ||= []; if (attempt.stabilityChecks.filter(item => item.phase === 'RESTORE').length >= 3) { attempt.lastReview = { phase: 'RESTORE', disposition, observationId, reviewedAt: now() }; commitAttempt(scanDir, 'attemptReviewDeferred', { contextId, attemptId, phase: 'RESTORE', observationId, disposition, reasonCode: 'RESTORE_RECHECK_LIMIT' }, attempt); transition(scanDir, 'PAUSED', 'RESTORE_RECHECK_LIMIT'); return output({ schemaVersion: 1, ok: true, attempt, runStatus: 'PAUSED' }); }
      const after = runJson('observe-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--purpose', 'stability-recheck', '--trigger', 'RECHECK']); if (after.inTargetApp !== true) fail('Target App left foreground during restore stability recheck', 'APP_LEFT_FOREGROUND');
      attempt.stabilityChecks.push({ schemaVersion: 2, phase: 'RESTORE', beforeObservationId: observationId, afterObservationId: after.observation.observationId, checkedAt: now() }); attempt.updatedAt = now(); commitAttempt(scanDir, 'attemptStabilityRechecked', { contextId, attemptId, phase: 'RESTORE', beforeObservationId: observationId, afterObservationId: after.observation.observationId, checkCount: attempt.stabilityChecks.filter(item => item.phase === 'RESTORE').length }, attempt); return performRestore(attempt, { restoreId, observationId: after.observation.observationId });
    }
    if ((attempt.interruptions || []).filter(item => item.phase === 'RESTORE').length >= 3) { attempt.lastReview = { phase: 'RESTORE', disposition, observationId, reviewedAt: now() }; commitAttempt(scanDir, 'attemptReviewDeferred', { contextId, attemptId, phase: 'RESTORE', observationId, disposition, reasonCode: 'RESTORE_POPUP_RECURS' }, attempt); transition(scanDir, 'PAUSED', 'RESTORE_POPUP_RECURS'); return output({ schemaVersion: 1, ok: true, attempt, runStatus: 'PAUSED' }); }
    const dismissAction = jsonArg(required(args, 'dismissAction'), null, 'dismissAction JSON'); const dismissal = runJson('popup-dismiss-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--observation-id', observationId, '--owner-type', 'ATTEMPT', '--owner-id', attemptId, '--action', JSON.stringify(dismissAction)]).actionResult;
    const after = runJson('observe-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--purpose', 'popup-cleanup-after', '--trigger', 'POPUP_DISMISSAL']); if (after.inTargetApp !== true) fail('Target App left foreground after restore popup dismissal', 'APP_LEFT_FOREGROUND');
    attempt.interruptions.push({ schemaVersion: 2, phase: 'RESTORE', restoreId, beforeObservationId: observationId, dismissalActionResultId: dismissal.actionId, afterObservationId: after.observation.observationId, handledAt: now() }); attempt.updatedAt = now(); commitAttempt(scanDir, 'attemptPopupDismissed', { contextId, attemptId, phase: 'RESTORE', restoreId, beforeObservationId: observationId, dismissalActionResultId: dismissal.actionId, afterObservationId: after.observation.observationId, dismissalCount: attempt.interruptions.filter(item => item.phase === 'RESTORE').length }, attempt); return performRestore(attempt, { restoreId, observationId: after.observation.observationId });
  }
  if (command === 'act') {
    if (attempt.status !== 'READY_FOR_ACTION') fail('Attempt is not ready for candidate action', 'ATTEMPT_STATE_INVALID');
    try {
      const action = runJson('action-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--attempt-id', attemptId]); if (!action.ok || action.actionResult.status !== 'SUCCEEDED') fail('Claimed action did not succeed', action.actionResult.reasonCode || 'ACTION_FAILED');
      const current = readJson(attemptFile); const after = runJson('observe-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--purpose', 'attempt-after', '--trigger', 'ACTION']); if (after.inTargetApp !== true) fail('Target App left foreground after action', 'APP_LEFT_FOREGROUND');
      current.afterObservationId = after.observation.observationId; current.reviewObservationId = after.observation.observationId; current.sourceComparison = compareObservations(scanDir, current.beforeObservationId, current.afterObservationId); current.status = 'AWAITING_OUTCOME_REVIEW'; current.updatedAt = now(); commitAttempt(scanDir, 'popupReviewRequested', { contextId, attemptId, phase: 'OUTCOME', observationId: current.reviewObservationId, sourceComparison: current.sourceComparison }, current); return output({ schemaVersion: 1, ok: true, attempt: current, reviewRequest: reviewRequest(scanDir, current, 'OUTCOME') });
    } catch (error) { if (error.code === 'OPERATION_OUTCOME_UNKNOWN' || loadScan(scanDir).status === 'PAUSED') throw error; failAttempt(scanDir, contextId, readJson(attemptFile, attempt), Object.assign(error, { code: error.code || 'ACTION_OR_OBSERVATION_FAILED' })); throw error; }
  }
  if (command === 'review-outcome') {
    if (attempt.status !== 'AWAITING_OUTCOME_REVIEW') fail('Attempt is not awaiting outcome review', 'ATTEMPT_STATE_INVALID'); const observationId = safeSegment(required(args, 'observationId'), 'observationId'); if (attempt.reviewObservationId !== observationId) fail('Popup review observation is stale', 'POPUP_REVIEW_STALE');
    const disposition = validatePopupDisposition(required(args, 'disposition')); attempt.lastReview = { phase: 'OUTCOME', disposition, observationId, reviewedAt: now() };
    if (disposition === 'SYSTEM_OR_UNKNOWN') { commitAttempt(scanDir, 'attemptReviewDeferred', { contextId, attemptId, phase: 'OUTCOME', observationId, disposition }, attempt); if (isV3(scan)) invalidateCursor(scanDir, contextId, 'POPUP_REVIEW_REQUIRED'); transition(scanDir, 'PAUSED', 'POPUP_REVIEW_REQUIRED'); return output({ schemaVersion: 1, ok: true, attempt, runStatus: 'PAUSED' }); }
    if (disposition === 'NO_STATE_CHANGE') {
      const comparison = compareObservations(scanDir, attempt.beforeObservationId, observationId); if (comparison !== 'EXACT') fail(`NO_STATE_CHANGE requires EXACT source comparison, observed ${comparison}`, 'NO_STATE_CHANGE_MISMATCH');
      attempt.status = 'NO_STATE_CHANGE'; attempt.outcomeKind = null; attempt.reviewObservationId = null; attempt.sourceComparison = comparison; attempt.noStateChange = { beforeObservationId: attempt.beforeObservationId, afterObservationId: observationId, comparison, confirmedAt: now() }; attempt.updatedAt = now();
      const frontier = loadFrontier(scanDir, contextId); const item = frontier.items.find(x => x.id === attempt.frontierId); if (!item || item.status !== 'CLAIMED' || item.claimedAttemptId !== attemptId || item.claimToken !== attempt.claimToken) fail('Attempt frontier is no longer claimed', 'ATTEMPT_CAUSALITY_INVALID'); item.status = 'EXPLORED'; item.reasonCode = 'NO_STATE_CHANGE'; item.resolvedAt = now(); item.attemptId = attemptId; item.claimToken = null; item.claimedAttemptId = null;
      const metricsFile = path.join(scanDir, 'contexts', contextId, 'metrics.json'); const metrics = readJson(metricsFile); metrics.noStateChangeActions = (metrics.noStateChangeActions || 0) + 1; const ops = [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }, { path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item }, { path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics }]; if (isV3(scan)) ops.push({ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: projectedCursor(scanDir, contextId, { reachableStateId: attempt.fromReachableStateId, observationId, status: 'EXACT', establishedBy: 'NO_STATE_CHANGE' }) }); commitEvent(scanDir, 'attemptCompletedWithoutEdge', { contextId, attemptId, frontierId: item.id, reasonCode: 'NO_STATE_CHANGE', beforeObservationId: attempt.beforeObservationId, afterObservationId: observationId, attempt, item }, ops); return output({ schemaVersion: 1, ok: true, attempt, edgeCreated: false, frontier: item });
    }
    if (disposition === 'TRANSIENT') {
      attempt.stabilityChecks ||= []; if (attempt.stabilityChecks.length >= 3) fail('Attempt stability recheck limit reached', 'POPUP_REVIEW_LIMIT'); const after = runJson('observe-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--purpose', 'stability-recheck', '--trigger', 'RECHECK']); if (after.inTargetApp !== true) fail('Target App left foreground during stability recheck', 'APP_LEFT_FOREGROUND');
      attempt.stabilityChecks.push({ phase: 'OUTCOME', beforeObservationId: observationId, afterObservationId: after.observation.observationId, checkedAt: now() }); attempt.afterObservationId = after.observation.observationId; attempt.reviewObservationId = after.observation.observationId; attempt.sourceComparison = compareObservations(scanDir, attempt.beforeObservationId, attempt.afterObservationId); attempt.updatedAt = now(); commitAttempt(scanDir, 'attemptStabilityRechecked', { contextId, attemptId, phase: 'OUTCOME', beforeObservationId: observationId, afterObservationId: after.observation.observationId, checkCount: attempt.stabilityChecks.length, sourceComparison: attempt.sourceComparison }, attempt); return output({ schemaVersion: 1, ok: true, attempt, reviewRequest: reviewRequest(scanDir, attempt, 'OUTCOME') });
    }
    if (disposition === 'DISMISSIBLE_POPUP') {
      if ((attempt.interruptions || []).length >= 3) fail('Attempt popup dismissal limit reached', 'POPUP_DISMISS_LIMIT'); const dismissAction = jsonArg(required(args, 'dismissAction'), null, 'dismissAction JSON');
      const dismissal = runJson('popup-dismiss-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--observation-id', observationId, '--owner-type', 'ATTEMPT', '--owner-id', attemptId, '--action', JSON.stringify(dismissAction)]).actionResult;
      const after = runJson('observe-runner.js', ['--scan-dir', scanDir, '--context', contextId, '--purpose', 'popup-cleanup-after', '--trigger', 'POPUP_DISMISSAL']);
      if (after.inTargetApp !== true) {
        const error = Object.assign(new Error('Target App left foreground after popup dismissal'), { code: 'APP_LEFT_FOREGROUND' }); failAttempt(scanDir, contextId, attempt, error); fail(error.message, error.code);
      }
      attempt.interruptions.push({ phase: 'OUTCOME', beforeObservationId: observationId, dismissalActionResultId: dismissal.actionId, afterObservationId: after.observation.observationId, handledAt: now() }); attempt.afterCleanupObservationId = after.observation.observationId; attempt.afterObservationId = after.observation.observationId; attempt.updatedAt = now();
      const graph = loadGraph(scanDir, contextId); const source = graph.reachableStates.find(x => x.id === attempt.fromReachableStateId); const sourceVisual = source && graph.visualStates.find(x => x.id === source.visualStateId); const cleanupLayout = readJson(path.join(scanDir, after.observation.layoutPath)); const cleanupComparison = sourceVisual ? compareFingerprint(sourceVisual.fingerprint, buildFingerprint(cleanupLayout, after.observation.foreground, observationVisual(after.observation))) : 'UNCERTAIN';
      if (cleanupComparison !== 'EXACT') { attempt.status = 'AWAITING_OUTCOME_REVIEW'; attempt.reviewObservationId = after.observation.observationId; attempt.sourceComparison = compareObservations(scanDir, attempt.beforeObservationId, attempt.afterObservationId); commitAttempt(scanDir, 'attemptPopupDismissed', { contextId, attemptId, phase: 'OUTCOME', dismissalActionResultId: dismissal.actionId, afterObservationId: after.observation.observationId, cleanupComparison, sourceComparison: attempt.sourceComparison }, attempt); return output({ schemaVersion: 1, ok: true, attempt, popupDismissed: true, cleanupComparison, reviewRequest: reviewRequest(scanDir, attempt, 'OUTCOME') }); }
      attempt.status = 'DISMISSED_NO_EDGE'; attempt.reviewObservationId = null;
      const frontier = loadFrontier(scanDir, contextId); const item = frontier.items.find(x => x.id === attempt.frontierId); if (!item || item.status !== 'CLAIMED' || item.claimedAttemptId !== attemptId || item.claimToken !== attempt.claimToken) fail('Attempt frontier is no longer claimed', 'ATTEMPT_CAUSALITY_INVALID'); item.status = 'EXPLORED'; item.reasonCode = 'DISMISSIBLE_POPUP'; item.resolvedAt = now(); item.attemptId = attemptId; item.claimToken = null; item.claimedAttemptId = null; const ops = [{ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }, { path: `contexts/${contextId}/frontier.json`, op: 'UPSERT', collection: 'items', keyFields: ['id'], value: item }]; if (isV3(scan)) ops.push({ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: projectedCursor(scanDir, contextId, { reachableStateId: attempt.fromReachableStateId, observationId: after.observation.observationId, status: 'EXACT', establishedBy: 'POPUP_DISMISSAL' }) }); commitEvent(scanDir, 'attemptCompletedWithoutEdge', { contextId, attemptId, frontierId: item.id, reasonCode: 'DISMISSIBLE_POPUP', dismissalActionResultId: dismissal.actionId, attempt, item }, ops); return output({ schemaVersion: 1, ok: true, attempt, edgeCreated: false, frontier: item });
    }
    if (disposition === 'BUSINESS_MODAL') {
      const graph = loadGraph(scanDir, contextId); const source = graph.reachableStates.find(x => x.id === attempt.fromReachableStateId); const sourceVisual = source && graph.visualStates.find(x => x.id === source.visualStateId); if (sourceVisual?.kind === 'modal') fail('Nested business modals are not supported in the current version', 'NESTED_MODAL_UNSUPPORTED');
    }
    const sourceComparison = compareObservations(scanDir, attempt.beforeObservationId, observationId); if (sourceComparison === 'EXACT') fail('Outcome is identical to the source state; use NO_STATE_CHANGE instead of creating a graph state', 'OUTCOME_NO_STATE_CHANGE'); attempt.sourceComparison = sourceComparison;
    attempt.outcomeKind = disposition === 'BUSINESS_MODAL' ? 'modal' : 'full-screen'; attempt.status = 'READY_TO_COMMIT'; attempt.reviewObservationId = null; attempt.updatedAt = now(); commitAttempt(scanDir, 'attemptReadyToCommit', { contextId, attemptId, frontierId: attempt.frontierId, observationId, disposition, beforeObservationId: attempt.beforeObservationId, actionResultId: attempt.actionResultId, afterObservationId: attempt.afterObservationId, outcomeKind: attempt.outcomeKind }, attempt); return output({ schemaVersion: 1, ok: true, attempt });
  }
  fail(`Unknown execute-frontier command: ${command}`, 'COMMAND_INVALID');
});
