'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

function command(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(new Error(`${command}: ${stderr || error.message}`)) : resolve(stdout.trim())));
}

function buildConfiguration(target, metadata, options = {}) {
  const identity = {
    schemaVersion: 1, ...metadata, device: target.device, deviceType: target.deviceType,
    team: target.xcodeOrgId || '', signing: target.xcodeSigningId || '', bundle: target.updatedWDABundleId || '',
  };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const base = options.cacheRoot || target.derivedDataPath || path.join(os.tmpdir(), 'mavt-ios-wda-builds');
  return { ...target, derivedDataPath: path.join(path.resolve(base), key), platformVersion: metadata.platformVersion };
}

function runBuild(command, args, options) {
  fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
  const fd = fs.openSync(options.logPath, 'a', 0o600);
  let child;
  try { child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let forceTimer;
    const signal = value => {
      try { if (child.pid) process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      forceTimer = setTimeout(() => signal('SIGKILL'), 1000);
    }, options.timeoutMs || 120000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(forceTimer); reject(error); });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (timedOut || code !== 0) {
        signal('SIGKILL');
        reject(new Error(timedOut ? 'WDA build timed out' : `xcodebuild failed with code ${code} (${exitSignal || 'no signal'})`));
      } else resolve();
    });
  });
}

async function prepareBuildTarget(target, options = {}) {
  // External WDA and remote Appium own their build locations. Do not send a
  // client-machine directory to another host or rebuild someone else's WDA.
  const host = new URL(target.appiumServer || 'http://127.0.0.1:4723').hostname;
  if (target.webDriverAgentUrl || target.deviceType !== 'realDevice' || !['localhost', '127.0.0.1', '[::1]'].includes(host)) return target;
  const run = options.run || command;
  try {
    const [developerDirectory, xcodeVersion, installed, devices] = await Promise.all([
      run('xcode-select', ['-p']), run('xcodebuild', ['-version']),
      run('appium', ['driver', 'list', '--installed', '--json']),
      target.platformVersion ? Promise.resolve(null) : run('xcrun', ['xcdevice', 'list', '--timeout', '2']),
    ]);
    const driver = JSON.parse(installed).xcuitest;
    if (driver?.installed !== true || !path.isAbsolute(driver.installPath || '') || !driver.version) throw new Error('XCUITest driver metadata unavailable');
    const requireDriver = createRequire(path.join(driver.installPath, 'package.json'));
    const wdaPackage = requireDriver.resolve('appium-webdriveragent/package.json');
    const wdaRoot = path.dirname(wdaPackage);
    const wdaVersion = JSON.parse(fs.readFileSync(wdaPackage, 'utf8')).version;
    const projectSha = createHash('sha256').update(fs.readFileSync(path.join(wdaRoot, 'WebDriverAgent.xcodeproj/project.pbxproj'))).digest('hex');
    const device = devices === null ? null : JSON.parse(devices).find(item => item.identifier === target.device && item.simulator === false);
    const platformVersion = target.platformVersion || String(device?.operatingSystemVersion || '').match(/^\d+(?:\.\d+){1,2}/)?.[0];
    if (!developerDirectory || !xcodeVersion || !wdaVersion || !platformVersion) throw new Error('WDA build toolchain or target system version unavailable');
    const prepared = buildConfiguration(target, { developerDirectory, xcodeVersion, driverVersion: driver.version, wdaVersion, projectSha, platformVersion }, options);
    const directory = options.diagnosticsDirectory || diagnosticDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const buildLogPath = path.join(directory, `build-${randomUUID()}.log`);
    const args = ['build-for-testing', '-project', path.join(wdaRoot, 'WebDriverAgent.xcodeproj'),
      '-scheme', 'WebDriverAgentRunner', '-destination', `id=${target.device}`, '-derivedDataPath', prepared.derivedDataPath,
      `IPHONEOS_DEPLOYMENT_TARGET=${platformVersion.split('.').slice(0, 2).join('.')}`,
      ...(target.xcodeOrgId ? [`DEVELOPMENT_TEAM=${target.xcodeOrgId}`] : []),
      ...(target.xcodeSigningId ? [`CODE_SIGN_IDENTITY=${target.xcodeSigningId}`] : []),
      ...(target.updatedWDABundleId ? [`PRODUCT_BUNDLE_IDENTIFIER=${target.updatedWDABundleId}`] : []),
      ...(target.allowProvisioningDeviceRegistration ? ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration'] : []),
      'GCC_TREAT_WARNINGS_AS_ERRORS=0', 'COMPILER_INDEX_STORE_ENABLE=NO'];
    try {
      const remaining = options.deadline ? options.deadline - Date.now() : 120000;
      if (remaining <= 0) throw new Error('WDA build preparation timed out');
      await (options.runBuild || runBuild)('xcodebuild', args, { logPath: buildLogPath,
        timeoutMs: Math.min(120000, options.timeoutMs || 120000, remaining) });
    } catch (error) {
      error.code = 'IOS_WDA_BUILD_FAILED';
      error.buildLogPath = buildLogPath;
      throw error;
    }
    return { ...prepared, wdaBuildPrepared: true, buildLogPath };
  } catch (error) {
    error.code ||= 'IOS_WDA_BUILD_CONTEXT_FAILED';
    throw error;
  }
}

function logOffset(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function diagnosticDirectory() {
  const workspace = process.env.MAVT_IOS_RUNTIME_WORKSPACE_ROOT;
  const batch = process.env.MAVT_IOS_RUNTIME_BATCH_ID;
  return workspace && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batch || '')
    ? path.join(workspace, 'runs', batch, 'diagnostics', 'ios')
    : path.join(os.tmpdir(), 'mavt-ios-diagnostics');
}

function readLogTail(file, offset = 0) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const end = fs.fstatSync(fd).size;
      const start = Math.max(end < offset ? 0 : offset, end - 1024 * 1024);
      const buffer = Buffer.alloc(Math.max(0, end - start));
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, start)).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function recordFailure(error, target, options = {}) {
  const appiumError = error.response?.value?.message || error.message || String(error);
  let output = readLogTail(options.appiumLogPath, options.logOffset);
  const buildLogPath = error.buildLogPath || target.buildLogPath;
  if (buildLogPath) output += `\n${readLogTail(buildLogPath)}`;
  const detail = `${appiumError}\n${output}`;
  const signing = detail.match(/[^\n]*conflicting provisioning settings[^\n]*/i);
  const missingLibrary = detail.match(/Library not loaded:[^\n]*/i);
  const buildError = output.split(/\r?\n/).find(line => /\berror:|Error Domain=|No profiles for /i.test(line));
  const code = signing ? 'IOS_WDA_SIGNING_CONFLICT' : missingLibrary ? 'IOS_WDA_BINARY_INCOMPATIBLE'
    : /^IOS_/.test(error.code || '') ? error.code : 'IOS_APPIUM_SESSION_CREATE_FAILED';
  const summary = signing ? signing[0].trim() : missingLibrary ? missingLibrary[0].trim() : buildError?.trim() || appiumError;
  const diagnostic = { code, stage: error.buildLogPath ? 'IOS_WDA_BUILD' : 'IOS_WDA_STARTUP', summary, retryable: false,
    ...(buildLogPath ? { buildLogPath } : {}) };
  try {
    const directory = options.diagnosticsDirectory || diagnosticDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const stem = `wda-${randomUUID()}`;
    diagnostic.detailsPath = path.join(directory, `${stem}.json`);
    if (output) {
      diagnostic.logPath = path.join(directory, `${stem}.log`);
      fs.writeFileSync(diagnostic.logPath, output, { mode: 0o600 });
    }
    fs.writeFileSync(diagnostic.detailsPath, JSON.stringify({ code, appiumError, server: target.appiumServer,
      derivedDataPath: target.derivedDataPath, platformVersion: target.platformVersion,
      ...(buildLogPath ? { buildLogPath } : {}),
      ...(diagnostic.logPath ? { logPath: diagnostic.logPath } : {}) }, null, 2), { mode: 0o600 });
  } catch (writeError) { diagnostic.logCollectionError = writeError.message; }
  error.code = code;
  error.diagnostic = diagnostic;
  error.message = `${summary}${diagnostic.detailsPath ? `；诊断：${diagnostic.detailsPath}` : ''}`;
  return error;
}

module.exports = { buildConfiguration, prepareBuildTarget, runBuild, logOffset, recordFailure };
