'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRepository, safeId, EXPORT_VERSION } = require('./repository');
const { createSettings } = require('./settings');
const { createCredentials } = require('./credentials');
const { createIdentity } = require('./identity');
const { createIntents } = require('./intents');
const { reportingError, requireInput } = require('./errors');

const CLAIM_MS = 15000;
const RETENTION_MS = 7 * 86400000;
const RUNNABLE = new Set(['QUEUED', 'RETRYABLE_FAILED', 'PARTIAL', 'ADOPTING_CREDENTIAL', 'COLLECTING', 'PREPARING', 'UPLOADING', 'COMMITTING', 'RUNNING']);
const TERMINAL = new Set(['COMMITTED', 'REJECTED', 'EXPIRED_LOCAL', 'SKIPPED_NOT_STARTED', 'SKIPPED_UNCONFIGURED', 'SKIPPED_DISABLED']);
function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/.test(fields[19]) && bootId ? `linux:${bootId}:${fields[19]}` : null;
    } catch { return null; }
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function publicationState(workspace, batchId, repository) {
  const run = repository.readRunState(workspace, batchId);
  if (!run || !['COMPLETE', 'BLOCKED'].includes(run.phase)) return { state: 'SKIPPED_NOT_STARTED' };
  const base = path.join(path.resolve(workspace), 'runs', safeId(batchId));
  const batch = path.join(base, 'batch.json');
  if (!fs.existsSync(batch)) return { state: 'QUEUED' };
  try {
    const stat = fs.lstatSync(batch);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('invalid batch');
    const value = JSON.parse(fs.readFileSync(batch, 'utf8'));
    if (Array.isArray(value.cases) && value.cases.length && value.cases.every(item => !item.executionId))
      return { state: 'QUEUED' };
  } catch {
    return { state: 'WAITING_PUBLICATION', failureCode: 'REPORTING_RUN_STATE_INVALID', nextAction: 'RESOLVE_PUBLICATION' };
  }
  const file = path.join(base, 'report-publication.json');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error('invalid publication');
    const publication = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (publication.status === 'PUBLISHED') return { state: 'QUEUED' };
    const code = typeof publication.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(publication.errorCode)
      ? publication.errorCode : 'REPORTING_WAITING_PUBLICATION';
    return { state: 'WAITING_PUBLICATION', failureCode: code,
      nextAction: publication.status === 'RETRY_REQUIRED' ? 'RENDER_INDEX' : 'RESOLVE_PUBLICATION' };
  } catch {
    return { state: 'WAITING_PUBLICATION', failureCode: 'REPORTING_WAITING_PUBLICATION', nextAction: 'RESOLVE_PUBLICATION' };
  }
}
function createJobQueue(options = {}) {
  const repository = options.repository || createRepository(options);
  const settings = options.settings || createSettings({ repository });
  const credentials = options.credentials || createCredentials({ repository });
  const identity = options.identity || createIdentity({ repository });
  const intents = options.intents || createIntents({ repository, settings, credentials });
  const launcher = options.launcher || (() => {});
  const clock = options.clock || Date.now;
  const processIdentity = options.processIdentity || processStart;
  const isAlive = options.isAlive || processAlive;
  const now = () => new Date(clock()).toISOString();
  const jobPath = id => `jobs/${safeId(id)}/state.json`;
  const skipPath = id => `skips/${safeId(id)}.json`;
  const jobClaimPath = id => `jobs/${safeId(id)}/claim.json`;
  const readJob = (workspace, id) => repository.readWorkspace(workspace, jobPath(id));
  function readCompatible(workspace, relative) {
    try { return repository.readWorkspace(workspace, relative); }
    catch (error) {
      if (['REPORTING_STATE_VERSION_UNSUPPORTED', 'REPORTING_STATE_CORRUPT'].includes(error.code)) return null;
      throw error;
    }
  }
  function view(job) {
    if (!job) return null;
    const { jobId, state, scope, trigger, batchId, serverUrl, bundleId, createdAt, updatedAt, failureCode,
      nextRetryAt, packageId, sessions, metrics, nextAction } = job;
    const safeSessions = (sessions || []).map(item => ({ id: item.id, state: item.state,
      failureCode: item.failureCode || null, nextRetryAt: item.nextRetryAt || null,
      receiptReady: Boolean(item.receiptRelative) }));
    const safeMetrics = Object.fromEntries(['frozenRawBytes', 'frozenUniqueBytes', 'frozenUniqueFiles',
      'acknowledgedRawBytes', 'acknowledgedWireBytes', 'localCleanupPending']
      .filter(key => Object.hasOwn(metrics || {}, key)).map(key => [key, metrics[key]]));
    return { jobId, state, scope, trigger, batchId, serverUrl, bundleId, createdAt, updatedAt,
      failureCode: failureCode || null, nextRetryAt: nextRetryAt || null, packageId: packageId || null,
      sessions: safeSessions, metrics: safeMetrics, nextAction: nextAction || null };
  }
  function status(workspace, jobId) {
    if (jobId) return view(readJob(workspace, jobId) || repository.readWorkspace(workspace, skipPath(jobId)));
    return [...repository.listWorkspace(workspace, 'jobs').map(id => view(readJob(workspace, id))),
      ...repository.listWorkspace(workspace, 'skips').filter(id => id.endsWith('.json'))
        .map(id => view(repository.readWorkspace(workspace, `skips/${id}`)))].filter(Boolean);
  }
  function runnable(job) {
    return job && RUNNABLE.has(job.state)
      && (!['RETRYABLE_FAILED', 'PARTIAL'].includes(job.state) || (job.attempts || 0) < 3)
      && !(job.state === 'PARTIAL' && job.sessions?.some(item => ['NEEDS_CREDENTIAL', 'REJECTED'].includes(item.state)))
      && (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= clock());
  }
  function nextJob(workspace) {
    const epoch = repository.readWorkspace(workspace, 'identity.json')?.identityEpoch;
    return repository.listWorkspace(workspace, 'jobs').map(id => readCompatible(workspace, jobPath(id)))
      .filter(job => job?.exportVersion === EXPORT_VERSION && job.identityEpoch === epoch && runnable(job))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId))[0] || null;
  }
  function ownerBusy(claim) {
    if (!claim || claim.state === 'RELEASED') return false;
    if (claim.state === 'RESERVED') return Date.parse(claim.leaseUntil) > clock();
    if (claim.state !== 'ACTIVE' || !claim.processStartedAt || !claim.pid) return true;
    const observed = processIdentity(claim.pid);
    return observed === claim.processStartedAt || (observed === null && isAlive(claim.pid));
  }
  function releaseStale(workspace, existing) {
    if (!existing || existing.state === 'RELEASED' || ownerBusy(existing)) return false;
    const owned = readCompatible(workspace, jobClaimPath(existing.jobId));
    if (owned?.state !== 'RELEASED' && owned?.nonce === existing.nonce && owned?.epoch === existing.epoch)
      repository.writeWorkspace(workspace, jobClaimPath(existing.jobId), { ...owned,
        state: 'RELEASED', releasedAt: now() });
    const job = readCompatible(workspace, jobPath(existing.jobId));
    if (job?.exportVersion === EXPORT_VERSION
      && ['RUNNING', 'COLLECTING', 'PREPARING', 'UPLOADING', 'COMMITTING'].includes(job.state))
      repository.writeWorkspace(workspace, jobPath(job.jobId), { ...job, state: 'RETRYABLE_FAILED',
        failureCode: 'REPORTING_WORKER_INTERRUPTED', nextRetryAt: null, updatedAt: now() });
    repository.writeWorkspace(workspace, 'worker-claim.json', { ...existing, state: 'RELEASED', releasedAt: now() });
    return true;
  }
  function reserveLocked(workspace) {
    const existing = repository.readWorkspace(workspace, 'worker-claim.json');
    if (ownerBusy(existing)) return { code: 'REPORTING_WORKER_BUSY' };
    releaseStale(workspace, existing);
    const job = nextJob(workspace);
    if (!job) return null;
    const claim = repository.writeWorkspace(workspace, 'worker-claim.json', {
      state: 'RESERVED', nonce: crypto.randomUUID(), epoch: (existing?.epoch || 0) + 1,
      identityEpoch: job.identityEpoch, jobId: job.jobId, bundleId: job.bundleId, runtimeRoot: job.runtimeRoot,
      pid: null, processStartedAt: null, leaseUntil: new Date(clock() + CLAIM_MS).toISOString(), createdAt: now()
    });
    return claim;
  }
  function reserveWorker(workspace) { return repository.withWorkspaceLock(workspace, () => reserveLocked(workspace)); }
  function reapDeadClaim(workspace) {
    return repository.withWorkspaceLock(workspace, () =>
      releaseStale(workspace, repository.readWorkspace(workspace, 'worker-claim.json')));
  }
  function launchReserved(workspace, first) {
    let claim = first;
    for (let failures = 0; claim && !claim.code && failures < 16; failures++) {
      try { launcher(claim, workspace); return null; }
      catch (error) {
        const code = error.code?.startsWith('MAVT_RUNTIME_BUNDLE_') ? 'REPORTING_BUNDLE_INVALID'
          : 'REPORTING_WORKER_LAUNCH_FAILED';
        claim = cancelReservation(workspace, claim, code);
      }
    }
    return claim?.code || null;
  }
  function registerWorker(workspace, nonce, pid = process.pid, startedAt = processIdentity(pid)) {
    return repository.withWorkspaceLock(workspace, () => {
      const claim = repository.readWorkspace(workspace, 'worker-claim.json');
      const current = repository.readWorkspace(workspace, 'identity.json');
      if (!claim || claim.state !== 'RESERVED' || claim.nonce !== nonce || claim.identityEpoch !== current?.identityEpoch
        || Date.parse(claim.leaseUntil) <= clock() || !startedAt || processIdentity(pid) !== startedAt)
        throw reportingError('REPORTING_WORKER_CLAIM_LOST');
      return repository.writeWorkspace(workspace, 'worker-claim.json', {
        ...claim, state: 'ACTIVE', pid, processStartedAt: startedAt,
        leaseUntil: new Date(clock() + CLAIM_MS).toISOString(), updatedAt: now()
      });
    });
  }
  function assertOwner(workspace, claim) {
    const current = repository.readWorkspace(workspace, 'worker-claim.json');
    if (!current || current.state !== 'ACTIVE' || current.nonce !== claim.nonce || current.epoch !== claim.epoch
      || current.identityEpoch !== claim.identityEpoch || current.pid !== claim.pid
      || current.processStartedAt !== claim.processStartedAt || processIdentity(current.pid) !== current.processStartedAt)
      throw reportingError('REPORTING_WORKER_CLAIM_LOST');
    return current;
  }
  function heartbeat(workspace, claim) {
    return repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, 'worker-claim.json', {
      ...assertOwner(workspace, claim), leaseUntil: new Date(clock() + CLAIM_MS).toISOString(), updatedAt: now()
    }));
  }
  function beginJob(workspace, claim) {
    return repository.withWorkspaceLock(workspace, () => {
      assertOwner(workspace, claim);
      const job = readJob(workspace, claim.jobId);
      if (!runnable(job) || job.bundleId !== claim.bundleId || job.identityEpoch !== claim.identityEpoch)
        throw reportingError('REPORTING_JOB_NOT_RUNNABLE');
      repository.writeWorkspace(workspace, jobClaimPath(job.jobId), { state: 'ACTIVE', nonce: claim.nonce,
        epoch: claim.epoch, identityEpoch: claim.identityEpoch, pid: claim.pid, processStartedAt: claim.processStartedAt });
      return repository.writeWorkspace(workspace, jobPath(job.jobId), { ...job,
        state: job.packageId ? 'RUNNING' : 'COLLECTING', updatedAt: now() });
    });
  }
  function updateJob(workspace, claim, patch) {
    return repository.withWorkspaceLock(workspace, () => {
      assertOwner(workspace, claim);
      const job = readJob(workspace, claim.jobId), owned = repository.readWorkspace(workspace, jobClaimPath(claim.jobId));
      if (!owned || owned.state !== 'ACTIVE' || owned.nonce !== claim.nonce || owned.epoch !== claim.epoch)
        throw reportingError('REPORTING_WORKER_CLAIM_LOST');
      return repository.writeWorkspace(workspace, jobPath(job.jobId), { ...job, ...patch, updatedAt: now() });
    });
  }
  function releaseWorker(workspace, claim) {
    return repository.withWorkspaceLock(workspace, () => {
      assertOwner(workspace, claim);
      const owned = repository.readWorkspace(workspace, jobClaimPath(claim.jobId));
      if (owned?.nonce === claim.nonce && owned.state !== 'RELEASED')
        repository.writeWorkspace(workspace, jobClaimPath(claim.jobId), { ...owned, state: 'RELEASED', releasedAt: now() });
      repository.writeWorkspace(workspace, 'worker-claim.json', { ...claim, state: 'RELEASED', releasedAt: now() });
      return reserveLocked(workspace);
    });
  }
  function submit(input) {
    requireInput(input && typeof input.workspace === 'string' && ['batch', 'workspace'].includes(input.scope)
      && ['automatic', 'manual'].includes(input.trigger) && (input.scope === 'batch') === (input.trigger === 'automatic'));
    if (input.scope === 'batch') safeId(input.batchId);
    const snapshot = input.trigger === 'automatic' ? intents.readRunSnapshot(input.workspace, input.batchId) : null;
    const target = snapshot ? snapshot.serverUrl : input.trigger === 'manual' ? settings.read().serverUrl : null;
    const generation = snapshot ? snapshot.credentialGeneration : target ? credentials.status(target).generation : null;
    const enabled = snapshot ? snapshot.autoUpload : true;
    let state = 'QUEUED', failureCode = null, nextAction = null;
    if (input.trigger === 'automatic' && !snapshot) state = 'SKIPPED_NOT_STARTED';
    else if (!enabled) state = 'SKIPPED_DISABLED';
    else if (!generation) state = 'SKIPPED_UNCONFIGURED';
    else if (input.trigger === 'automatic') {
      const publication = publicationState(input.workspace, input.batchId, repository);
      ({ state, failureCode = null, nextAction = null } = publication);
    }
    if (state.startsWith('SKIPPED_')) {
      const jobId = input.trigger === 'automatic'
        ? crypto.createHash('sha256').update(JSON.stringify([input.batchId, target, EXPORT_VERSION])).digest('hex')
        : crypto.randomUUID();
      const existing = repository.readWorkspace(input.workspace, skipPath(jobId));
      const skipped = existing || repository.withWorkspaceLock(input.workspace, () =>
        repository.writeWorkspace(input.workspace, skipPath(jobId), { jobId, state, failureCode,
          nextAction, scope: input.scope, trigger: input.trigger, batchId: input.batchId || null,
          serverUrl: target, createdAt: now(), updatedAt: now() }));
      return { jobId: skipped.jobId, state: skipped.state, serverUrl: skipped.serverUrl };
    }
    const ident = identity.ensure(input.workspace);
    const intent = intents.enqueue({ ...input, serverUrl: target, credentialGeneration: generation,
      identityEpoch: ident.identityEpoch, exportVersion: EXPORT_VERSION });
    const job = repository.withWorkspaceLock(input.workspace, () => {
      const prior = readJob(input.workspace, intent.intentId);
      if (prior) return prior;
      return repository.writeWorkspace(input.workspace, jobPath(intent.intentId), {
        jobId: intent.intentId, intentId: intent.intentId, state, failureCode, nextAction,
        scope: input.scope, trigger: input.trigger, batchId: input.batchId || null,
        serverUrl: target, credentialGeneration: generation, identityEpoch: ident.identityEpoch,
        exportVersion: EXPORT_VERSION, runtimeRoot: input.runtimeRoot || null, bundleId: input.bundleId || null,
        packageId: null, sessions: [], attempts: 0, metrics: {}, createdAt: now(), updatedAt: now()
      });
    });
    if (job.state === 'QUEUED') {
      const reservation = reserveWorker(input.workspace);
      launchReserved(input.workspace, reservation);
    }
    const current = readJob(input.workspace, job.jobId);
    return { jobId: current.jobId, state: current.state, serverUrl: current.serverUrl,
      ...(current.failureCode ? { code: current.failureCode } : {}) };
  }
  function cancelReservation(workspace, reservation, code = null) {
    return repository.withWorkspaceLock(workspace, () => {
      const current = repository.readWorkspace(workspace, 'worker-claim.json');
      if (current?.state !== 'RESERVED' || current.nonce !== reservation.nonce || current.epoch !== reservation.epoch)
        return { code: 'REPORTING_WORKER_BUSY' };
      if (code) {
        const job = readJob(workspace, reservation.jobId);
        repository.writeWorkspace(workspace, jobPath(job.jobId), { ...job, state: 'COLLECTION_FAILED',
          failureCode: code, nextRetryAt: null, updatedAt: now() });
      }
      repository.writeWorkspace(workspace, 'worker-claim.json', { ...current, state: 'RELEASED', releasedAt: now() });
      return reserveLocked(workspace);
    });
  }
  function retry(workspace, jobId, retryOptions = {}) {
    const job = readJob(workspace, jobId);
    if (!job) throw reportingError('REPORTING_JOB_NOT_FOUND');
    if (job.exportVersion !== EXPORT_VERSION) throw reportingError('REPORTING_STATE_VERSION_UNSUPPORTED');
    if (job.identityEpoch !== repository.readWorkspace(workspace, 'identity.json')?.identityEpoch)
      throw reportingError('REPORTING_IDENTITY_STALE');
    if (job.state === 'REJECTED') throw reportingError('REPORTING_RESUBMIT_REQUIRED');
    if (job.state === 'EXPIRED_LOCAL') throw reportingError('REPORTING_RESUBMIT_REQUIRED');
    if (TERMINAL.has(job.state)) return { jobId, state: job.state, serverUrl: job.serverUrl };
    if (job.state === 'WAITING_PUBLICATION') {
      const publication = publicationState(workspace, job.batchId, repository);
      if (publication.state !== 'QUEUED') {
        repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, jobPath(jobId), {
          ...readJob(workspace, jobId), state: 'WAITING_PUBLICATION', failureCode: publication.failureCode,
          nextAction: publication.nextAction, updatedAt: now()
        }));
        return { jobId, state: 'WAITING_PUBLICATION', serverUrl: job.serverUrl, code: publication.failureCode };
      }
    }
    if (job.sessions?.some(item => item.state === 'REJECTED')) throw reportingError('REPORTING_RESUBMIT_REQUIRED');
    const currentGeneration = credentials.status(job.serverUrl).generation;
    if (!currentGeneration) return { jobId, state: 'NEEDS_CREDENTIAL', serverUrl: job.serverUrl,
      code: 'REPORTING_NEEDS_CREDENTIAL' };
    if (currentGeneration !== job.credentialGeneration && retryOptions.acceptCredentialChange !== true)
      return { jobId, state: 'NEEDS_CREDENTIAL', serverUrl: job.serverUrl, code: 'REPORTING_NEEDS_CREDENTIAL' };
    if ((job.state === 'NEEDS_CREDENTIAL' || job.sessions?.some(item => item.state === 'NEEDS_CREDENTIAL'))
      && currentGeneration === job.credentialGeneration)
      return { jobId, state: 'NEEDS_CREDENTIAL', serverUrl: job.serverUrl, code: 'REPORTING_NEEDS_CREDENTIAL' };
    const updated = repository.withWorkspaceLock(workspace, () => {
      const current = readJob(workspace, jobId);
      if (current.identityEpoch !== repository.readWorkspace(workspace, 'identity.json')?.identityEpoch)
        throw reportingError('REPORTING_IDENTITY_STALE');
      if (ownerBusy(repository.readWorkspace(workspace, 'worker-claim.json')))
        throw reportingError('REPORTING_WORKER_BUSY');
      if (currentGeneration !== current.credentialGeneration) {
        const relative = `jobs/${jobId}/credential-change.json`;
        const existing = repository.readWorkspace(workspace, relative);
        if (existing && existing.state === 'PENDING'
          && (existing.oldGeneration !== current.credentialGeneration || existing.newGeneration !== currentGeneration))
          throw reportingError('REPORTING_SESSION_CHANGED');
        if (!existing || existing.state !== 'PENDING')
          repository.writeWorkspace(workspace, relative, { state: 'PENDING', oldGeneration: current.credentialGeneration,
            newGeneration: currentGeneration, identityEpoch: current.identityEpoch, createdAt: now() });
        return repository.writeWorkspace(workspace, jobPath(jobId), { ...current,
          state: 'ADOPTING_CREDENTIAL', nextRetryAt: null, updatedAt: now() });
      }
      return repository.writeWorkspace(workspace, jobPath(jobId), { ...current, state: current.packageId ? 'PARTIAL' : 'QUEUED',
        attempts: 0, nextRetryAt: null, updatedAt: now() });
    });
    const reservation = reserveWorker(workspace);
    launchReserved(workspace, reservation);
    const current = readJob(workspace, jobId);
    return { jobId, state: current.state, serverUrl: current.serverUrl,
      ...(current.failureCode ? { code: current.failureCode } : {}) };
  }
  function finishCredentialChange(workspace, claim, generation) {
    return repository.withWorkspaceLock(workspace, () => {
      assertOwner(workspace, claim);
      const job = readJob(workspace, claim.jobId);
      const relative = `jobs/${job.jobId}/credential-change.json`;
      const journal = repository.readWorkspace(workspace, relative);
      if (!journal || journal.state !== 'PENDING' || journal.newGeneration !== generation
        || journal.identityEpoch !== job.identityEpoch) throw reportingError('REPORTING_SESSION_CHANGED');
      const updated = repository.writeWorkspace(workspace, jobPath(job.jobId), { ...job,
        credentialGeneration: generation, sessions: job.sessions.map(item => item.state === 'COMMITTED' ? item : {
          ...item, state: 'QUEUED', failureCode: null, nextRetryAt: null
        }), state: job.packageId ? 'RUNNING' : 'COLLECTING', attempts: 0, nextRetryAt: null,
        failureCode: null, updatedAt: now() });
      repository.writeWorkspace(workspace, relative, { ...journal, state: 'COMPLETED', completedAt: now() });
      return updated;
    });
  }
  return { submit, status, retry, reserveWorker, reapDeadClaim, registerWorker, assertOwner, heartbeat, beginJob, updateJob,
    releaseWorker, cancelReservation, launchReserved, finishCredentialChange, readJob, processStart, RETENTION_MS };
}
module.exports = { createJobQueue, processStart, CLAIM_MS, RETENTION_MS };
