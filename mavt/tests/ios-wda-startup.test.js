'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const root = '../src/mobile-ai-visual-test/scripts/platform/adapters/ios/lib/';
const client = require(`${root}appium-client`);

test('selected device system version survives environment resolution and adapter serialization', () => {
  const ios = require(`${root}../environment`);
  const { environmentAdapterArgs } = require('../src/mobile-ai-visual-test/scripts/lib/execution-environment');
  const { buildTarget, parseArgs } = require(`${root}device-target`);
  // Simulator resolution needs no local signing commands.
  const result = ios.resolve({ binding: { deviceId: 'SIM', deviceType: 'simulator', appId: 'com.example' },
    probe: { devices: [{ id: 'SIM', platformVersion: '18.0' }] } }, { env: {} });
  assert.equal(result.binding.platformVersion, '18.0');
  const args = environmentAdapterArgs({ ...result.binding, platform: 'ios' }, 'runtime');
  assert.equal(buildTarget(parseArgs(args.slice(2))).platformVersion, '18.0');
});

test('metadata failure prevents an Appium session request', async () => {
  let called = false;
  const server = http.createServer((_req, res) => { called = true; res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-wda-preflight-'));
  try {
    await assert.rejects(client.createSession({ appiumServer: `http://127.0.0.1:${server.address().port}` }, {
      buildTarget: () => { const error = new Error('target version unavailable'); error.code = 'IOS_WDA_BUILD_CONTEXT_FAILED'; throw error; },
      diagnosticsDirectory: dir,
    }), { code: 'IOS_WDA_BUILD_CONTEXT_FAILED' });
    assert.equal(called, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('managed WDA requests a separate successful build before launch and retains Xcode output', () => {
  const caps = client.sessionCapabilities({ deviceType: 'realDevice', wdaBuildPrepared: true });
  assert.equal(caps['appium:usePrebuiltWDA'], true);
  assert.equal(Object.hasOwn(caps, 'appium:prebuildWDA'), false);
  assert.equal(caps['appium:showXcodeLog'], true);
  const external = client.sessionCapabilities({ webDriverAgentUrl: 'http://wda:8100' });
  assert.equal(Object.hasOwn(external, 'appium:prebuildWDA'), false);
});

test('cache changes for toolchain, device OS and signing while identical configuration reuses it', () => {
  const { buildConfiguration } = require(`${root}wda-build`);
  const target = { device: 'IPAD', deviceType: 'realDevice', xcodeOrgId: 'TEAM', xcodeSigningId: 'Apple Development', updatedWDABundleId: 'com.example.wda' };
  const metadata = { developerDirectory: '/Xcode/Developer', xcodeVersion: 'Xcode 26.3\nBuild version 17C529', driverVersion: '11.17.1', wdaVersion: '12.0.0', projectSha: 'abc', platformVersion: '15.4.1' };
  const options = { cacheRoot: '/test/wda' };
  const original = buildConfiguration(target, metadata, options);
  assert.equal(buildConfiguration({ ...target }, { ...metadata }, options).derivedDataPath, original.derivedDataPath);
  for (const changed of [{ xcodeVersion: 'Xcode 27' }, { driverVersion: '12' }, { wdaVersion: '13' }, { projectSha: 'def' }, { platformVersion: '16.0' }]) {
    assert.notEqual(buildConfiguration(target, { ...metadata, ...changed }, options).derivedDataPath, original.derivedDataPath);
  }
  for (const changed of [{ device: 'IPHONE' }, { xcodeOrgId: 'TEAM2' }, { xcodeSigningId: 'iPhone Developer' }, { updatedWDABundleId: 'com.other.wda' }]) {
    assert.notEqual(buildConfiguration({ ...target, ...changed }, metadata, options).derivedDataPath, original.derivedDataPath);
  }
  assert.match(original.derivedDataPath, /^\/test\/wda\/[a-f0-9]{64}$/);
  assert.equal(original.platformVersion, '15.4.1');
});

test('build metadata uses installed WDA and frozen OS without querying the device again', async (t) => {
  const { prepareBuildTarget } = require(`${root}wda-build`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-wda-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const driver = path.join(directory, 'xcuitest');
  const wda = path.join(driver, 'node_modules/appium-webdriveragent');
  fs.mkdirSync(path.join(wda, 'WebDriverAgent.xcodeproj'), { recursive: true });
  fs.writeFileSync(path.join(driver, 'package.json'), '{"name":"appium-xcuitest-driver"}');
  fs.writeFileSync(path.join(wda, 'package.json'), '{"name":"appium-webdriveragent","version":"12.0.0"}');
  fs.writeFileSync(path.join(wda, 'WebDriverAgent.xcodeproj/project.pbxproj'), 'fixture project');
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === 'xcode-select') return '/Xcode/Developer';
    if (command === 'xcodebuild') return 'Xcode 26.3\nBuild version 17C529';
    if (command === 'appium') return JSON.stringify({ xcuitest: { installed: true, version: '11.17.1', installPath: driver } });
    throw new Error('Must not query a device');
  };
  const builds = [];
  const runBuild = async (command, args) => { builds.push([command, args]); };
  const target = { appiumServer: 'http://127.0.0.1:4723', deviceType: 'realDevice', device: 'IPAD', platformVersion: '15.4.1' };
  const first = await prepareBuildTarget(target, { run, runBuild, diagnosticsDirectory: directory, cacheRoot: directory });
  const second = await prepareBuildTarget(target, { run, runBuild, diagnosticsDirectory: directory, cacheRoot: directory });
  assert.equal(first.derivedDataPath, second.derivedDataPath);
  assert.equal(first.platformVersion, '15.4.1');
  assert.equal(calls.length, 6);
  assert.equal(first.wdaBuildPrepared, true);
  assert.equal(builds.length, 2);
  assert.equal(builds[0][0], 'xcodebuild');
  assert.equal(builds[0][1][0], 'build-for-testing');
  assert.ok(!builds[0][1].includes('test-without-building'));
  assert.ok(builds[0][1].includes('IPHONEOS_DEPLOYMENT_TARGET=15.4'));
  fs.writeFileSync(path.join(wda, 'WebDriverAgent.xcodeproj/project.pbxproj'), 'different project');
  assert.notEqual((await prepareBuildTarget(target, { run, runBuild, diagnosticsDirectory: directory, cacheRoot: directory })).derivedDataPath, first.derivedDataPath);
  for (const external of [{ ...target, webDriverAgentUrl: 'http://localhost:8100' }, { ...target, appiumServer: 'http://remote:4723' }]) {
    assert.deepEqual(await prepareBuildTarget(external, { run: () => { throw new Error('Unexpected host command'); } }), external);
  }
  await assert.rejects(prepareBuildTarget(target, { run, cacheRoot: directory, diagnosticsDirectory: directory,
    runBuild: async (_command, _args, options) => {
      fs.writeFileSync(options.logPath, 'error: real build failed\n');
      throw new Error('xcodebuild failed with code 65');
    } }), error => {
    assert.equal(error.code, 'IOS_WDA_BUILD_FAILED');
    assert.match(fs.readFileSync(error.buildLogPath, 'utf8'), /real build failed/);
    return true;
  });
});

test('runtime failure keeps structured diagnostics and releases acquired services', async () => {
  const { acquireIosRuntime } = require(`${root}runtime-lifecycle`);
  const released = [];
  const diagnostic = { code: 'IOS_WDA_SIGNING_CONFLICT', stage: 'IOS_WDA_STARTUP', summary: 'signing conflict', logPath: '/run/wda.log', detailsPath: '/run/wda.json', retryable: false };
  const result = await acquireIosRuntime({}, 'owner', {
    acquireAppium: async () => ({ ok: true, ownership: 'FRAMEWORK_MANAGED', resource: {} }),
    acquireWda: async () => ({ ok: true, ownership: 'FRAMEWORK_MANAGED', resource: {} }),
    createSession: async () => { throw Object.assign(new Error('signing conflict'), { code: 'IOS_WDA_SIGNING_CONFLICT', diagnostic }); },
    releaseWda: async () => { released.push('wda'); return { ok: true }; },
    releaseAppium: async () => { released.push('appium'); return { ok: true }; },
  });
  assert.equal(result.failureCode, 'IOS_WDA_SIGNING_CONFLICT');
  assert.deepEqual(result.diagnostic, diagnostic);
  assert.deepEqual(released, ['wda', 'appium']);
});

test('session refresh exposes the original diagnostic paths to its caller', () => {
  const { refreshThroughAdapter } = require('../src/mobile-ai-visual-test/scripts/session/ios-session-service');
  const diagnostic = { code: 'IOS_WDA_BINARY_INCOMPATIBLE', stage: 'IOS_WDA_STARTUP', summary: 'Library not loaded', detailsPath: '/run/wda.json', logPath: '/run/wda.log', retryable: false };
  assert.throws(() => refreshThroughAdapter({ platform: 'ios', deviceId: 'IPAD', appId: 'com.example' }, {}, {
    runner: () => ({ status: 0, stdout: JSON.stringify({ ok: false, operation: 'refresh-session', failureCode: diagnostic.code, reason: diagnostic.summary, diagnostic }) }),
  }), error => {
    assert.equal(error.code, diagnostic.code);
    assert.deepEqual(error.diagnostic, diagnostic);
    return true;
  });
});

test('build process keeps output and timeout terminates its process group', async (t) => {
  const { runBuild } = require(`${root}wda-build`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-wda-build-process-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, 'build.log');
  await runBuild(process.execPath, ['-e', 'console.log("build output");'], { logPath, timeoutMs: 5000 });
  assert.match(fs.readFileSync(logPath, 'utf8'), /build output/);
  await assert.rejects(runBuild(process.execPath, ['-e', 'console.error("specific compiler error");process.exit(65);'], { logPath, timeoutMs: 5000 }), /code 65/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /specific compiler error/);
  const marker = path.join(directory, 'orphan.txt');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1900);`;
  const parent = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10000);`;
  await assert.rejects(runBuild(process.execPath, ['-e', parent], { logPath, timeoutMs: 300 }), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(fs.existsSync(marker), false, 'a surviving descendant must not execute after the build timed out');
});

test('failed build keeps detailed error and run log and never retries session creation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-wda-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'appium.log');
  fs.writeFileSync(logPath, 'old unrelated error\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      fs.appendFileSync(logPath, '[Xcode] error: WebDriverAgentRunner has conflicting provisioning settings.\n');
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: { error: 'unknown error', message: `Unable to launch WebDriverAgent: ${'detail '.repeat(200)}xcodebuild failed with code 65` } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(client.createSession({ appiumServer: `http://127.0.0.1:${server.address().port}`, deviceType: 'realDevice' }, {
    buildTarget: target => ({ ...target, derivedDataPath: path.join(dir, 'cache') }),
    diagnosticsDirectory: path.join(dir, 'run'), appiumLogPath: logPath,
  }), error => {
    assert.equal(error.code, 'IOS_WDA_SIGNING_CONFLICT');
    assert.match(error.message, /conflicting provisioning settings/);
    assert.match(error.message, /run/);
    const detail = JSON.parse(fs.readFileSync(error.diagnostic.detailsPath, 'utf8'));
    assert.match(detail.appiumError, /xcodebuild failed with code 65/);
    const log = fs.readFileSync(error.diagnostic.logPath, 'utf8');
    assert.match(log, /conflicting provisioning settings/);
    assert.doesNotMatch(log, /old unrelated/);
    return true;
  });
  assert.equal(requests, 1);
});
