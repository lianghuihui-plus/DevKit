#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, contextDir,
  writeJsonAtomic, nextId, now, event, commitEvent, output, main, fail, bool, jsonArg, safeSegment
} = require('./lib/common');
const { bridge } = require('./lib/runtime-client');
const { assessAction } = require('./lib/safety');
const { buildFingerprint, compareFingerprint, observationVisual } = require('./lib/fingerprint');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { resolveSyntheticAction } = require('./lib/synthetic-data');
const { activeContextId } = require('./lib/run-protocol');
const { recordDeviceAction, recordColdStart } = require('./lib/action-metrics');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');

function observe(scanDir, contextId, trigger) {
  const child = spawnSync(process.execPath, [
    path.join(__dirname, 'observe-runner.js'), '--scan-dir', scanDir, '--context', contextId,
    '--purpose', 'restore-verification', '--trigger', trigger
  ], { encoding: 'utf8' });
  if (child.status !== 0) fail((child.stderr || child.stdout || 'Restore observation failed').trim(), 'RESTORE_OBSERVE_FAILED');
  const result = JSON.parse(child.stdout);
  if (result.inTargetApp !== true) fail('Target App is not in foreground during restore', 'APP_LEFT_FOREGROUND');
  return result.observation.observationId;
}

function stateVisual(graph, stateId) {
  const state = graph.reachableStates.find(item => item.id === stateId);
  const visual = state && graph.visualStates.find(item => item.id === state.visualStateId);
  if (!state || !visual) fail(`Restore state missing: ${stateId}`, 'RESTORE_PATH_INVALID');
  return { state, visual };
}

function observedFingerprint(scanDir, observationId) {
  const dir = path.join(scanDir, 'evidence', 'observations', observationId);
  const observation = readJson(path.join(dir, 'observation.json'));
  const layout = readJson(path.join(dir, 'layout.json'));
  return { observation, fingerprint: buildFingerprint(layout, observation.foreground, observationVisual(observation)) };
}

function compareState(scanDir, graph, stateId, observationId) {
  const { visual } = stateVisual(graph, stateId);
  return compareFingerprint(visual.fingerprint, observedFingerprint(scanDir, observationId).fingerprint);
}

function deriveCheckpoint(result, edges) {
  if (result.checkpoint) return result.checkpoint;
  const mismatch = result.mismatch;
  if (!mismatch) fail('Restore result has no resumable checkpoint', 'RESTORE_CHECKPOINT_INVALID');
  const edgeIndex = mismatch.edgeId == null ? 0 : edges.findIndex(edge => edge.id === mismatch.edgeId);
  if (mismatch.edgeId != null && edgeIndex < 0) fail(`Restore checkpoint edge missing: ${mismatch.edgeId}`, 'RESTORE_CHECKPOINT_INVALID');
  return {
    stage: mismatch.stage,
    edgeIndex,
    edgeId: mismatch.edgeId || null,
    expectedReachableStateId: mismatch.expectedReachableStateId,
    observationId: mismatch.observationId,
    comparison: mismatch.comparison
  };
}

function validateEquivalence(scanDir, graph, checkpoint, observationId, comparison, assessment) {
  if (comparison !== 'PROBABLE') fail(`Restore equivalence requires PROBABLE comparison, observed ${comparison}`, 'RESTORE_EQUIVALENCE_INVALID');
  const { visual } = stateVisual(graph, checkpoint.expectedReachableStateId);
  const observed = observedFingerprint(scanDir, observationId);
  if (visual.fingerprint?.visualDynamic !== true) fail('Restore equivalence is only allowed for an expected dynamic VisualState', 'RESTORE_EQUIVALENCE_INVALID');
  if (!visual.fingerprint.layoutHash || visual.fingerprint.layoutHash !== observed.fingerprint.layoutHash) fail('Restore equivalence requires an identical normalized layout', 'RESTORE_EQUIVALENCE_INVALID');
  if (assessment?.status !== 'EXPECTED_STATE_EQUIVALENT' || assessment.expectedReachableStateId !== checkpoint.expectedReachableStateId || assessment.observedSha256 !== observed.fingerprint.screenshotSha256 || !String(assessment.rationale || '').trim()) fail('Restore equivalence assessment is missing or not bound to the current evidence', 'RESTORE_EQUIVALENCE_INVALID');
  return {
    schemaVersion: 1,
    status: 'EXPECTED_STATE_EQUIVALENT',
    expectedReachableStateId: checkpoint.expectedReachableStateId,
    observationId,
    comparison,
    expectedScreenshotSha256: visual.fingerprint.screenshotSha256,
    observedSha256: observed.fingerprint.screenshotSha256,
    layoutHash: observed.fingerprint.layoutHash,
    rationale: String(assessment.rationale).trim(),
    reviewedAt: now()
  };
}

