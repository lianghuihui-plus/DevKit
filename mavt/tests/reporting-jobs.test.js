'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createRepository } = require('../src/mobile-ai-visual-test/scripts/reporting/repository');
const { createJobQueue } = require('../src/mobile-ai-visual-test/scripts/reporting/jobs');
const { createWorker } = require('../src/mobile-ai-visual-test/scripts/reporting/worker');
const { launchWorker } = require('../src/mobile-ai-visual-test/scripts/reporting/launcher');
const { createReportingService } = require('../src/mobile-ai-visual-test/scripts/reporting/service');
const { createManifest, pinBundle } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
const { publishManagedRun, runCommand } = require('../src/mobile-ai-visual-test/scripts/lib/runtime-binding');
const { confirmEnvironment, createExecutionRequest } = require('../src/mobile-ai-visual-test/scripts/lib/run-control');
const { createCaseContract } = require('../src/mobile-ai-visual-test/scripts/execution/contracts/case-contract');
const { publishSnapshot, bindTerminalResource } = require('../src/mobile-ai-visual-test/scripts/coordinator/agent-resource-store');
const { recordAgentFacingEvent } = require('../src/mobile-ai-visual-test/scripts/lib/agent-facing-telemetry');
const { createSettings } = require('../src/mobile-ai-visual-test/scripts/reporting/settings');
const { capabilities } = require('./support/reporting-http-fixture');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: 'mobile-ai-visual-test-workspace', initializationState: 'READY', name: 'Fixture' }));
  const repository = createRepository({ configDir: path.join(root, 'config') });
  return { root, workspace, repository };
}

test('manual submit persists a job and never performs network work', t => {
  const { workspace, repository } = fixture(t);
  const launches = [];
  const queue = createJobQueue({ repository, launcher: claim => launches.push(claim), credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const result = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: '/fixed/runtime', bundleId: 'b'.repeat(64) });
  assert.equal(result.state, 'QUEUED');
  assert.equal(launches.length, 1);
  assert.equal(queue.status(workspace, result.jobId).state, 'QUEUED');
  assert.equal(repository.readWorkspace(workspace, `jobs/${result.jobId}/state.json`).credentialGeneration, 'a'.repeat(64));
});

test('status of an absent job creates no state or launch', t => {
  const { workspace, repository } = fixture(t);
  let launched = 0;
  const queue = createJobQueue({ repository, launcher: () => launched++ });
  assert.equal(queue.status(workspace, 'absent'), null);
  assert.equal(fs.existsSync(path.join(workspace, '.mavt')), false);
  assert.equal(launched, 0);
});

test('a live owner remains busy after lease expiry and a reused PID can be reclaimed', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  let start = 'process-one';
  const queue = createJobQueue({ repository, clock: () => now, processIdentity: () => start, launcher: () => {}, credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const job = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: '/fixed/runtime', bundleId: 'b'.repeat(64) });
  const first = repository.readWorkspace(workspace, 'worker-claim.json');
  queue.registerWorker(workspace, first.nonce, 123, 'process-one');
  now += 60000;
  assert.equal(queue.reserveWorker(workspace).code, 'REPORTING_WORKER_BUSY');
  start = 'process-two';
  const replacement = queue.reserveWorker(workspace);
  assert.notEqual(replacement.nonce, first.nonce);
  assert.equal(replacement.jobId, job.jobId);
});

test('a confirmed dead owner is released even when no runnable work remains', t => {
  const { workspace, repository } = fixture(t);
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => null, isAlive: () => false,
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const submitted = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const reserved = repository.readWorkspace(workspace, 'worker-claim.json');
  repository.withWorkspaceLock(workspace, () => {
    repository.writeWorkspace(workspace, 'worker-claim.json', { ...reserved, state: 'ACTIVE', pid: 4321, processStartedAt: 'old-start' });
    repository.writeWorkspace(workspace, `jobs/${submitted.jobId}/claim.json`, { state: 'ACTIVE', nonce: reserved.nonce,
      epoch: reserved.epoch, pid: 4321, processStartedAt: 'old-start' });
    repository.writeWorkspace(workspace, `jobs/${submitted.jobId}/state.json`, {
      ...repository.readWorkspace(workspace, `jobs/${submitted.jobId}/state.json`), state: 'COMMITTED'
    });
  });
  assert.equal(queue.reserveWorker(workspace), null);
  assert.equal(repository.readWorkspace(workspace, 'worker-claim.json').state, 'RELEASED');
  assert.equal(repository.readWorkspace(workspace, `jobs/${submitted.jobId}/claim.json`).state, 'RELEASED');
});

test('identity reset reaps a confirmed dead worker but refuses an uncertain live owner', t => {
  const { workspace, repository } = fixture(t);
  const credentials = { status: () => ({ configured: true, generation: 'a'.repeat(64) }) };
  const queue = createJobQueue({ repository, launcher: () => {}, credentials,
    processIdentity: () => null, isAlive: () => false });
  const submitted = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const original = repository.readWorkspace(workspace, 'identity.json').identityEpoch;
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  repository.withWorkspaceLock(workspace, () => {
    repository.writeWorkspace(workspace, 'worker-claim.json', { ...claim, state: 'ACTIVE', pid: 4321, processStartedAt: 'old-start' });
    repository.writeWorkspace(workspace, `jobs/${submitted.jobId}/claim.json`, { state: 'ACTIVE', nonce: claim.nonce,
      epoch: claim.epoch, pid: 4321, processStartedAt: 'old-start' });
    repository.writeWorkspace(workspace, `jobs/${submitted.jobId}/state.json`, {
      ...repository.readWorkspace(workspace, `jobs/${submitted.jobId}/state.json`), state: 'RUNNING'
    });
  });
  const service = createReportingService({ repository, jobs: queue });
  const reset = service.resetIdentity(workspace);
  assert.notEqual(reset.identityEpoch, original);
  assert.equal(Object.hasOwn(reset, 'anonymizationSalt'), false);
  assert.equal(repository.readWorkspace(workspace, `jobs/${submitted.jobId}/state.json`).state, 'RETRYABLE_FAILED');
});

