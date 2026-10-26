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
const { capabilities, terminal } = require('./support/reporting-http-fixture');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-jobs-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: 'mobile-ai-visual-test-workspace', initializationState: 'READY', name: 'Fixture' }));
  const repository = createRepository({ configDir: path.join(root, 'config') });
  return { root, workspace, repository };
}

function retainedJob(repository, workspace, id, state, createdAt, extra = {}) {
  const identityEpoch = repository.readWorkspace(workspace, 'identity.json').identityEpoch;
  const packageId = `package-${id}`;
  repository.writeWorkspace(workspace, `jobs/${id}/state.json`, {
    jobId: id, packageId, state, identityEpoch, exportVersion: 1, createdAt,
    updatedAt: createdAt, sessions: [], metrics: {}, ...extra
  });
  const blob = path.join(workspace, '.mavt/reporting/packages', packageId, 'blobs', 'file');
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.writeFileSync(blob, 'retained');
  return blob;
}

async function committedPackage(t, { oldGeneration = false, queueOptions = {} } = {}) {
  const f = require('./support/reporting-fixture').fixture(t);
  const generation = 'a'.repeat(64), currentGeneration = oldGeneration ? 'b'.repeat(64) : generation;
  const queue = createJobQueue({ repository: f.repository, launcher: () => {}, ...queueOptions,
    credentials: { status: () => ({ configured: true, generation: currentGeneration }) } });
  const submitted = queue.submit({ workspace: f.workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const claim = f.repository.readWorkspace(f.workspace, 'worker-claim.json');
  f.repository.writeWorkspace(f.workspace, 'worker-claim.json', { ...claim, state: 'RELEASED' });
  const frozen = await require('../src/mobile-ai-visual-test/scripts/reporting/collector')
    .collectExport(f.request, f.dependencies);
  const identityEpoch = f.repository.readWorkspace(f.workspace, 'identity.json').identityEpoch;
  const sessions = frozen.sessions.map(session => {
    const binding = { packageId: frozen.packageId, localId: session.id, identityEpoch,
      exportVersion: 1, serverUrl: submitted.serverUrl, credentialGeneration: generation,
      manifestSha256: session.manifestSha256 };
    f.repository.writeWorkspace(f.workspace, `sessions/${frozen.packageId}/${session.id}.json`, {
      ...binding, state: 'COMMITTED', phase: 'TERMINAL', key: session.key,
      remoteSessionId: `remote-${session.id}`, manifestRelative: session.manifestRelative,
      receiptRelative: `receipts/${frozen.packageId}/${session.id}.json`, sequence: 1
    });
    f.repository.writeWorkspace(f.workspace, `receipts/${frozen.packageId}/${session.id}.json`, {
      ...binding, ...terminal(session.manifest, `remote-${session.id}`)
    });
    return { id: session.id, state: 'COMMITTED', receiptRelative: `receipts/${frozen.packageId}/${session.id}.json` };
  });
  const original = f.repository.readWorkspace(f.workspace, `jobs/${submitted.jobId}/state.json`);
  f.repository.writeWorkspace(f.workspace, `jobs/${submitted.jobId}/state.json`, {
    ...original, state: 'COMMITTED', packageId: frozen.packageId, sessions,
    credentialGeneration: currentGeneration
  });
  return { ...f, queue, submitted, frozen, sessions, generation, currentGeneration,
    packageRoot: path.join(f.workspace, '.mavt/reporting/packages', frozen.packageId) };
}

function releaseReservation(f) {
  const owner = f.repository.readWorkspace(f.workspace, 'worker-claim.json');
  if (owner?.state !== 'RELEASED')
    f.repository.writeWorkspace(f.workspace, 'worker-claim.json', { ...owner, state: 'RELEASED' });
}
function drainCommittedCleanup(f) {
  releaseReservation(f);
  for (let i = 0; i < 12 && f.queue.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending; i++)
    f.queue.retry(f.workspace, f.submitted.jobId);
  assert.equal(f.queue.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending, false);
}

for (const [name, mutate, authorized] of [
  ['real committed receipt', () => {}, true],
  ['empty job session list', f => {
    const job = f.repository.readWorkspace(f.workspace, `jobs/${f.submitted.jobId}/state.json`);
    f.repository.writeWorkspace(f.workspace, `jobs/${f.submitted.jobId}/state.json`, { ...job, sessions: [] });
  }, false],
  ['foreign receipt binding', f => {
    const relative = f.sessions[0].receiptRelative, receipt = f.repository.readWorkspace(f.workspace, relative);
    f.repository.writeWorkspace(f.workspace, relative, { ...receipt, serverUrl: 'https://foreign.invalid/' });
  }, false],
  ['invalid terminal result', f => {
    const relative = f.sessions[0].receiptRelative, receipt = f.repository.readWorkspace(f.workspace, relative);
    f.repository.writeWorkspace(f.workspace, relative, { ...receipt, results: { ...receipt.results,
      workspace: { ...receipt.results.workspace, id: 'foreign-workspace' } } });
  }, false],
  ['malformed terminal receipt', f => {
    const relative = f.sessions[0].receiptRelative, receipt = f.repository.readWorkspace(f.workspace, relative);
    f.repository.writeWorkspace(f.workspace, relative, { ...receipt, results: null });
  }, false],
  ['missing persisted session', f => {
    fs.unlinkSync(path.join(f.workspace, '.mavt/reporting/sessions', f.frozen.packageId, `${f.sessions[0].id}.json`));
  }, false],
  ['unproven session key change', f => {
    const relative = `sessions/${f.frozen.packageId}/${f.sessions[0].id}.json`;
    f.repository.writeWorkspace(f.workspace, relative, { ...f.repository.readWorkspace(f.workspace, relative), key: crypto.randomUUID() });
  }, false]
]) {
  test(`${name} authorizes terminal cleanup only with the complete frozen proof`, async t => {
    const f = await committedPackage(t);
    mutate(f);
    const blob = path.join(f.packageRoot, 'blobs', f.frozen.files[0].id);
    assert.equal(fs.existsSync(blob), true);
    f.queue.submit({ workspace: f.workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
    assert.equal(fs.existsSync(blob), !authorized);
  });
}

test('410 key rotation preserves frozen bytes and permits COMMITTED worker cleanup', async t => {
  const f = require('./support/reporting-fixture').fixture(t);
  const generation = 'a'.repeat(64), credentials = { status: () => ({ configured: true, generation }) };
  const queue = createJobQueue({ repository: f.repository, credentials, launcher: () => {} });
  const submitted = queue.submit({ workspace: f.workspace, scope: 'workspace', trigger: 'manual' });
  const prepared = [], manifests = [];
  const transport = { serverUrl: submitted.serverUrl, credentialGeneration: generation,
    capabilities: async () => capabilities(),
    prepare: async (raw, key) => {
      prepared.push(key); manifests.push(raw);
      if (prepared.length === 1) throw Object.assign(new Error('expired'), { code: 'REPORTING_SESSION_EXPIRED' });
      return { protocolVersion: '2.0', sessionId: 'remote-after-410', status: 'UPLOADING',
        expiresAt: '2099-01-01T00:00:00.000Z', limits: capabilities().limits, missingFiles: [] };
    }, commit: async () => terminal(JSON.parse(manifests.at(-1)), 'remote-after-410') };
  await createWorker({ repository: f.repository, queue, credentials, transport })
    .runClaim(f.workspace, f.repository.readWorkspace(f.workspace, 'worker-claim.json').nonce);
  const job = queue.status(f.workspace, submitted.jobId);
  assert.equal(job.state, 'COMMITTED');
  assert.equal(prepared.length, 2);
  assert.notEqual(prepared[0], prepared[1]);
  assert.equal(manifests[0], manifests[1]);
  assert.notEqual(job.metrics.localCleanupPending, true);
  const root = path.join(f.workspace, '.mavt/reporting/packages', job.packageId);
  assert.equal(fs.existsSync(path.join(root, 'blobs')), false);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
});

test('failed collection retains durable job ownership and explicit retry reclaims its abandoned stage', async t => {
  const f = require('./support/reporting-fixture').fixture(t);
  let now = Date.now();
  const generation = 'a'.repeat(64), credentials = { status: () => ({ configured: true, generation }) };
  const queue = createJobQueue({ repository: f.repository, credentials, launcher: () => {}, clock: () => now });
  const submitted = queue.submit({ workspace: f.workspace, scope: 'workspace', trigger: 'manual' });
  const staging = path.join(f.workspace, '.mavt/reporting/staging');
  const unlink = fs.unlinkSync;
  const block = t.mock.method(fs, 'unlinkSync', function(file, ...args) {
    if (String(file).startsWith(staging + path.sep) && String(file).includes('/blobs/'))
      throw Object.assign(new Error('cleanup temporarily unavailable'), { code: 'EACCES' });
    return unlink.call(this, file, ...args);
  });
  const transport = { serverUrl: submitted.serverUrl, credentialGeneration: generation,
    capabilities: async () => ({ ...capabilities(), limits: { ...capabilities().limits, documentBytes: 20000 } }) };
  try {
    await createWorker({ repository: f.repository, queue, credentials, transport, clock: () => now })
      .runClaim(f.workspace, f.repository.readWorkspace(f.workspace, 'worker-claim.json').nonce);
  } finally { block.mock.restore(); }
  const job = queue.status(f.workspace, submitted.jobId), packageId = fs.readdirSync(staging)[0];
  const stage = f.repository.readWorkspace(f.workspace, `staging/${packageId}/stage.json`);
  assert.equal(job.state, 'COLLECTION_FAILED');
  assert.equal(job.failureCode, 'REPORTING_NATIVE_MODEL_TOO_LARGE');
  assert.equal(job.packageId, null);
  assert.equal(stage.jobId, job.jobId);
  assert.equal(stage.identityEpoch, f.repository.readWorkspace(f.workspace, 'identity.json').identityEpoch);
  assert.equal(stage.state, 'FAILED');
  now += 8 * 86400000;
  queue.status(f.workspace, job.jobId);
  assert.equal(fs.existsSync(path.join(staging, packageId)), true, 'status must not clean');
  queue.retry(f.workspace, job.jobId);
  assert.equal(fs.existsSync(path.join(staging, packageId)), false);
});

test('explicit writes reclaim expired snapshots left by a collector process crash', t => {
  const f = require('./support/reporting-fixture').fixture(t);
  const source = `const [root,workspace,configDir]=process.argv.slice(1);
    const repository=require(root+'/repository').createRepository({configDir});
    require(root+'/collector').collectExport({workspace,scope:'workspace'},
      {repository,validatePackage:()=>process.exit(17)}).catch(()=>process.exit(18));`;
  const child = spawnSync(process.execPath, ['-e', source,
    path.dirname(require.resolve('../src/mobile-ai-visual-test/scripts/reporting/collector')),
    f.workspace, f.repository.configDir], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 17, child.stderr);
  const staging = path.join(f.workspace, '.mavt/reporting/staging'), packageId = fs.readdirSync(staging)[0];
  const queue = createJobQueue({ repository: f.repository, clock: () => Date.now() + 8 * 86400000,
    credentials: { status: () => ({ configured: false, generation: null }) } });
  queue.status(f.workspace);
  assert.equal(fs.existsSync(path.join(staging, packageId, 'blobs')), true);
  queue.submit({ workspace: f.workspace, scope: 'workspace', trigger: 'manual' });
  assert.equal(fs.existsSync(path.join(staging, packageId)), false);
});

test('orphan cleanup protects live collectors, future metadata, foreign epochs and package references', t => {
  const { workspace, repository } = fixture(t);
  const epoch = require('../src/mobile-ai-visual-test/scripts/reporting/identity').createIdentity({ repository }).ensure(workspace).identityEpoch;
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
  const protectedBlobs = [];
  for (const [id, area, patch] of [
    ['live', 'staging', { ownerPid: process.pid }],
    ['future', 'staging', { schemaVersion: 2 }],
    ['future-export', 'staging', { exportVersion: 2 }],
    ['foreign', 'staging', { identityEpoch: 'foreign-epoch' }],
    ['referenced', 'packages', { state: 'FAILED' }],
    ['future-claim', 'staging', { state: 'FAILED', jobId: 'future-job' }]
  ]) {
    const stage = { schemaVersion:1, exportVersion:1, state:'COLLECTING', packageId:id,
      identityEpoch:epoch, ownerPid:deadPid, createdAt, jobId:null, ...patch };
    const root = path.join(workspace, '.mavt/reporting', area, id);
    fs.mkdirSync(path.join(root, 'blobs'), { recursive:true });
    fs.writeFileSync(path.join(root, 'stage.json'), JSON.stringify(stage));
    const blob = path.join(root, 'blobs/file'); fs.writeFileSync(blob, 'protected'); protectedBlobs.push(blob);
  }
  repository.writeWorkspace(workspace, 'jobs/referenced-job/state.json', { jobId:'referenced-job', state:'COMMITTED',
    identityEpoch:epoch, exportVersion:1, packageId:'referenced', createdAt, sessions:[], metrics:{} });
  repository.writeWorkspace(workspace, 'jobs/future-job/state.json', { jobId:'future-job', state:'COLLECTION_FAILED',
    identityEpoch:epoch, exportVersion:1, packageId:null, createdAt, sessions:[], metrics:{} });
  const claim = path.join(workspace, '.mavt/reporting/jobs/future-job/claim.json');
  fs.writeFileSync(claim, JSON.stringify({ schemaVersion:2, state:'ACTIVE' }));
  const queue = createJobQueue({ repository, credentials:{status:()=>({configured:false,generation:null})} });
  queue.submit({ workspace, scope:'workspace', trigger:'manual' });
  assert.equal(protectedBlobs.every(file => fs.existsSync(file)), true);
  // A supported dead collector in the same directory is still reclaimed.
  const root = path.join(workspace, '.mavt/reporting/staging/dead');
  repository.writeWorkspace(workspace, 'staging/dead/stage.json', { state:'COLLECTING', packageId:'dead',
    identityEpoch:epoch, ownerPid:deadPid, createdAt, jobId:null });
  fs.mkdirSync(path.join(root, 'blobs')); fs.writeFileSync(path.join(root, 'blobs/file'), 'expired');
  queue.submit({ workspace, scope:'workspace', trigger:'manual' });
  assert.equal(fs.existsSync(root), false);
  assert.equal(protectedBlobs.every(file => fs.existsSync(file)), true);
});

test('orphan stage cleanup is bounded and retains authority until the last payload file is gone', t => {
  const { workspace, repository } = fixture(t);
  const epoch = require('../src/mobile-ai-visual-test/scripts/reporting/identity').createIdentity({ repository }).ensure(workspace).identityEpoch;
  const root = path.join(workspace, '.mavt/reporting/staging/abandoned');
  repository.writeWorkspace(workspace, 'staging/abandoned/stage.json', { state:'FAILED', packageId:'abandoned',
    identityEpoch:epoch, ownerPid:process.pid, createdAt:new Date(Date.now() - 8 * 86400000).toISOString(), jobId:null });
  fs.mkdirSync(path.join(root, 'blobs'));
  for (let i=0; i<50; i++) fs.writeFileSync(path.join(root, 'blobs', `file-${i}`), 'payload');
  const queue = createJobQueue({ repository, credentials:{status:()=>({configured:false,generation:null})} });
  queue.submit({ workspace, scope:'workspace', trigger:'manual' });
  const remaining = fs.readdirSync(path.join(root, 'blobs')).length;
  assert.ok(remaining > 0 && remaining >= 18 && remaining < 50);
  assert.equal(repository.readWorkspace(workspace, 'staging/abandoned/stage.json').state, 'FAILED');
  queue.submit({ workspace, scope:'workspace', trigger:'manual' });
  assert.equal(fs.existsSync(root), false);
});

test('a partial orphan cleanup failure cannot consume another package in the same write', t => {
  const { workspace, repository } = fixture(t);
  const epoch = require('../src/mobile-ai-visual-test/scripts/reporting/identity').createIdentity({ repository }).ensure(workspace).identityEpoch;
  const roots = ['a-failing', 'b-next'].map(packageId => {
    repository.writeWorkspace(workspace, `staging/${packageId}/stage.json`, { state:'FAILED', packageId,
      identityEpoch:epoch, ownerPid:process.pid, createdAt:new Date(Date.now()-8*86400000).toISOString(), jobId:null });
    const root = path.join(workspace, '.mavt/reporting/staging', packageId);
    fs.mkdirSync(path.join(root, 'blobs')); fs.writeFileSync(path.join(root, 'blobs/file'), 'payload');
    return root;
  });
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', function(file, ...args) {
    if (file === path.join(roots[0], 'stage.json')) throw Object.assign(new Error('permission denied'), {code:'EACCES'});
    return unlink.call(this, file, ...args);
  });
  const queue = createJobQueue({ repository, credentials:{status:()=>({configured:false,generation:null})} });
  queue.submit({ workspace, scope:'workspace', trigger:'manual' });
  assert.equal(fs.existsSync(path.join(roots[0], 'blobs/file')), false);
  assert.equal(fs.existsSync(path.join(roots[0], 'stage.json')), true);
  assert.equal(fs.existsSync(path.join(roots[1], 'blobs/file')), true);
});

test('a finalized snapshot not yet attached to its job is retained then reclaimed after expiry', async t => {
  const f = require('./support/reporting-fixture').fixture(t);
  const revisions = require('../src/mobile-ai-visual-test/scripts/reporting/revisions').createRevisions(f.dependencies);
  f.dependencies.revisions = { ...revisions, publish: () => {
    throw Object.assign(new Error('publication interrupted'), { code:'REPORTING_STORAGE_ERROR' });
  } };
  await assert.rejects(require('../src/mobile-ai-visual-test/scripts/reporting/collector').collectExport(f.request, f.dependencies),
    { code:'REPORTING_STORAGE_ERROR' });
  const packages = path.join(f.workspace, '.mavt/reporting/packages'), id = fs.readdirSync(packages)[0];
  const root = path.join(packages, id);
  assert.equal(fs.existsSync(path.join(root, 'blobs')), true);
  const queue = createJobQueue({ repository:f.repository, clock:()=>Date.now()+8*86400000,
    credentials:{status:()=>({configured:false,generation:null})} });
  for (let i=0; i<10 && fs.existsSync(path.join(root, 'blobs')); i++)
    queue.submit({ workspace:f.workspace, scope:'workspace', trigger:'manual' });
  assert.equal(fs.existsSync(path.join(root, 'blobs')), false);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
  assert.equal(f.repository.readWorkspace(f.workspace, `packages/${id}/stage.json`).state, 'EXPIRED_LOCAL');
});

test('valid old-generation receipt authorizes cleanup without adopting current credentials', async t => {
  const f = await committedPackage(t, { oldGeneration: true });
  const blob = path.join(f.packageRoot, 'blobs', f.frozen.files[0].id);
  f.queue.submit({ workspace: f.workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(fs.existsSync(blob), false);
  assert.equal(f.repository.readWorkspace(f.workspace, f.sessions[0].receiptRelative).credentialGeneration, f.generation);
});

test('an explicit submit retries COMMITTED cleanup after a durable receipt, while status is readonly', async t => {
  const f = await committedPackage(t);
  const { workspace, repository, queue } = f;
  const blob = path.join(f.packageRoot, 'blobs', f.frozen.files[0].id);
  const stateFile = path.join(workspace, '.mavt/reporting/jobs', f.submitted.jobId, 'state.json');
  const before = fs.readFileSync(stateFile);
  assert.equal(queue.status(workspace, f.submitted.jobId).metrics.localCleanupPending, undefined);
  assert.deepEqual(fs.readFileSync(stateFile), before);
  assert.equal(fs.existsSync(blob), true);
  queue.submit({ workspace, scope: 'batch', trigger: 'automatic', batchId: 'unconfirmed' });
  assert.equal(fs.existsSync(blob), true);
  const unlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = function(file,...args) {
    if (!injected && file.startsWith(path.join(f.packageRoot, 'blobs'))) {
      injected = true;
      throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' });
    }
    return unlink.call(this,file,...args);
  };
  try { queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) }); }
  finally { fs.unlinkSync = unlink; }
  assert.equal(injected, true);
  assert.equal(queue.status(workspace, f.submitted.jobId).metrics.localCleanupPending, true);
  assert.equal(fs.existsSync(blob), true);
  drainCommittedCleanup(f);
  assert.equal(fs.existsSync(blob), false);
});

test('a restarted queue resumes authorized cleanup after the session manifest is removed', async t => {
  const f = await committedPackage(t);
  const sessionDir = path.join(f.packageRoot, 'sessions', f.sessions[0].id);
  const manifestFile = path.join(sessionDir, 'manifest.json');
  const rmdir = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = function(directory, ...args) {
    if (!injected && directory === sessionDir) {
      assert.equal(fs.existsSync(manifestFile), false);
      injected = true;
      throw Object.assign(new Error('injected directory cleanup failure'), { code: 'EACCES' });
    }
    return rmdir.call(this, directory, ...args);
  };
  try { f.queue.retry(f.workspace, f.submitted.jobId); }
  finally { fs.rmdirSync = rmdir; }
  assert.equal(injected, true);
  assert.equal(f.queue.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending, true);
  assert.equal(fs.existsSync(manifestFile), false);
  assert.equal(f.repository.readWorkspace(f.workspace,
    `jobs/${f.submitted.jobId}/cleanup-authorized.json`).state, 'AUTHORIZED');

  const restarted = createJobQueue({ repository: f.repository, launcher: () => {
    assert.fail('cleanup must not launch network work');
  }, credentials: { status: () => ({ configured: true, generation: f.currentGeneration }) } });
  assert.equal(restarted.retry(f.workspace, f.submitted.jobId).state, 'COMMITTED');
  assert.equal(restarted.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending, false);
  assert.equal(fs.existsSync(path.join(f.packageRoot, 'sessions')), false);
});

function prepareCommittedWorker(f) {
  const { workspace, repository } = f;
  const jobRelative = `jobs/${f.submitted.jobId}/state.json`;
  const job = repository.readWorkspace(workspace, jobRelative);
  repository.writeWorkspace(workspace, jobRelative, { ...job, state: 'QUEUED' });
  const reserved = repository.readWorkspace(workspace, 'worker-claim.json');
  repository.writeWorkspace(workspace, 'worker-claim.json', { ...reserved, state: 'RESERVED' });
  return reserved;
}
function activateCommittedWorker(f) {
  const { workspace, queue } = f;
  const reserved = prepareCommittedWorker(f);
  const claim = queue.registerWorker(workspace, reserved.nonce, 123, 'started');
  const running = queue.beginJob(workspace, claim);
  return { claim, running };
}
async function runCommittedWorker(f) {
  const { workspace, repository, queue } = f;
  const { claim, running } = activateCommittedWorker(f);
  const worker = createWorker({ repository, queue,
    credentials: { status: () => ({ configured: true, generation: f.currentGeneration }) },
    transport: { serverUrl: f.submitted.serverUrl, credentialGeneration: f.currentGeneration },
    collectExport: () => assert.fail('frozen package must not be recollected'),
    sessionRunner: { async runSession() { return { state: 'COMMITTED' }; } } });
  try { await worker.processJob(workspace, claim, running); }
  finally { queue.releaseWorker(workspace, claim); }
}

test('worker-origin partial cleanup resumes after the frozen manifest is removed', async t => {
  const f = await committedPackage(t, { queueOptions: { processIdentity: () => 'started' } });
  const sessionDir = path.join(f.packageRoot, 'sessions', f.sessions[0].id);
  const manifestFile = path.join(sessionDir, 'manifest.json');
  const rmdir = fs.rmdirSync;
  let injected = false;
  fs.rmdirSync = function(directory, ...args) {
    if (!injected && directory === sessionDir) {
      assert.equal(fs.existsSync(manifestFile), false);
      injected = true;
      throw Object.assign(new Error('injected directory cleanup failure'), { code: 'EACCES' });
    }
    return rmdir.call(this, directory, ...args);
  };
  try { await runCommittedWorker(f); }
  finally { fs.rmdirSync = rmdir; }
  assert.equal(injected, true);
  assert.equal(f.queue.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending, true);
  assert.equal(fs.existsSync(manifestFile), false);
  const proofRelative = `jobs/${f.submitted.jobId}/cleanup-authorized.json`;
  assert.equal(f.repository.readWorkspace(f.workspace, proofRelative)?.state, 'AUTHORIZED');

  const restarted = createJobQueue({ repository: f.repository, launcher: () => {
    assert.fail('cleanup must not launch network work');
  }, credentials: { status: () => ({ configured: true, generation: f.currentGeneration }) } });
  assert.equal(restarted.retry(f.workspace, f.submitted.jobId).state, 'COMMITTED');
  assert.equal(restarted.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending, false);
  assert.equal(fs.existsSync(path.join(f.packageRoot, 'sessions')), false);
});

test('worker refuses cleanup when a persisted terminal receipt is invalid', async t => {
  const f = await committedPackage(t, { queueOptions: { processIdentity: () => 'started' } });
  const relative = f.sessions[0].receiptRelative;
  const receipt = f.repository.readWorkspace(f.workspace, relative);
  f.repository.writeWorkspace(f.workspace, relative, { ...receipt, results: null });
  const blob = path.join(f.packageRoot, 'blobs', f.frozen.files[0].id);
  await runCommittedWorker(f);
  assert.equal(f.queue.status(f.workspace, f.submitted.jobId).metrics.localCleanupPending, true);
  assert.equal(f.repository.readWorkspace(f.workspace,
    `jobs/${f.submitted.jobId}/cleanup-authorized.json`), null);
  assert.equal(fs.existsSync(blob), true);
});

test('cleanup is bounded and refuses live, uncertain, or future-version ownership', async t => {
  const f = await committedPackage(t, { queueOptions: { processIdentity: () => null, isAlive: () => true } });
  const { workspace, repository, queue } = f;
  const blobDir = path.join(f.packageRoot, 'blobs');
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(blobDir, `extra-${i}`), 'retained');
  const before = fs.readdirSync(blobDir).length;
  repository.writeWorkspace(workspace, 'worker-claim.json', { state: 'RESERVED', jobId: 'other', nonce: 'incomplete', epoch: 1 });
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(fs.readdirSync(blobDir).length, before);
  repository.writeWorkspace(workspace, 'worker-claim.json', { state: 'ACTIVE', jobId: 'other', pid: 999999,
    processStartedAt: 'unknown', nonce: 'live', epoch: 1 });
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(fs.readdirSync(blobDir).length, before);
  repository.writeWorkspace(workspace, 'worker-claim.json', { state: 'RELEASED', nonce: 'live', epoch: 1 });
  const claimRelative = `jobs/${f.submitted.jobId}/claim.json`;
  repository.writeWorkspace(workspace, claimRelative, { state: 'RELEASED' });
  const claimFile = path.join(workspace, '.mavt/reporting', claimRelative);
  fs.writeFileSync(claimFile, JSON.stringify({ schemaVersion: 2, state: 'ACTIVE' }));
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(fs.readdirSync(blobDir).length, before);
  fs.writeFileSync(claimFile, JSON.stringify({ schemaVersion: 1, state: 'RELEASED' }));
  releaseReservation(f);
  const stateFile = path.join(workspace, '.mavt/reporting/jobs', f.submitted.jobId, 'state.json');
  const currentState = JSON.parse(fs.readFileSync(stateFile));
  fs.writeFileSync(stateFile, JSON.stringify({ ...currentState, identityEpoch: 'previous-epoch' }));
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(fs.readdirSync(blobDir).length, before);
  fs.writeFileSync(stateFile, JSON.stringify(currentState));
  releaseReservation(f);
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  const remaining = fs.readdirSync(blobDir).length;
  assert.ok(remaining < before && remaining >= before - 32);
  const futureState = { ...JSON.parse(fs.readFileSync(stateFile)), schemaVersion: 2 };
  fs.writeFileSync(stateFile, JSON.stringify(futureState));
  releaseReservation(f);
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)), futureState);
  assert.equal(fs.readdirSync(blobDir).length, remaining);
});

