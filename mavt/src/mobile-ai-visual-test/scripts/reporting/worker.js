'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createRepository, safeId } = require('./repository');
const { createJobQueue, RETENTION_MS } = require('./jobs');
const { createCredentials } = require('./credentials');
const { reportingError } = require('./errors');

const JOB_BUDGET_MS = 30 * 60000;
const MAX_ATTEMPTS = 3;
const TRANSIENT = new Set(['REPORTING_RETRY_LATER', 'REPORTING_NETWORK_ERROR', 'REPORTING_TIMEOUT',
  'REPORTING_UPLOAD_ERROR', 'REPORTING_RUN_BUDGET_EXCEEDED']);
function releaseFrozenData(workspace, packageId, repository, sessions, expired = false) {
  safeId(packageId);
  if (!expired && !sessions.every(item => repository.readWorkspace(workspace,
    `receipts/${packageId}/${item.id}.json`)?.status === 'COMMITTED'))
    throw reportingError('REPORTING_RECEIPT_MISSING');
  const root = path.join(path.resolve(workspace), '.mavt/reporting/packages', packageId);
  if (!fs.existsSync(root)) return;
  if (!fs.lstatSync(root).isDirectory()) throw reportingError('REPORTING_PATH_UNSAFE');
  for (const name of ['blobs', 'sessions']) {
    const target = path.join(root, name);
    if (!fs.existsSync(target)) continue;
    if (!fs.lstatSync(target).isDirectory()) throw reportingError('REPORTING_PATH_UNSAFE');
    fs.rmSync(target, { recursive: true, force: true });
  }
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function createWorker(options = {}) {
  const repository = options.repository || createRepository(options);
  const queue = options.queue || createJobQueue({ ...options, repository });
  const credentials = options.credentials || createCredentials({ repository });
  const clock = options.clock || Date.now;
  const collect = options.collectExport || ((...args) => require('./collector').collectExport(...args));
  const readFrozen = options.readFrozenExport || ((...args) => require('./collector').readFrozenExport(...args));
  const makeTransport = options.createTransport || (input => require('./transport').createTransport(input));
  const makeRunner = options.createSessionRunner || (input => require('./session').createSessionRunner(input));
  const launch = options.launcher || (() => {});
  const now = () => new Date(clock()).toISOString();
  function remaining(deadline) {
    const ms = deadline - clock();
    if (ms <= 0) throw reportingError('REPORTING_RUN_BUDGET_EXCEEDED');
    return ms;
  }
  async function processJob(workspace, claim, job) {
    const deadline = clock() + (options.jobBudgetMs || JOB_BUDGET_MS);
    const identity = repository.readWorkspace(workspace, 'identity.json');
    if (identity?.identityEpoch !== job.identityEpoch || job.exportVersion !== 1)
      throw reportingError('REPORTING_IDENTITY_STALE');
    if (job.packageId && clock() - Date.parse(job.createdAt) > RETENTION_MS) {
      queue.updateJob(workspace, claim, { state: 'EXPIRED_LOCAL', failureCode: 'REPORTING_LOCAL_EXPIRED' });
      try { releaseFrozenData(workspace, job.packageId, repository, job.sessions || [], true); }
      catch { queue.updateJob(workspace, claim, { metrics: { ...job.metrics, localCleanupPending: true } }); }
      return;
    }
    const journal = repository.readWorkspace(workspace, `jobs/${job.jobId}/credential-change.json`);
    if (journal?.state === 'PENDING') {
      if (journal.identityEpoch !== job.identityEpoch || journal.oldGeneration !== job.credentialGeneration
        && journal.newGeneration !== job.credentialGeneration)
        throw reportingError('REPORTING_SESSION_CHANGED');
      if (credentials.status(job.serverUrl).generation !== journal.newGeneration)
        throw reportingError('REPORTING_NEEDS_CREDENTIAL');
      const adopter = options.sessionRunner || makeRunner({ repository, credentials, clock });
      for (const item of job.sessions || []) {
        queue.assertOwner(workspace, claim);
        if (repository.readWorkspace(workspace, `receipts/${job.packageId}/${item.id}.json`)) continue;
        const state = repository.readWorkspace(workspace, `sessions/${job.packageId}/${item.id}.json`);
        if (!state || state.credentialGeneration === journal.newGeneration) continue;
        if (state.credentialGeneration !== journal.oldGeneration) throw reportingError('REPORTING_SESSION_CHANGED');
        adopter.acceptCredentialChange({ workspace, packageId: job.packageId, sessionId: item.id,
          serverUrl: job.serverUrl, previousGeneration: journal.oldGeneration,
          credentialGeneration: journal.newGeneration, expectedSequence: state.sequence });
      }
      job = queue.finishCredentialChange(workspace, claim, journal.newGeneration);
    }
    if (!job.credentialGeneration || credentials.status(job.serverUrl).generation !== job.credentialGeneration)
      return queue.updateJob(workspace, claim, { state: 'NEEDS_CREDENTIAL', failureCode: 'REPORTING_NEEDS_CREDENTIAL' });
    const metrics = { ...job.metrics };
    const baseTransport = options.transport || makeTransport({ repository, credentials, serverUrl: job.serverUrl,
      credentialGeneration: job.credentialGeneration, clock, timeouts: { ordinary: 15000, file: 180000, commit: 360000 } });
    if (baseTransport.serverUrl !== job.serverUrl || baseTransport.credentialGeneration !== job.credentialGeneration)
      throw reportingError('REPORTING_TRANSPORT_BINDING_INVALID');
    let packageId = job.packageId, sessions = job.sessions || [];
    if (!packageId) {
      queue.assertOwner(workspace, claim);
      const capabilities = await baseTransport.capabilities({ timeout: Math.min(15000, remaining(deadline)) });
      queue.assertOwner(workspace, claim);
      remaining(deadline);
      const frozen = await collect({ workspace, scope: job.scope, batchId: job.batchId || undefined,
        capabilities }, { repository, sourceReader: options.sourceReader });
      queue.assertOwner(workspace, claim);
      remaining(deadline);
      packageId = safeId(frozen.packageId);
      sessions = frozen.sessions.map(s => ({ id: safeId(s.id), state: 'QUEUED', receiptRelative: null }));
      metrics.frozenRawBytes = frozen.files.reduce((sum, file) => sum + file.bytes, 0);
      metrics.frozenUniqueFiles = frozen.files.length;
      const unique = new Map(frozen.files.map(file => [file.sha256, file.bytes]));
      metrics.frozenUniqueBytes = [...unique.values()].reduce((sum, bytes) => sum + bytes, 0);
      queue.updateJob(workspace, claim, { packageId, sessions, metrics, state: 'PREPARING' });
    }
    let acknowledgedRawBytes = metrics.acknowledgedRawBytes || 0;
    let acknowledgedWireBytes = metrics.acknowledgedWireBytes || 0;
    const transport = Object.assign(Object.create(baseTransport), {
      async upload(...args) {
        const result = await baseTransport.upload(...args);
        acknowledgedRawBytes += result.rawBytes || 0;
        acknowledgedWireBytes += result.wireBytes || 0;
        metrics.acknowledgedRawBytes = acknowledgedRawBytes;
        metrics.acknowledgedWireBytes = acknowledgedWireBytes;
        queue.updateJob(workspace, claim, { metrics });
        return result;
      }
    });
    for (const item of sessions) {
      queue.assertOwner(workspace, claim);
      remaining(deadline);
      const receiptRelative = `receipts/${packageId}/${item.id}.json`;
      const receipt = repository.readWorkspace(workspace, receiptRelative);
      if (receipt?.status === 'COMMITTED') {
        item.state = 'COMMITTED'; item.receiptRelative = receiptRelative;
        continue;
      }
      if (receipt?.status === 'REJECTED') {
        item.state = 'REJECTED'; item.receiptRelative = receiptRelative;
        continue;
      }
      const runner = options.sessionRunner || makeRunner({ repository, credentials, transport, readFrozenExport: readFrozen,
        clock, timeouts: { total: remaining(deadline) } });
      const result = await runner.runSession({ workspace, packageId, sessionId: item.id,
        serverUrl: job.serverUrl, credentialGeneration: job.credentialGeneration });
      queue.assertOwner(workspace, claim);
      item.state = result.state;
      item.failureCode = result.failureCode || null;
      item.nextRetryAt = result.nextRetryAt || null;
      item.receiptRelative = ['COMMITTED', 'REJECTED'].includes(result.state) ? receiptRelative : null;
      metrics.acknowledgedRawBytes = acknowledgedRawBytes;
      metrics.acknowledgedWireBytes = acknowledgedWireBytes;
      queue.updateJob(workspace, claim, { sessions, metrics, state: result.state === 'COMMITTED' ? 'UPLOADING' : result.state });
      if (result.state !== 'COMMITTED') break;
    }
    const committed = sessions.filter(s => s.state === 'COMMITTED').length;
    const unfinished = sessions.filter(s => s.state !== 'COMMITTED');
    let state = 'COMMITTED', failureCode = null, nextRetryAt = null;
    let retryableOutcome = false;
    if (unfinished.length) {
      const first = unfinished[0];
      state = committed ? 'PARTIAL' : first.state === 'REJECTED' ? 'REJECTED'
        : first.state === 'NEEDS_CREDENTIAL' ? 'NEEDS_CREDENTIAL' : 'RETRYABLE_FAILED';
      retryableOutcome = !['REJECTED', 'NEEDS_CREDENTIAL'].includes(first.state);
      failureCode = first.failureCode || (first.state === 'REJECTED' ? 'REPORTING_RESUBMIT_REQUIRED' : null);
      nextRetryAt = first.nextRetryAt || (retryableOutcome
        ? new Date(clock() + Math.min(3600000, 1000 * 2 ** Math.min(job.attempts || 0, 10))).toISOString() : null);
    }
    const attempts = retryableOutcome ? (job.attempts || 0) + 1 : job.attempts || 0;
    if (attempts >= MAX_ATTEMPTS && retryableOutcome) nextRetryAt = null;
    const updated = queue.updateJob(workspace, claim, { sessions, metrics, state, failureCode, nextRetryAt, attempts });
    if (state === 'COMMITTED') {
      try { releaseFrozenData(workspace, packageId, repository, sessions); }
      catch { queue.updateJob(workspace, claim, { metrics: { ...metrics, localCleanupPending: true } }); }
    }
    return updated;
  }
  async function runClaim(workspace, nonce, registration = {}) {
    const claim = queue.registerWorker(workspace, nonce, registration.pid || process.pid,
      registration.processStartedAt || queue.processStart(process.pid));
    let next = null;
    const heartbeat = setInterval(() => {
      try { queue.heartbeat(workspace, claim); }
      catch (error) {
        if (error.code !== 'REPORTING_LOCKED' && options.exitOnClaimLoss) process.exit(2);
      }
    }, options.heartbeatMs || 5000);
    heartbeat.unref();
    try {
      const job = queue.beginJob(workspace, claim);
      try { await processJob(workspace, claim, job); }
      catch (error) {
        const code = error.code?.startsWith('REPORTING_') ? error.code : 'REPORTING_WORKER_FAILED';
        const current = queue.readJob(workspace, job.jobId);
        const retryable = TRANSIENT.has(code) || (code === 'REPORTING_HTTP_FAILED' && error.status >= 500);
        const state = code === 'REPORTING_IDENTITY_STALE' ? 'EXPIRED_LOCAL'
          : code === 'REPORTING_NEEDS_CREDENTIAL' ? 'NEEDS_CREDENTIAL'
            : retryable ? 'RETRYABLE_FAILED' : current.packageId ? 'RETRYABLE_FAILED' : 'COLLECTION_FAILED';
        const attempts = (current.attempts || 0) + 1;
        const wait = error.retryAfterMs ?? Math.min(3600000, 1000 * 2 ** Math.min(attempts, 10));
        queue.updateJob(workspace, claim, { state, failureCode: code, attempts,
          ...(error.status ? { httpStatus: error.status } : {}),
          nextRetryAt: state === 'RETRYABLE_FAILED' && attempts < MAX_ATTEMPTS
            ? new Date(clock() + wait).toISOString() : null });
      }
    } finally {
      clearInterval(heartbeat);
      next = queue.releaseWorker(workspace, claim);
    }
    for (let attempts = 0; next && !next.code && attempts < 16; attempts++) {
      try { launch(next, workspace); break; }
      catch (error) {
        const code = error.code?.startsWith('MAVT_RUNTIME_BUNDLE_') ? 'REPORTING_BUNDLE_INVALID'
          : 'REPORTING_WORKER_LAUNCH_FAILED';
        next = queue.cancelReservation(workspace, next, code);
      }
    }
    return next;
  }
  return { runClaim, processJob };
}

async function main() {
  const [, , mode, workspace, nonce, configDir] = process.argv;
  if (mode === 'check') {
    const repository = createRepository({ configDir: workspace || undefined });
    const settings = require('./settings').createSettings({ repository }).read();
    const credentials = createCredentials({ repository });
    const generation = credentials.status(settings.serverUrl).generation;
    if (!generation) { process.stdout.write(JSON.stringify({ ok: false, code: 'REPORTING_NEEDS_CREDENTIAL' })); return; }
    try {
      const transport = require('./transport').createTransport({ repository, credentials,
        serverUrl: settings.serverUrl, credentialGeneration: generation, timeouts: { ordinary: 14000 } });
      await transport.capabilities({ timeout: 14000 });
      process.stdout.write(JSON.stringify({ ok: true, code: null, serverUrl: settings.serverUrl }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code?.startsWith('REPORTING_')
        ? error.code : 'REPORTING_CONNECTION_FAILED' }));
    }
    return;
  }
  if (mode !== 'run' || !workspace || !nonce) { process.exitCode = 2; return; }
  else {
    const { verifyBundle, RUNTIME_RELATIVE_ROOT } = require('../lib/runtime-bundle');
    const bundleRoot = path.resolve(__dirname, '../../../../');
    if (path.join(bundleRoot, RUNTIME_RELATIVE_ROOT, 'scripts/reporting/worker.js') !== __filename)
      throw reportingError('REPORTING_BUNDLE_INVALID');
    const manifest = verifyBundle(bundleRoot);
    const repository = createRepository({ configDir: configDir || undefined });
    const claim = repository.readWorkspace(workspace, 'worker-claim.json');
    if (claim?.bundleId !== manifest.bundleId || claim.nonce !== nonce)
      throw reportingError('REPORTING_WORKER_CLAIM_LOST');
    const watchdog = setTimeout(() => process.exit(2), JOB_BUDGET_MS);
    try {
      await createWorker({ repository, exitOnClaimLoss: true,
        launcher: (next, root) => require('./launcher').launchWorker(next, root,
        { configDir: repository.configDir }) }).runClaim(workspace, nonce);
    } finally { clearTimeout(watchdog); }
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 2; });
module.exports = { createWorker, JOB_BUDGET_MS, MAX_ATTEMPTS };
