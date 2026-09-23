#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  HelperActionOutcomeUnknown,
  HelperAuthenticationRejected,
  performAction,
  ping,
  snapshotToFiles,
} = require('../platform/adapters/android/lib/android-helper-client');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const XML = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="Settings" /></hierarchy>';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-android-helper-client-'));
let behavior = null;

function json(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
  response.end(body);
}

function requestBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (request, response) => {
  try {
    await behavior(request, response);
  } catch (error) {
    response.destroy(error);
  }
});

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close() {
  return new Promise((resolve) => server.close(resolve));
}

function runCli(command, args) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function goodSnapshot(overrides = {}) {
  return {
    success: true,
    has_screenshot: true,
    screenshot_format: 'png',
    screenshot_media_type: 'image/png',
    screenshot_base64: PNG.toString('base64'),
    xml: XML,
    width: 1,
    height: 1,
    atomic_elapsed_ms: 17,
    elapsed_ms: 11,
    node_count: 1,
    ...overrides,
  };
}

(async () => {
  const port = await listen();
  const session = {
    deviceId: 'android-device', localPort: port, token: 'secret-token',
    protocolVersion: 2, versionCode: 7, helperVersion: '1.2.1', generation: 1,
  };
  const screenshotPath = path.join(root, 'screenshots', 'scene.png');
  const layoutPath = path.join(root, 'layouts', 'scene.xml');

  behavior = async (request, response) => {
    assert.strictEqual(request.headers['x-artemis-token'], 'secret-token');
    assert.strictEqual(request.method, 'GET');
    assert.strictEqual(request.url, '/snapshot?fields=xml&format=png');
    json(response, 200, goodSnapshot());
  };
  const metadata = await snapshotToFiles(session, { screenshotPath, layoutPath, timeoutMs: 1000 });
  assert.deepStrictEqual(fs.readFileSync(screenshotPath), PNG);
  assert.strictEqual(fs.readFileSync(layoutPath, 'utf8'), XML);
  assert.strictEqual(metadata.backend, 'helper');
  assert.strictEqual(metadata.width, 1);
  assert.strictEqual(metadata.height, 1);
  assert.strictEqual(metadata.atomicElapsedMs, 17);
  assert.strictEqual(metadata.layoutElapsedMs, 11);
  assert.strictEqual(metadata.protocolVersion, 2);
  assert.strictEqual(metadata.versionCode, 7);
  assert.strictEqual(Object.hasOwn(metadata, 'screenshot_base64'), false);
  assert.strictEqual(JSON.stringify(metadata).includes('secret-token'), false);
  assert.strictEqual(JSON.stringify(metadata).includes('<hierarchy'), false);

  behavior = async (request, response) => {
    assert.strictEqual(request.url, '/ping');
    json(response, 200, {
      success: true, authenticated: true, token_set: true, protocol_version: 2, version_code: 7,
    });
  };
  assert.strictEqual((await ping(session, { timeoutMs: 1000 })).authenticated, true);

  behavior = async (request, response) => {
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.url, '/action');
    assert.deepStrictEqual(JSON.parse(await requestBody(request)), { cmd: 'tap', x: 1, y: 2 });
    json(response, 200, { success: true });
  };
  assert.strictEqual((await performAction(session, 'tap', { x: 1, y: 2 }, { timeoutMs: 1000 })).success, true);

  behavior = async (_request, response) => json(response, 401, { success: false, error: 'unauthorized' });
  await assert.rejects(() => performAction(session, 'tap', { x: 1, y: 2 }, { timeoutMs: 1000 }), (error) => {
    assert.ok(error instanceof HelperAuthenticationRejected);
    assert.strictEqual(error.code, 'ANDROID_HELPER_AUTHENTICATION_REJECTED');
    assert.strictEqual(error.phase, 'AUTH_REJECTED');
    return true;
  });

  behavior = async () => {};
  await assert.rejects(() => performAction(session, 'tap', { x: 1, y: 2 }, { timeoutMs: 20 }), (error) => {
    assert.ok(error instanceof HelperActionOutcomeUnknown);
    assert.strictEqual(error.code, 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN');
    assert.strictEqual(error.phase, 'POST_DISPATCH_UNKNOWN');
    assert.strictEqual(String(error).includes('secret-token'), false);
    return true;
  });

  behavior = async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': 100 });
    response.write('{"success":');
    response.destroy();
  };
  await assert.rejects(() => performAction(session, 'tap', { x: 1, y: 2 }, { timeoutMs: 1000 }), (error) => {
    assert.ok(error instanceof HelperActionOutcomeUnknown);
    assert.match(error.message, /truncated|socket hang up/);
    return true;
  });

  behavior = async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': 64 * 1024 * 1024 + 1 });
    response.end();
  };
  await assert.rejects(() => snapshotToFiles(session, { screenshotPath, layoutPath, timeoutMs: 1000 }), /response body exceeds 64 MiB/);
  assert.strictEqual(fs.existsSync(screenshotPath), false);
  assert.strictEqual(fs.existsSync(layoutPath), false);

  for (const [name, overrides, pattern] of [
    ['format', { screenshot_format: 'jpeg' }, /screenshot_format/],
    ['media type', { screenshot_media_type: 'image\/jpeg' }, /screenshot_media_type/],
    ['PNG signature', { screenshot_base64: Buffer.from('not-png').toString('base64') }, /PNG signature/],
    ['empty XML', { xml: '  ' }, /non-empty XML/],
    ['missing screenshot', { has_screenshot: false }, /has_screenshot/],
    ['failed snapshot', { success: false, error: 'no active window' }, /no active window/],
  ]) {
    behavior = async (_request, response) => json(response, 200, goodSnapshot(overrides));
    await assert.rejects(
      () => snapshotToFiles(session, { screenshotPath, layoutPath, timeoutMs: 1000 }),
      pattern,
      name,
    );
    assert.strictEqual(fs.existsSync(screenshotPath), false, `${name}: screenshot is not published`);
    assert.strictEqual(fs.existsSync(layoutPath), false, `${name}: layout is not published`);
  }

  const blockedParent = path.join(root, 'blocked-parent');
  fs.writeFileSync(blockedParent, 'not a directory');
  behavior = async (_request, response) => json(response, 200, goodSnapshot());
  await assert.rejects(() => snapshotToFiles(session, {
    screenshotPath,
    layoutPath: path.join(blockedParent, 'scene.xml'),
    timeoutMs: 1000,
  }));
  assert.strictEqual(fs.existsSync(screenshotPath), false);

  const sessionPath = path.join(root, 'session.json');
  fs.writeFileSync(sessionPath, JSON.stringify(session), { mode: 0o600 });
  const cli = path.resolve(__dirname, '../platform/adapters/android/atoms/helper-snapshot.js');
  behavior = async (_request, response) => json(response, 200, goodSnapshot());
  const cliResult = await runCli(process.execPath, [
    cli, '--session-state', sessionPath, '--screenshot-out', screenshotPath,
    '--layout-out', layoutPath, '--timeout-ms', '1000',
  ]);
  assert.strictEqual(cliResult.status, 0, cliResult.stderr);
  const cliMetadata = JSON.parse(cliResult.stdout);
  assert.strictEqual(cliMetadata.backend, 'helper');
  assert.strictEqual(cliResult.stdout.includes('secret-token'), false);

  fs.chmodSync(sessionPath, 0o644);
  const permissive = childProcess.spawnSync(process.execPath, [
    cli, '--session-state', sessionPath, '--screenshot-out', screenshotPath,
    '--layout-out', layoutPath, '--timeout-ms', '1000',
  ], { encoding: 'utf8' });
  assert.notStrictEqual(permissive.status, 0);
  assert.match(permissive.stderr, /permissions/);
  fs.chmodSync(sessionPath, 0o600);
  const symlinkPath = path.join(root, 'session-link.json');
  fs.symlinkSync(sessionPath, symlinkPath);
  const symlinked = childProcess.spawnSync(process.execPath, [
    cli, '--session-state', symlinkPath, '--screenshot-out', screenshotPath,
    '--layout-out', layoutPath, '--timeout-ms', '1000',
  ], { encoding: 'utf8' });
  assert.notStrictEqual(symlinked.status, 0);
  assert.match(symlinked.stderr, /symbolic link/);

  await close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('android helper client passed');
})().catch(async (error) => {
  await close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
