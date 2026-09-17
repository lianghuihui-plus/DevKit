'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalJson, contractError } = require('../lib/contract-utils');
const { findActiveExecutions, readJson, readJsonl, withFileLock } = require('../lib/execution-lifecycle');
const { readActiveDispatch } = require('../lib/dispatch-lease');
const { markDegraded } = require('../lib/warm-session-contract');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');
const { RECONCILE_RETRY_LIMIT, classifyReconcileError } = require('./reconcile-policy');
const { loadBatch, readBatchState, saveBatch } = require('./state-repository');
const { caseRuntimeDir, currentCase, protocolBindings, stopBatch } = require('./service-support');
const { commitBusinessTerminal } = require('./finalization-service');

function probeWarmSession(state, contract, adapter, now) {
  const probe = adapter.probeSession({ binding: contract.binding });
  if (probe?.ok === true && canonicalJson(probe.binding) === canonicalJson(contract.binding)) return { state, probe };
  const failureCode = probe?.failureCode || (probe?.ok === true ? 'WARM_SESSION_BINDING_MISMATCH' : 'WARM_SESSION_PROBE_FAILED');
  const reason = probe?.reason || (probe?.ok === true
    ? 'warm App session no longer matches the frozen execution binding'
    : 'warm App session probe failed');
  state.warmSession = markDegraded(state.warmSession, now || new Date().toISOString(), { failureCode, reason });
  return { state, probe, failureCode, reason };
}

function executionProgress(execDir, execution, runtime, dispatch) {
  const lastEvent = readJsonl(path.join(execDir, 'events.jsonl')).at(-1) || null;
  return {
    executionPhase: execution.finalized === true
      ? 'RESULT_FINALIZED'
      : runtime?.status === 'COMPLETED'
        ? 'RUNTIME_COMPLETED'
        : dispatch?.status === 'CONSUMED' ? 'HANDOFF_CONSUMED' : 'HANDOFF_PREPARED',
    lastEventType: lastEvent?.type || null,
    lastEventAt: lastEvent?.time || null,
    resultArtifacts: {
      result: fs.existsSync(path.join(execDir, 'result.json')),
      metrics: fs.existsSync(path.join(execDir, 'metrics.json')),
      executionFinalized: execution.finalized === true,
      runtimeCompleted: runtime?.status === 'COMPLETED',
    },
  };
}

