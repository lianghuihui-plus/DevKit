#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseArgs, required, resolveScanDir, loadScan, loadGraph, loadFrontier, readJson, contextDir,
  nextId, now, event, commitEvent, output, main, fail, bool, jsonArg, safeSegment
} = require('./lib/common');
const { bridge } = require('./lib/runtime-client');
const { assertCapacity, assertExecutionWindow } = require('./lib/budget');
const { activeContextId } = require('./lib/run-protocol');
const { recordColdStart } = require('./lib/action-metrics');
const { startDeviceOperation, finishDeviceOperation } = require('./lib/operation-journal');
const { matchVisualEquivalence } = require('./lib/visual-equivalence');
const { compareStateEquivalence, isSamePage } = require('./lib/state-equivalence');
const { loadStateEquivalence, recordStateEquivalenceRule, makeStateEquivalenceReview } = require('./lib/state-equivalence-store');
const { loadObservationBundle } = require('./lib/observation-store');
const { assessReplayableAction, executePathStepAction, resolveReplayAction } = require('./lib/path-replay-engine');
const { completeDeviceActionSuccess, completeDeviceActionUnknownOutcome } = require('./lib/device-action-executor');
const { edgeRunnableReason } = require('./lib/replayability');
const { shortestPath } = require('./lib/navigation-planner');

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
  return loadObservationBundle(scanDir, observationId);
}

function compareStateResult(scanDir, graph, contextId, stateId, observationId) {
  const { visual } = stateVisual(graph, stateId);
  return compareStateEquivalence({
    expected: { fingerprint: visual.fingerprint },
    observed: observedFingerprint(scanDir, observationId),
    expectedReachableStateId: stateId,
    expectedVisualStateId: visual.id,
    contextId,
    rules: loadStateEquivalence(scanDir, contextId).rules
  });
}

function compareState(scanDir, graph, contextId, stateId, observationId) {
  return compareStateResult(scanDir, graph, contextId, stateId, observationId).status;
}

function rootState(graph) {
  return graph.reachableStates.find(item => (item.depth?.pathDepth || 0) === 0) || null;
}

function replayPathIsValid(graph, edgeIds, fromId, toId) {
  if (!fromId || !toId || !Array.isArray(edgeIds)) return false;
  const byEdge = new Map(graph.edges.map(edge => [edge.id, edge]));
  let cursor = fromId;
  for (const edgeId of edgeIds) {
    const edge = byEdge.get(edgeId);
    if (!edge || edge.fromReachableStateId !== cursor || edgeRunnableReason(edge)) return false;
    cursor = edge.toReachableStateId;
  }
  return cursor === toId;
}

function restoreEdgeIds(graph, targetState, fixedEdgeIds) {
  if (fixedEdgeIds) return fixedEdgeIds;
  const root = rootState(graph);
  const cached = targetState.runnablePathEdgeIds || targetState.replayPathEdgeIds || [];
  if (replayPathIsValid(graph, cached, root?.id, targetState.id)) return cached;
  return shortestPath(graph, root?.id, targetState.id)?.edgeIds || [];
}

