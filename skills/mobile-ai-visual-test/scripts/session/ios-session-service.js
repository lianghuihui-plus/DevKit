'use strict';

const childProcess = require('child_process');
const path = require('path');
const { contractError } = require('../lib/contract-utils');
const { environmentAdapterArgs } = require('../lib/execution-environment');
const { appendJsonl, readJson, withFileLock, writeJsonAtomic } = require('../lib/execution-lifecycle');
const { validateSessionRef } = require('./warm-session-store');

const INVALID_SESSION_PATTERN = /invalid session id|session (?:is )?(?:either )?terminated|session[^\n]{0,80}not started/i;
const TRANSPORT_FAILURE_PATTERN = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|timed out|network error|fetch failed/i;

function failureText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const parts = [
    value.message,
    value.reason,
    value.failureCode,
    value.stderr,
    value.adapterDiagnostics?.stderr,
    value.adapterError?.message,
    value.adapterError?.failureCode,
    value.command?.message,
    value.command?.failureCode,
    value.deviceExecution?.message,
    value.deviceExecution?.failureCode,
    value.response?.value?.error,
    value.response?.value?.message,
  ];
  return parts.filter(Boolean).join('\n');
}

function isInvalidIosSessionFailure(value) {
  return INVALID_SESSION_PATTERN.test(failureText(value));
}

function isIosSessionOrTransportFailure(value) {
  const text = failureText(value);
  return INVALID_SESSION_PATTERN.test(text) || TRANSPORT_FAILURE_PATTERN.test(text);
}

function defaultRunner(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs || 180000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function refreshThroughAdapter(binding, runtime, options = {}) {
  const command = path.join(path.resolve(__dirname, '../..'), 'scripts', 'platform', 'runtime.sh');
  const args = [
    ...environmentAdapterArgs(binding, 'runtime'),
    '--operation', 'refresh-session',
    '--runtime-json', JSON.stringify(runtime),
  ];
  const runner = options.runner || defaultRunner;
  const result = runner(command, args, {
    timeoutMs: options.timeoutMs || 180000,
    kind: 'SESSION_REFRESH',
    binding,
  });
  const stderr = String(result?.stderr || '').trim();
  if (result?.error || result?.status !== 0) {
    throw contractError('IOS_APPIUM_SESSION_REFRESH_FAILED', stderr || result?.error?.message || 'iOS Appium session refresh failed', {
      adapterDiagnostics: { status: result?.status ?? null, signal: result?.signal || null, stderr },
    });
  }
  let value;
  try {
    value = JSON.parse(String(result.stdout || '').trim());
  } catch (error) {
    throw contractError('IOS_APPIUM_SESSION_REFRESH_FAILED', `session refresh returned invalid JSON: ${error.message}`, {
      adapterDiagnostics: { status: result?.status ?? null, signal: result?.signal || null, stderr },
    });
  }
  if (value?.ok !== true || value?.operation !== 'refresh-session' || !value.platformSession?.sessionId) {
    throw contractError(value?.failureCode || 'IOS_APPIUM_SESSION_REFRESH_FAILED', value?.reason || 'session refresh did not return a replacement session');
  }
  return value.platformSession;
}

function currentSession(runtime) {
  const session = runtime?.resource?.session;
  if (!session?.sessionId) throw contractError('IOS_APPIUM_SESSION_UNAVAILABLE', 'batch Appium session is unavailable');
  if (runtime.status !== 'ACTIVE') {
    throw contractError('IOS_APPIUM_SESSION_UNAVAILABLE', `batch platform runtime is ${runtime.status}`);
  }
  return { ...session, generation: Number(session.generation || 1) };
}

function commitReplacement(target, previous, replacement, options = {}) {
  const authoritative = readJson(target.platformRuntime, null);
  const authoritativeSession = currentSession(authoritative);
  if (authoritativeSession.sessionId !== previous.sessionId
    || authoritativeSession.generation !== previous.generation) {
    if (options.adoptConcurrent === true) return authoritativeSession;
    throw contractError('IOS_APPIUM_SESSION_CHANGED', 'batch Appium session changed before replacement commit');
  }
  const next = {
    ...previous,
    ...replacement,
    generation: previous.generation + 1,
    refreshedAt: options.now || new Date().toISOString(),
    ...(options.operationId ? { refreshOperationId: options.operationId } : {}),
  };
  authoritative.resource.session = next;
  authoritative.updatedAt = next.refreshedAt;
  writeJsonAtomic(target.platformRuntime, authoritative);
  appendJsonl(target.events, {
    schemaVersion: 1,
    eventId: `ios-session-refreshed-${options.operationId || next.generation}-${next.generation}`,
    time: next.refreshedAt,
    type: 'iosSessionRefreshed',
    previousSessionId: previous.sessionId,
    sessionId: next.sessionId,
    generation: next.generation,
    ...(options.reason ? { reason: options.reason } : {}),
  });
  return next;
}

function withCurrentIosSession(sessionRef, operationKind, callback, options = {}) {
  if (!['OBSERVE', 'ACTION'].includes(operationKind)) {
    throw contractError('IOS_SESSION_OPERATION_INVALID', `unsupported iOS session operation: ${operationKind}`);
  }
  const target = validateSessionRef(sessionRef, sessionRef?.batchId);
  return withFileLock(target.lock, () => {
    const runtime = readJson(target.platformRuntime, null);
    let session = currentSession(runtime);
    try {
      const result = callback(session);
      const returnedReplacement = typeof options.replacementFromResult === 'function'
        ? options.replacementFromResult(result)
        : null;
      if (returnedReplacement?.sessionId && returnedReplacement.sessionId !== session.sessionId) {
        commitReplacement(target, session, returnedReplacement, {
          now: options.now,
          operationId: options.operationId,
        });
      }
      return result;
    } catch (error) {
      if (operationKind === 'ACTION' && isIosSessionOrTransportFailure(error)) {
        error.actionOutcomeUnknown = true;
        throw error;
      }
      if (operationKind !== 'OBSERVE' || !isInvalidIosSessionFailure(error)) throw error;

      const previous = session;
      const originalFailure = failureText(error).slice(0, 4000);
      appendJsonl(target.events, {
        schemaVersion: 1,
        eventId: `ios-session-invalid-${options.operationId || previous.generation}-${previous.generation}`,
        time: options.now || new Date().toISOString(),
        type: 'iosSessionInvalidated',
        sessionId: previous.sessionId,
        generation: previous.generation,
        operationKind,
        reason: originalFailure,
      });
      const replacement = options.refreshSession
        ? options.refreshSession({
          binding: options.binding,
          runtime,
          previousSession: previous,
        })
        : refreshThroughAdapter(options.binding, runtime, {
          runner: options.runner,
          timeoutMs: options.timeoutMs,
        });
      if (!replacement?.sessionId) {
        throw contractError('IOS_APPIUM_SESSION_REFRESH_FAILED', 'session refresh did not return a session id');
      }
      if (typeof options.beforeRefreshCommit === 'function') options.beforeRefreshCommit();
      session = commitReplacement(target, previous, replacement, {
        now: options.now,
        operationId: options.operationId,
        adoptConcurrent: true,
        reason: originalFailure,
      });
      return callback(session);
    }
  }, { now: options.now });
}

module.exports = {
  failureText,
  commitReplacement,
  isInvalidIosSessionFailure,
  isIosSessionOrTransportFailure,
  refreshThroughAdapter,
  withCurrentIosSession,
};
