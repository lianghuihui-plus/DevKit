'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bindingSha } = require('../lib/batch-contract');
const { contractError } = require('../lib/contract-utils');
const {
  appendJsonl,
  readJson,
  withFileLock,
  writeJsonAtomic,
} = require('../lib/execution-lifecycle');
const { loadBatch } = require('./core');

const SCHEMA_VERSION = 1;
const ACQUIRED_STATUSES = new Set(['ACTIVE', 'NOT_REQUIRED']);
const TERMINAL_STATUSES = new Set(['RELEASED', 'RETAINED', 'NOT_REQUIRED']);
const OWNERSHIPS = new Set(['FRAMEWORK_MANAGED', 'EXTERNAL', 'NONE']);

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function timestamp(value) {
  return value || localIso();
}

function runtimePaths(batchDir) {
  return {
    state: path.join(batchDir, 'platform-runtime.json'),
    acquireDraft: path.join(batchDir, 'platform-runtime-acquire.draft.json'),
    releaseDraft: path.join(batchDir, 'platform-runtime-release.draft.json'),
  };
}

function ownerKey(workspaceRoot, batchId, contractSha) {
  return `batch-${crypto.createHash('sha256')
    .update(`${path.resolve(workspaceRoot)}\n${batchId}\n${contractSha}`)
    .digest('hex').slice(0, 24)}`;
}

function protocolBindings(options) {
  return {
    caseProtocolSha: options.caseProtocolSha,
    coordinatorProtocolSha: options.coordinatorProtocolSha,
    runtimeSha: options.runtimeSha,
    adapterSha: options.adapterSha,
    coordinatorSha: options.coordinatorSha,
  };
}

function validateAdapterResult(result, operation) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw contractError('PLATFORM_RUNTIME_RESULT_INVALID', `${operation} did not return an object`);
  }
  if (typeof result.ok !== 'boolean') {
    throw contractError('PLATFORM_RUNTIME_RESULT_INVALID', `${operation}.ok must be boolean`);
  }
  if (result.ok === true) {
    const allowed = operation === 'acquire' ? ACQUIRED_STATUSES : TERMINAL_STATUSES;
    if (!allowed.has(result.status)) {
      throw contractError('PLATFORM_RUNTIME_RESULT_INVALID', `${operation}.status is invalid: ${result.status || 'missing'}`);
    }
    if (!OWNERSHIPS.has(result.ownership)) {
      throw contractError('PLATFORM_RUNTIME_RESULT_INVALID', `${operation}.ownership is invalid: ${result.ownership || 'missing'}`);
    }
  }
  return result;
}

function acquisitionFromState(state) {
  return {
    ok: !['ACQUIRE_FAILED', 'RELEASE_FAILED'].includes(state.status),
    status: state.status,
    ownership: state.ownership,
    platform: state.platform,
    ownerKey: state.ownerKey,
    ...(state.resource ? { resource: state.resource } : {}),
    ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

function validateState(state, loaded) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || state.batchId !== loaded.state.batchId
    || state.platform !== loaded.contract.binding.platform
    || state.bindingSha !== bindingSha(loaded.contract.binding)
    || state.ownerKey !== ownerKey(path.dirname(path.dirname(loaded.paths.batchDir)), loaded.state.batchId, loaded.state.contractSha)) {
    throw contractError('PLATFORM_RUNTIME_STATE_INVALID', 'platform runtime state does not match the batch binding');
  }
  if (![...ACQUIRED_STATUSES, ...TERMINAL_STATUSES, 'ACQUIRE_FAILED', 'RELEASE_FAILED'].includes(state.status)
    || !OWNERSHIPS.has(state.ownership)) {
    throw contractError('PLATFORM_RUNTIME_STATE_INVALID', 'platform runtime state contains an invalid status or ownership');
  }
  return state;
}

function hasEvent(eventsPath, eventId) {
  if (!fs.existsSync(eventsPath)) return false;
  return fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      return JSON.parse(line).eventId === eventId;
    } catch {
      return false;
    }
  });
}