test('identity reset refuses a worker whose process may still be alive', t => {
  const { workspace, repository } = fixture(t);
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => null,
    isAlive: () => true, credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const original = repository.readWorkspace(workspace, 'identity.json').identityEpoch;
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, 'worker-claim.json', {
    ...claim, state: 'ACTIVE', pid: 4321, processStartedAt: 'unavailable'
  }));
  assert.throws(() => createReportingService({ repository, jobs: queue }).resetIdentity(workspace),
    { code: 'REPORTING_IDENTITY_BUSY' });
  assert.equal(repository.readWorkspace(workspace, 'identity.json').identityEpoch, original);
});

test('retry can requeue one job while another worker owns the workspace', t => {
  const { workspace, repository } = fixture(t);
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started',
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const claim = queue.registerWorker(workspace, repository.readWorkspace(workspace, 'worker-claim.json').nonce, 123, 'started');
  queue.beginJob(workspace, claim);
  const second = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${second.jobId}/state.json`, {
    ...repository.readWorkspace(workspace, `jobs/${second.jobId}/state.json`), state: 'RETRYABLE_FAILED', nextRetryAt: null
  }));
  assert.equal(queue.retry(workspace, second.jobId).state, 'QUEUED');
  queue.updateJob(workspace, claim, { state: 'COMMITTED' });
  assert.equal(queue.releaseWorker(workspace, claim).jobId, second.jobId);
  assert.equal(queue.status(workspace, first.jobId).state, 'COMMITTED');
});

test('retry rechecks export version under its write lock', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  let upgrade = false;
  const guarded = { ...repository, withWorkspaceLock(root, callback) {
    if (upgrade) {
      upgrade = false;
      const path = `jobs/${submitted.jobId}/state.json`;
      repository.writeWorkspace(root, path, { ...repository.readWorkspace(root, path), exportVersion: 2 });
    }
    return repository.withWorkspaceLock(root, callback);
  } };
  const queue = createJobQueue({ repository: guarded, clock: () => now, launcher: () => {},
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const submitted = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  now += 16000;
  upgrade = true;
  assert.throws(() => queue.retry(workspace, submitted.jobId), { code: 'REPORTING_STATE_VERSION_UNSUPPORTED' });
  assert.equal(repository.readWorkspace(workspace, `jobs/${submitted.jobId}/state.json`).exportVersion, 2);
});

test('retry refuses an old identity epoch and unsupported export version without rewriting state', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.now();
  const queue = createJobQueue({ repository, clock: () => now, launcher: () => {},
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const original = repository.readWorkspace(workspace, `jobs/${first.jobId}/state.json`);
  now += 16000;
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${first.jobId}/state.json`, {
    ...original, exportVersion: 2
  }));
  assert.throws(() => queue.retry(workspace, first.jobId), { code: 'REPORTING_STATE_VERSION_UNSUPPORTED' });
  assert.equal(queue.reserveWorker(workspace), null);
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${first.jobId}/state.json`, original));
  const service = createReportingService({ repository, jobs: queue });
  service.resetIdentity(workspace);
  assert.throws(() => queue.retry(workspace, first.jobId), { code: 'REPORTING_IDENTITY_STALE' });
});

test('an expired reservation for a future-schema job does not block another job', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  const queue = createJobQueue({ repository, clock: () => now, launcher: () => {},
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const second = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const firstPath = path.join(workspace, '.mavt', 'reporting', 'jobs', first.jobId, 'state.json');
  const futureState = JSON.stringify({ ...repository.readWorkspace(workspace, `jobs/${first.jobId}/state.json`), schemaVersion: 2 });
  fs.writeFileSync(firstPath, futureState);

  now += 16000;
  const claim = queue.reserveWorker(workspace);
  assert.equal(claim.jobId, second.jobId);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), futureState);
});

test('an expired reservation does not rewrite a job with a future export version', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  const queue = createJobQueue({ repository, clock: () => now, launcher: () => {},
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const second = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const firstPath = path.join(workspace, '.mavt', 'reporting', 'jobs', first.jobId, 'state.json');
  const futureState = JSON.stringify({ ...repository.readWorkspace(workspace, `jobs/${first.jobId}/state.json`),
    state: 'RUNNING', exportVersion: 2 });
  fs.writeFileSync(firstPath, futureState);

  now += 16000;
  const claim = queue.reserveWorker(workspace);
  assert.equal(claim.jobId, second.jobId);
  assert.equal(fs.readFileSync(firstPath, 'utf8'), futureState);
});

test('credential wait and future retry do not block another runnable job', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  const queue = createJobQueue({ repository, clock: () => now, launcher: () => {}, credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: '/fixed/runtime', bundleId: 'b'.repeat(64) });
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${first.jobId}/state.json`, { ...repository.readWorkspace(workspace, `jobs/${first.jobId}/state.json`), state: 'NEEDS_CREDENTIAL' }));
  const second = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: '/fixed/runtime', bundleId: 'b'.repeat(64) });
  now += 16000;
  queue.reserveWorker(workspace);
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  assert.equal(claim.jobId, second.jobId);
});