function restoreOp(result) {
  return { path: `evidence/restores/${result.restoreId}.json`, op: 'REPLACE', value: result };
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
  if (!['PROBABLE', 'UNCERTAIN'].includes(comparison)) fail(`Restore equivalence requires a reviewable comparison, observed ${comparison}`, 'RESTORE_EQUIVALENCE_INVALID');
  const { visual } = stateVisual(graph, checkpoint.expectedReachableStateId);
  const observed = observedFingerprint(scanDir, observationId);
  if (assessment?.status !== 'EXPECTED_STATE_EQUIVALENT' || assessment.expectedReachableStateId !== checkpoint.expectedReachableStateId || assessment.observedSha256 !== observed.fingerprint.screenshotSha256 || !String(assessment.rationale || '').trim()) fail('Restore equivalence assessment is missing or not bound to the current evidence', 'RESTORE_EQUIVALENCE_INVALID');
  return { ...makeStateEquivalenceReview({ visual, observed, observationId, comparison, assessment: { ...assessment, expectedReachableStateId: checkpoint.expectedReachableStateId } }), expectedReachableStateId: checkpoint.expectedReachableStateId, restoreId: assessment.restoreId || null, attemptId: assessment.attemptId || null };
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
    commitEvent(scanDir, 'restoreStarted', { contextId, restoreId, reachableStateId: targetId, restoreAttempts: currentMetrics.restoreAttempts }, [restoreOp(result), { path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: currentMetrics }]);
  }

  const operationOwner = args.attemptId ? { type: 'ATTEMPT', id: safeSegment(args.attemptId, 'attemptId') } : { type: 'RESTORE', id: result.restoreId };
  const targetStateId = result.reachableStateId;
  const targetState = graph.reachableStates.find(item => item.id === targetStateId);
  if (!targetState) fail(`Unknown ReachableState: ${targetStateId}`, 'GRAPH_REFERENCE_MISSING');
  const fixedEdgeIds = command === 'start' && args.edgeIds ? jsonArg(args.edgeIds, null, 'edgeIds JSON') : null;
  const fixedFingerprints = command === 'start' && args.transitionFingerprints ? jsonArg(args.transitionFingerprints, null, 'transitionFingerprints JSON') : null;
  if (fixedEdgeIds && (!Array.isArray(fixedEdgeIds) || fixedFingerprints && (!Array.isArray(fixedFingerprints) || fixedFingerprints.length !== fixedEdgeIds.length))) fail('Fixed verification chain is invalid', 'RESTORE_PATH_INVALID');
  const edgeIds = restoreEdgeIds(graph, targetState, fixedEdgeIds);
  const edges = edgeIds.map((edgeId, index) => {
    const edge = graph.edges.find(item => item.id === edgeId);
    if (!edge) fail(`Replay edge missing: ${edgeId}`, 'RESTORE_PATH_INVALID');
    const replayReason = edgeRunnableReason(edge);
    if (replayReason) fail(`Replay edge is not portable: ${edgeId}`, replayReason);
    if (fixedFingerprints && edge.verification?.transitionFingerprint !== fixedFingerprints[index]) fail(`Replay edge fingerprint changed: ${edgeId}`, 'VERIFICATION_SUPERSEDED');
    return edge;
  });
  if (fixedEdgeIds) { result.verificationExecutionId = args.verificationExecutionId || null; result.fixedEdgeIds = [...fixedEdgeIds]; result.fixedTransitionFingerprints = [...(fixedFingerprints || [])]; }

  const save = (eventType = 'restoreUpdated', data = {}) => {
    result.schemaVersion = 2;
    result.updatedAt = now();
    commitEvent(scanDir, eventType, { contextId, restoreId: result.restoreId, ...data }, [restoreOp(result)]);
  };

  const failRestore = (reasonCode, data = {}) => {
    if (['SUCCEEDED', 'FAILED'].includes(result.status)) return result;
    result.status = 'FAILED';
    result.reasonCode = reasonCode;
    if (data.terminalObservationId !== undefined) result.terminalObservationId = data.terminalObservationId;
    if (data.mismatch !== undefined) result.mismatch = data.mismatch;
    if (data.checkpoint !== undefined) result.checkpoint = data.checkpoint;
    result.finishedAt = now();
    save('restoreResult', { status: result.status, reasonCode, terminalObservationId: result.terminalObservationId || null });
    return result;
  };

  const finish = (terminalObservationId) => {
    result.status = 'SUCCEEDED';
    result.terminalObservationId = terminalObservationId;
    result.mismatch = null;
    result.checkpoint = null;
    result.finishedAt = now();
    save('restoreResult', { status: result.status, terminalObservationId });
    output({ schemaVersion: 1, ok: true, restoreResult: result });
  };

  const requestReview = (stage, expectedReachableStateId, observationId, comparison, edgeIndex = 0, edgeId = null) => {
    const checkpoint = { stage, edgeIndex, edgeId, expectedReachableStateId, observationId, comparison };
    const mismatch = { stage, expectedReachableStateId, observationId, comparison, edgeId };
    if (!allowInterruption) {
      failRestore('RESTORE_STATE_MISMATCH', { terminalObservationId: observationId, mismatch, checkpoint });
      fail(`Restore verification mismatch at ${expectedReachableStateId}: ${comparison}`, 'RESTORE_STATE_MISMATCH');
    }
    result.status = 'REVIEW_REQUIRED';
    result.terminalObservationId = observationId;
    result.mismatch = mismatch;
    result.checkpoint = checkpoint;
    result.reviewRequestedAt = now();
    result.finishedAt = null;
    save('restoreReviewRequired', { stage, expectedReachableStateId, observationId, comparison, edgeIndex, edgeId });
    output({ schemaVersion: 1, ok: true, restoreResult: result });
  };

  const acceptCachedEquivalence = (checkpoint, observationId, comparison) => {
    const matched = matchVisualEquivalence(scanDir, contextId, graph, checkpoint.expectedReachableStateId, observationId, comparison);
    if (!matched) return false;
    result.equivalenceReviews ||= [];
    result.equivalenceReviews.push(matched.review);
    save('restoreEquivalentStateAccepted', matched.review);
    return true;
  };

  const replayFrom = (edgeIndex, currentObservationId, reviewedStateId = null) => {
    if (edgeIndex >= edges.length) {
      if (edges.length && edges[edges.length - 1].toReachableStateId !== targetStateId) fail('Replay path does not terminate at target state', 'RESTORE_PATH_INVALID');
      return finish(currentObservationId);
    }
    const edge = edges[edgeIndex];
    if (edgeIndex > 0 && edges[edgeIndex - 1].toReachableStateId !== edge.fromReachableStateId) fail(`Replay path is discontinuous at ${edge.id}`, 'RESTORE_PATH_INVALID');
    const beforeComparison = reviewedStateId === edge.fromReachableStateId ? 'REVIEW_CONFIRMED' : compareState(scanDir, graph, contextId, edge.fromReachableStateId, currentObservationId);
    if (!['REVIEW_CONFIRMED'].includes(beforeComparison) && !isSamePage(beforeComparison)) {
      const checkpoint = { stage: 'BEFORE_EDGE', edgeIndex, edgeId: edge.id, expectedReachableStateId: edge.fromReachableStateId, observationId: currentObservationId, comparison: beforeComparison };
      if (!acceptCachedEquivalence(checkpoint, currentObservationId, beforeComparison)) return requestReview('BEFORE_EDGE', edge.fromReachableStateId, currentObservationId, beforeComparison, edgeIndex, edge.id);
    }

    const replayAction = resolveReplayAction(scanDir, contextId, currentObservationId, edge);
    const safety = assessReplayableAction(replayAction, scan, edge.replayPolicy, 'RESTORE_UNSAFE');
    const currentMetrics = metrics();
    assertExecutionWindow(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), currentMetrics);
    assertCapacity(scan, contextId, loadGraph(scanDir, contextId), loadFrontier(scanDir, contextId), currentMetrics, 'actions', 1);
    const executed = executePathStepAction(scanDir, {
      scan,
      contextId,
      beforeObservationId: currentObservationId,
      action: replayAction,
      safety,
      owner: operationOwner,
      role: actionCategory === 'verification' ? 'VERIFICATION_REPLAY_ACTION' : 'RESTORE_REPLAY_ACTION',
      category: actionCategory,
      locatorResolution: 'SEMANTIC_RESOLVED',
      idempotency: 'SAFE_RETRY_AFTER_OBSERVATION',
      failureReasonCode: actionCategory === 'verification' ? 'VERIFICATION_ACTION_FAILED' : 'RESTORE_ACTION_FAILED',
      syntheticSeed: `${result.restoreId}:${edge.id}`
    });
    result.actionsReplayed += 1;
    let afterObservationId = null;
    let comparison = null;
    try {
      afterObservationId = observe(scanDir, contextId, 'RESTORE_ACTION');
      comparison = compareState(scanDir, graph, contextId, edge.toReachableStateId, afterObservationId);
      result.steps.push({ edgeId: edge.id, beforeObservationId: currentObservationId, afterObservationId, action: executed.actionResult.action, deviceResult: executed.actionResult.deviceResult, verificationStatus: comparison });
      save('restoreStepCompleted', { edgeId: edge.id, afterObservationId, comparison });
      completeDeviceActionSuccess(scanDir, executed.operation, { ...executed.actionResult, afterObservationId, finishedAt: now() }, { eventType: null, evidenceRef: `evidence/restores/${result.restoreId}.json` });
    } catch (error) {
      completeDeviceActionUnknownOutcome(scanDir, executed.operation, { ...executed.actionResult, afterObservationId }, { reasonCode: error.code || 'RESTORE_AFTER_ACTION_EVIDENCE_FAILED', evidenceRef: `evidence/restores/${result.restoreId}.json`, writeEvidence: false });
      error.code = 'OPERATION_OUTCOME_UNKNOWN';
      throw error;
    }
    if (!isSamePage(comparison)) {
      const checkpoint = { stage: 'AFTER_EDGE', edgeIndex, edgeId: edge.id, expectedReachableStateId: edge.toReachableStateId, observationId: afterObservationId, comparison };
      if (!acceptCachedEquivalence(checkpoint, afterObservationId, comparison)) return requestReview('AFTER_EDGE', edge.toReachableStateId, afterObservationId, comparison, edgeIndex, edge.id);
    }
    return replayFrom(edgeIndex + 1, afterObservationId, edge.toReachableStateId);
  };

  const continueFromCheckpoint = (checkpoint, observationId, equivalenceAssessment = null) => {
    const comparison = compareState(scanDir, graph, contextId, checkpoint.expectedReachableStateId, observationId);
    if (!isSamePage(comparison)) {
      if (!equivalenceAssessment) return requestReview(checkpoint.stage, checkpoint.expectedReachableStateId, observationId, comparison, checkpoint.edgeIndex, checkpoint.edgeId);
      const accepted = validateEquivalence(scanDir, graph, checkpoint, observationId, comparison, { ...equivalenceAssessment, restoreId: result.restoreId, attemptId: args.attemptId || null });
      result.equivalenceReviews ||= [];
      result.equivalenceReviews.push(accepted);
      recordStateEquivalenceRule(scanDir, contextId, graph, checkpoint, accepted);
    }
    result.status = 'IN_PROGRESS';
    result.mismatch = null;
    result.checkpoint = null;
    result.finishedAt = null;
    save('restoreCheckpointResolved', { checkpoint, observationId, equivalenceAccepted: Boolean(equivalenceAssessment) });
    if (checkpoint.stage === 'ROOT') return finish(observationId);
    if (checkpoint.stage === 'BEFORE_EDGE') return replayFrom(checkpoint.edgeIndex, observationId, checkpoint.expectedReachableStateId);
    if (checkpoint.stage === 'AFTER_EDGE') return replayFrom(checkpoint.edgeIndex + 1, observationId, checkpoint.expectedReachableStateId);
    fail(`Unsupported restore checkpoint stage: ${checkpoint.stage}`, 'RESTORE_CHECKPOINT_INVALID');
  };

  const executeRestore = () => {
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
      const comparison = compareState(scanDir, graph, contextId, targetStateId, rootObservationId);
      if (!isSamePage(comparison)) {
        const checkpoint = { stage: 'ROOT', edgeIndex: 0, edgeId: null, expectedReachableStateId: targetStateId, observationId: rootObservationId, comparison };
        if (!acceptCachedEquivalence(checkpoint, rootObservationId, comparison)) return requestReview('ROOT', targetStateId, rootObservationId, comparison);
      }
      return finish(rootObservationId);
    }
    return replayFrom(0, rootObservationId);
  };

  try {
    return executeRestore();
  } catch (error) {
    if (error.code !== 'OPERATION_OUTCOME_UNKNOWN' && result?.status === 'IN_PROGRESS') failRestore(error.code || 'RESTORE_FAILED');
    throw error;
  }
});