function publishAcquisitionEvent(loaded, state) {
  const eventId = `platform-runtime-acquired-${state.batchId}`;
  if (hasEvent(loaded.paths.events, eventId)) return;
  appendJsonl(loaded.paths.events, {
    schemaVersion: 1,
    eventId,
    time: state.acquiredAt,
    type: 'platformRuntimeAcquired',
    platform: state.platform,
    status: state.status,
    ownership: state.ownership,
    ...(state.failureCode ? { failureCode: state.failureCode } : {}),
  });
}

function publishReleaseEvent(loaded, state) {
  if (!Number.isInteger(state.releaseAttempts) || state.releaseAttempts < 1 || !state.releaseAttemptedAt) return;
  const eventId = `platform-runtime-release-${state.batchId}-${state.releaseAttempts}`;
  if (hasEvent(loaded.paths.events, eventId)) return;
  appendJsonl(loaded.paths.events, {
    schemaVersion: 1,
    eventId,
    time: state.releaseAttemptedAt,
    type: 'platformRuntimeReleased',
    platform: state.platform,
    status: state.status,
    ownership: state.ownership,
    ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  });
}

function acquireBatchPlatformRuntime(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  const paths = runtimePaths(loaded.paths.batchDir);
  return withFileLock(loaded.paths.lock, () => {
    const existing = readJson(paths.state, null);
    if (existing) {
      const state = validateState(existing, loaded);
      publishAcquisitionEvent(loaded, state);
      if (fs.existsSync(paths.acquireDraft)) fs.unlinkSync(paths.acquireDraft);
      return acquisitionFromState(state);
    }

    const expectedOwner = ownerKey(options.workspaceRoot, options.batchId, loaded.state.contractSha);
    let draft = readJson(paths.acquireDraft, null);
    if (!draft) {
      draft = {
        schemaVersion: SCHEMA_VERSION,
        batchId: options.batchId,
        platform: loaded.contract.binding.platform,
        bindingSha: bindingSha(loaded.contract.binding),
        ownerKey: expectedOwner,
        createdAt: timestamp(options.now),
      };
      writeJsonAtomic(paths.acquireDraft, draft);
    }
    if (draft.schemaVersion !== SCHEMA_VERSION || draft.batchId !== options.batchId
      || draft.platform !== loaded.contract.binding.platform
      || draft.bindingSha !== bindingSha(loaded.contract.binding) || draft.ownerKey !== expectedOwner) {
      throw contractError('PLATFORM_RUNTIME_ACQUIRE_DRAFT_INVALID', 'platform runtime acquire draft does not match the batch');
    }
    if (!draft.result) {
      try {
        draft.result = validateAdapterResult(options.adapter.acquirePlatformRuntime({
          binding: loaded.contract.binding,
          ownerKey: expectedOwner,
          batchId: options.batchId,
        }), 'acquire');
      } catch (error) {
        draft.result = {
          ok: false,
          status: 'ACQUIRE_FAILED',
          ownership: 'NONE',
          failureCode: error.code || 'PLATFORM_RUNTIME_ACQUIRE_FAILED',
          reason: error.message || String(error),
        };
      }
      draft.recordedAt = timestamp(options.now);
      writeJsonAtomic(paths.acquireDraft, draft);
    }
    const acquired = draft.result;
    const state = {
      schemaVersion: SCHEMA_VERSION,
      type: 'batchPlatformRuntime',
      batchId: options.batchId,
      platform: loaded.contract.binding.platform,
      bindingSha: draft.bindingSha,
      ownerKey: expectedOwner,
      status: acquired.ok ? acquired.status : 'ACQUIRE_FAILED',
      ownership: acquired.ok ? acquired.ownership : 'NONE',
      ...(acquired.resource ? { resource: acquired.resource } : {}),
      ...(acquired.failureCode ? { failureCode: acquired.failureCode } : {}),
      ...(acquired.reason ? { reason: acquired.reason } : {}),
      acquiredAt: draft.recordedAt || draft.createdAt,
      updatedAt: draft.recordedAt || draft.createdAt,
    };
    writeJsonAtomic(paths.state, state);
    publishAcquisitionEvent(loaded, state);
    fs.unlinkSync(paths.acquireDraft);
    return acquisitionFromState(state);
  }, { now: options.now });
}

