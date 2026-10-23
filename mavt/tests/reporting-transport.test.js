'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { fixture, runtime } = require('./support/reporting-fixture');
const { httpFixture, capabilities, terminal } = require('./support/reporting-http-fixture');
const load = name => require(path.join(runtime, 'reporting', name));
async function setup(t, hook, options = {}) {
  const f = fixture(t), server = await httpFixture(t, hook), credentials = load('credentials').createCredentials(f.dependencies);
  credentials.prepare(server.serverUrl);
  f.repository.writeConfig('credentials.json', { targets: { [server.serverUrl]: { token: 'private-test-token' } } });
  const generation = credentials.status(server.serverUrl).generation;
  const frozen = await load('collector').collectExport(f.request, f.dependencies);
  const transport = load('transport').createTransport({ credentials, serverUrl: server.serverUrl, credentialGeneration: generation,
    timeouts: { ordinary: 100, file: 500, commit: 500 }, ...options.transport });
  const runner = load('session').createSessionRunner({ ...f.dependencies, credentials, transport,
    timeouts: { total: 3000, commit: 200, poll: 10, retry: 1 }, ...options.runner });
  const input = { workspace: f.workspace, packageId: frozen.packageId, sessionId: frozen.sessions[0].id,
    serverUrl: server.serverUrl, credentialGeneration: generation };
  return { ...f, ...server, credentials, generation, frozen, transport, runner, input,
    run: () => runner.runSession(input) };
}
test('real prefixed routes authenticate, query capabilities independently and upload only requested hash representatives', async t => {
  const f = await setup(t);
  assert.equal((await f.transport.capabilities()).protocolVersions[0], '2.0');
  const result = await f.run();
  assert.equal(result.state, 'COMMITTED');
  assert.ok(f.requests.every(r => r.headers.authorization === 'Bearer private-test-token'));
  const puts = f.requests.filter(r => r.method === 'PUT');
  assert.equal(puts.length, new Set(f.frozen.sessions[0].files.map(x => x.sha256)).size);
  assert.ok(puts.every(r => !r.headers['content-encoding']));
  assert.equal(f.repository.readWorkspace(f.workspace, result.receiptRelative).status, 'COMMITTED');
});
test('lost prepare retries exact raw bytes and original key without an unknown-session query', async t => {
  let lost = false;
  const f = await setup(t, ({ req, res }) => {
    if (req.method === 'POST' && req.url.endsWith('/sessions') && !lost) { lost = true; res.destroy(); return true; }
  });
  assert.equal((await f.run()).state, 'COMMITTED');
  const prepares = f.requests.filter(r => r.url.endsWith('/sessions'));
  assert.equal(prepares.length, 2);
  assert.deepEqual(prepares[1].body, prepares[0].body);
  assert.equal(prepares[1].headers['idempotency-key'], prepares[0].headers['idempotency-key']);
  assert.equal(prepares[0].body.toString(), f.frozen.sessions[0].rawManifest);
  assert.equal(f.requests.some(r => r.method === 'GET' && /sessions/.test(r.url)), false);
});
test('PUT response loss queries known session and skips remotely accepted content', async t => {
  let lost = false;
  const f = await setup(t, ({ req, res, sessions }) => {
    if (req.method === 'PUT' && !lost) {
      lost = true;
      const s = [...sessions.values()][0]; s.missingFiles = s.missingFiles.filter(id => !req.url.endsWith('/' + id));
      res.destroy(); return true;
    }
  });
  assert.equal((await f.run()).state, 'COMMITTED');
  assert.equal(f.requests.filter(r => r.method === 'GET' && /sessions/.test(r.url)).length, 1);
  const puts = f.requests.filter(r => r.method === 'PUT');
  assert.equal(new Set(puts.map(r => r.url)).size, puts.length);
});
test('lost commit response recovers terminal receipt by GET without another commit', async t => {
  let lost = false;
  const f = await setup(t, ({ req, res, sessions }) => {
    if (req.url.endsWith('/commit') && !lost) {
      lost = true; const s = [...sessions.values()][0]; Object.assign(s, terminal(s.manifest, s.sessionId)); res.destroy(); return true;
    }
  });
  assert.equal((await f.run()).state, 'COMMITTED');
  assert.equal(f.requests.filter(r => r.url.endsWith('/commit')).length, 1);
});
test('410 durably rotates only key while preserving manifest bytes and revision', async t => {
  let expired = false;
  const f = await setup(t, ({ req, res, json }) => {
    if (req.url.endsWith('/sessions') && !expired) { expired = true; json(res, {}, 410); return true; }
  });
  const result = await f.run();
  assert.equal(result.state, 'COMMITTED');
  const prepares = f.requests.filter(r => r.url.endsWith('/sessions'));
  assert.deepEqual(prepares[0].body, prepares[1].body);
  assert.notEqual(prepares[0].headers['idempotency-key'], prepares[1].headers['idempotency-key']);
  assert.equal(result.key, prepares[1].headers['idempotency-key']);
});
test('HTTP 200 REJECTED is a durable terminal failure with safe diagnostics', async t => {
  const f = await setup(t, ({ req, res, sessions, json }) => {
    if (req.url.endsWith('/commit')) { const s = [...sessions.values()][0]; json(res, terminal(s.manifest, s.sessionId, 'REJECTED')); return true; }
  });
  assert.equal((await f.run()).state, 'REJECTED');
  const count = f.requests.length;
  assert.equal((await f.run()).failureCode, 'REPORTING_RESUBMIT_REQUIRED');
  assert.equal(f.requests.length, count);
});
for (const status of [401, 403, 404, 429, 503]) test(`HTTP ${status} pauses safely and honors persisted Retry-After`, async t => {
  const f = await setup(t, ({ res, json }) => { json(res, { message: 'private-test-token /Users/secret', code: 'PRIVATE_TOKEN' }, status, { 'retry-after': '120' }); return true; });
  const result = await f.run();
  assert.equal(result.state, [401, 403].includes(status) ? 'NEEDS_CREDENTIAL' : 'RETRYABLE_FAILED');
  if ([429, 503].includes(status)) assert.ok(Date.parse(result.nextRetryAt) >= Date.now() + 110000);
  assert.doesNotMatch(JSON.stringify(result), /private-test-token|Users|PRIVATE_TOKEN/);
  assert.equal(f.requests.length, 1);
});
test('changed credential generation stops before any request and does not retarget existing state', async t => {
  const f = await setup(t);
  f.repository.writeConfig('credentials.json', { targets: { [f.serverUrl]: { token: 'different-private-token' } } });
  assert.equal((await f.run()).state, 'NEEDS_CREDENTIAL');
  assert.equal(f.requests.length, 0);
});
for (const kind of ['html', 'oversize', 'redirect', 'wrong-missing', 'wrong-result', 'wrong-session']) test(`rejects ${kind} protocol response without echo or foreign requests`, async t => {
  let redirected = 0;
  const f = await setup(t, ({ req, res, sessions, json }) => {
    if (kind === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>private-test-token</html>'); return true; }
    if (kind === 'oversize') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(' '.repeat(4 * 1024 * 1024 + 1)); return true; }
    if (kind === 'redirect') { redirected++; res.writeHead(302, { location: '/foreign/private-test-token' }); res.end(); return true; }
    if (kind === 'wrong-missing' && req.url.endsWith('/sessions')) { json(res, { protocolVersion: '2.0', sessionId: 'remote-1', status: 'UPLOADING', expiresAt: '2099-01-01T00:00:00.000Z', limits: capabilities().limits, missingFiles: ['../private-test-token'] }, 201); return true; }
    if ((kind === 'wrong-result' || kind === 'wrong-session') && req.url.endsWith('/commit')) {
      const s = [...sessions.values()][0], result = terminal(s.manifest, s.sessionId);
      if (kind === 'wrong-result') result.results.cases[0].caseKey = 'foreign'; else result.sessionId = 'foreign';
      json(res, result); return true;
    }
  });
  const result = await f.run();
  assert.equal(result.state, 'RETRYABLE_FAILED');
  assert.match(result.failureCode, /REPORTING_(PROTOCOL_INVALID|RESPONSE_TOO_LARGE|REDIRECT_REFUSED)/);
  assert.doesNotMatch(JSON.stringify(result), /private-test-token|foreign/);
  if (kind === 'redirect') assert.equal(redirected, 1);
});
test('capabilities reductions are enforced before prepare', async t => {
  const f = await setup(t, ({ req, res, json }) => {
    if (req.url.endsWith('/capabilities')) { const c = capabilities(); c.limits.files = 1; json(res, c); return true; }
  });
  assert.equal((await f.run()).state, 'RETRYABLE_FAILED');
  assert.equal(f.requests.some(r => r.method === 'POST'), false);
});
test('explicit frozen gzip descriptors send bounded gzip bytes without rewriting prepare', async t => {
  const f = await setup(t);
  const file = f.frozen.sessions[0].files.find(x => x.mediaType === 'application/json');
  file.encoding = 'gzip';
  const original = fs.readFileSync(file.path);
  const prepared = await f.transport.prepare(f.frozen.sessions[0].rawManifest, f.frozen.sessions[0].key);
  await f.transport.upload(prepared.sessionId, file, { limits: capabilities().limits });
  const put = f.requests.find(r => r.method === 'PUT');
  assert.equal(put.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(put.body), original);
  assert.equal(Number(put.headers['content-length']), put.body.length);
});
test('excessive frozen gzip ratio fails before transmission rather than mutating descriptor', async t => {
  const f = await setup(t), raw = Buffer.alloc(100000, 32), p = path.join(f.dir, 'compressible'); fs.writeFileSync(p, raw);
  const file = { id: 'compressible', path: p, bytes: raw.length, sha256: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex'), mediaType: 'text/plain', encoding: 'gzip' };
  await assert.rejects(f.transport.upload('remote-gzip', file, { limits: { ...capabilities().limits, gzipRatio: 2 } }), { code: 'REPORTING_GZIP_RATIO_EXCEEDED' });
  assert.equal(f.requests.length, 0);
  assert.equal(file.encoding, 'gzip');
});
test('prepare observes durable original hash/key and unchanged frozen identity bytes', async t => {
  let f;
  f = await setup(t, ({ req, record }) => {
    if (req.method === 'POST' && req.url.endsWith('/sessions')) {
      const state = f.repository.readWorkspace(f.workspace, `sessions/${f.frozen.packageId}/${f.input.sessionId}.json`);
      assert.equal(state.key, record.headers['idempotency-key']);
      assert.equal(state.manifestSha256, 'sha256:' + crypto.createHash('sha256').update(record.body).digest('hex'));
      assert.deepEqual(record.body, fs.readFileSync(f.frozen.sessions[0].manifestPath));
    }
  });
  assert.equal((await f.run()).state, 'COMMITTED');
});
test('lost commit validation polls its known session before any expensive repeat', async t => {
  let commitSeen = false, polls = 0;
  const f = await setup(t, ({ req, res, sessions }) => {
    if (req.url.endsWith('/commit')) { commitSeen = true; res.destroy(); return true; }
    if (commitSeen && req.method === 'GET' && /sessions/.test(req.url) && ++polls === 3) {
      const s = [...sessions.values()][0]; Object.assign(s, terminal(s.manifest, s.sessionId));
    }
  });
  assert.equal((await f.run()).state, 'COMMITTED');
  assert.equal(polls, 3);
  assert.equal(f.requests.filter(r => r.url.endsWith('/commit')).length, 1);
});
test('commit uses an independent timeout longer than ordinary control requests', async t => {
  const f = await setup(t, async ({ req }) => {
    if (req.url.endsWith('/commit')) await new Promise(resolve => setTimeout(resolve, 80));
  }, { transport: { timeouts: { ordinary: 40, file: 500, commit: 150 } } });
  assert.equal((await f.run()).state, 'COMMITTED');
});
test('receipt storage failure preserves known commit and retry queries without preparing again', async t => {
  const f = await setup(t), write = f.repository.writeWorkspace;
  let failed = false;
  f.repository.writeWorkspace = (workspace, relative, value) => {
    if (relative.startsWith('receipts/') && !failed) { failed = true; throw load('errors').reportingError('REPORTING_STORAGE_ERROR'); }
    return write(workspace, relative, value);
  };
  await assert.rejects(f.run(), { code: 'REPORTING_STORAGE_ERROR' });
  const before = f.requests.length;
  assert.equal((await f.run()).state, 'COMMITTED');
  const recovery = f.requests.slice(before);
  assert.ok(recovery.some(r => r.method === 'GET' && /sessions/.test(r.url)));
  assert.equal(recovery.some(r => r.method === 'POST'), false);
  assert.ok(fs.existsSync(f.frozen.sessions[0].files[0].path));
});
test('resume after upload failure consumes persisted session instead of preparing a new one', async t => {
  let rejectPut = true;
  const f = await setup(t, ({ req, res, json }) => {
    if (rejectPut && req.method === 'PUT') { json(res, {}, 503); return true; }
  });
  const first = await f.run();
  assert.equal(first.state, 'RETRYABLE_FAILED');
  assert.ok(first.remoteSessionId);
  rejectPut = false;
  assert.equal((await f.run()).state, 'COMMITTED');
  assert.equal(f.requests.filter(r => r.url.endsWith('/sessions')).length, 1);
});
for (const kind of ['duplicate-id', 'same-hash-alias', 'foreign-id']) test(`missingFiles refuses ${kind} before PUT`, async t => {
  let f;
  f = await setup(t, ({ req, res, json }) => {
    if (req.url.endsWith('/sessions')) {
      const s = f.frozen.sessions[0], a = s.files[0];
      let missingFiles;
      if (kind === 'duplicate-id') missingFiles = [a.id, a.id];
      else if (kind === 'foreign-id') missingFiles = ['undeclared'];
      else {
        const pair = s.files.find(x => s.files.some(y => y.id !== x.id && y.sha256 === x.sha256));
        assert.ok(pair, 'fixture must contain real samehash aliases');
        missingFiles = s.files.filter(x => x.sha256 === pair.sha256).map(x => x.id);
      }
      json(res, { protocolVersion: '2.0', sessionId: 'remote-1', status: 'UPLOADING',
        expiresAt: '2099-01-01T00:00:00.000Z', missingFiles, limits: capabilities().limits }, 201);
      return true;
    }
  });
  assert.equal((await f.run()).failureCode, 'REPORTING_PROTOCOL_INVALID');
  assert.equal(f.requests.some(r => r.method === 'PUT'), false);
});
test('control JSON supports a valid ten-thousand-ID response exceeding 1 MiB', async t => {
  const missingFiles = Array.from({ length: 10000 }, (_, i) => 'f' + String(i).padStart(6, '0') + 'x'.repeat(120));
  const f = await setup(t, ({ req, res, json }) => {
    if (req.url.endsWith('/sessions/large')) { json(res, { protocolVersion: '2.0', sessionId: 'large', status: 'UPLOADING', missingFiles }); return true; }
  });
  const value = await f.transport.status('large');
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024);
  assert.deepEqual(value.missingFiles, missingFiles);
});
test('injected total clock budget prevents unbounded retry sleeps and keeps frozen bytes', async t => {
  let now = Date.now();
  const f = await setup(t, ({ req, res }) => {
    if (req.url.endsWith('/sessions')) { res.destroy(); return true; }
  }, { runner: { clock: () => now, sleep: async ms => { now += ms; }, timeouts: { total: 5, retry: 10 } } });
  const result = await f.run();
  assert.equal(result.failureCode, 'REPORTING_RUN_BUDGET_EXCEEDED');
  assert.equal(result.remoteSessionId, null);
  assert.equal(fs.readFileSync(f.frozen.sessions[0].manifestPath, 'utf8'), f.frozen.sessions[0].rawManifest);
});
test('persisted state rejects malformed key and phase instead of making remote effects', async t => {
  const f = await setup(t, ({ res, json }) => { json(res, {}, 503); return true; });
  await f.run();
  const relative = `sessions/${f.frozen.packageId}/${f.input.sessionId}.json`;
  const state = f.repository.readWorkspace(f.workspace, relative);
  f.repository.writeWorkspace(f.workspace, relative, { ...state, key: '../invalid', phase: 'UNKNOWN' });
  const before = f.requests.length;
  await assert.rejects(f.run(), { code: 'REPORTING_STATE_CORRUPT' });
  assert.equal(f.requests.length, before);
});
test('invalid header characters in private credentials produce only a safe paused state', async t => {
  const f = await setup(t);
  f.repository.writeConfig('credentials.json', { targets: { [f.serverUrl]: { token: 'secret\u0000value' } } });
  f.input.credentialGeneration = f.credentials.status(f.serverUrl).generation;
  const transport = load('transport').createTransport({ credentials: f.credentials, serverUrl: f.serverUrl,
    credentialGeneration: f.input.credentialGeneration });
  const runner = load('session').createSessionRunner({ ...f.dependencies, credentials: f.credentials, transport });
  const result = await runner.runSession(f.input);
  assert.equal(result.state, 'NEEDS_CREDENTIAL');
  assert.doesNotMatch(JSON.stringify(result), /secret|value/);
  assert.equal(f.requests.length, 0);
});
test('frozen package corruption fails before prepare or capability requests', async t => {
  const f = await setup(t);
  fs.appendFileSync(f.frozen.sessions[0].files[0].path, 'corruption');
  await assert.rejects(f.run(), { code: 'REPORTING_PACKAGE_CORRUPT' });
  assert.equal(f.requests.length, 0);
});
test('a ready original package remains sendable after a changed newer revision publishes', async t => {
  const f = await setup(t);
  fs.appendFileSync(path.join(f.sources[0].caseDir, 'source.md'), '\nnew definition');
  const newer = await load('collector').collectExport(f.request, f.dependencies);
  assert.ok(newer.manifests[0].cases[0].definitionRevision > f.frozen.manifests[0].cases[0].definitionRevision);
  assert.equal((await f.run()).state, 'COMMITTED');
  assert.equal(f.requests.find(r => r.url.endsWith('/sessions')).body.toString(), f.frozen.sessions[0].rawManifest);
});
test('malformed terminal result rows are sanitized as protocol failure', async t => {
  const f = await setup(t, ({ req, res, sessions, json }) => {
    if (req.url.endsWith('/commit')) {
      const s = [...sessions.values()][0], result = terminal(s.manifest, s.sessionId);
      result.results.cases[0] = null; json(res, result); return true;
    }
  });
  const result = await f.run();
  assert.equal(result.state, 'RETRYABLE_FAILED');
  assert.equal(result.failureCode, 'REPORTING_PROTOCOL_INVALID');
});
test('a fully PACKAGE_READY gzip session preserves its frozen manifest and negotiates header encoding', async t => {
  const f = await setup(t), revisions = load('revisions').createRevisions(f.dependencies);
  const packageId = crypto.randomUUID(), original = f.frozen.sessions[0];
  const manifest = JSON.parse(original.rawManifest);
  manifest.files.forEach(file => { file.encoding = 'gzip'; });
  const tx = revisions.reserve(f.workspace, { packageId, entries: [
    { kind: 'workspace', key: manifest.workspace.id, descriptor: manifest.workspace }
  ] });
  manifest.workspace.revision = tx.allocations[0].revision;
  const rawManifest = JSON.stringify(manifest), key = crypto.randomUUID();
  const base = path.join(f.workspace, '.mavt/reporting/packages', packageId);
  fs.mkdirSync(path.join(base, 'blobs'), { recursive: true });
  for (const file of original.files) fs.copyFileSync(file.path, path.join(base, 'blobs', file.id));
  fs.mkdirSync(path.join(base, 'sessions/session-0001'), { recursive: true });
  fs.writeFileSync(path.join(base, 'sessions/session-0001/manifest.json'), rawManifest);
  revisions.publish(f.workspace, { transactionId: tx.transactionId, manifest: {
    format: 'mavt-frozen/1', packageId, identityEpoch: f.frozen.identityEpoch, limits: capabilities().limits,
    sessions: [{ id: 'session-0001', key, manifestRelative: 'sessions/session-0001/manifest.json',
      manifestSha256: 'sha256:' + crypto.createHash('sha256').update(rawManifest).digest('hex'),
      unitKeys: [], limits: capabilities().limits }], files: manifest.files, units: [], excluded: []
  } });
  f.input.packageId = packageId;
  assert.equal((await f.run()).state, 'COMMITTED');
  const prepare = f.requests.find(r => r.url.endsWith('/sessions'));
  assert.equal(prepare.body.toString(), rawManifest);
  for (const put of f.requests.filter(r => r.method === 'PUT')) {
    const id = put.url.split('/').at(-1), file = original.files.find(file => file.id === id);
    assert.equal(put.headers['content-encoding'], 'gzip');
    assert.deepEqual(zlib.gunzipSync(put.body), fs.readFileSync(file.path));
  }
  assert.equal(fs.readFileSync(path.join(base, 'sessions/session-0001/manifest.json'), 'utf8'), rawManifest);
});
test('explicit credential adoption uses a metadata CAS and retains the known remote session', async t => {
  let rejectPut = true;
  const f = await setup(t, ({ req, res, json }) => {
    if (rejectPut && req.method === 'PUT') { json(res, {}, 503); return true; }
  });
  const original = await f.run();
  f.repository.writeConfig('credentials.json', { targets: { [f.serverUrl]: { token: 'accepted-next-token' } } });
  const generation = f.credentials.status(f.serverUrl).generation;
  const request = { ...f.input, previousGeneration: f.generation, credentialGeneration: generation, expectedSequence: original.sequence };
  assert.throws(() => f.runner.acceptCredentialChange({ ...request, expectedSequence: original.sequence + 1 }), { code: 'REPORTING_SESSION_CHANGED' });
  const adopted = f.runner.acceptCredentialChange(request);
  for (const key of ['remoteSessionId', 'key', 'manifestSha256', 'manifestRelative', 'identityEpoch', 'serverUrl']) assert.equal(adopted[key], original[key]);
  assert.equal(adopted.credentialGeneration, generation);
  assert.equal(adopted.sequence, original.sequence + 1);
  const transport = load('transport').createTransport({ credentials: f.credentials, serverUrl: f.serverUrl, credentialGeneration: generation });
  const runner = load('session').createSessionRunner({ ...f.dependencies, credentials: f.credentials, transport });
  rejectPut = false;
  const completed = await runner.runSession({ ...f.input, credentialGeneration: generation });
  assert.equal(completed.state, 'COMMITTED');
  assert.equal(f.requests.filter(r => r.url.endsWith('/sessions')).length, 1);
  assert.equal(f.requests.at(-1).headers.authorization, 'Bearer accepted-next-token');
  const receipt = f.repository.readWorkspace(f.workspace, completed.receiptRelative);
  assert.throws(() => runner.acceptCredentialChange({ ...request, previousGeneration: generation, expectedSequence: completed.sequence }), { code: 'REPORTING_CREDENTIAL_REBIND_REFUSED' });
  assert.deepEqual(f.repository.readWorkspace(f.workspace, completed.receiptRelative), receipt);
});
