'use strict';

const fs = require('fs');
const path = require('path');
const { contextDir, readJson, writeJsonAtomic, hashObject, now, nextIdLocked, commitEventLocked, withRunLock } = require('./common');
const { replayable } = require('./navigation-planner');

const MAX_VERIFICATION_ATTEMPTS = 2;

function queueFile(scanDir, contextId) { return path.join(contextDir(scanDir, contextId), 'verification-queue.json'); }
function loadVerificationQueue(scanDir, contextId) {
  const queue = readJson(queueFile(scanDir, contextId), { schemaVersion: 2, contextId, items: [] }); queue.schemaVersion = 2;
  for (const item of queue.items) {
    if (item.status === 'COMPLETED') item.status = 'SUCCEEDED'; item.executionIds ||= []; item.executions ||= [];
  }
  return queue;
}
function queueUpsertOp(contextId, item) { return { path: `contexts/${contextId}/verification-queue.json`, op: 'UPSERT', collection: 'items', keyFields: ['verificationId'], value: item, fallback: { schemaVersion: 2, contextId, items: [] } }; }
function verificationEvidenceDir(scanDir, verificationId) { return path.join(scanDir, 'evidence', 'verifications', verificationId); }
function verificationEvidenceRef(verificationId, executionId) { return `evidence/verifications/${verificationId}/${executionId}.json`; }

function canonicalScreenPaths(graph) {
  const states = new Map(graph.reachableStates.map(state => [state.id, state])); const visuals = new Map(graph.visualStates.map(visual => [visual.id, visual])); const edges = new Map(graph.edges.map(edge => [edge.id, edge])); const candidates = [];
  for (const pathItem of graph.paths || []) {
    if (!(pathItem.edgeIds || []).length) continue;
    const state = states.get(pathItem.terminalReachableStateId); const visual = state && visuals.get(state.visualStateId); if (!visual) continue;
    const pathEdges = (pathItem.edgeIds || []).map(id => edges.get(id)); if (pathEdges.some(edge => !edge || !replayable(edge) || edge.sideEffect && edge.sideEffect !== 'NONE')) continue;
    const transitionFingerprints = pathEdges.map(edge => edge.verification?.transitionFingerprint || hashObject({ edgeId: edge.id, action: edge.action }));
    candidates.push({ logicalScreenKey: visual.logicalScreenKey, terminalReachableStateId: state.id, edgeIds: pathItem.edgeIds || [], transitionFingerprints, coordinateEdges: pathEdges.filter(edge => edge.locatorResolution !== 'SEMANTIC_VERIFIED').length });
  }
  const selected = new Map();
  for (const item of candidates.sort((a, b) => a.coordinateEdges - b.coordinateEdges || a.edgeIds.length - b.edgeIds.length || a.edgeIds.join(',').localeCompare(b.edgeIds.join(',')))) if (!selected.has(item.logicalScreenKey)) selected.set(item.logicalScreenKey, item);
  return [...selected.values()];
}

function reconcileVerificationQueue(scanDir, scan, contextId, graph, { persist = false } = {}) {
  const queue = loadVerificationQueue(scanDir, contextId); if (scan.scanMode !== 'exploration') return { queue, scheduled: [], superseded: [] };
  const scheduled = []; const superseded = [];
  for (const canonical of canonicalScreenPaths(graph)) {
    const taskKey = hashObject({ contextId, logicalScreenKey: canonical.logicalScreenKey, transitionFingerprintChain: canonical.transitionFingerprints });
    for (const old of queue.items.filter(item => item.logicalScreenKey === canonical.logicalScreenKey && item.taskKey !== taskKey && ['PENDING', 'RUNNING', 'FAILED'].includes(item.status))) { old.status = 'SUPERSEDED'; old.supersededAt = now(); old.supersededByTaskKey = taskKey; superseded.push(old); }
    if (queue.items.some(item => item.taskKey === taskKey)) continue;
    const verificationId = `verify-${taskKey.slice(-16)}`; const item = { schemaVersion: 2, verificationId, taskKey, contextId, logicalScreenKey: canonical.logicalScreenKey, terminalReachableStateId: canonical.terminalReachableStateId, edgeIds: canonical.edgeIds, transitionFingerprints: canonical.transitionFingerprints, reason: 'CANONICAL_SCREEN_PATH', status: 'PENDING', attemptCount: 0, activeExecutionId: null, executionIds: [], executions: [], createdAt: now() }; queue.items.push(item); scheduled.push(item);
  }
  queue.items.sort((a, b) => a.verificationId.localeCompare(b.verificationId)); if (persist) writeJsonAtomic(queueFile(scanDir, contextId), queue); return { queue, scheduled, superseded };
}