function releaseBatchPlatformRuntime(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  if (!['FINALIZING', 'CANCELLING', 'BLOCKING', 'COMPLETED', 'CANCELLED', 'BLOCKED'].includes(loaded.state.status)) {
    throw contractError('PLATFORM_RUNTIME_RELEASE_EARLY', 'platform runtime can only be released after the batch reaches a terminal state');
  }
  const paths = runtimePaths(loaded.paths.batchDir);
  return withFileLock(loaded.paths.lock, () => {
    const current = readJson(paths.state, null);
    if (!current) return { ok: true, status: 'NOT_ACQUIRED', ownership: 'NONE' };
    const state = validateState(current, loaded);
    if (TERMINAL_STATUSES.has(state.status)) {
      publishReleaseEvent(loaded, state);
      if (fs.existsSync(paths.releaseDraft)) fs.unlinkSync(paths.releaseDraft);
      return { ...acquisitionFromState(state), alreadyFinalized: true };
    }

    let draft = readJson(paths.releaseDraft, null);
    if (!draft) {
      draft = {
        schemaVersion: SCHEMA_VERSION,
        batchId: options.batchId,
        ownerKey: state.ownerKey,
        attempt: Number(state.releaseAttempts || 0) + 1,
        runtime: acquisitionFromState(state),
        createdAt: timestamp(options.now),
      };
      writeJsonAtomic(paths.releaseDraft, draft);
    }
    if (draft.schemaVersion !== SCHEMA_VERSION || draft.batchId !== options.batchId
      || draft.ownerKey !== state.ownerKey || draft.runtime?.platform !== state.platform) {
      throw contractError('PLATFORM_RUNTIME_RELEASE_DRAFT_INVALID', 'platform runtime release draft does not match the batch');
    }
    if (!draft.result) {
      try {
        draft.result = validateAdapterResult(options.adapter.releasePlatformRuntime({
          binding: loaded.contract.binding,
          runtime: draft.runtime,
          ownerKey: state.ownerKey,
          batchId: options.batchId,
        }), 'release');
      } catch (error) {
        draft.result = {
          ok: false,
          status: 'RELEASE_FAILED',
          ownership: state.ownership,
          failureCode: error.code || 'PLATFORM_RUNTIME_RELEASE_FAILED',
          reason: error.message || String(error),
        };
      }
      draft.recordedAt = timestamp(options.now);
      writeJsonAtomic(paths.releaseDraft, draft);
    }
    const released = draft.result;
    Object.assign(state, {
      status: released.ok ? released.status : 'RELEASE_FAILED',
      ownership: released.ownership || state.ownership,
      ...(released.resource ? { resource: released.resource } : {}),
      updatedAt: draft.recordedAt,
      releaseAttemptedAt: draft.recordedAt,
      releaseAttempts: draft.attempt,
      ...(released.ok ? { releasedAt: draft.recordedAt } : {}),
      ...(released.failureCode ? { failureCode: released.failureCode } : {}),
      ...(released.reason ? { reason: released.reason } : {}),
    });
    if (released.ok) {
      delete state.failureCode;
      delete state.reason;
    }
    writeJsonAtomic(paths.state, state);
    publishReleaseEvent(loaded, state);
    fs.unlinkSync(paths.releaseDraft);
    return acquisitionFromState(state);
  }, { now: options.now });
}

function loadBatchPlatformRuntime(options) {
  const loaded = loadBatch(options.workspaceRoot, options.batchId, protocolBindings(options));
  const state = readJson(runtimePaths(loaded.paths.batchDir).state, null);
  return state ? validateState(state, loaded) : null;
}

module.exports = {
  acquireBatchPlatformRuntime,
  loadBatchPlatformRuntime,
  ownerKey,
  releaseBatchPlatformRuntime,
  runtimePaths,
  validateAdapterResult,
};