test('worker negotiates capabilities before one collection and commits each frozen session', async t => {
  const { workspace, repository } = fixture(t);
  const calls = [];
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started',
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const submitted = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: '/fixed/runtime', bundleId: 'b'.repeat(64) });
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  const worker = createWorker({ repository, queue, processIdentity: () => 'started',
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) },
    transport: { serverUrl: submitted.serverUrl, credentialGeneration: 'a'.repeat(64), capabilities: async () => { calls.push('capabilities'); return { protocolVersion: '2.0' }; } },
    collectExport: async request => { calls.push('collect'); assert.equal(request.capabilities.protocolVersion, '2.0'); return { packageId: 'package-1', files: [], sessions: [{ id: 'session-0001' }, { id: 'session-0002' }] }; },
    sessionRunner: { runSession: async input => { calls.push(input.sessionId); repository.writeWorkspace(workspace, `receipts/package-1/${input.sessionId}.json`, { status: 'COMMITTED' }); return { state: 'COMMITTED' }; } } });
  await worker.runClaim(workspace, claim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.deepEqual(calls, ['capabilities', 'collect', 'session-0001', 'session-0002']);
  assert.equal(queue.status(workspace, submitted.jobId).state, 'COMMITTED');
});

test('launcher runs only an intact fixed bundle in an independent process group', async t => {
  const { workspace } = fixture(t);
  const root = path.join(workspace, '.mavt/runtime-bundles');
  const staging = path.join(root, 'fixture');
  const entry = path.join(staging, 'runtime/mobile-ai-visual-test/scripts/reporting/worker.js');
  const marker = path.join(workspace, 'child-alive');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(path.join(staging, 'hosts/codex'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'hosts/codex/delegation.md'), 'fixture');
  fs.writeFileSync(entry, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 250)`);
  const manifest = createManifest(staging, 'fixture');
  fs.writeFileSync(path.join(staging, 'bundle.manifest.json'), JSON.stringify(manifest));
  fs.renameSync(staging, path.join(root, manifest.bundleId));
  const parent = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../src/mobile-ai-visual-test/scripts/reporting/launcher'))}).launchWorker({bundleId:${JSON.stringify(manifest.bundleId)},nonce:'nonce'},${JSON.stringify(workspace)})`],
    { encoding: 'utf8', timeout: 3000 });
  assert.equal(parent.status, 0);
  for (let i = 0; i < 30 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'alive');
  fs.appendFileSync(path.join(root, manifest.bundleId, 'hosts/codex/delegation.md'), 'changed');
  assert.throws(() => launchWorker({ bundleId: manifest.bundleId, nonce: 'nonce' }, workspace));
});

test('service status and preflight stay local and read only', t => {
  const { workspace, repository } = fixture(t);
  let launched = 0;
  const service = createReportingService({ repository, launcher: () => launched++ });
  const before = fs.readdirSync(workspace);
  assert.equal(service.preflight(workspace).autoUpload, true);
  assert.deepEqual(service.status(workspace), []);
  assert.deepEqual(fs.readdirSync(workspace), before);
  assert.equal(launched, 0);
});

test('missing credential records a skip without allocating workspace identity', t => {
  const { workspace, repository } = fixture(t);
  const queue = createJobQueue({ repository, launcher: () => assert.fail('should not launch') });
  const result = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(result.state, 'SKIPPED_UNCONFIGURED');
  assert.equal(repository.readWorkspace(workspace, 'identity.json'), null);
  assert.equal(queue.status(workspace, result.jobId).state, 'SKIPPED_UNCONFIGURED');
  const serverUrl = 'http://127.0.0.1:12345/fixture/';
  createSettings({ repository }).update({ serverUrl });
  repository.writeConfig('credentials.json', { targets: { [serverUrl]: { token: 'anonymous-test-token' } } });
  const configured = createJobQueue({ repository, launcher: () => {} });
  const next = configured.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(next.state, 'QUEUED');
  assert.equal(typeof repository.readWorkspace(workspace, 'identity.json').identityEpoch, 'string');
});

