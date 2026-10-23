'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildPlugin } = require('../build-plugin');
const { fixture, runtime } = require('./support/reporting-fixture');
const { httpFixture, terminal } = require('./support/reporting-http-fixture');
const { skills, tools, reportingModules } = require('./support/release-contract');
const { pinBundle, verifyBundle } = require(path.join(runtime, 'lib/runtime-bundle'));
const { createSettings } = require(path.join(runtime, 'reporting/settings'));
const { createJobQueue } = require(path.join(runtime, 'reporting/jobs'));

// A separate process loads only the relocated distribution; no source imports
// are available to satisfy a missing reporting dependency.
test('0.4.0 relocated release has exact Skills/tools and source-closed reporting runtime', t => {
  const f = fixture(t);
  const built = buildPlugin({ outputRoot: path.join(f.dir, 'build') });
  const relocated = path.join(f.dir, 'relocated');
  fs.renameSync(built.marketplaceRoot, relocated);
  const root = path.join(relocated, 'plugins/mavt');
  const manifest = verifyBundle(root, built.manifest.bundleId);
  assert.equal(manifest.pluginVersion, '0.4.0');
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), skills);
  assert.deepEqual(fs.readdirSync(path.join(root, 'runtime/mobile-ai-visual-test/scripts/reporting')).sort(), reportingModules);
  const inventory = require('../release-files.json').files;
  assert.deepEqual(manifest.files.map(f => f.path).sort(), [...inventory.filter(p => /^(hosts|runtime)\//.test(p)), 'runtime/mobile-ai-visual-test/mcp-transport.json'].sort());
  const files = fs.readdirSync(root, { recursive: true }).filter(p => fs.lstatSync(path.join(root, p)).isFile()).sort();
  assert.deepEqual(files, [...inventory, 'runtime/mobile-ai-visual-test/mcp-transport.json', 'bundle.manifest.json'].sort());
  for (const relative of inventory) {
    const source = relative.startsWith('runtime/') ? relative.replace(/^runtime\//, 'src/') : relative;
    assert.deepEqual(fs.readFileSync(path.join(root, relative)), fs.readFileSync(path.resolve(__dirname, '..', source)), relative);
  }
  const script = `const p=${JSON.stringify(root)};const r=p+'/runtime/mobile-ai-visual-test/scripts/reporting/';for(const n of require('node:fs').readdirSync(r).filter(n=>n.endsWith('.js')))require(r+n);console.log(JSON.stringify(Object.keys(require.cache).filter(n=>!n.startsWith(p+'/'))))`;
  const closed = spawnSync(process.execPath, ['-e', script], { cwd: f.dir, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout), []);
  const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const probe = spawnSync(process.execPath, [path.join(root, 'scripts/mavt-mcp.js')], { cwd: f.dir, env: { PATH: process.env.PATH, HOME: f.dir, XDG_CONFIG_HOME: path.join(f.dir, 'stdio-config') }, encoding: 'utf8', input: [
    request(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release', version: '0' } }),
    request(1, 'tools/list', {}), request(2, 'tools/call', { name: 'mavt_reporting_settings_read', arguments: {} })
  ].join('\n') + '\n' });
  assert.equal(probe.status, 0, probe.stderr);
  const output = probe.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(output[1].result.tools.map(t => t.name).sort(), tools);
  assert.equal(output[2].result.structuredContent.result.configured, false);
});

for (const broken of [false, true]) test(`detached pinned whole-job upload survives parent exit${broken ? ' and replays dropped prepare/PUT/commit responses' : ''}`, { timeout: 30000 }, async t => {
  const f = fixture(t, [{ platform: 'ios', verdict: 'PASS', checkStatus: 'WAIVED' },
    { platform: 'android', suffix: 'android', verdict: 'FAIL' }, { platform: 'harmony', suffix: 'harmony', verdict: 'BLOCKED' }]);
  const dropped = new Set();
  let releaseCapabilities;
  const capabilityGate = new Promise(resolve => { releaseCapabilities = resolve; });
  const remote = await httpFixture(t, async ({ req, res, sessions, keys, record }) => {
    if (req.url.endsWith('/capabilities')) await capabilityGate;
    if (!broken) return false;
    if (req.method === 'POST' && req.url.endsWith('/sessions') && !dropped.has('prepare')) {
      const manifest = JSON.parse(record.body), id = 'remote-1';
      const hashes = new Set();
      sessions.set(id, { manifest, protocolVersion: '2.0', sessionId: id, status: 'UPLOADING',
        expiresAt: '2099-01-01T00:00:00.000Z', limits: require('./support/reporting-http-fixture').capabilities().limits,
        missingFiles: manifest.files.filter(f => !hashes.has(f.sha256) && hashes.add(f.sha256)).map(f => f.id) });
      keys.set(record.headers['idempotency-key'], id);
      dropped.add('prepare'); res.destroy(); return true;
    }
    if (req.method === 'PUT' && !dropped.has('put')) {
      const session = [...sessions.values()][0], id = req.url.split('/').at(-1);
      session.missingFiles = session.missingFiles.filter(f => f !== id);
      dropped.add('put'); res.destroy(); return true;
    }
    if (req.url.endsWith('/commit') && !dropped.has('commit')) {
      const s = [...sessions.values()][0]; Object.assign(s, terminal(s.manifest, s.sessionId));
      dropped.add('commit'); res.destroy(); return true;
    }
  });
  createSettings({ repository: f.repository }).update({ serverUrl: remote.serverUrl });
  f.repository.writeConfig('credentials.json', { targets: { [remote.serverUrl]: { token: 'anonymous-release-fixture' } } });
  const credentials = require(path.join(runtime, 'reporting/credentials')).createCredentials({ repository: f.repository });
  const productionTransport = require(path.join(runtime, 'reporting/transport')).createTransport({ repository: f.repository, credentials,
    serverUrl: remote.serverUrl, credentialGeneration: credentials.status(remote.serverUrl).generation });
  assert.equal(Object.isFrozen(productionTransport), true, 'regression must use the frozen production transport');
  const built = buildPlugin({ outputRoot: path.join(f.dir, 'built') });
  const pinned = pinBundle(built.pluginRoot, f.workspace);
  fs.rmSync(built.marketplaceRoot, { recursive: true });
  // The parent submits via the real pinned service and exits before the server
  // allows collection; its detached child must finish from the pinned closure.
  const script = `const s=require(${JSON.stringify(path.join(pinned.runtimeRoot, 'scripts/reporting/service'))}).createReportingService({configDir:${JSON.stringify(f.repository.configDir)}});console.log(JSON.stringify(s.submit(${JSON.stringify({ workspace: f.workspace, scope: 'workspace', trigger: 'manual', runtimeRoot: pinned.runtimeRoot, bundleId: pinned.bundleId })})))`;
  const startedAt = Date.now();
  let sampledWorkerPeakRssKiB = 0;
  function sampleWorker() {
    const claim = f.repository.readWorkspace(f.workspace, 'worker-claim.json');
    if (!claim?.pid || claim.state !== 'ACTIVE') return;
    const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(claim.pid)], { encoding: 'utf8' });
    if (ps.status === 0) sampledWorkerPeakRssKiB = Math.max(sampledWorkerPeakRssKiB, Number(ps.stdout.trim()) || 0);
  }
  const parent = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(parent.status, 0, parent.stderr);
  const submission = JSON.parse(parent.stdout);
  assert.equal(submission.state, 'QUEUED');
  releaseCapabilities();
  const queue = createJobQueue({ repository: f.repository, launcher: () => {} });
  let state;
  const deadline = Date.now() + 25000;
  do {
    await new Promise(resolve => setTimeout(resolve, 40));
    sampleWorker();
    state = queue.status(f.workspace, submission.jobId);
  } while (Date.now() < deadline && !['COMMITTED', 'COLLECTION_FAILED', 'REJECTED', 'RETRYABLE_FAILED'].includes(state.state));
  if (broken) {
    assert.equal(state.state, 'RETRYABLE_FAILED', JSON.stringify(state));
    assert.deepEqual([...dropped].sort(), ['commit', 'prepare', 'put']);
    assert.equal(state.sessions[0].failureCode, 'REPORTING_NETWORK_ERROR');
    const frozenPackageId = state.packageId;
    const frozenRoot = path.join(f.workspace, '.mavt/reporting/packages', frozenPackageId);
    assert.equal(fs.existsSync(path.join(frozenRoot, 'blobs')), true, 'lost response cannot authorize cleanup');
    const releasedBy = Date.now() + 2000;
    while (f.repository.readWorkspace(f.workspace, 'worker-claim.json').state !== 'RELEASED' && Date.now() < releasedBy)
      await new Promise(resolve => setTimeout(resolve, 20));
    const retryScript = `const s=require(${JSON.stringify(path.join(pinned.runtimeRoot, 'scripts/reporting/service'))}).createReportingService({configDir:${JSON.stringify(f.repository.configDir)}});console.log(JSON.stringify(s.retry(${JSON.stringify(f.workspace)},${JSON.stringify(submission.jobId)})))`;
    const retryParent = spawnSync(process.execPath, ['-e', retryScript], { encoding: 'utf8', timeout: 10000 });
    assert.equal(retryParent.status, 0, retryParent.stderr);
    const retryDeadline = Date.now() + 12000;
    do {
      await new Promise(resolve => setTimeout(resolve, 40));
      sampleWorker();
      state = queue.status(f.workspace, submission.jobId);
    } while (Date.now() < retryDeadline && state.state !== 'COMMITTED');
    assert.equal(state.packageId, frozenPackageId, 'explicit retry resumes the original frozen package');
  }
  assert.equal(state.state, 'COMMITTED', JSON.stringify(state));
  const claimDeadline = Date.now() + 2000;
  while (f.repository.readWorkspace(f.workspace, 'worker-claim.json').state !== 'RELEASED' && Date.now() < claimDeadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.repository.readWorkspace(f.workspace, 'worker-claim.json').state, 'RELEASED');
  assert.equal(remote.sessions.size, 1);
  assert.equal(remote.keys.size, 1);
  const session = [...remote.sessions.values()][0];
  assert.deepEqual(session.manifest.executions.map(e => e.platform).sort(), ['android', 'harmony', 'ios']);
  assert.equal(session.status, 'COMMITTED');
  assert.equal(session.missingFiles.length, 0);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].receiptReady, true);
  const receipt = f.repository.readWorkspace(f.workspace, `receipts/${state.packageId}/${state.sessions[0].id}.json`);
  assert.equal(receipt.status, 'COMMITTED');
  assert.equal(receipt.sessionId, session.sessionId);
  const packageRoot = path.join(f.workspace, '.mavt/reporting/packages', state.packageId);
  assert.equal(fs.existsSync(path.join(packageRoot, 'blobs')), false);
  assert.equal(fs.existsSync(path.join(packageRoot, 'sessions')), false);
  const puts = remote.requests.filter(r => r.method === 'PUT');
  assert.ok(puts.length > 0);
  assert.equal(puts.length, new Set(session.manifest.files.map(file => file.sha256)).size);
  assert.equal(new Set(puts.map(put => put.url)).size, puts.length, 'query recovery must not replay an already accepted PUT');
  for (const put of puts) {
    const file = session.manifest.files.find(f => f.id === put.url.split('/').at(-1));
    assert.ok(file, 'only requested missing files are uploaded');
    assert.equal('sha256:' + crypto.createHash('sha256').update(put.body).digest('hex'), file.sha256);
  }
  const prepares = remote.requests.filter(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  assert.equal(prepares.length, broken ? 2 : 1);
  if (broken) {
    assert.deepEqual([...dropped].sort(), ['commit', 'prepare', 'put']);
    assert.equal(prepares[0].headers['idempotency-key'], prepares[1].headers['idempotency-key']);
    assert.deepEqual(prepares[0].body, prepares[1].body);
    assert.ok(remote.requests.some(r => r.method === 'GET' && r.url.endsWith('/remote-1')));
  }
  assert.equal(remote.requests.filter(r => r.url.endsWith('/commit')).length, 1);
  assert.ok(state.metrics.frozenRawBytes > 0);
  assert.ok(state.metrics.acknowledgedWireBytes > 0);
  assert.ok(sampledWorkerPeakRssKiB > 0);
  t.diagnostic(JSON.stringify({ broken, jobs: 1, executions: 3, sessions: 1, files: session.manifest.files.length,
    missingFiles: session.missingFiles.length, rawBytes: state.metrics.frozenRawBytes, uniqueRawBytes: state.metrics.frozenUniqueBytes,
    wireBytes: state.metrics.acknowledgedWireBytes, receivedWireBytes: puts.reduce((n, r) => n + r.body.length, 0),
    missingBytes: 0, elapsedMs: Date.now() - startedAt, sampledWorkerPeakRssKiB, puts: puts.length, parentExitedBeforeCollection: true }));
});