test('a missing COMMITTED receipt protects its package without starving older expiry', async t => {
  const f = await committedPackage(t);
  const { workspace, repository, queue } = f;
  const committed = path.join(f.packageRoot, 'blobs', f.frozen.files[0].id);
  const receiptRelative = f.sessions[0].receiptRelative;
  const receipt = repository.readWorkspace(workspace, receiptRelative);
  fs.unlinkSync(path.join(workspace, '.mavt/reporting', receiptRelative));
  const rejected = retainedJob(repository, workspace, 'b-rejected', 'REJECTED',
    new Date(Date.now() - 8 * 86400000).toISOString());
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(fs.existsSync(committed), true);
  assert.equal(fs.existsSync(rejected), false);
  releaseReservation(f);
  repository.writeWorkspace(workspace, receiptRelative, receipt);
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  drainCommittedCleanup(f);
  assert.equal(fs.existsSync(committed), false);
});

test('explicit write expires retained rejected jobs after seven days but keeps younger unfinished packages', t => {
  const { workspace, repository } = fixture(t);
  const queue = createJobQueue({ repository, launcher: () => {},
    credentials: { status: () => ({ configured: true, generation: 'a'.repeat(64) }) } });
  require('../src/mobile-ai-visual-test/scripts/reporting/identity').createIdentity({ repository }).ensure(workspace);
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const recent = new Date(Date.now() - 6 * 86400000).toISOString();
  const rejected = retainedJob(repository, workspace, 'a-rejected', 'REJECTED', old);
  const exhausted = retainedJob(repository, workspace, 'b-exhausted', 'RETRYABLE_FAILED', old, { attempts: 3 });
  const unfinished = retainedJob(repository, workspace, 'c-unfinished', 'RETRYABLE_FAILED', recent, { attempts: 3 });
  queue.status(workspace);
  assert.equal(fs.existsSync(rejected), true);
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(queue.status(workspace, 'a-rejected').state, 'EXPIRED_LOCAL');
  assert.equal(fs.existsSync(rejected), false);
  assert.equal(fs.existsSync(exhausted), true);
  const owner = repository.readWorkspace(workspace, 'worker-claim.json');
  repository.writeWorkspace(workspace, 'worker-claim.json', { ...owner, state: 'RELEASED' });
  queue.submit({ workspace, scope: 'workspace', trigger: 'manual', bundleId: 'b'.repeat(64) });
  assert.equal(queue.status(workspace, 'b-exhausted').state, 'EXPIRED_LOCAL');
  assert.equal(fs.existsSync(exhausted), false);
  assert.equal(fs.existsSync(unfinished), true);
  assert.equal(queue.status(workspace, 'c-unfinished').state, 'RETRYABLE_FAILED');
  assert.throws(() => queue.retry(workspace, 'a-rejected'), { code: 'REPORTING_RESUBMIT_REQUIRED' });
});

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

