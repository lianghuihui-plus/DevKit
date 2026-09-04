'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { readJson, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { invokeAppRestart, resolveTargetBinding } = require('../platform/device-port');
const { commitRecoveryGeneration } = require('../session/warm-session-store');
const sceneService = require('./scene-service');
const store = require('./store');
const actionTransactions = require('./transaction-manager');

function commitGeneration(execDir, execution, nextGeneration, now) {
  const runtime = readJson(path.join(execDir, 'runtime.json'), null);
  commitRecoveryGeneration({ sessionRef: runtime?.sessionRef, batchId: execution.batchId, nextGeneration, now });
  if (execution.warmSessionGeneration === nextGeneration) return execution;
  if (execution.warmSessionGeneration !== nextGeneration - 1) {
    throw contractError('RECOVERY_GENERATION_MISMATCH', 'execution warm session generation is inconsistent with recovery');
  }
  return store.updateExecution(execDir, {
    ...execution,
    warmSessionGeneration: nextGeneration,
    executionRecoveryCount: (execution.executionRecoveryCount || 0) + 1,
    batchRecoveryCountAtEnd: (execution.batchRecoveryCountAtEnd || 0) + 1,
  });
}

function recoverPendingTransactions(execDir, options = {}) {
  const target = store.paths(execDir);
  if (!fs.existsSync(target.transactions)) return [];
  const recovered = [];
  for (const name of fs.readdirSync(target.transactions).filter((item) => item.endsWith('.draft.json')).sort()) {
    const file = path.join(target.transactions, name);
    const draft = readJson(file, null);
    if (name === 'recovery.draft.json' && draft?.reason) {
      const response = recover(execDir, { reason: draft.reason }, { ...options, interruptAfter: undefined });
      recovered.push({
        kind: 'recovery',
        operationId: draft.operationId,
        status: response.recovery?.status || 'RECOVERED',
        response,
      });
      continue;
    }
    if (!draft || draft.operationId?.startsWith('action-') !== true) continue;
    if (draft.status === 'PREPARED') {
      fs.unlinkSync(file);
      recovered.push({ kind: 'action', operationId: draft.operationId, status: 'NOT_SENT' });
      continue;
    }
    if (['DISPATCHED', 'RESULT_RECORDED'].includes(draft.status)) {
      const unknown = draft.status === 'DISPATCHED';
      let technicalFact = store.events(execDir).find((event) => event.type === 'actionOutcomeUnknown' && event.operationId === draft.operationId) || null;
      if (unknown && !technicalFact) {
        technicalFact = store.appendEvent(execDir, 'actionOutcomeUnknown', {
          operationId: draft.operationId,
          sceneId: draft.sceneId,
          action: draft.action,
          code: 'ACTION_OUTCOME_UNKNOWN_AFTER_INTERRUPTION',
          message: 'action dispatch completed without a recorded device result',
          decisionId: draft.decisionId || null,
        }, options);
      }
      if (!unknown && !store.events(execDir).some((event) => event.type === 'actionCompleted' && event.operationId === draft.operationId)) {
        store.appendEvent(execDir, 'actionCompleted', {
          operationId: draft.operationId,
          sceneId: draft.sceneId,
          action: draft.action,
          ok: draft.deviceResult?.ok !== false,
          result: draft.deviceResult,
          coordinateAudit: draft.coordinateAudit || null,
        }, options);
      }
      const observed = sceneService.observe(execDir, {
        ...options,
        purpose: unknown ? 'AFTER_UNKNOWN_ACTION' : 'POST_ACTION',
        relatedOperationId: draft.operationId,
        preAdapterDelayMs: unknown || draft.action?.type === 'wait' ? 0 : 500,
        previousAction: {
          operationId: draft.operationId,
          status: unknown ? 'UNKNOWN' : draft.deviceResult?.ok === false ? 'FAILED' : 'SUCCEEDED',
          action: draft.action,
          ...(draft.deviceResult ? { result: draft.deviceResult } : {}),
        },
      });
      const observedDraft = actionTransactions.transitionAction(execDir, draft, draft.status, 'OBSERVED', {
        outcome: unknown ? 'UNKNOWN' : draft.deviceResult?.ok === false ? 'FAILED' : 'SUCCEEDED',
        sceneIdAfter: observed.scene.sceneId,
      });
      actionTransactions.completeAction(execDir, observedDraft, { recoveredAfterInterruption: true });
      const response = unknown
        ? { ...observed, action: { operationId: draft.operationId, status: 'UNKNOWN', technicalFactRef: technicalFact.technicalFactRef } }
        : observed;
      recovered.push({ kind: 'action', operationId: draft.operationId, status: unknown ? 'OUTCOME_UNKNOWN' : 'OBSERVED', response });
      continue;
    }
    if (draft.status === 'OBSERVED') {
      actionTransactions.completeAction(execDir, draft, { recoveredAfterInterruption: true });
      recovered.push({ kind: 'action', operationId: draft.operationId, status: 'COMPLETED' });
    }
  }
  return recovered;
}