function targetVerificationProjection(scanDir, contextId, input) {
  const queue = loadVerificationQueue(scanDir, contextId); const taskKey = hashObject({ contextId, reason: 'CONFIRMED_TARGET_PATH', decisionId: input.decisionId, transitionFingerprintChain: input.transitionFingerprints }); let item = queue.items.find(entry => entry.taskKey === taskKey);
  if (!item) { item = { schemaVersion: 2, verificationId: `verify-${taskKey.slice(-16)}`, taskKey, contextId, logicalScreenKey: input.logicalScreenKey || null, terminalReachableStateId: input.terminalReachableStateId, edgeIds: input.edgeIds, transitionFingerprints: input.transitionFingerprints, reason: 'CONFIRMED_TARGET_PATH', decisionId: input.decisionId, status: 'PENDING', attemptCount: 0, activeExecutionId: null, executionIds: [], executions: [], createdAt: now() }; queue.items.push(item); }
  return { queue, item, created: !loadVerificationQueue(scanDir, contextId).items.some(entry => entry.taskKey === taskKey) };
}

function scheduleTargetVerification(scanDir, contextId, input, { persist = false } = {}) {
  const projection = targetVerificationProjection(scanDir, contextId, input); if (persist) writeJsonAtomic(queueFile(scanDir, contextId), projection.queue); return projection.item;
}

function processAlive(owner) {
  const pid = Number(String(owner || '').replace(/^pid:/, '')); if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function startVerificationExecution(scanDir, contextId, verificationId, { requiresVisualAssessment = false } = {}) {
  return withRunLock(scanDir, () => { const queue = loadVerificationQueue(scanDir, contextId); const task = queue.items.find(item => item.verificationId === verificationId);
    if (!task || !['PENDING', 'FAILED'].includes(task.status)) { const error = new Error('Verification task is not runnable'); error.code = 'VERIFICATION_STATE_INVALID'; throw error; }
    if (Number(task.attemptCount || 0) >= MAX_VERIFICATION_ATTEMPTS) { const error = new Error('Verification retry limit reached'); error.code = 'VERIFICATION_RETRY_LIMIT'; throw error; }
    const executionId = nextIdLocked(scanDir, 'verificationExecution', 'vexec'); const startedAt = now(); const execution = { schemaVersion: 1, executionId, verificationId, attemptNo: Number(task.attemptCount || 0) + 1, status: 'RESTORING', requiresVisualAssessment, leaseOwner: `pid:${process.pid}`, leaseExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), restoreId: null, evidenceRef: null, startedAt, finishedAt: null, reasonCode: null };
    task.status = 'RUNNING'; task.attemptCount = execution.attemptNo; task.activeExecutionId = executionId; task.executionIds.push(executionId); task.executions.push(execution); task.startedAt = startedAt;
    commitEventLocked(scanDir, 'verificationExecutionStarted', { contextId, verificationId, executionId, verification: task, execution }, [queueUpsertOp(contextId, task)]); return { task, execution }; });
}

function finishVerificationExecution(scanDir, contextId, verificationId, executionId, { status, evidenceRef = null, restoreId = null, reasonCode = null, awaitingAssessment = false } = {}) {
  return withRunLock(scanDir, () => { const queue = loadVerificationQueue(scanDir, contextId); const task = queue.items.find(item => item.verificationId === verificationId); const execution = task?.executions?.find(item => item.executionId === executionId);
    if (!task || !execution || task.activeExecutionId !== executionId) { const error = new Error('Verification execution is stale'); error.code = 'VERIFICATION_EXECUTION_STALE'; throw error; }
    if (awaitingAssessment) { execution.status = 'AWAITING_VISUAL_ASSESSMENT'; execution.restoreId = restoreId; execution.evidenceRef = evidenceRef; execution.leaseOwner = null; execution.leaseExpiresAt = null; task.status = 'RUNNING'; }
    else { execution.status = status; execution.restoreId = restoreId; execution.evidenceRef = evidenceRef; execution.reasonCode = reasonCode; execution.finishedAt = now(); execution.leaseOwner = null; execution.leaseExpiresAt = null; task.status = status; task.activeExecutionId = null; task.finishedAt = execution.finishedAt; task.evidenceRef = evidenceRef; }
    commitEventLocked(scanDir, awaitingAssessment ? 'verificationVisualAssessmentRequested' : status === 'SUCCEEDED' ? 'verificationExecutionSucceeded' : 'verificationExecutionFailed', { contextId, verificationId, executionId, verification: task, execution }, [queueUpsertOp(contextId, task)]); return { task, execution }; });
}

