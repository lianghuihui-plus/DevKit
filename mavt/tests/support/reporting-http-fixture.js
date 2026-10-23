'use strict';
const http = require('node:http');
const { SECTION_KINDS, LIMITS } = require('../../src/mobile-ai-visual-test/scripts/reporting/contracts');
function capabilities() {
  return { protocolVersions: ['2.0'], documentVersions: ['1.0'],
    sectionVersions: Object.fromEntries(SECTION_KINDS.map(k => [k, ['1.0']])),
    platforms: ['android', 'ios', 'harmony'], encodings: ['identity', 'gzip'],
    mediaTypes: { upload: 'opaque-attachment', preview: [] },
    unknownSections: 'preserve-with-generic-view', chunkedUpload: false,
    sessionTtlSeconds: 86400, limits: { ...LIMITS } };
}
function terminal(manifest, sessionId, status = 'COMMITTED') {
  const decision = status === 'COMMITTED' ? 'CREATED' : 'REJECTED';
  const result = value => ({ ...value, decision, code: status === 'COMMITTED' ? null : 'INVALID_DOCUMENT' });
  return { protocolVersion: '2.0', sessionId, status, results: {
    workspace: result({ id: manifest.workspace.id }),
    cases: manifest.cases.map(c => result({ caseKey: c.caseKey })),
    executions: manifest.executions.map(e => result({ caseKey: e.caseKey, platform: e.platform, executionId: e.executionId }))
  }, errors: status === 'COMMITTED' ? [] : [{ path: '/cases/0', code: 'INVALID_DOCUMENT' }] };
}
async function httpFixture(t, hook = () => false) {
  const requests = [], sessions = new Map(), keys = new Map();
  const json = (res, body, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    if (await hook({ req, res, record, requests, sessions, keys, json })) return;
    const relative = req.url.replace('/prefix/api/v2/reporting/', '');
    if (relative === 'capabilities') return json(res, capabilities());
    if (relative === 'sessions' && req.method === 'POST') {
      const key = req.headers['idempotency-key'];
      let s = sessions.get(keys.get(key));
      if (!s) {
        const manifest = JSON.parse(body), id = `remote-${sessions.size + 1}`;
        const hashes = new Set();
        s = { manifest, protocolVersion: '2.0', sessionId: id, status: 'UPLOADING',
          expiresAt: '2099-01-01T00:00:00.000Z', limits: { ...LIMITS },
          missingFiles: manifest.files.filter(f => !hashes.has(f.sha256) && hashes.add(f.sha256)).map(f => f.id) };
        sessions.set(id, s); keys.set(key, id);
      }
      return json(res, s, 201);
    }
    const match = /^sessions\/([^/]+)(?:\/files\/([^/]+)|(\/commit))?$/.exec(relative);
    const s = sessions.get(match?.[1]);
    if (!s) return json(res, { message: 'missing' }, 404);
    if (req.method === 'GET') return json(res, s);
    if (match[2]) { s.missingFiles = s.missingFiles.filter(id => id !== match[2]); return json(res, { status: 'AVAILABLE' }); }
    if (match[3]) { const result = terminal(s.manifest, s.sessionId); Object.assign(s, result); return json(res, result); }
    json(res, {}, 400);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { serverUrl: `http://127.0.0.1:${server.address().port}/prefix/`, requests, sessions, keys, json };
}
module.exports = { httpFixture, capabilities, terminal };
