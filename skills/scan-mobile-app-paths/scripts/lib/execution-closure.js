'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, fail } = require('./common');
const { runContextIds } = require('./run-protocol');
const { loadVerificationQueue } = require('./verification-store');

function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => path.join(dir, name));
}

function evidenceFile(scanDir, relative) {
  if (!relative || path.isAbsolute(relative)) fail('Evidence reference must be relative', 'EVIDENCE_REFERENCE_INVALID');
  const file = path.resolve(scanDir, relative); const rel = path.relative(scanDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('Evidence reference escapes Run', 'EVIDENCE_REFERENCE_INVALID');
  return file;
}

function validateProjectionWatermark(scanDir) {
  const head = readJson(path.join(scanDir, 'event-head.json')); const state = readJson(path.join(scanDir, 'projection-state.json'));
  if (Number(state.lastAppliedEventSeq) !== Number(head.lastEventSeq) || Number(state.timelineOffset) !== Number(head.timelineOffset)) fail('Projection watermark is behind the event head', 'PROJECTION_NOT_CAUGHT_UP');
  const timelineSize = fs.statSync(path.join(scanDir, 'timeline.jsonl')).size;
  if (Number(head.timelineOffset) !== timelineSize) fail('Event head is behind timeline.jsonl', 'EVENT_HEAD_NOT_CAUGHT_UP');
  return { lastEventSeq: head.lastEventSeq, timelineOffset: head.timelineOffset };
}

function validateExecutionClosure(scanDir, scan, requestedStatus) {
  const summary = { projection: null, operations: 0, navigationExecutions: 0, verificationTasks: 0, verificationExecutions: 0 };
  if (Number(scan.eventProtocolVersion || 1) >= 2 && Number(scan.projectionProtocolVersion || 1) >= 2) summary.projection = validateProjectionWatermark(scanDir);

  if (Number(scan.eventProtocolVersion || 1) >= 2) for (const file of jsonFiles(path.join(scanDir, 'operations'))) {
    const operation = readJson(file); summary.operations += 1;
    if (!operation.operationId || path.basename(file, '.json') !== operation.operationId || !['STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME', 'RESOLVED_NO_EFFECT', 'RESOLVED_EFFECT'].includes(operation.status)) fail('Device operation identity or status is invalid', 'DEVICE_OPERATION_INVALID');
    if (['STARTED', 'UNKNOWN_OUTCOME'].includes(operation.status)) fail(`Device operation ${operation.operationId} has unresolved outcome`, 'DEVICE_OPERATION_UNRESOLVED');
    if (['SUCCEEDED', 'FAILED', 'RESOLVED_NO_EFFECT', 'RESOLVED_EFFECT'].includes(operation.status) && operation.evidenceRef && !fs.existsSync(evidenceFile(scanDir, operation.evidenceRef))) fail(`Device operation ${operation.operationId} evidence is missing`, 'DEVICE_OPERATION_INVALID');
  }

  if (Number(scan.navigationProtocolVersion || 1) >= 2) for (const file of jsonFiles(path.join(scanDir, 'evidence', 'navigations'))) {
    const execution = readJson(file); summary.navigationExecutions += 1;
    if (['PLANNED', 'IN_PROGRESS'].includes(execution.status)) fail(`Navigation execution ${execution.navigationExecutionId} is unfinished`, 'NAVIGATION_EXECUTION_UNFINISHED');
    if (!execution.navigationExecutionId || path.basename(file, '.json') !== execution.navigationExecutionId || !execution.navigationPlanId || !execution.planFingerprint) fail('Navigation execution identity is invalid', 'NAVIGATION_EXECUTION_INVALID');
  }

  if (Number(scan.verificationProtocolVersion || 1) >= 2) {
    const executionIds = new Set();
    for (const contextId of runContextIds(scan)) for (const task of loadVerificationQueue(scanDir, contextId).items) {
      summary.verificationTasks += 1;
      const taskExecutionIds = (task.executions || []).map(item => item.executionId); if (JSON.stringify(task.executionIds || []) !== JSON.stringify(taskExecutionIds) || task.status === 'RUNNING' && !task.activeExecutionId || task.status !== 'RUNNING' && task.activeExecutionId) fail(`Verification task ${task.verificationId} execution index is inconsistent`, 'VERIFICATION_EXECUTION_INVALID');
      if (task.status === 'RUNNING' || requestedStatus === 'COMPLETED' && ['PENDING', 'FAILED'].includes(task.status)) fail(`Verification ${task.verificationId} is not closed for ${requestedStatus}`, 'VERIFICATION_UNFINISHED');
      for (const execution of task.executions || []) {
        summary.verificationExecutions += 1;
        if (!execution.executionId || executionIds.has(execution.executionId)) fail('Verification executionId must be globally unique in a Run', 'VERIFICATION_EXECUTION_INVALID');
        executionIds.add(execution.executionId);
        if (['RESTORING', 'AWAITING_VISUAL_ASSESSMENT'].includes(execution.status)) fail(`Verification execution ${execution.executionId} is unfinished`, 'VERIFICATION_EXECUTION_UNFINISHED');
        if (['SUCCEEDED', 'FAILED'].includes(execution.status)) {
          const file = evidenceFile(scanDir, execution.evidenceRef); const evidence = readJson(file);
          if (evidence.executionId !== execution.executionId || evidence.verificationId !== task.verificationId || evidence.status !== execution.status) fail(`Verification evidence is inconsistent for ${execution.executionId}`, 'VERIFICATION_EVIDENCE_INVALID');
        }
      }
    }
  }
  return summary;
}

module.exports = { validateProjectionWatermark, validateExecutionClosure };
