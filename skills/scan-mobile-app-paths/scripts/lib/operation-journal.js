'use strict';

const fs = require('fs');
const path = require('path');
const { nextId, now, commitEvent, readJson, transitionWithOps, transitionWithOpsLocked } = require('./common');
const { loadCursor, currentMutationSeq } = require('./live-cursor');

function operationFile(scanDir, operationId) { return path.join(scanDir, 'operations', `${operationId}.json`); }
function operationOp(operation) { return { path: `operations/${operation.operationId}.json`, op: 'REPLACE', value: operation }; }

function startDeviceOperation(scanDir, contextId, input) {
  const operationId = nextId(scanDir, 'operation', 'op'); const operation = { schemaVersion: 1, operationId, contextId, kind: input.kind, owner: input.owner || null, idempotency: input.idempotency || 'UNKNOWN', status: 'STARTED', executor: `pid:${process.pid}`, startedAt: now(), finishedAt: null, evidenceRef: null, reasonCode: null };
  commitEvent(scanDir, 'deviceOperationStarted', { contextId, operation }, [operationOp(operation)]); return operation;
}

function finishDeviceOperation(scanDir, operation, status, { evidenceRef = null, reasonCode = null } = {}) {
  const current = readJson(operationFile(scanDir, operation.operationId), operation); current.status = status; current.evidenceRef = evidenceRef; current.reasonCode = reasonCode; current.finishedAt = now(); current.executor = null; const ops = [operationOp(current)];
  if (status === 'UNKNOWN_OUTCOME') {
    if (current.contextId) { const cursor = loadCursor(scanDir, current.contextId); ops.push({ path: `contexts/${current.contextId}/live-cursor.json`, op: 'REPLACE', value: { ...cursor, reachableStateId: null, observationId: null, status: 'UNKNOWN', epoch: Number(cursor.epoch || 0) + 1, mutationSeq: currentMutationSeq(scanDir, current.contextId), updatedAt: now(), invalidatedReason: 'OPERATION_OUTCOME_UNKNOWN' } }); }
    if (current.owner?.type === 'ATTEMPT' && current.owner.id) { const attemptFile = path.join(scanDir, 'attempts', `${current.owner.id}.json`); if (fs.existsSync(attemptFile)) { const attempt = readJson(attemptFile); attempt.status = 'UNKNOWN_EFFECT'; attempt.reasonCode = 'OPERATION_OUTCOME_UNKNOWN'; attempt.updatedAt = now(); ops.push({ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }); } }
    const scan = readJson(path.join(scanDir, 'scan.json'));
    if (!['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(scan.status) && scan.status !== 'PAUSED') {
      transitionWithOps(scanDir, 'PAUSED', 'OPERATION_OUTCOME_UNKNOWN', 'deviceOperationOutcomeUnknown', { contextId: current.contextId, operation: current }, ops);
      return current;
    }
  }
  commitEvent(scanDir, status === 'SUCCEEDED' ? 'deviceOperationCompleted' : status === 'UNKNOWN_OUTCOME' ? 'deviceOperationOutcomeUnknown' : 'deviceOperationFailed', { contextId: current.contextId, operation: current }, ops); return current;
}

function alive(executor) { const pid = Number(String(executor || '').replace(/^pid:/, '')); if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

function recoverDeviceOperations(scanDir) {
  const dir = path.join(scanDir, 'operations'); if (!fs.existsSync(dir)) return 0; let recovered = 0;
  for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json'))) {
    const operation = readJson(path.join(dir, name)); if (operation.status !== 'STARTED' || alive(operation.executor)) continue;
    operation.status = 'UNKNOWN_OUTCOME'; operation.reasonCode = 'EXECUTOR_LOST_AFTER_DEVICE_OPERATION_STARTED'; operation.finishedAt = now(); operation.executor = null; const ops = [operationOp(operation)];
    if (operation.contextId) { const cursor = loadCursor(scanDir, operation.contextId); ops.push({ path: `contexts/${operation.contextId}/live-cursor.json`, op: 'REPLACE', value: { ...cursor, reachableStateId: null, observationId: null, status: 'UNKNOWN', epoch: Number(cursor.epoch || 0) + 1, mutationSeq: currentMutationSeq(scanDir, operation.contextId), updatedAt: now(), invalidatedReason: 'OPERATION_OUTCOME_UNKNOWN' } }); }
    if (operation.owner?.type === 'ATTEMPT' && operation.owner.id) { const attemptFile = path.join(scanDir, 'attempts', `${operation.owner.id}.json`); if (fs.existsSync(attemptFile)) { const attempt = readJson(attemptFile); attempt.status = 'UNKNOWN_EFFECT'; attempt.reasonCode = 'OPERATION_OUTCOME_UNKNOWN'; attempt.updatedAt = now(); ops.push({ path: `attempts/${attempt.attemptId}.json`, op: 'REPLACE', value: attempt }); } }
    const scan = readJson(path.join(scanDir, 'scan.json'));
    if (!['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(scan.status) && scan.status !== 'PAUSED') transitionWithOpsLocked(scanDir, 'PAUSED', 'OPERATION_OUTCOME_UNKNOWN', 'deviceOperationOutcomeUnknown', { contextId: operation.contextId, operation }, ops);
    else commitEvent(scanDir, 'deviceOperationOutcomeUnknown', { contextId: operation.contextId, operation }, ops);
    recovered += 1;
  }
  return recovered;
}

module.exports = { operationFile, startDeviceOperation, finishDeviceOperation, recoverDeviceOperations };