function abandonVerificationExecution(scanDir, contextId, verificationId, executionId, reasonCode = 'EXECUTOR_LOST') {
  return withRunLock(scanDir, () => { const queue = loadVerificationQueue(scanDir, contextId); const task = queue.items.find(item => item.verificationId === verificationId); const execution = task?.executions?.find(item => item.executionId === executionId);
    if (!task || !execution || task.activeExecutionId !== executionId) { const error = new Error('Verification execution is stale'); error.code = 'VERIFICATION_EXECUTION_STALE'; throw error; }
    execution.status = 'ABANDONED'; execution.finishedAt = now(); execution.reasonCode = reasonCode; execution.leaseOwner = null; execution.leaseExpiresAt = null;
    task.activeExecutionId = null; task.status = Number(task.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS ? 'PENDING' : 'FAILED'; task.reasonCode = reasonCode;
    commitEventLocked(scanDir, 'verificationExecutionAbandoned', { contextId, verificationId, executionId, verification: task, execution, reasonCode }, [queueUpsertOp(contextId, task)]); return { task, execution }; });
}

function recoverVerificationExecutions(scanDir, contextId, { persist = true } = {}) {
  const queue = loadVerificationQueue(scanDir, contextId); const changed = [];
  for (const task of queue.items.filter(item => item.status === 'RUNNING' && item.activeExecutionId)) {
    const execution = task.executions.find(item => item.executionId === task.activeExecutionId); if (!execution || execution.status === 'AWAITING_VISUAL_ASSESSMENT') continue;
    const expired = !processAlive(execution.leaseOwner); if (!expired) continue;
    execution.status = 'ABANDONED'; execution.finishedAt = now(); execution.reasonCode = 'EXECUTOR_LOST'; execution.leaseOwner = null; execution.leaseExpiresAt = null; task.activeExecutionId = null; task.status = Number(task.attemptCount || 0) < MAX_VERIFICATION_ATTEMPTS ? 'PENDING' : 'FAILED'; task.reasonCode = execution.reasonCode; changed.push(task);
  }
  if (persist && changed.length) {
    const scan = readJson(path.join(scanDir, 'scan.json')); const store = require('./event-store'); const ops = changed.map(item => queueUpsertOp(contextId, item)); const appended = store.append(scanDir, { type: 'verificationExecutionsRecovered', at: now(), scanId: scan.scanId, contextId, verificationIds: changed.map(item => item.verificationId), projectionOps: ops }); const appliedOps = appended.record.projectionOps || []; store.applyProjectionOps(scanDir, appliedOps); store.markApplied(scanDir, appended.head, appliedOps);
  }
  return { recovered: changed.length, queue, changed };
}

function writeVerificationEvidence(scanDir, verificationId, executionId, evidence) {
  const dir = verificationEvidenceDir(scanDir, verificationId); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${executionId}.json`); if (fs.existsSync(file)) { const error = new Error(`Verification evidence already exists: ${executionId}`); error.code = 'EVIDENCE_IMMUTABLE'; throw error; } writeJsonAtomic(file, evidence); return verificationEvidenceRef(verificationId, executionId);
}

module.exports = { MAX_VERIFICATION_ATTEMPTS, queueFile, queueUpsertOp, loadVerificationQueue, canonicalScreenPaths, reconcileVerificationQueue, targetVerificationProjection, scheduleTargetVerification, startVerificationExecution, finishVerificationExecution, abandonVerificationExecution, recoverVerificationExecutions, verificationEvidenceDir, verificationEvidenceRef, writeVerificationEvidence };