test('an exhausted retryable job is not automatically reserved again', t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  const queue = createJobQueue({ repository, clock: () => now, launcher: () => {},
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const result = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${result.jobId}/state.json`, {
    ...repository.readWorkspace(workspace, `jobs/${result.jobId}/state.json`), state: 'RETRYABLE_FAILED', attempts: 3, nextRetryAt: null
  }));
  now += 16000;
  assert.equal(queue.reserveWorker(workspace), null);
});

test('explicit credential acceptance journals and resumes only an unfinished session', async t => {
  const { workspace, repository } = fixture(t);
  let now = Date.parse('2026-10-23T00:00:00Z');
  let generation = 'a'.repeat(64);
  const credentials = { status: () => ({ configured: true, generation }) };
  const queue = createJobQueue({ repository, clock: () => now, launcher: () => {}, processIdentity: () => 'started', credentials });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const initial = repository.readWorkspace(workspace, `jobs/${first.jobId}/state.json`);
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${first.jobId}/state.json`, {
    ...initial, state: 'NEEDS_CREDENTIAL', packageId: 'frozen-1',
    sessions: [{ id: 'session-0001', state: 'COMMITTED', receiptRelative: 'receipts/frozen-1/session-0001.json' },
      { id: 'session-0002', state: 'NEEDS_CREDENTIAL' }]
  }));
  repository.writeWorkspace(workspace, 'receipts/frozen-1/session-0001.json', { status: 'COMMITTED' });
  repository.writeWorkspace(workspace, 'sessions/frozen-1/session-0002.json', { state: 'NEEDS_CREDENTIAL',
    sequence: 4, credentialGeneration: generation, key: 'fixed-key', remoteSessionId: 'remote-id' });
  generation = 'b'.repeat(64);
  now += 16000;
  assert.equal(queue.retry(workspace, first.jobId).state, 'NEEDS_CREDENTIAL');
  const accepted = queue.retry(workspace, first.jobId, { acceptCredentialChange: true });
  assert.equal(accepted.state, 'ADOPTING_CREDENTIAL');
  const journal = repository.readWorkspace(workspace, `jobs/${first.jobId}/credential-change.json`);
  assert.equal(journal.newGeneration, generation);
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  const calls = [];
  const runner = {
    acceptCredentialChange(input) {
      calls.push(`adopt:${input.sessionId}`);
      const relative = `sessions/${input.packageId}/${input.sessionId}.json`;
      const state = repository.readWorkspace(workspace, relative);
      repository.writeWorkspace(workspace, relative, { ...state, credentialGeneration: generation, sequence: state.sequence + 1 });
    },
    async runSession(input) {
      calls.push(`run:${input.sessionId}`);
      if (input.sessionId === 'session-0001') return { state: 'COMMITTED' };
      repository.writeWorkspace(workspace, `receipts/frozen-1/${input.sessionId}.json`, { status: 'COMMITTED' });
      return { state: 'COMMITTED' };
    }
  };
  const worker = createWorker({ repository, queue, credentials, clock: () => now, sessionRunner: runner,
    transport: { serverUrl: first.serverUrl, credentialGeneration: generation },
    collectExport: () => assert.fail('frozen package must be reused') });
  await worker.runClaim(workspace, claim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.deepEqual(calls, ['adopt:session-0002', 'run:session-0001', 'run:session-0002']);
  assert.equal(queue.status(workspace, first.jobId).state, 'COMMITTED');
  assert.equal(repository.readWorkspace(workspace, 'sessions/frozen-1/session-0002.json').key, 'fixed-key');
});

