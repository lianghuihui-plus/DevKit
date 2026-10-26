'use strict';
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createRepository, safeId } = require('./repository');
const { createCredentials } = require('./credentials');
const { normalizeServerUrl } = require('./settings');
const { readFrozenExport } = require('./collector');
const { createTransport, validateCapabilityResponse, validId, DEFAULT_TIMEOUTS } = require('./transport');
const { LIMITS, resolveLimits, validateManifest, terminalResult } = require('./contracts');
const { reportingError, ReportingError } = require('./errors');
const { assertSessionKey } = require('./session-identity');
const DEFAULT_SESSION_TIMEOUTS = Object.freeze({ total: 1800000, commit: 360000, poll: 2000, retry: 1000 });
const RETRYABLE = new Set(['REPORTING_NETWORK_ERROR', 'REPORTING_TIMEOUT', 'REPORTING_UPLOAD_ERROR']);
function check(condition) {
  if (!condition) throw reportingError('REPORTING_PROTOCOL_INVALID');
}
function constraints(capabilities, session) {
  validateCapabilityResponse(capabilities);
  const advertised = resolveLimits(capabilities.limits);
  const limits = resolveLimits(Object.fromEntries(Object.keys(LIMITS).map(k => [k, Math.min(advertised[k], session.limits[k])])));
  try { validateManifest(session.manifest, { limits }); } catch { throw reportingError('REPORTING_CAPABILITIES_CHANGED'); }
  check(Buffer.byteLength(session.rawManifest) <= limits.manifestBytes);
  check(session.files.every(f => capabilities.encodings.includes(f.encoding)));
  return limits;
}
function sessionResponse(value, session, remoteId, limits) {
  check(value?.protocolVersion === '2.0' && validId(value.sessionId) && (!remoteId || value.sessionId === remoteId));
  check(['UPLOADING', 'COMMITTED', 'REJECTED'].includes(value.status));
  if (value.status !== 'UPLOADING') return { terminal: terminalResult(value, session.manifest, value.sessionId) };
  check(typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)));
  check(value.limits && Object.keys(LIMITS).every(k => Number.isSafeInteger(value.limits[k]) && value.limits[k] > 0));
  const effective = resolveLimits(Object.fromEntries(Object.keys(LIMITS).map(k => [k, Math.min(limits[k], value.limits[k])])));
  try { validateManifest(session.manifest, { limits: effective }); } catch { throw reportingError('REPORTING_CAPABILITIES_CHANGED'); }
  check(Array.isArray(value.missingFiles) && value.missingFiles.length <= session.files.length);
  const files = new Map(session.files.map(f => [f.id, f])), ids = new Set(), hashes = new Set();
  for (const id of value.missingFiles) {
    check(validId(id) && files.has(id) && !ids.has(id));
    const file = files.get(id);
    check(!hashes.has(file.sha256));
    ids.add(id); hashes.add(file.sha256);
  }
  return { sessionId: value.sessionId, missingFiles: value.missingFiles, limits: effective };
}
function assertStoredSession(record) {
  check(record && typeof record === 'object');
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1
    || !['PREPARING', 'UPLOADING', 'COMMITTING', 'COMMITTED', 'REJECTED', 'RETRYABLE_FAILED', 'NEEDS_CREDENTIAL'].includes(record.state)
    || !['PREPARE', 'UPLOAD', 'COMMIT', 'TERMINAL'].includes(record.phase)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.key)
    || (record.remoteSessionId !== null && !validId(record.remoteSessionId))
    || (record.commitStartedAt && !Number.isFinite(Date.parse(record.commitStartedAt)))
    || (record.nextRetryAt && !Number.isFinite(Date.parse(record.nextRetryAt)))) {
    throw reportingError('REPORTING_STATE_CORRUPT');
  }
}
/** Runs one validated frozen session; caller owns the durable asynchronous worker claim. */
function createSessionRunner(options = {}) {
  const repository = options.repository || createRepository(options);
  const credentials = options.credentials || createCredentials({ repository });
  const readFrozen = options.readFrozenExport || readFrozenExport;
  const clock = options.clock || Date.now;
  const sleep = options.sleep || (ms => delay(ms));
  const timeouts = { ...DEFAULT_SESSION_TIMEOUTS, ...options.timeouts };
  check(Object.values(timeouts).every(v => Number.isFinite(v) && v > 0));
  async function runSession(input) {
    const { workspace } = input;
    const packageId = safeId(input.packageId), localId = safeId(input.sessionId);
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const credentialGeneration = input.credentialGeneration;
    const frozen = readFrozen(workspace, packageId, { ...options, repository });
    check(frozen.state === 'PACKAGE_READY' && frozen.packageId === packageId);
    const session = frozen.sessions.find(s => s.id === localId);
    check(session && typeof session.rawManifest === 'string');
    const identityEpoch = frozen.identityEpoch;
    const stateRelative = `sessions/${packageId}/${localId}.json`;
    const receiptRelative = `receipts/${packageId}/${localId}.json`;
    const manifestSha256 = 'sha256:' + crypto.createHash('sha256').update(session.rawManifest).digest('hex');
    check(manifestSha256 === session.manifestSha256);
    const binding = { packageId, localId, identityEpoch, exportVersion: 1, serverUrl, credentialGeneration, manifestSha256 };
    let state;
    const assertBinding = record => check(record && Object.entries(binding).every(([key, value]) => record[key] === value));
    function assertState(record) {
      assertBinding(record);
      assertStoredSession(record);
      assertSessionKey(record, session.key);
    }
    function save(patch) {
      return repository.withWorkspaceLock(workspace, () => {
        const current = repository.readWorkspace(workspace, stateRelative);
        if (current) {
          assertState(current);
          // Worker claim ownership is external; still refuse stale session writers.
          check(current.sequence === state.sequence);
        }
        state = repository.writeWorkspace(workspace, stateRelative, { ...state, ...patch, sequence: (state.sequence || 0) + 1, updatedAt: new Date(clock()).toISOString() });
        return state;
      });
    }
    repository.withWorkspaceLock(workspace, () => {
      state = repository.readWorkspace(workspace, stateRelative);
      if (state) assertState(state);
      else {
        state = repository.writeWorkspace(workspace, stateRelative, { ...binding, state: 'PREPARING', phase: 'PREPARE',
          key: session.key, remoteSessionId: null, manifestRelative: session.manifestRelative,
          sequence: 1, createdAt: new Date(clock()).toISOString() });
      }
    });
    const receipt = repository.readWorkspace(workspace, receiptRelative);
    if (receipt) {
      assertBinding(receipt);
      assertSessionKey(state, session.key, receipt);
      const terminal = terminalResult(receipt, session.manifest, state.remoteSessionId);
      return save({ state: terminal.status, phase: 'TERMINAL', receiptRelative,
        failureCode: terminal.status === 'REJECTED' ? 'REPORTING_RESUBMIT_REQUIRED' : null });
    }
    if (state.state === 'REJECTED') return state;
    if (state.state === 'COMMITTED') throw reportingError('REPORTING_STATE_CORRUPT');
    const started = clock(), deadline = started + timeouts.total;
    const transport = options.transport || createTransport({ repository, credentials, serverUrl, credentialGeneration, clock,
      timeouts: options.transportTimeouts });
    check(transport.serverUrl === serverUrl && transport.credentialGeneration === credentialGeneration);
    const requestTimeouts = transport.timeouts || DEFAULT_TIMEOUTS;
    const remaining = () => {
      const ms = deadline - clock();
      if (ms <= 0) throw reportingError('REPORTING_RUN_BUDGET_EXCEEDED');
      return ms;
    };
    const budget = kind => ({ timeout: Math.min(requestTimeouts[kind], remaining()) });
    function checkCredentials() {
      const status = credentials.status(serverUrl);
      if (!status.configured || status.generation !== credentialGeneration) throw reportingError('REPORTING_NEEDS_CREDENTIAL');
    }
    async function wait(ms) { await sleep(Math.min(ms, remaining())); remaining(); }
    async function finish(value) {
      const terminal = terminalResult(value, session.manifest, state.remoteSessionId);
      // The immutable receipt is durable before COMMITTED authorizes reference release.
      repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, receiptRelative, {
        ...binding, ...terminal, sessionKey: state.key, receivedAt: new Date(clock()).toISOString()
      }));
      return save({ state: terminal.status, phase: 'TERMINAL', receiptRelative,
        failureCode: terminal.status === 'REJECTED' ? 'REPORTING_RESUBMIT_REQUIRED' : null, nextRetryAt: null });
    }
    let limits, attempts = 0;
    try {
      checkCredentials();
      if (state.nextRetryAt && Date.parse(state.nextRetryAt) > clock()) return state;
      limits = constraints(await transport.capabilities(budget('ordinary')), session);
      while (attempts < 3) {
        try {
          checkCredentials(); remaining();
          let response;
          if (state.remoteSessionId) response = await transport.status(state.remoteSessionId, budget('ordinary'));
          else {
            save({ state: 'PREPARING', phase: 'PREPARE', nextRetryAt: null, failureCode: null });
            response = await transport.prepare(session.rawManifest, state.key, budget('ordinary'));
          }
          let remote = sessionResponse(response, session, state.remoteSessionId, limits);
          if (!state.remoteSessionId) save({ remoteSessionId: response.sessionId });
          if (remote.terminal) return await finish(remote.terminal);
          limits = remote.limits;
          if (state.phase === 'COMMIT' && state.commitStartedAt) {
            // A lost commit can still be validating on the server for five minutes.
            // Query until its independent validation budget elapses before retrying it.
            const until = Date.parse(state.commitStartedAt) + timeouts.commit;
            while (clock() < until) {
              await wait(Math.min(timeouts.poll, until - clock()));
              checkCredentials();
              response = await transport.status(state.remoteSessionId, budget('ordinary'));
              remote = sessionResponse(response, session, state.remoteSessionId, limits);
              if (remote.terminal) return await finish(remote.terminal);
            }
          }
          save({ state: 'UPLOADING', phase: 'UPLOAD', failureCode: null });
          for (const id of remote.missingFiles) {
            checkCredentials();
            await transport.upload(state.remoteSessionId, session.files.find(f => f.id === id), { ...budget('file'), limits });
          }
          save({ state: 'COMMITTING', phase: 'COMMIT', commitStartedAt: new Date(clock()).toISOString() });
          checkCredentials();
          const result = await transport.commit(state.remoteSessionId, { timeout: Math.min(requestTimeouts.commit, timeouts.commit, remaining()) });
          return await finish(result);
        } catch (error) {
          if (error.code === 'REPORTING_SESSION_EXPIRED') {
            attempts++;
            const key = crypto.randomUUID();
            save({ state: 'PREPARING', phase: 'PREPARE', remoteSessionId: null, key, commitStartedAt: null,
              keyRotations: [...(state.keyRotations || []), { reason: 'SESSION_EXPIRED',
                previousKey: state.key, key, sequence: state.sequence + 1 }] });
            continue;
          }
          if (!RETRYABLE.has(error.code) || ++attempts >= 3) throw error;
          await wait(timeouts.retry * 2 ** (attempts - 1));
        }
      }
      throw reportingError('REPORTING_RETRY_LIMIT');
    } catch (error) {
      if (!(error instanceof ReportingError) || /REPORTING_(STORAGE|STATE|PATH|LOCK)/.test(error.code)) throw error;
      const needsCredential = /^REPORTING_(NEEDS_CREDENTIAL|CREDENTIALS_)/.test(error.code);
      return save({ state: needsCredential ? 'NEEDS_CREDENTIAL' : 'RETRYABLE_FAILED', failureCode: error.code,
        ...(error.status ? { httpStatus: error.status } : {}),
        nextRetryAt: error.retryAfterMs !== undefined ? new Date(clock() + error.retryAfterMs).toISOString() : null });
    }
  }
  // Explicit user acceptance is authorized by Task4's service. This method owns
  // its short workspace lock; callers must not nest another workspace lock.
  function acceptCredentialChange(input) {
    const { workspace } = input;
    const packageId = safeId(input.packageId), localId = safeId(input.sessionId);
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const relative = `sessions/${packageId}/${localId}.json`;
    return repository.withWorkspaceLock(workspace, () => {
      const state = repository.readWorkspace(workspace, relative);
      assertStoredSession(state);
      const receipt = repository.readWorkspace(workspace, `receipts/${packageId}/${localId}.json`);
      if (receipt || ['COMMITTED', 'REJECTED'].includes(state.state)) throw reportingError('REPORTING_CREDENTIAL_REBIND_REFUSED');
      const identity = repository.readWorkspace(workspace, 'identity.json');
      const ready = repository.readWorkspace(workspace, `packages/${packageId}/package.json`);
      check(state.packageId === packageId && state.localId === localId && state.serverUrl === serverUrl
        && state.exportVersion === 1 && state.identityEpoch === identity?.identityEpoch
        && ready?.state === 'PACKAGE_READY' && ready.identityEpoch === state.identityEpoch);
      if (state.sequence !== input.expectedSequence || state.credentialGeneration !== input.previousGeneration) {
        throw reportingError('REPORTING_SESSION_CHANGED');
      }
      const current = credentials.status(serverUrl);
      if (!current.configured || current.generation !== input.credentialGeneration) throw reportingError('REPORTING_NEEDS_CREDENTIAL');
      return repository.writeWorkspace(workspace, relative, { ...state, credentialGeneration: current.generation,
        previousCredentialGeneration: state.credentialGeneration, credentialAcceptedAt: new Date(clock()).toISOString(),
        sequence: state.sequence + 1, failureCode: null, httpStatus: null, nextRetryAt: null,
        state: state.state === 'NEEDS_CREDENTIAL' ? 'RETRYABLE_FAILED' : state.state });
    });
  }
  return { runSession, acceptCredentialChange };
}
module.exports = { createSessionRunner, DEFAULT_SESSION_TIMEOUTS };
