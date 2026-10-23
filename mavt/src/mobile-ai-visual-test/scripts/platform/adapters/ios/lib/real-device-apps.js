'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run: defaultRun } = require('../../../environment/command');

// Cache only the working transport and dependency location, never installation
// results: reinstall polling must always read the current state from the device.
const sessions = new WeakMap();
const appIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+$/.test(value);
const failure = (source, detail) => ({ ok: false, source, detail: String(detail || 'Application query failed').trim().slice(0, 2000) });

function normalize(records, source) {
  const apps = [];
  let malformed = 0;
  for (const [key, app] of records) {
    const id = app?.CFBundleIdentifier || app?.bundleIdentifier || key;
    if (!app || typeof app !== 'object' || Array.isArray(app) || !appIdentifier(id)
      || (key && key !== id)) { malformed += 1; continue; }
    apps.push({ ...app, bundleIdentifier: id,
      version: app.CFBundleShortVersionString ?? app.version,
      bundleVersion: app.CFBundleVersion ?? app.bundleVersion });
  }
  return { ok: true, source, apps, coverage: malformed ? 'limited' : 'all' };
}

function queryDevicectl(device, appId, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-ios-apps-'));
  const output = path.join(directory, 'apps.json');
  try {
    const result = run('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', device,
      ...(appId ? ['--bundle-id', appId] : []), '--include-all-apps', '--timeout', '15', '--json-output', output], { timeout: 25000 });
    if (!result.ok) return failure('DEVICECTL', result.stderr || 'devicectl application query failed');
    const data = JSON.parse(fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : result.stdout);
    if (!Array.isArray(data?.result?.apps) || (data.info?.outcome && data.info.outcome !== 'success')) {
      return failure('DEVICECTL', 'devicectl returned invalid application JSON');
    }
    return normalize(data.result.apps.map(app => [null, app]), 'DEVICECTL');
  } catch (error) { return failure('DEVICECTL', error.message); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function queryLegacy(device, appId, run, session) {
  try {
    if (!session.driverPath) {
      const drivers = run('appium', ['driver', 'list', '--installed', '--json'], { timeout: 20000 });
      if (!drivers.ok) return failure('INSTALLATION_PROXY', drivers.stderr || 'Unable to locate XCUITest driver');
      const driver = JSON.parse(drivers.stdout).xcuitest;
      if (driver?.installed !== true || !path.isAbsolute(driver.installPath || '')) {
        return failure('INSTALLATION_PROXY', 'Installed XCUITest driver installPath unavailable; install or repair the XCUITest driver');
      }
      session.driverPath = driver.installPath;
    }
    const result = run(process.execPath, [path.join(__dirname, 'installation-proxy-query.js'),
      '--driver', session.driverPath, '--device', device, ...(appId ? ['--app', appId] : [])], { timeout: 25000 });
    if (!result.ok) {
      delete session.driverPath;
      return failure('INSTALLATION_PROXY', result.stderr || 'Installation Proxy query failed');
    }
    const data = JSON.parse(result.stdout);
    if (!data?.applications || typeof data.applications !== 'object' || Array.isArray(data.applications)) {
      return failure('INSTALLATION_PROXY', 'Installation Proxy returned invalid application JSON');
    }
    return normalize(Object.entries(data.applications), 'INSTALLATION_PROXY');
  } catch (error) { delete session.driverPath; return failure('INSTALLATION_PROXY', error.message); }
}

function queryRealDeviceApps({ device, appId }, options = {}) {
  const run = options.run || defaultRun;
  if (!device) return failure('NATIVE', 'Missing target device');
  let session = sessions.get(run);
  if (!session) { session = { legacyDevices: new Set() }; sessions.set(run, session); }
  let legacy;
  if (session.legacyDevices.has(device)) {
    legacy = queryLegacy(device, appId, run, session);
    if (legacy.ok) return legacy;
    session.legacyDevices.delete(device);
  }
  const modern = queryDevicectl(device, appId, run);
  if (modern.ok) return modern;
  legacy = legacy || queryLegacy(device, appId, run, session);
  if (legacy.ok) {
    if (session.legacyDevices.size >= 64) session.legacyDevices.clear();
    session.legacyDevices.add(device);
    return legacy;
  }
  return failure('NATIVE', `devicectl: ${modern.detail}; Installation Proxy: ${legacy.detail}`);
}

module.exports = { queryRealDeviceApps };