function reconcileBatch(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  return withFileLock(loaded.paths.lock, () => {
    const state = readBatchState(loaded.paths, loaded.contract);
    const terminalAction = { BLOCKED: 'BATCH_BLOCKED', CANCELLED: 'BATCH_CANCELLED', COMPLETED: 'BATCH_COMPLETE' }[state.status];
    if (terminalAction) {
      if (state.warmSession.status !== 'CLOSED') {
        throw contractError('BATCH_FINALIZATION_INVALID', `${state.status.toLowerCase()} batch has an open warm session`);
      }
      return { action: terminalAction, state };
    }
    if (fs.existsSync(loaded.paths.bootstrapDraft)) return { action: 'BOOTSTRAP', state, draft: readJson(loaded.paths.bootstrapDraft) };
    if (state.warmSession.status === 'INITIALIZING') return { action: 'BOOTSTRAP', state };
    if (fs.existsSync(loaded.paths.caseStartDraft)) return { action: 'RESUME_CASE_START', state, draft: readJson(loaded.paths.caseStartDraft) };
    if (fs.existsSync(loaded.paths.caseCommitDraft)) return { action: 'COMMIT_CASE', state, draft: readJson(loaded.paths.caseCommitDraft) };
    if (['BLOCKING', 'CANCELLING', 'FINALIZING'].includes(state.status) && commitBusinessTerminal(state, options.now)) {
      saveBatch(loaded.paths, state, options.now);
      return {
        action: { BLOCKED: 'BATCH_BLOCKED', CANCELLED: 'BATCH_CANCELLED', COMPLETED: 'BATCH_COMPLETE' }[state.status],
        state,
        recovered: true,
      };
    }
    if (state.status === 'BLOCKING') {
      if (state.finalization?.executionsSettled !== true) return { action: 'SETTLE_EXECUTIONS', state };
      if (state.finalization.platformReleased !== true) return { action: 'RELEASE_PLATFORM', state };
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'blocked finalization checklist was not committed', { now: options.now });
    }
    if (state.status === 'CANCELLING') {
      if (state.finalization.executionsSettled !== true) return { action: 'SETTLE_EXECUTIONS', state };
      if (state.finalization.platformReleased !== true) return { action: 'RELEASE_PLATFORM', state };
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'cancelled batch finalization was not committed', { now: options.now });
    }
    if (state.status === 'FINALIZING') {
      if (state.finalization?.casesCommitted !== true) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'finalizing batch has uncommitted cases', { now: options.now });
      if (state.finalization.executionsSettled !== true) return { action: 'SETTLE_EXECUTIONS', state };
      if (state.finalization.platformReleased !== true) return { action: 'RELEASE_PLATFORM', state };
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'completed finalization checklist was not committed', { now: options.now });
    }
    const requireDeviceSession = () => {
      const probed = probeWarmSession(state, loaded.contract, options.adapter, options.now);
      if (probed.state.warmSession.status !== 'DEGRADED') return null;
      const activeItem = currentCase(state);
      return {
        ...stopBatch(loaded.paths, state, 'DEGRADED', probed.failureCode, probed.reason, {
          now: options.now,
          stopContext: {
            source: 'warm-session-probe',
            caseKey: activeItem?.caseKey || null,
            executionId: activeItem?.executionId || null,
            warmSessionGeneration: state.warmSession.generation,
            probe: probed.probe || null,
          },
        }),
        probe: probed.probe,
      };
    };
    const allActive = findActiveExecutions(options.workspaceRoot);
    const active = allActive.filter((entry) => entry.execution.batchId === state.batchId);
    const mismatched = active.filter((entry) => entry.execution.platform !== loaded.contract.binding.platform);
    const samePlatformConflicts = allActive.filter((entry) => (
      entry.execution.batchId !== state.batchId
      && entry.execution.platform === loaded.contract.binding.platform
    ));
    if (mismatched.length) {
      const executions = mismatched.map((entry) => entry.execution.executionId);
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'batch owns an active execution for another platform', { now: options.now, executions });
    }
    if (active.length > 1) {
      const executions = active.map((entry) => entry.execution.executionId);
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_ACTIVE_EXECUTION_CONFLICT', 'batch has more than one active execution', { now: options.now, executions });
    }
    if (samePlatformConflicts.length) {
      const executions = samePlatformConflicts.map((entry) => entry.execution.executionId);
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_ACTIVE_EXECUTION_CONFLICT', 'another batch on the same platform owns an active execution', { now: options.now, executions });
    }
    const item = currentCase(state);
    if (!item) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_FINALIZATION_INVALID', 'batch has no current case before finalization', { now: options.now });
    if (item.status === 'PENDING') {
      if (active.length) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'pending case conflicts with an active execution', { now: options.now });
      return requireDeviceSession() || { action: 'START_CASE', state };
    }
    if (item.status !== 'RUNNING' || !item.executionId) return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'current case state is invalid', { now: options.now });
    const execDir = path.join(caseRuntimeDir(item.caseDir, loaded.contract.binding.platform), 'executions', item.executionId);
    const execution = readJson(path.join(execDir, 'execution.json'), null);
    if (!execution || (active.length && active[0].execution.executionId !== item.executionId)) {
      return stopBatch(loaded.paths, state, 'CORRUPTED', 'BATCH_STATE_CORRUPTED', 'current execution is missing or conflicts with batch state', { now: options.now });
    }
    const entry = { execDir, execution };
    if (entry.execution.runtimeSha !== state.runtimeSha || entry.execution.adapterSha !== state.adapterSha
      || entry.execution.batchContractSha !== state.contractSha) {
      throw contractError('BATCH_IMPLEMENTATION_MISMATCH', 'active execution belongs to another batch implementation');
    }
    if (entry.execution.schemaVersion === 12) {
      try {
        const reconcileExecution = options.reconcileExecution || caseRuntimeLifecycle.reconcileExecution;
        reconcileExecution({ executionDir: entry.execDir, runtimeOptions: options.runtimeOptions || {} });
        if (state.reconcileFailure) {
          delete state.reconcileFailure;
          saveBatch(loaded.paths, state, options.now);
        }
      } catch (error) {
        const classified = classifyReconcileError(error);
        const previous = state.reconcileFailure?.executionId === item.executionId
          && state.reconcileFailure?.code === classified.code ? state.reconcileFailure.count : 0;
        const count = previous + 1;
        state.reconcileFailure = {
          executionId: item.executionId,
          code: classified.code,
          classification: classified.classification,
          count,
          lastAt: options.now || new Date().toISOString(),
        };
        saveBatch(loaded.paths, state, options.now);
        if (classified.classification === 'RETRYABLE' && count < RECONCILE_RETRY_LIMIT) {
          return {
            action: 'WAIT_EXECUTION_RESULT',
            batchId: state.batchId,
            caseKey: item.caseKey,
            executionId: item.executionId,
            retry: { count, limit: RECONCILE_RETRY_LIMIT },
            technical: { code: classified.code, reason: error.message || String(error) },
          };
        }
        const classification = classified.classification === 'RETRYABLE' ? 'FATAL_EXECUTION' : classified.classification;
        return stopBatch(loaded.paths, state, 'RECONCILE_FATAL', classified.code, error.message || String(error), {
          now: options.now,
          platform: loaded.contract.binding.platform,
          stopContext: { source: 'case-runtime-reconcile', classification, retryCount: count, caseKey: item.caseKey, executionId: item.executionId },
        });
      }
      entry.execution = readJson(path.join(entry.execDir, 'execution.json'), null);
      const runtime = readJson(path.join(entry.execDir, 'runtime.json'), null);
      if (!runtime || runtime.executionId !== entry.execution.executionId) {
        return stopBatch(loaded.paths, state, 'CORRUPTED', 'CASE_RUNTIME_MISSING', 'active execution has no valid Case Runtime binding', { now: options.now });
      }
      if (entry.execution.finalized === true) return { action: 'COMMIT_CASE', state, execDir: entry.execDir };
      const dispatch = readActiveDispatch(path.join(loaded.paths.batchDir, 'handoffs', item.executionId), item.executionId);
      return {
        action: dispatch?.status === 'CONSUMED' ? 'WAIT_EXECUTION_RESULT' : 'NEED_CASE_AGENT',
        batchId: state.batchId,
        caseKey: item.caseKey,
        executionId: item.executionId,
        ...(dispatch?.status === 'CONSUMED'
          ? { progress: executionProgress(entry.execDir, entry.execution, runtime, dispatch) }
          : {}),
      };
    }
    return stopBatch(loaded.paths, state, 'CORRUPTED', 'FORMAT_UNSUPPORTED', 'This execution was created by an unsupported format and must be run again', { now: options.now });
  }, { now: options.now });
}

module.exports = { reconcileBatch };