test('automatic publication wait remains durable until a published sidecar is observed by retry', t => {
  const { workspace, repository } = fixture(t);
  const batchId = 'batch-1';
  const batchDir = path.join(workspace, 'runs', batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'coordinator-state.json'), JSON.stringify({ workspace, batchId, phase: 'COMPLETE', targets: [{ caseKey: 'case-1' }] }));
  fs.writeFileSync(path.join(batchDir, 'batch.json'), JSON.stringify({ cases: [{ caseKey: 'case-1', executionId: 'execution-1' }] }));
  fs.writeFileSync(path.join(batchDir, 'report-publication.json'), JSON.stringify({ status: 'RETRY_REQUIRED', errorCode: 'REPORT_PUBLISH_FAILED' }));
  repository.writeWorkspace(workspace, `runs/${batchId}.json`, { batchId, attemptId: 'attempt-1', state: 'ACTIVE',
    serverUrl: 'https://mobile-backend.codemao.cn/mavtdashboard/', autoUpload: true,
    configured: true, noticeAcknowledged: true, credentialGeneration: 'a'.repeat(64), requestDigest: 'b'.repeat(64) });
  let launches = 0;
  const queue = createJobQueue({ repository, launcher: () => launches++,
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const submission = queue.submit({ workspace, scope: 'batch', trigger: 'automatic', batchId, bundleId: 'b'.repeat(64) });
  assert.equal(submission.state, 'WAITING_PUBLICATION');
  assert.equal(queue.status(workspace, submission.jobId).nextAction, 'RENDER_INDEX');
  assert.equal(launches, 0);
  assert.equal(queue.retry(workspace, submission.jobId).state, 'WAITING_PUBLICATION');
  fs.writeFileSync(path.join(batchDir, 'report-publication.json'), JSON.stringify({ status: 'DEGRADED', errorCode: 'REPORT_FINALIZE_FAILED' }));
  assert.equal(queue.retry(workspace, submission.jobId).state, 'WAITING_PUBLICATION');
  assert.equal(queue.status(workspace, submission.jobId).nextAction, 'RESOLVE_PUBLICATION');
  fs.writeFileSync(path.join(batchDir, 'report-publication.json'), JSON.stringify({ status: 'PUBLISHED' }));
  assert.equal(queue.retry(workspace, submission.jobId).state, 'QUEUED');
  assert.equal(launches, 1);
});

test('pinned zero-execution cancellation queues before and after request creation but refuses lost batch history', t => {
  const { workspace, repository } = fixture(t);
  const plugin = path.join(path.dirname(workspace), 'plugin');
  fs.mkdirSync(path.join(plugin, 'runtime/mobile-ai-visual-test/scripts'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hosts/codex'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'hosts/codex/delegation.md'), 'profile');
  fs.writeFileSync(path.join(plugin, 'runtime/mobile-ai-visual-test/scripts/coordinator-agent.js'), 'code');
  fs.writeFileSync(path.join(plugin, 'bundle.manifest.json'), JSON.stringify(createManifest(plugin, 'fixture')));
  const pinned = pinBundle(plugin, workspace);
  let launches = 0;
  const queue = createJobQueue({ repository, launcher: () => launches++,
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const observed = [];
  for (const [batchId, withRequest, lostBatch] of [
    ['cancel-before-request', false, false],
    ['cancel-after-request', true, false],
    ['lost-batch', true, true],
    ['unexpected-execution', false, false]
  ]) {
    const base = path.join(workspace, 'runs', batchId);
    const statePath = path.join(base, 'coordinator-state.json');
    const state = { type: 'coordinatorRun', workspace, batchId, statePath,
      command: runCommand(pinned.runtimeRoot, statePath), phase: 'COMPLETE', outcome: 'CANCELLED',
      environmentConfirmed: true, initialization: { executionRequestCreated: null, batchInitialized: null },
      targets: [{ caseKey: 'ck-0123456789ab' }] };
    publishManagedRun(state, pinned.runtimeRoot);
    if (withRequest) {
      const caseKey = 'ck-0123456789ab';
      const caseDir = path.join(workspace, 'cases', `case__${caseKey}`);
      fs.mkdirSync(caseDir, { recursive: true });
      fs.writeFileSync(path.join(caseDir, 'source.md'), 'Check cancellation.');
      fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify(createCaseContract({
        caseKey, title: 'Cancellation', sourceText: 'Check cancellation.', importPath: '/fixture/case.md'
      })));
      const binding = { platform: 'harmony', deviceId: 'offline-device', appId: 'com.example.offline', entry: 'EntryAbility' };
      const environmentConfirmation = confirmEnvironment({ workspaceRoot: workspace, binding,
        probe: { schemaVersion: 1, platform: 'harmony', ready: true, devices: [{ id: 'offline-device' }] },
        userConfirmation: 'Confirm offline fixture' });
      const request = createExecutionRequest({ workspaceRoot: workspace, batchId, mode: 'SINGLE',
        targets: [{ caseNo: '001' }], environmentConfirmation, userInstruction: 'Check cancellation.' });
      state.initialization.executionRequestCreated = { requestId: request.requestId, requestSha: request.requestSha };
    }
    if (lostBatch) state.initialization.batchInitialized = { status: 'INITIALIZED', contractSha: 'a'.repeat(64) };
    fs.writeFileSync(statePath, JSON.stringify(state));
    bindTerminalResource(state, publishSnapshot(state, 'runSummary', { outcome: 'CANCELLED' }));
    recordAgentFacingEvent(path.join(base, 'telemetry', 'agent-facing.jsonl'),
      { operation: 'cancelRun', status: 'SUCCEEDED', result: { outcome: 'CANCELLED' } }, 0);
    if (batchId === 'unexpected-execution') fs.mkdirSync(path.join(base, 'executions'));
    repository.writeWorkspace(workspace, `runs/${batchId}.json`, { batchId, attemptId: `attempt-${batchId}`,
      state: 'ACTIVE', serverUrl: 'https://mobile-backend.codemao.cn/mavtdashboard/', autoUpload: true,
      configured: true, noticeAcknowledged: true, credentialGeneration: 'a'.repeat(64), requestDigest: 'b'.repeat(64) });
    observed.push([batchId, queue.submit({ workspace, scope: 'batch', trigger: 'automatic', batchId,
      bundleId: 'c'.repeat(64) }).state]);
  }
  assert.deepEqual(observed, [
    ['cancel-before-request', 'QUEUED'], ['cancel-after-request', 'QUEUED'],
    ['lost-batch', 'WAITING_PUBLICATION'], ['unexpected-execution', 'WAITING_PUBLICATION']
  ]);
  assert.equal(launches, 1);
});

test('frozen blobs survive a partial result and are removed only after all receipts commit', async t => {
  const { workspace, repository } = fixture(t);
  const generation = 'a'.repeat(64);
  const credentials = { status: () => ({ configured: true, generation }) };
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started', credentials });
  const job = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const blob = path.join(workspace, '.mavt/reporting/packages/one-package/blobs/file-1');
  const runner = { async runSession(input) {
    assert.equal(fs.existsSync(blob), true);
    if (input.sessionId === 'session-0002') return { state: 'NEEDS_CREDENTIAL', failureCode: 'REPORTING_NEEDS_CREDENTIAL' };
    repository.writeWorkspace(workspace, `receipts/one-package/${input.sessionId}.json`, { status: 'COMMITTED' });
    return { state: 'COMMITTED' };
  } };
  const worker = createWorker({ repository, queue, credentials, sessionRunner: runner,
    transport: { serverUrl: job.serverUrl, credentialGeneration: generation, capabilities: async () => ({}) },
    collectExport: async () => {
      fs.mkdirSync(path.dirname(blob), { recursive: true }); fs.writeFileSync(blob, 'frozen');
      return { packageId: 'one-package', files: [{ bytes: 6 }], sessions: [{ id: 'session-0001' }, { id: 'session-0002' }] };
    } });
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  await worker.runClaim(workspace, claim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.equal(queue.status(workspace, job.jobId).state, 'PARTIAL');
  assert.equal(fs.existsSync(blob), true);
  const partial = repository.readWorkspace(workspace, `jobs/${job.jobId}/state.json`);
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${job.jobId}/state.json`, {
    ...partial, sessions: partial.sessions.map(item => item.id === 'session-0002' ? { ...item, state: 'QUEUED' } : item),
    state: 'PARTIAL', nextRetryAt: null
  }));
  const secondClaim = queue.reserveWorker(workspace);
  const second = createWorker({ repository, queue, credentials,
    transport: { serverUrl: job.serverUrl, credentialGeneration: generation },
    sessionRunner: { async runSession(input) {
      assert.equal(fs.existsSync(blob), true);
      if (input.sessionId === 'session-0001') return { state: 'COMMITTED' };
      assert.equal(input.sessionId, 'session-0002');
      repository.writeWorkspace(workspace, 'receipts/one-package/session-0002.json', { status: 'COMMITTED' });
      return { state: 'COMMITTED' };
    } } });
  await second.runClaim(workspace, secondClaim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.equal(queue.status(workspace, job.jobId).state, 'COMMITTED');
  assert.equal(fs.existsSync(blob), false);
});

for (const [name, mutate, expected, adopted] of [
  ['valid', receipt => receipt, 'COMMITTED', false],
  ['valid old-generation', receipt => receipt, 'COMMITTED', true],
  ['foreign binding', receipt => ({ ...receipt, serverUrl: 'https://foreign.invalid/' }), 'RETRYABLE_FAILED', false],
  ['invalid terminal result', receipt => ({ ...receipt, results: { ...receipt.results,
    workspace: { ...receipt.results.workspace, id: 'foreign-workspace' } } }), 'RETRYABLE_FAILED', false]
]) {
  test(`${name} persisted receipt is validated before frozen data cleanup`, async t => {
    const { workspace, repository } = fixture(t);
    const generation = 'a'.repeat(64);
    let currentGeneration = generation;
    const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started',
      credentials: { status: () => ({ configured: true, generation: currentGeneration }) } });
    const job = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
    if (adopted) currentGeneration = 'b'.repeat(64);
    const identityEpoch = repository.readWorkspace(workspace, 'identity.json').identityEpoch;
    const packageId = 'receipt-package', localId = 'session-0001';
    const manifest = { workspace: { id: 'workspace-1' }, cases: [], executions: [], files: [] };
    const rawManifest = JSON.stringify(manifest);
    const manifestSha256 = `sha256:${crypto.createHash('sha256').update(rawManifest).digest('hex')}`;
    const binding = { packageId, localId, identityEpoch, exportVersion: 1,
      serverUrl: job.serverUrl, credentialGeneration: generation, manifestSha256 };
    const blob = path.join(workspace, '.mavt/reporting/packages', packageId, 'blobs/file-1');
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    fs.writeFileSync(blob, 'frozen');
    repository.writeWorkspace(workspace, `sessions/${packageId}/${localId}.json`, { ...binding,
      state: 'COMMITTED', phase: 'TERMINAL', key: crypto.randomUUID(), remoteSessionId: 'remote-1',
      manifestRelative: `sessions/${localId}/manifest.json`, sequence: 1 });
    repository.writeWorkspace(workspace, `receipts/${packageId}/${localId}.json`, mutate({ ...binding,
      protocolVersion: '2.0', sessionId: 'remote-1', status: 'COMMITTED',
      results: { workspace: { id: 'workspace-1', decision: 'CREATED', code: null }, cases: [], executions: [] }, errors: [] }));
    repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${job.jobId}/state.json`, {
      ...repository.readWorkspace(workspace, `jobs/${job.jobId}/state.json`), packageId,
      credentialGeneration: currentGeneration,
      sessions: [{ id: localId, state: 'QUEUED' }]
    }));
    const worker = createWorker({ repository, queue,
      credentials: { status: () => ({ configured: true, generation: currentGeneration }) },
      transport: { serverUrl: job.serverUrl, credentialGeneration: currentGeneration,
        capabilities: () => assert.fail('receipt recovery must not use network') },
      readFrozenExport: () => ({ state: 'PACKAGE_READY', packageId, identityEpoch,
        sessions: [{ id: localId, rawManifest, manifestSha256, manifest }]
      }) });
    const claim = repository.readWorkspace(workspace, 'worker-claim.json');
    await worker.runClaim(workspace, claim.nonce, { pid: 123, processStartedAt: 'started' });
    assert.equal(queue.status(workspace, job.jobId).state, expected);
    assert.equal(fs.existsSync(blob), expected !== 'COMMITTED');
    if (adopted) assert.equal(repository.readWorkspace(workspace,
      `receipts/${packageId}/${localId}.json`).credentialGeneration, generation);
  });
}

test('a committed and rejected pair is partial but cannot replay the rejected key', async t => {
  const { workspace, repository } = fixture(t);
  const generation = 'a'.repeat(64);
  const credentials = { status: () => ({ configured: true, generation }) };
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started', credentials });
  const job = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  const worker = createWorker({ repository, queue, credentials,
    transport: { serverUrl: job.serverUrl, credentialGeneration: generation, capabilities: async () => ({}) },
    collectExport: async () => ({ packageId: 'pair-package', files: [],
      sessions: [{ id: 'session-0001' }, { id: 'session-0002' }] }),
    sessionRunner: { async runSession(input) {
      const state = input.sessionId === 'session-0001' ? 'COMMITTED' : 'REJECTED';
      repository.writeWorkspace(workspace, `receipts/pair-package/${input.sessionId}.json`, { status: state });
      return { state };
    } } });
  await worker.runClaim(workspace, claim.nonce, { pid: 123, processStartedAt: 'started' });
  const status = queue.status(workspace, job.jobId);
  assert.equal(status.state, 'PARTIAL');
  assert.equal(status.failureCode, 'REPORTING_RESUBMIT_REQUIRED');
  assert.equal(status.nextRetryAt, null);
  assert.throws(() => queue.retry(workspace, job.jobId), { code: 'REPORTING_RESUBMIT_REQUIRED' });
});

test('an expired frozen task cannot replay its old package', async t => {
  const { workspace, repository } = fixture(t);
  const credentials = { status: () => ({ configured: true, generation: 'a'.repeat(64) }) };
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started', credentials });
  const result = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const current = repository.readWorkspace(workspace, `jobs/${result.jobId}/state.json`);
  repository.withWorkspaceLock(workspace, () => repository.writeWorkspace(workspace, `jobs/${result.jobId}/state.json`, {
    ...current, packageId: 'expired-package', createdAt: new Date(Date.now() - 8 * 86400000).toISOString()
  }));
  const blob = path.join(workspace, '.mavt/reporting/packages/expired-package/blobs/file-1');
  fs.mkdirSync(path.dirname(blob), { recursive: true }); fs.writeFileSync(blob, 'old');
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  const worker = createWorker({ repository, queue, credentials, collectExport: () => assert.fail('no collection'),
    transport: { capabilities: () => assert.fail('no network') } });
  await worker.runClaim(workspace, claim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.equal(queue.status(workspace, result.jobId).state, 'EXPIRED_LOCAL');
  assert.equal(fs.existsSync(blob), false);
  assert.throws(() => queue.retry(workspace, result.jobId), { code: 'REPORTING_RESUBMIT_REQUIRED' });
});

test('service import stays clear of collector, transport and renderer modules', () => {
  const script = `require(${JSON.stringify(require.resolve('../src/mobile-ai-visual-test/scripts/reporting/service'))});console.log(Object.keys(require.cache).filter(p=>p.includes('/scripts/report/')||/\\/scripts\\/reporting\\/(collector|transport|session|worker)\\.js$/.test(p)).join('\\n'))`;
  const output = spawnSync(process.execPath, ['-e', script],
    { encoding: 'utf8' });
  assert.equal(output.status, 0);
  assert.equal(output.stdout.trim(), '');
});

test('a broken pinned bundle does not starve a different runnable bundle', t => {
  const { workspace, repository } = fixture(t);
  const launches = [];
  const queue = createJobQueue({ repository, launcher: claim => {
    launches.push(claim.bundleId);
    if (claim.bundleId === 'a'.repeat(64)) throw Object.assign(new Error('bundle corrupt'), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  }, credentials: { status: () => ({ configured: true, generation: 'c'.repeat(64) }) } });
  const broken = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'a'.repeat(64) });
  const good = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(queue.status(workspace, broken.jobId).state, 'COLLECTION_FAILED');
  assert.equal(queue.status(workspace, good.jobId).state, 'QUEUED');
  assert.deepEqual(launches, ['a'.repeat(64), 'b'.repeat(64)]);
});

test('more than sixteen broken bundles cannot leave a healthy job unlaunched', t => {
  const { workspace, repository } = fixture(t);
  const goodBundle = 'f'.repeat(64);
  let failuresEnabled = false;
  const launches = [];
  const queue = createJobQueue({ repository, launcher: claim => {
    if (!failuresEnabled) return;
    launches.push(claim.jobId);
    if (claim.bundleId !== goodBundle) throw Object.assign(new Error('broken bundle'), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  }, credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  const broken = Array.from({ length: 17 }, (_, index) => queue.submit({ workspace, scope: 'workspace',
    trigger: 'manual', bundleId: String(index).padStart(64, '0') }));
  const healthy = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: goodBundle });
  failuresEnabled = true;
  queue.launchReserved(workspace, repository.readWorkspace(workspace, 'worker-claim.json'));
  assert.equal(launches.length, 18);
  assert.equal(launches.at(-1), healthy.jobId);
  assert.equal(repository.readWorkspace(workspace, 'worker-claim.json').jobId, healthy.jobId);
  assert.equal(broken.every(job => queue.status(workspace, job.jobId).state === 'COLLECTION_FAILED'), true);
});

test('worker handoff reaches a healthy bundle after seventeen failed launches', async t => {
  const { workspace, repository } = fixture(t);
  const generation = 'a'.repeat(64);
  const credentials = { status: () => ({ configured: true, generation }) };
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started', credentials });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'e'.repeat(64) });
  const firstClaim = repository.readWorkspace(workspace, 'worker-claim.json');
  const broken = Array.from({ length: 17 }, (_, index) => queue.submit({ workspace, scope: 'workspace',
    trigger: 'manual', bundleId: String(index).padStart(64, '0') }));
  const healthy = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'f'.repeat(64) });
  const launches = [];
  const worker = createWorker({ repository, queue, credentials,
    launcher: claim => {
      launches.push(claim.jobId);
      if (claim.jobId !== healthy.jobId) throw Object.assign(new Error('broken bundle'), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
    },
    transport: { serverUrl: first.serverUrl, credentialGeneration: generation, capabilities: async () => ({}) },
    collectExport: async () => ({ packageId: 'handoff-package', files: [], sessions: [{ id: 'session-0001' }] }),
    sessionRunner: { async runSession() {
      repository.writeWorkspace(workspace, 'receipts/handoff-package/session-0001.json', { status: 'COMMITTED' });
      return { state: 'COMMITTED' };
    } }
  });
  await worker.runClaim(workspace, firstClaim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.equal(launches.length, 18);
  assert.equal(launches.at(-1), healthy.jobId);
  assert.equal(repository.readWorkspace(workspace, 'worker-claim.json').jobId, healthy.jobId);
  assert.equal(broken.every(job => queue.status(workspace, job.jobId).state === 'COLLECTION_FAILED'), true);
});

test('enqueue during a worker completion hands the next bundle a reserved claim', async t => {
  const { workspace, repository } = fixture(t);
  const credentials = { status: () => ({ configured: true, generation: 'a'.repeat(64) }) };
  const queue = createJobQueue({ repository, launcher: () => {}, processIdentity: () => 'started', credentials });
  const first = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'a'.repeat(64) });
  const firstClaim = repository.readWorkspace(workspace, 'worker-claim.json');
  let second;
  const launches = [];
  const worker = createWorker({ repository, queue, credentials,
    launcher: claim => launches.push(claim),
    transport: { serverUrl: first.serverUrl, credentialGeneration: 'a'.repeat(64), capabilities: async () => ({}) },
    collectExport: async () => ({ packageId: 'first-package', files: [], sessions: [{ id: 'session-0001' }] }),
    sessionRunner: { async runSession() {
      second = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
      repository.writeWorkspace(workspace, 'receipts/first-package/session-0001.json', { status: 'COMMITTED' });
      return { state: 'COMMITTED' };
    } }
  });
  await worker.runClaim(workspace, firstClaim.nonce, { pid: 123, processStartedAt: 'started' });
  assert.equal(queue.status(workspace, first.jobId).state, 'COMMITTED');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].bundleId, 'b'.repeat(64));
  assert.equal(launches[0].jobId, second.jobId);
  assert.equal(repository.readWorkspace(workspace, 'worker-claim.json').state, 'RESERVED');
});

