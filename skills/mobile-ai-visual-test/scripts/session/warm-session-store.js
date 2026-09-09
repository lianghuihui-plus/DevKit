'use strict';

const fs = require('fs');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { appendJsonl, readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const {
  createRotatedWarmSession,
  markBootstrapReady,
  markDegraded,
  markPreparationFailed,
  markRecovered,
} = require('../lib/warm-session-contract');

function validateSessionRef(value, batchId) {
  if (!value || value.schemaVersion !== 2 || value.batchId !== batchId
    || !path.isAbsolute(value.statePath || '') || !path.isAbsolute(value.lockPath || '')
    || !path.isAbsolute(value.eventsPath || '') || !path.isAbsolute(value.platformRuntimePath || '')) {
    throw contractError('SESSION_REF_INVALID', 'execution sessionRef is invalid');
  }
  return {
    state: path.resolve(value.statePath),
    lock: path.resolve(value.lockPath),
    events: path.resolve(value.eventsPath),
    platformRuntime: path.resolve(value.platformRuntimePath),
  };
}

function commitRecoveryGeneration(options) {
  const target = validateSessionRef(options.sessionRef, options.batchId);
  return withFileLock(target.lock, () => {
    const state = readJson(target.state, null);
    if (!state) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${options.batchId}`);
    if (state.warmSession.sessionId !== options.sessionId || state.warmSession.epoch !== options.epoch) {
      throw contractError('RECOVERY_SESSION_MISMATCH', 'batch warm session changed before recovery commit');
    }
    if (state.warmSession.generation < options.nextGeneration) {
      state.warmSession = markRecovered(state.warmSession, options.now);
      if (state.warmSession.generation !== options.nextGeneration) {
        throw contractError('RECOVERY_GENERATION_MISMATCH', 'batch warm session generation changed concurrently');
      }
      state.updatedAt = options.now;
      writeJsonAtomic(target.state, state);
    } else if (state.warmSession.generation !== options.nextGeneration) {
      throw contractError('RECOVERY_GENERATION_MISMATCH', 'batch warm session is ahead of this execution');
    }
    return state.warmSession;
  }, { now: options.now });
}

function appendRotationEvent(target, event) {
  const existing = fs.existsSync(target.events) ? fs.readFileSync(target.events, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try { return JSON.parse(line).eventId === event.eventId; } catch { return false; }
  }) : false;
  if (!existing) appendJsonl(target.events, event);
}

function commitPreparationRotation(options) {
  const target = validateSessionRef(options.sessionRef, options.batchId);
  return withFileLock(target.lock, () => {
    const state = readJson(target.state, null);
    if (!state) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${options.batchId}`);
    const current = state.warmSession;
    if (current.sessionId === options.nextSessionId && current.epoch === options.nextEpoch) {
      appendRotationEvent(target, {
        schemaVersion: 1,
        eventId: `warm-session-ended-${options.operationId}`,
        time: options.now,
        type: 'warmSessionEnded',
        sessionId: options.previousSessionId,
        epoch: options.previousEpoch,
        reason: options.strategy,
        operationId: options.operationId,
      });
      return current;
    }
    if (current.sessionId !== options.previousSessionId || current.epoch !== options.previousEpoch) {
      throw contractError('WARM_SESSION_ROTATION_MISMATCH', 'batch warm session changed before preparation commit');
    }
    const next = createRotatedWarmSession(current, options.strategy, options.now);
    if (next.sessionId !== options.nextSessionId || next.epoch !== options.nextEpoch) throw contractError('WARM_SESSION_ROTATION_MISMATCH', 'reserved warm session identity is invalid');
    state.warmSession = next;
    state.updatedAt = options.now;
    writeJsonAtomic(target.state, state);
    appendRotationEvent(target, {
      schemaVersion: 1,
      eventId: `warm-session-ended-${options.operationId}`,
      time: options.now,
      type: 'warmSessionEnded',
      sessionId: current.sessionId,
      epoch: current.epoch,
      reason: options.strategy,
      operationId: options.operationId,
    });
    return next;
  }, { now: options.now });
}

function commitPreparationReady(options) {
  const target = validateSessionRef(options.sessionRef, options.batchId);
  return withFileLock(target.lock, () => {
    const state = readJson(target.state, null);
    if (!state) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${options.batchId}`);
    const current = state.warmSession;
    if (current.sessionId !== options.sessionId || current.epoch !== options.epoch) {
      throw contractError('WARM_SESSION_ROTATION_MISMATCH', 'batch warm session changed before preparation became ready');
    }
    if (current.status === 'READY') {
      appendRotationEvent(target, {
        schemaVersion: 1,
        eventId: `warm-session-started-${options.operationId}`,
        time: options.now,
        type: 'warmSessionStarted',
        sessionId: current.sessionId,
        epoch: current.epoch,
        generation: current.generation,
        reason: current.startReason,
        operationId: options.operationId,
      });
      return current;
    }
    if (current.status !== 'INITIALIZING') throw contractError('WARM_SESSION_ROTATION_MISMATCH', `rotated warm session is ${current.status}`);
    const ready = markBootstrapReady(current, options.now);
    state.warmSession = ready;
    state.updatedAt = options.now;
    writeJsonAtomic(target.state, state);
    appendRotationEvent(target, {
      schemaVersion: 1,
      eventId: `warm-session-started-${options.operationId}`,
      time: options.now,
      type: 'warmSessionStarted',
      sessionId: ready.sessionId,
      epoch: ready.epoch,
      generation: ready.generation,
      reason: ready.startReason,
      operationId: options.operationId,
    });
    return ready;
  }, { now: options.now });
}

function invalidateWarmSession(options) {
  const target = validateSessionRef(options.sessionRef, options.batchId);
  return withFileLock(target.lock, () => {
    const state = readJson(target.state, null);
    if (!state) throw contractError('BATCH_NOT_INITIALIZED', `batch is not initialized: ${options.batchId}`);
    if (state.warmSession.status !== 'DEGRADED') {
      const mark = state.warmSession.status === 'INITIALIZING' ? markPreparationFailed : markDegraded;
      state.warmSession = mark(state.warmSession, options.now, { failureCode: options.failureCode, reason: options.reason });
      state.updatedAt = options.now;
      writeJsonAtomic(target.state, state);
    }
    return state.warmSession;
  }, { now: options.now });
}

function commitPlatformSessionRefresh(options) {
  const target = validateSessionRef(options.sessionRef, options.batchId);
  return withFileLock(target.lock, () => {
    const runtime = readJson(target.platformRuntime, null);
    if (!runtime?.resource?.session) throw contractError('IOS_APPIUM_SESSION_UNAVAILABLE', 'batch Appium session is unavailable');
    if (runtime.resource.session.sessionId === options.platformSession.sessionId) return runtime.resource;
    if (runtime.resource.session.sessionId !== options.previousSessionId) {
      throw contractError('IOS_APPIUM_SESSION_CHANGED', 'batch Appium session changed before preparation commit');
    }
    runtime.resource.session = {
      ...runtime.resource.session,
      ...options.platformSession,
      generation: Number(runtime.resource.session.generation || 1) + 1,
      refreshedAt: options.now,
      refreshOperationId: options.operationId,
    };
    runtime.updatedAt = options.now;
    writeJsonAtomic(target.platformRuntime, runtime);
    return runtime.resource;
  }, { now: options.now });
}

module.exports = { commitPlatformSessionRefresh, commitPreparationReady, commitPreparationRotation, commitRecoveryGeneration, invalidateWarmSession, validateSessionRef };
