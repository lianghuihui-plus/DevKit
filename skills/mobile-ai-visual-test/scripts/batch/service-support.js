'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { appendJsonl, withFileLock } = require('../lib/execution-lifecycle');
const { markDegraded } = require('../lib/warm-session-contract');
const caseRuntimeLifecycle = require('../case-runtime/lifecycle');
const { saveBatch } = require('./state-repository');

function caseRuntimeDir(caseDir, platform) {
  return path.join(caseDir, 'platforms', platform);
}

function caseAgentPrompt() {
  return fs.readFileSync(path.resolve(__dirname, '../../prompts/case-agent.md'), 'utf8');
}

function caseAgentResponse({ action, agentRequired, batchId, caseKey, executionId, handoff }) {
  return {
    action,
    agentRequired,
    batchId,
    caseKey,
    executionId,
    ...(handoff ? { handoff } : {}),
  };
}

function withRetriedBatchLock(file, callback, options = {}) {
  const attempts = 50;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return withFileLock(file, callback, options);
    } catch (error) {
      if (error?.code !== 'EXECUTION_LOCKED' || attempt === attempts - 1) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  throw contractError('EXECUTION_LOCKED', 'batch lock retry limit reached');
}

function hasBatchEvent(eventsPath, predicate) {
  if (!fs.existsSync(eventsPath)) return false;
  return fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line);
      return predicate(event);
    } catch (error) {
      return false;
    }
  });
}

function stopBatch(paths, state, action, failureCode, reason, options = {}) {
  const time = options.now || new Date().toISOString();
  const cleanupDeadline = new Date(Date.parse(time) + 120000).toISOString();
  const diagnostic = options.diagnostic || {
    code: failureCode,
    stage: options.stage || action,
    summary: reason,
    retryable: options.retryable === true,
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  };
  if (!['BLOCKING', 'BLOCKED'].includes(state.status)) {
    const activeItem = currentCase(state);
    const settledExecutions = [];
    if (activeItem?.status === 'RUNNING' && activeItem.executionId) {
      const execDir = path.join(caseRuntimeDir(activeItem.caseDir, state.binding?.platform || options.platform || ''), 'executions', activeItem.executionId);
      try {
        const cancelled = caseRuntimeLifecycle.cancelExecution({ executionDir: execDir, reason, now: time });
        settledExecutions.push(cancelled.execution.executionId);
      } catch (error) {
        settledExecutions.push({ executionId: activeItem.executionId, settlementError: error.code || error.message || String(error) });
      }
      Object.assign(activeItem, { status: 'BLOCKED', executionStatus: 'TECHNICALLY_BLOCKED', endedAt: time });
    }
    for (const pending of state.cases.filter((entry) => entry.status === 'PENDING')) pending.status = 'SKIPPED';
    state.status = 'BLOCKING';
    state.failureCode = failureCode;
    state.reason = reason;
    state.diagnostic = diagnostic;
    state.stoppedAt = time;
    state.cleanupDeadlineAt = cleanupDeadline;
    state.finalization = {
      cause: 'BLOCKED',
      executionsSettled: false,
      settledExecutions,
      platformReleased: false,
    };
    if (options.stopContext) state.stopContext = options.stopContext;
    if (state.warmSession?.status !== 'CLOSED' && state.warmSession?.status !== 'DEGRADED') {
      state.warmSession = markDegraded(state.warmSession, time, { failureCode, reason });
    }
    saveBatch(paths, state, time);
  }
  const eventId = `batch-stopped-${state.batchId}`;
  if (!hasBatchEvent(paths.events, (event) => event.eventId === eventId)) {
    appendJsonl(paths.events, {
      schemaVersion: 1,
      eventId,
      time,
      type: 'batchStopped',
      action,
      failureCode: state.failureCode || failureCode,
      reason: state.reason || reason,
      diagnostic: state.diagnostic || diagnostic,
      ...(state.stopContext ? { stopContext: state.stopContext } : {}),
      ...(options.executions ? { executions: options.executions } : {}),
    });
  }
  return {
    action,
    state,
    failureCode: state.failureCode || failureCode,
    reason: state.reason || reason,
    ...(state.diagnostic || diagnostic ? { diagnostic: state.diagnostic || diagnostic } : {}),
    ...(state.diagnostic?.stage || diagnostic.stage ? { stage: state.diagnostic?.stage || diagnostic.stage } : {}),
    ...(state.diagnostic?.retryable !== undefined || diagnostic.retryable !== undefined
      ? { retryable: state.diagnostic?.retryable ?? diagnostic.retryable }
      : {}),
    nextAction: state.status === 'BLOCKING' ? 'SETTLE_EXECUTIONS' : 'BATCH_BLOCKED',
    ...(options.executions ? { executions: options.executions } : {}),
  };
}

function protocolBindings(options, compatibilityMode) {
  return {
    caseProtocolSha: options.caseProtocolSha,
    coordinatorProtocolSha: options.coordinatorProtocolSha,
    runtimeSha: options.runtimeSha,
    adapterSha: options.adapterSha,
    coordinatorSha: options.coordinatorSha,
    ...(compatibilityMode ? { compatibilityMode } : {}),
  };
}

function currentCase(state) {
  return state.cases[state.currentIndex] || null;
}

module.exports = {
  caseAgentPrompt,
  caseAgentResponse,
  caseRuntimeDir,
  currentCase,
  hasBatchEvent,
  protocolBindings,
  stopBatch,
  withRetriedBatchLock,
};