test('real pinned worker survives launcher-parent exit and releases its durable claim', async t => {
  const { workspace, repository } = fixture(t);
  let notifyRequest;
  const requestSeen = new Promise(resolve => { notifyRequest = resolve; });
  const server = http.createServer((request, response) => {
    notifyRequest(request.url);
    setTimeout(() => { response.writeHead(503, { 'Retry-After': '2' }); response.end('{}'); }, 350);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const serverUrl = `http://127.0.0.1:${server.address().port}/fixture/`;
  createSettings({ repository }).update({ serverUrl });
  repository.writeConfig('credentials.json', { targets: { [serverUrl]: { token: 'anonymous-loopback-token' } } });
  const staging = path.join(workspace, '.mavt/runtime-bundles/staging');
  fs.mkdirSync(path.join(staging, 'runtime'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../src/mobile-ai-visual-test'), path.join(staging, 'runtime/mobile-ai-visual-test'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'hosts/codex'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'hosts/codex/delegation.md'), 'fixture');
  const manifest = createManifest(staging, 'fixture');
  fs.writeFileSync(path.join(staging, 'bundle.manifest.json'), JSON.stringify(manifest));
  fs.renameSync(staging, path.join(workspace, '.mavt/runtime-bundles', manifest.bundleId));
  const queue = createJobQueue({ repository, launcher: () => {} });
  const submission = queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: manifest.bundleId });
  const claim = repository.readWorkspace(workspace, 'worker-claim.json');
  const parentCode = `require(${JSON.stringify(require.resolve('../src/mobile-ai-visual-test/scripts/reporting/launcher'))}).launchWorker(${JSON.stringify(claim)},${JSON.stringify(workspace)},{configDir:${JSON.stringify(repository.configDir)}})`;
  const parent = spawnSync(process.execPath, ['-e', parentCode], { encoding: 'utf8', timeout: 5000 });
  assert.equal(parent.status, 0);
  const route = await Promise.race([requestSeen, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not reach loopback')), 8000);
    timer.unref();
  })]);
  assert.equal(route, '/fixture/api/v2/reporting/capabilities');
  const active = repository.readWorkspace(workspace, 'worker-claim.json');
  assert.equal(active.state, 'ACTIVE');
  assert.equal(typeof active.processStartedAt, 'string');
  for (let i = 0; i < 150 && repository.readWorkspace(workspace, 'worker-claim.json').state !== 'RELEASED'; i++)
    await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(repository.readWorkspace(workspace, 'worker-claim.json').state, 'RELEASED');
  const outcome = queue.status(workspace, submission.jobId);
  assert.equal(outcome.state, 'RETRYABLE_FAILED');
  assert.equal(outcome.failureCode, 'REPORTING_RETRY_LATER');
  assert.ok(Date.parse(outcome.nextRetryAt) >= Date.now());
});

test('synchronous connection check uses a bounded child and current loopback target', async t => {
  const { repository } = fixture(t);
  const response = JSON.stringify(capabilities());
  const code = `const http=require('node:http');const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(${JSON.stringify(response)})});server.listen(0,'127.0.0.1',()=>console.log(server.address().port))`;
  const server = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => server.kill());
  const port = await new Promise((resolve, reject) => {
    server.stdout.once('data', bytes => resolve(Number(bytes.toString().trim())));
    server.once('error', reject);
  });
  const serverUrl = `http://127.0.0.1:${port}/fixture/`;
  createSettings({ repository }).update({ serverUrl });
  repository.writeConfig('credentials.json', { targets: { [serverUrl]: { token: 'anonymous-loopback-token' } } });
  const service = createReportingService({ repository });
  assert.deepEqual(service.checkConnection(), { ok: true, code: null, serverUrl });
});