test('real spawn failure is persisted without an unhandled error terminating the reporting caller', t => {
  const { workspace, repository } = fixture(t);
  const bundleRoot = path.join(workspace, '.mavt/runtime-bundles');
  const staging = path.join(bundleRoot, 'fixture');
  const entry = path.join(staging, 'runtime/mobile-ai-visual-test/scripts/reporting/worker.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(path.join(staging, 'hosts/codex'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'hosts/codex/delegation.md'), 'fixture');
  fs.writeFileSync(entry, '');
  const manifest = createManifest(staging, 'fixture');
  fs.writeFileSync(path.join(staging, 'bundle.manifest.json'), JSON.stringify(manifest));
  fs.renameSync(staging, path.join(bundleRoot, manifest.bundleId));
  const source = `
    const {spawn}=require('node:child_process');
    const [root,workspace,configDir,bundleId]=process.argv.slice(1);
    const repository=require(root+'/repository').createRepository({configDir});
    const queue=require(root+'/jobs').createJobQueue({repository,
      credentials:{status:()=>({configured:true,generation:'a'.repeat(64)})},
      launcher:(claim,workspace)=>require(root+'/launcher').launchWorker(claim,workspace,{
        spawn:()=>spawn(process.execPath,['-e',''],{cwd:workspace+'/missing-cwd',stdio:'ignore'})
      })});
    const submitted=queue.submit({workspace,scope:'workspace',trigger:'manual',bundleId});
    setImmediate(()=>console.log(JSON.stringify({job:queue.status(workspace,submitted.jobId),
      claim:repository.readWorkspace(workspace,'worker-claim.json').state})));`;
  const child = spawnSync(process.execPath, ['-e', source,
    path.dirname(require.resolve('../src/mobile-ai-visual-test/scripts/reporting/jobs')),
    workspace, repository.configDir, manifest.bundleId], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.job.state, 'COLLECTION_FAILED');
  assert.equal(result.job.failureCode, 'REPORTING_WORKER_LAUNCH_FAILED');
  assert.equal(result.claim, 'RELEASED');
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

test('frozen blobs survive a partial result and status-only terminal receipts', async t => {
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
  assert.equal(queue.status(workspace, job.jobId).metrics.localCleanupPending, true);
  assert.equal(fs.existsSync(blob), true);
});

for (const [name, mutate, expected, adopted] of [
  ['valid', receipt => receipt, 'COMMITTED', false],
  ['valid old-generation', receipt => receipt, 'COMMITTED', true],
  ['foreign binding', receipt => ({ ...receipt, serverUrl: 'https://foreign.invalid/' }), 'RETRYABLE_FAILED', false],
  ['invalid terminal result', receipt => ({ ...receipt, results: { ...receipt.results,
    workspace: { ...receipt.results.workspace, id: 'foreign-workspace' } } }), 'RETRYABLE_FAILED', false]
]) {
  test(`${name} persisted receipt is validated before frozen data cleanup`, async t => {
    const f = await committedPackage(t, { oldGeneration: adopted,
      queueOptions: { processIdentity: () => 'started' } });
    const { workspace, repository, queue } = f;
    const relative = f.sessions[0].receiptRelative;
    const receipt = repository.readWorkspace(workspace, relative);
    repository.writeWorkspace(workspace, relative, mutate(receipt));
    const blob = path.join(f.packageRoot, 'blobs', f.frozen.files[0].id);
    const reserved = prepareCommittedWorker(f);
    const worker = createWorker({ repository, queue,
      credentials: { status: () => ({ configured: true, generation: f.currentGeneration }) },
      transport: { serverUrl: f.submitted.serverUrl, credentialGeneration: f.currentGeneration,
        capabilities: () => assert.fail('receipt recovery must not use network') },
      collectExport: () => assert.fail('receipt recovery must not recollect sources') });
    await worker.runClaim(workspace, reserved.nonce, { pid: 123, processStartedAt: 'started' });
    assert.equal(queue.status(workspace, f.submitted.jobId).state, expected);
    assert.equal(fs.existsSync(blob), expected !== 'COMMITTED');
    if (adopted) assert.equal(repository.readWorkspace(workspace, relative).credentialGeneration, f.generation);
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
