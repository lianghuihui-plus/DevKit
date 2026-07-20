#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { parseArgs, required, resolveScanDir, loadScan, loadGraph, readJson, now, commitEvent, output, main, fail, contextDir } = require('./lib/common');
const { runContextId } = require('./lib/run-protocol');
const { loadVerificationQueue, queueUpsertOp, startVerificationExecution, abandonVerificationExecution, writeVerificationEvidence } = require('./lib/verification-store');
const { projectedCursor, loadCursor, currentMutationSeq } = require('./lib/live-cursor');
const { updateCanonicalPaths } = require('./lib/graph-store');
const { restoreChainVerified } = require('./lib/verification-result');

function runRestore(scanDir, contextId, task, executionId) {
  return spawnSync(process.execPath, [path.join(__dirname, 'restore-node.js'), '--scan-dir', scanDir, '--context', contextId, '--reachable-state-id', task.terminalReachableStateId, '--edge-ids', JSON.stringify(task.edgeIds), '--transition-fingerprints', JSON.stringify(task.transitionFingerprints), '--verification-execution-id', executionId, '--action-category', 'verification'], { encoding: 'utf8' });
}

function childError(child) {
  for (const text of [child.stderr, child.stdout]) {
    try {
      const parsed = JSON.parse(text || '{}');
      if (parsed.error) return parsed.error;
    } catch {}
  }
  return null;
}

function childRestoreResult(child) {
  try { return JSON.parse(child.stdout || '{}').restoreResult || null; } catch { return null; }
}

function findRestoreByVerificationExecution(scanDir, executionId) {
  const dir = path.join(scanDir, 'evidence', 'restores');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => readJson(path.join(dir, name)))
    .filter(item => item.verificationExecutionId === executionId)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null;
}

main(() => {
  const args = parseArgs(); const command = args._[0] || 'run'; const { scanDir } = resolveScanDir(required(args, 'scanDir')); const scan = loadScan(scanDir, { mutable: command === 'run' }); const contextId = args.context || runContextId(scan);
  if (command === 'list') return output(loadVerificationQueue(scanDir, contextId));
  if (command !== 'run') fail(`Unknown verify-path command: ${command}`, 'COMMAND_INVALID');
  if (scan.status !== 'SCANNING') fail('Path verification requires SCANNING', 'RUN_STATE_INVALID'); const verificationId = required(args, 'verificationId');
  const started = startVerificationExecution(scanDir, contextId, verificationId); const task = started.task; const execution = started.execution; const child = runRestore(scanDir, contextId, task, execution.executionId); let restored = childRestoreResult(child) || findRestoreByVerificationExecution(scanDir, execution.executionId);
  const restoreError = child.status === 0 ? null : childError(child); const currentScan = loadScan(scanDir);
  if (restoreError?.code === 'OPERATION_OUTCOME_UNKNOWN' || currentScan.status === 'PAUSED') {
    abandonVerificationExecution(scanDir, contextId, verificationId, execution.executionId, restoreError?.code || currentScan.reasonCode || 'RUN_PAUSED_DURING_VERIFICATION');
    fail('Verification replay paused because a device operation outcome is unknown', restoreError?.code || 'RUN_PAUSED_DURING_VERIFICATION');
  }
  const graph = loadGraph(scanDir, contextId); const chainCurrent = task.edgeIds.every((edgeId, index) => graph.edges.find(item => item.id === edgeId)?.verification?.transitionFingerprint === task.transitionFingerprints[index]);
  const verified = child.status === 0 && restoreChainVerified(task, restored) && chainCurrent; const reasonCode = verified ? null : !chainCurrent ? 'VERIFICATION_SUPERSEDED' : child.status === 0 ? 'VERIFICATION_CHAIN_MISMATCH' : 'COLD_REPLAY_FAILED';
  const evidence = { schemaVersion: 2, verificationId, executionId: execution.executionId, taskKey: task.taskKey, contextId, reason: task.reason, terminalReachableStateId: task.terminalReachableStateId, edgeIds: task.edgeIds, transitionFingerprints: task.transitionFingerprints, startedAt: execution.startedAt, finishedAt: now(), restoreId: restored?.restoreId || null, terminalObservationId: restored?.terminalObservationId || null, status: verified ? 'SUCCEEDED' : 'FAILED', reasonCode };
  const evidenceRef = writeVerificationEvidence(scanDir, verificationId, execution.executionId, evidence); execution.status = evidence.status; execution.restoreId = evidence.restoreId; execution.evidenceRef = evidenceRef; execution.reasonCode = reasonCode; execution.finishedAt = evidence.finishedAt; execution.leaseOwner = null; execution.leaseExpiresAt = null; task.status = evidence.status; task.activeExecutionId = null; task.finishedAt = evidence.finishedAt; task.evidenceRef = evidenceRef; task.reasonCode = reasonCode;
  const edgeOps = [];
  for (let i = 0; i < task.edgeIds.length; i += 1) {
    const edge = graph.edges.find(item => item.id === task.edgeIds[i]); if (!edge?.verification || edge.verification.transitionFingerprint !== task.transitionFingerprints[i]) continue;
    edge.verification.replayStatus = verified ? 'COLD_REPLAY_VERIFIED' : 'REPLAY_UNSTABLE'; edge.verification.verificationRefs ||= []; if (!edge.verification.verificationRefs.includes(evidenceRef)) edge.verification.verificationRefs.push(evidenceRef); edgeOps.push({ path: `contexts/${contextId}/graph.json`, op: 'UPSERT', collection: 'edges', keyFields: ['id'], value: edge, recompute: 'GRAPH' });
  }
  updateCanonicalPaths(graph); const ops = [queueUpsertOp(contextId, task), ...edgeOps];
  if (verified) ops.push({ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: projectedCursor(scanDir, contextId, { reachableStateId: task.terminalReachableStateId, observationId: evidence.terminalObservationId, status: 'EXACT', establishedBy: 'PATH_VERIFICATION', incrementEpoch: true }) });
  else {
    const current = loadCursor(scanDir, contextId); ops.push({ path: `contexts/${contextId}/live-cursor.json`, op: 'REPLACE', value: { ...current, reachableStateId: null, observationId: null, status: 'UNKNOWN', epoch: Number(current.epoch || 0) + 1, mutationSeq: currentMutationSeq(scanDir, contextId), updatedAt: now(), invalidatedReason: reasonCode } });
    const metricsFile = path.join(contextDir(scanDir, contextId), 'metrics.json'); const metrics = readJson(metricsFile, {}); metrics.cursorInvalidations = Number(metrics.cursorInvalidations || 0) + 1; ops.push({ path: `contexts/${contextId}/metrics.json`, op: 'REPLACE', value: metrics });
  }
  commitEvent(scanDir, verified ? 'verificationExecutionSucceeded' : 'verificationExecutionFailed', { contextId, verificationId, executionId: execution.executionId, verification: task, execution, evidence, replayStatus: verified ? 'COLD_REPLAY_VERIFIED' : 'REPLAY_UNSTABLE' }, ops);
  if (!verified) fail('Cold replay verification failed', 'PATH_VERIFICATION_FAILED'); output({ schemaVersion: 1, ok: true, verification: task, execution, evidence });
});