function recover(execDir, request, options = {}) {
  const execution = store.loadExecution(execDir, { allowFinalized: options.allowFinalized === true });
  const target = store.paths(execDir);
  fs.mkdirSync(target.transactions, { recursive: true });
  fs.mkdirSync(target.operations, { recursive: true });
  const file = path.join(target.transactions, 'recovery.draft.json');
  const now = options.now || new Date().toISOString();
  let draft = readJson(file, null);
  if (!draft) {
    draft = {
      schemaVersion: 1,
      operationId: store.nextId(execDir, 'recovery'),
      status: 'PREPARED',
      reason: request.reason,
      decisionId: request.decisionId || null,
      generationBefore: execution.warmSessionGeneration,
      generationAfter: execution.warmSessionGeneration + 1,
      createdAt: now,
    };
    writeJsonAtomic(file, draft);
  }
  if (draft.reason !== request.reason
    || ![draft.generationBefore, draft.generationAfter].includes(execution.warmSessionGeneration)) {
    throw contractError('RECOVERY_ALREADY_PENDING', 'a different App recovery is already pending');
  }
  if (draft.status === 'PREPARED') {
    draft.status = 'DISPATCHED';
    writeJsonAtomic(file, draft);
    const restart = options.restartApp || (() => invokeAppRestart(resolveTargetBinding(execDir, execution), options));
    const adapterStartedAt = Date.now();
    let result;
    try {
      result = restart({ requestId: draft.operationId, scope: 'case-runtime', binding: execution.targetBinding });
    } finally {
      if (typeof options.onAdapterSpan === 'function') {
        options.onAdapterSpan({ name: 'adapter', kind: 'ACTION', action: 'restartApp', durationMs: Date.now() - adapterStartedAt });
      }
    }
    draft = { ...draft, status: 'RESULT_RECORDED', result, recordedAt: now };
    writeJsonAtomic(file, draft);
  }
  if (options.interruptAfter === 'device-result') throw new Error('MAVT_CASE_RECOVERY_INTERRUPTED: device-result');
  if (draft.status === 'DISPATCHED') {
    let technicalFact = store.events(execDir).find((event) => event.type === 'recoveryOutcomeUnknown' && event.operationId === draft.operationId) || null;
    if (!technicalFact) {
      technicalFact = store.appendEvent(execDir, 'recoveryOutcomeUnknown', {
        operationId: draft.operationId,
        reason: draft.reason,
        decisionId: draft.decisionId || null,
      }, { now, allowFinalized: options.allowFinalized === true });
    }
    const observed = sceneService.observe(execDir, {
      ...options,
      purpose: 'AFTER_UNKNOWN_RECOVERY',
      relatedOperationId: draft.operationId,
      decisionId: draft.decisionId || null,
    });
    draft = { ...draft, status: 'OBSERVED', outcome: 'UNKNOWN', sceneIdAfter: observed.scene.sceneId };
    writeJsonAtomic(file, draft);
    writeJsonAtomic(path.join(target.operations, `${draft.operationId}.json`), { ...draft, status: 'COMPLETED' });
    fs.unlinkSync(file);
    return { ...observed, recovery: { operationId: draft.operationId, status: 'UNKNOWN', technicalFactRef: technicalFact.technicalFactRef } };
  }
  if (draft.status === 'OBSERVED') {
    writeJsonAtomic(path.join(target.operations, `${draft.operationId}.json`), { ...draft, status: 'COMPLETED' });
    fs.unlinkSync(file);
    return {
      status: 'SCENE',
      scene: store.readCurrentScene(execDir),
      recovery: { operationId: draft.operationId, status: draft.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'SUCCEEDED', generation: execution.warmSessionGeneration },
    };
  }
  if (draft.status === 'RESULT_RECORDED' && (draft.result?.ok !== true || draft.result?.coldStartVerified !== true || draft.result?.startupDisplayVerified !== true)) {
    const error = contractError('APP_RECOVERY_FAILED', draft.result?.reason || 'App restart was not verified');
    writeJsonAtomic(path.join(target.operations, `${draft.operationId}.json`), { ...draft, status: 'FAILED' });
    if (!store.events(execDir).some((event) => event.type === 'recoveryFailed' && event.operationId === draft.operationId)) {
      store.appendEvent(execDir, 'recoveryFailed', {
        operationId: draft.operationId,
        reason: draft.reason,
        code: error.code,
        message: error.message,
        decisionId: draft.decisionId || null,
      }, { now, allowFinalized: options.allowFinalized === true });
    }
    fs.unlinkSync(file);
    throw error;
  }
  const updated = commitGeneration(execDir, execution, draft.generationAfter, now);
  if (options.interruptAfter === 'generation') throw new Error('MAVT_CASE_RECOVERY_INTERRUPTED: generation');
  if (!store.events(execDir).some((event) => event.type === 'appRecovered' && event.operationId === draft.operationId)) {
    store.appendEvent(execDir, 'appRecovered', {
      operationId: draft.operationId,
      reason: draft.reason,
      decisionId: draft.decisionId || null,
      generationBefore: draft.generationBefore,
      generationAfter: draft.generationAfter,
    }, { now, allowFinalized: options.allowFinalized === true });
  }
  const observed = sceneService.observe(execDir, {
    ...options,
    purpose: 'POST_RECOVERY',
    relatedOperationId: draft.operationId,
    previousAction: { operationId: draft.operationId, status: 'SUCCEEDED', action: { type: 'restartApp' } },
    decisionId: draft.decisionId || null,
  });
  draft = { ...draft, status: 'OBSERVED', sceneIdAfter: observed.scene.sceneId };
  writeJsonAtomic(file, draft);
  writeJsonAtomic(path.join(target.operations, `${draft.operationId}.json`), { ...draft, status: 'COMPLETED' });
  fs.unlinkSync(file);
  return { ...observed, recovery: { operationId: draft.operationId, status: 'SUCCEEDED', generation: updated.warmSessionGeneration } };
}

module.exports = { commitGeneration, recover, recoverPendingTransactions };