main(() => {
  const args = parseArgs();
  const command = args._[0] || 'start';
  if (!['start', 'resume'].includes(command)) fail(`Unknown restore command: ${command}`, 'COMMAND_INVALID');
  const allowInterruption = bool(args.allowInterruption, false);
  const actionCategory = args.actionCategory || 'recovery'; if (!['recovery', 'verification'].includes(actionCategory)) fail('Restore action category must be recovery or verification', 'ACTION_CATEGORY_INVALID');
  const { scanDir } = resolveScanDir(required(args, 'scanDir'));
  const scan = loadScan(scanDir, { mutable: true });
  if (scan.status !== 'SCANNING') fail('Restore requires a SCANNING Run', 'RUN_STATE_INVALID');
  const contextId = args.context || activeContextId(scan);
  if (contextId !== activeContextId(scan)) fail('Restore context must be active', 'CONTEXT_INVALID');

  let graph = loadGraph(scanDir, contextId);
  const metricsFile = path.join(contextDir(scanDir, contextId), 'metrics.json');
  const metrics = () => readJson(metricsFile);
  const targetId = command === 'resume' ? null : required(args, 'reachableStateId');
  let result;

  if (command === 'resume') {
    const restoreId = required(args, 'restoreId');
    result = readJson(path.join(scanDir, 'evidence', 'restores', `${restoreId}.json`));
    if (result.contextId !== contextId || result.status !== 'REVIEW_REQUIRED') fail('Restore is not awaiting review in this context', 'RESTORE_CHECKPOINT_INVALID');
  } else {
    let target = graph.reachableStates.find(item => item.id === targetId);
    if (!target && scan.parentScanId) {
      graph = readJson(path.join(scanDir, 'known', 'contexts', `${contextId}.json`), graph);
      target = graph.reachableStates.find(item => item.id === targetId);
    }
    if (!target) fail(`Unknown ReachableState: ${targetId}`, 'GRAPH_REFERENCE_MISSING');
    assertExecutionWindow(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), metrics());
    const restoreId = nextId(scanDir, 'restore', 'restore');
    result = {
      schemaVersion: 2,
      restoreId,
      contextId,
      reachableStateId: targetId,
      startedAt: now(),
      updatedAt: now(),
      finishedAt: null,
      status: 'IN_PROGRESS',
      actionsReplayed: 0,
      terminalObservationId: null,
      mismatch: null,
      checkpoint: null,
      steps: [],
      equivalenceReviews: []
    };
    const currentMetrics = metrics();
    currentMetrics.restoreAttempts = (currentMetrics.restoreAttempts || 0) + 1;
    commitEvent(scanDir, 'restoreAttemptMetricRecorded', { contextId, restoreId, restoreAttempts: currentMetrics.restoreAttempts }, [{ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: currentMetrics }]);
    writeJsonAtomic(path.join(scanDir, 'evidence', 'restores', `${restoreId}.json`), result);
  }

  const resultFile = path.join(scanDir, 'evidence', 'restores', `${result.restoreId}.json`);
  const operationOwner = args.attemptId ? { type: 'ATTEMPT', id: safeSegment(args.attemptId, 'attemptId') } : { type: 'RESTORE', id: result.restoreId };
  const targetStateId = result.reachableStateId;
  const targetState = graph.reachableStates.find(item => item.id === targetStateId);
  if (!targetState) fail(`Unknown ReachableState: ${targetStateId}`, 'GRAPH_REFERENCE_MISSING');
  const fixedEdgeIds = command === 'start' && args.edgeIds ? jsonArg(args.edgeIds, null, 'edgeIds JSON') : null;
  const fixedFingerprints = command === 'start' && args.transitionFingerprints ? jsonArg(args.transitionFingerprints, null, 'transitionFingerprints JSON') : null;
  if (fixedEdgeIds && (!Array.isArray(fixedEdgeIds) || fixedFingerprints && (!Array.isArray(fixedFingerprints) || fixedFingerprints.length !== fixedEdgeIds.length))) fail('Fixed verification chain is invalid', 'RESTORE_PATH_INVALID');
  const edges = (fixedEdgeIds || targetState.replayPathEdgeIds || []).map((edgeId, index) => {
    const edge = graph.edges.find(item => item.id === edgeId);
    if (!edge) fail(`Replay edge missing: ${edgeId}`, 'RESTORE_PATH_INVALID');
    if (fixedFingerprints && edge.verification?.transitionFingerprint !== fixedFingerprints[index]) fail(`Replay edge fingerprint changed: ${edgeId}`, 'VERIFICATION_SUPERSEDED');
    return edge;
  });
  if (fixedEdgeIds) { result.verificationExecutionId = args.verificationExecutionId || null; result.fixedEdgeIds = [...fixedEdgeIds]; result.fixedTransitionFingerprints = [...(fixedFingerprints || [])]; }

  const save = () => {
    result.schemaVersion = 2;
    result.updatedAt = now();
    writeJsonAtomic(resultFile, result);
  };

  const finish = (terminalObservationId) => {
    result.status = 'SUCCEEDED';
    result.terminalObservationId = terminalObservationId;
    result.mismatch = null;
    result.checkpoint = null;
    result.finishedAt = now();
    save();
    event(scanDir, 'restoreResult', result);
    output({ schemaVersion: 1, ok: true, restoreResult: result });
  };

  const requestReview = (stage, expectedReachableStateId, observationId, comparison, edgeIndex = 0, edgeId = null) => {
    if (!allowInterruption) fail(`Restore verification mismatch at ${expectedReachableStateId}: ${comparison}`, 'RESTORE_STATE_MISMATCH');
    const checkpoint = { stage, edgeIndex, edgeId, expectedReachableStateId, observationId, comparison };
    result.status = 'REVIEW_REQUIRED';
    result.terminalObservationId = observationId;
    result.mismatch = { stage, expectedReachableStateId, observationId, comparison, edgeId };
    result.checkpoint = checkpoint;
    result.reviewRequestedAt = now();
    result.finishedAt = null;
    save();
    event(scanDir, 'restoreReviewRequired', result);
    output({ schemaVersion: 1, ok: true, restoreResult: result });
  };

  const replayFrom = (edgeIndex, currentObservationId, reviewedStateId = null) => {
    if (edgeIndex >= edges.length) {
      if (edges.length && edges[edges.length - 1].toReachableStateId !== targetStateId) fail('Replay path does not terminate at target state', 'RESTORE_PATH_INVALID');
      return finish(currentObservationId);
    }
    const edge = edges[edgeIndex];
    if (edgeIndex > 0 && edges[edgeIndex - 1].toReachableStateId !== edge.fromReachableStateId) fail(`Replay path is discontinuous at ${edge.id}`, 'RESTORE_PATH_INVALID');
    const beforeComparison = reviewedStateId === edge.fromReachableStateId ? 'REVIEW_CONFIRMED' : compareState(scanDir, graph, edge.fromReachableStateId, currentObservationId);
    if (!['EXACT', 'REVIEW_CONFIRMED'].includes(beforeComparison)) return requestReview('BEFORE_EDGE', edge.fromReachableStateId, currentObservationId, beforeComparison, edgeIndex, edge.id);

    const safety = assessAction(edge.action, scan.target);
    if (!safety.allowed || edge.replayPolicy === 'NONREPEATABLE') fail(`Replay blocked at ${edge.id}`, 'RESTORE_UNSAFE');
    const currentMetrics = metrics();
    assertExecutionWindow(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), currentMetrics);
    assertCapacity(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), currentMetrics, 'actions', 1);
    const replayAction = edge.replayPolicy === 'REGENERATE_SYNTHETIC' ? resolveSyntheticAction(edge.action, `${result.restoreId}:${edge.id}`) : edge.action;
    const bounds = replayAction.fallbackBounds;
    const x = bounds ? Math.round((bounds[0] + bounds[2]) / 2) : replayAction.x;
    const y = bounds ? Math.round((bounds[1] + bounds[3]) / 2) : replayAction.y;
    const operation = startDeviceOperation(scanDir, contextId, { kind: actionCategory === 'verification' ? 'VERIFICATION_REPLAY_ACTION' : 'RESTORE_REPLAY_ACTION', owner: operationOwner, idempotency: 'SAFE_RETRY_AFTER_OBSERVATION' }); recordDeviceAction(scanDir, contextId, actionCategory); let deviceResult;
    try { deviceResult = bridge('action', { device: scan.target.deviceId, actionType: replayAction.type, x, y, fromX: replayAction.fromX, fromY: replayAction.fromY, toX: replayAction.toX, toY: replayAction.toY, value: replayAction.value, key: replayAction.key, durationMs: replayAction.durationMs }); }
    catch (error) { finishDeviceOperation(scanDir, operation, 'UNKNOWN_OUTCOME', { reasonCode: error.code || 'RESTORE_ACTION_FAILED' }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error; }
    result.actionsReplayed += 1;
    const afterObservationId = observe(scanDir, contextId, 'RESTORE_ACTION');
    const comparison = compareState(scanDir, graph, edge.toReachableStateId, afterObservationId);
    result.steps.push({ edgeId: edge.id, beforeObservationId: currentObservationId, afterObservationId, action: replayAction, deviceResult, verificationStatus: comparison });
    save(); finishDeviceOperation(scanDir, operation, 'SUCCEEDED', { evidenceRef: `evidence/restores/${result.restoreId}.json` });
    if (comparison !== 'EXACT') return requestReview('AFTER_EDGE', edge.toReachableStateId, afterObservationId, comparison, edgeIndex, edge.id);
    return replayFrom(edgeIndex + 1, afterObservationId, edge.toReachableStateId);
  };

  const continueFromCheckpoint = (checkpoint, observationId, equivalenceAssessment = null) => {
    const comparison = compareState(scanDir, graph, checkpoint.expectedReachableStateId, observationId);
    if (comparison !== 'EXACT') {
      if (!equivalenceAssessment) return requestReview(checkpoint.stage, checkpoint.expectedReachableStateId, observationId, comparison, checkpoint.edgeIndex, checkpoint.edgeId);
      const accepted = validateEquivalence(scanDir, graph, checkpoint, observationId, comparison, equivalenceAssessment);
      result.equivalenceReviews ||= [];
      result.equivalenceReviews.push(accepted);
      event(scanDir, 'restoreEquivalentStateAccepted', { contextId, restoreId: result.restoreId, ...accepted });
    }
    result.status = 'IN_PROGRESS';
    result.mismatch = null;
    result.checkpoint = null;
    result.finishedAt = null;
    save();
    if (checkpoint.stage === 'ROOT') return finish(observationId);
    if (checkpoint.stage === 'BEFORE_EDGE') return replayFrom(checkpoint.edgeIndex, observationId, checkpoint.expectedReachableStateId);
    if (checkpoint.stage === 'AFTER_EDGE') return replayFrom(checkpoint.edgeIndex + 1, observationId, checkpoint.expectedReachableStateId);
    fail(`Unsupported restore checkpoint stage: ${checkpoint.stage}`, 'RESTORE_CHECKPOINT_INVALID');
  };

  if (command === 'resume') {
    const checkpoint = deriveCheckpoint(result, edges);
    const observationId = required(args, 'observationId');
    const assessment = args.equivalenceAssessment ? jsonArg(args.equivalenceAssessment, null, 'equivalenceAssessment JSON') : null;
    event(scanDir, 'restoreResumed', { contextId, restoreId: result.restoreId, checkpoint, observationId, equivalenceRequested: Boolean(assessment) });
    return continueFromCheckpoint(checkpoint, observationId, assessment);
  }

  assertCapacity(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), metrics(), 'coldStarts');
  const coldStartOperation = startDeviceOperation(scanDir, contextId, { kind: actionCategory === 'verification' ? 'VERIFICATION_COLD_START' : 'RESTORE_COLD_START', owner: operationOwner, idempotency: 'SAFE_RETRY_AFTER_OBSERVATION' }); recordColdStart(scanDir, contextId); let restart;
  try { restart = bridge('restart', { device: scan.target.deviceId, bundleName: scan.target.bundleName, entryAbility: scan.target.entryAbility, settleMs: args.settleMs || process.env.SMAP_RESTART_SETTLE_MS || 1200 }); }
  catch (error) { finishDeviceOperation(scanDir, coldStartOperation, 'UNKNOWN_OUTCOME', { reasonCode: error.code || 'RESTORE_COLD_START_FAILED' }); error.code = 'OPERATION_OUTCOME_UNKNOWN'; throw error; }
  if (restart.coldStartVerified !== true) fail('Restore cold start could not verify target App foreground', 'COLD_START_UNVERIFIED');
  const rootObservationId = observe(scanDir, contextId, 'RESTORE_COLD_START'); finishDeviceOperation(scanDir, coldStartOperation, 'SUCCEEDED', { evidenceRef: `evidence/observations/${rootObservationId}/observation.json` });
  if (!edges.length) {
    const comparison = compareState(scanDir, graph, targetStateId, rootObservationId);
    if (comparison !== 'EXACT') return requestReview('ROOT', targetStateId, rootObservationId, comparison);
    return finish(rootObservationId);
  }
  return replayFrom(0, rootObservationId);
});
