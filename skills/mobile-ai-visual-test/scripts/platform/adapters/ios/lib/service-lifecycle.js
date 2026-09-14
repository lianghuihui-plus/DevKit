'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const appium = require('./appium-client');
const { localIso } = require('./output');
const processLifecycle = require('./process-lifecycle');
const { resolveManagedOwner } = require('./runtime-ownership');

const REGISTRY_SCHEMA_VERSION = 1;

const { processAlive, processCommand, sleep } = processLifecycle;

function normalizedServer(server) {
  const url = new URL(server || 'http://127.0.0.1:4723');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname}:${port}`;
}

function runtimeRoot() {
  return path.resolve(process.env.MAVT_IOS_RUNTIME_DIR || path.join(os.tmpdir(), 'mavt-ios-runtime'));
}

function registryPath(server) {
  const key = crypto.createHash('sha256').update(normalizedServer(server)).digest('hex').slice(0, 20);
  return path.join(runtimeRoot(), `appium-${key}.json`);
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function recordMatchesProcess(record, server, dependencies = {}) {
  if (!record || record.schemaVersion !== REGISTRY_SCHEMA_VERSION || record.server !== normalizedServer(server)
    || !Number.isInteger(record.pid) || record.pid <= 0 || record.processGroupId !== record.pid
    || !record.ownerToken || !(dependencies.processAlive || processAlive)(record.pid)) return false;
  const command = (dependencies.processCommand || processCommand)(record.pid);
  if (!command || !/appium/i.test(command)) return false;
  const url = new URL(record.server);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return command.includes(`--port ${port}`) || command.includes(`--port=${port}`);
}

async function waitForServer(target, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await appium.status(target.appiumServer, Math.min(2000, timeoutMs));
      return { ok: true };
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  return { ok: false, reason: lastError?.message || 'Appium server is not available' };
}

function spawnManagedAppium(target) {
  const url = new URL(target.appiumServer);
  const port = url.port || '4723';
  const address = url.hostname || '127.0.0.1';
  const logPath = path.resolve(process.env.MAVT_IOS_APPIUM_LOG || path.join(os.tmpdir(), 'mavt-ios-appium.log'));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const ownerToken = crypto.randomBytes(16).toString('hex');
  const child = childProcess.spawn('appium', ['--address', address, '--port', port], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, MAVT_IOS_SERVICE_OWNER_TOKEN: ownerToken },
  });
  fs.closeSync(logFd);
  child.unref();
  const record = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    server: normalizedServer(target.appiumServer),
    pid: child.pid,
    processGroupId: child.pid,
    ownerToken,
    ownerKey: null,
    logPath,
    startedAt: localIso(),
  };
  writeJsonAtomic(registryPath(target.appiumServer), record);
  return record;
}

function removeRegistryIfOwned(server, ownerToken) {
  const file = registryPath(server);
  const current = readJson(file, null);
  if (current?.ownerToken === ownerToken && fs.existsSync(file)) fs.unlinkSync(file);
}

async function stopManagedRecord(record, options = {}) {
  const stop = options.stopProcessGroup || processLifecycle.stopProcessGroup;
  return stop(record, {
    ...options,
    label: 'framework-managed Appium process',
  });
}

async function ensureAppium(target, dependencies = {}) {
  if (process.env.MAVT_IOS_FAKE === '1') {
    return {
      ok: true,
      ownership: 'FRAMEWORK_MANAGED',
      resource: {
        server: normalizedServer(target.appiumServer),
        ownerToken: 'fake-appium-owner',
        fake: true,
      },
    };
  }
  const file = registryPath(target.appiumServer);
  const registered = readJson(file, null);
  const wait = dependencies.waitForServer || waitForServer;
  const server = await wait(target, 2000);
  if (server.ok) {
    if (recordMatchesProcess(registered, target.appiumServer, dependencies)) {
      return { ok: true, ownership: 'FRAMEWORK_MANAGED', resource: { ...registered } };
    }
    return {
      ok: true,
      ownership: 'EXTERNAL',
      resource: { server: normalizedServer(target.appiumServer) },
    };
  }
  const hostname = new URL(target.appiumServer).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    return {
      ok: false,
      ownership: 'NONE',
      failureCode: 'IOS_APPIUM_SERVER_UNAVAILABLE',
      reason: `external Appium server is unavailable: ${normalizedServer(target.appiumServer)}`,
    };
  }
  if (registered && (dependencies.processAlive || processAlive)(registered.pid)) {
    return {
      ok: false,
      ownership: 'NONE',
      failureCode: 'IOS_APPIUM_SERVER_UNRESPONSIVE',
      reason: `registered Appium process ${registered.pid} is alive but its server is unavailable`,
    };
  }
  if (registered && fs.existsSync(file)) fs.unlinkSync(file);
  let spawned;
  try {
    spawned = (dependencies.spawnManagedAppium || spawnManagedAppium)(target);
  } catch (error) {
    return { ok: false, ownership: 'NONE', failureCode: 'IOS_APPIUM_START_FAILED', reason: error.message || String(error) };
  }
  const ready = await wait(target, 20000);
  if (!ready.ok) {
    await stopManagedRecord(spawned, dependencies);
    removeRegistryIfOwned(target.appiumServer, spawned.ownerToken);
    return { ok: false, ownership: 'NONE', failureCode: 'IOS_APPIUM_START_FAILED', reason: ready.reason };
  }
  return { ok: true, ownership: 'FRAMEWORK_MANAGED', resource: { ...spawned } };
}

async function prepareAppium(target) {
  return ensureAppium(target);
}

async function reclaimStaleAppium(target, record, dependencies = {}) {
  if (!recordMatchesProcess(record, target.appiumServer, dependencies)) {
    return { ok: false, failureCode: 'IOS_APPIUM_OWNERSHIP_UNKNOWN', reason: 'Appium registry does not match a live isolated process' };
  }
  const owner = (dependencies.resolveOwnerStatus || resolveManagedOwner)(record.ownerKey, dependencies);
  if (owner?.status === 'ACTIVE') return { ok: false, failureCode: 'IOS_APPIUM_SERVICE_IN_USE', owner };
  if (owner?.status !== 'TERMINAL' && owner?.status !== 'RECLAIMABLE') return { ok: false, failureCode: 'IOS_APPIUM_OWNERSHIP_UNKNOWN', owner };
  const stopped = await stopManagedRecord(record, dependencies);
  if (!stopped.ok) {
    return { ok: false, failureCode: 'IOS_APPIUM_STALE_CLEANUP_FAILED', reason: stopped.reason, owner };
  }
  removeRegistryIfOwned(target.appiumServer, record.ownerToken);
  return { ok: true, owner, stopped };
}

async function acquireAppium(target, ownerKey, dependencies = {}) {
  let ensured = await ensureAppium(target, dependencies);
  if (!ensured.ok || ensured.ownership === 'EXTERNAL') {
    return {
      ...ensured,
      status: ensured.ok ? 'ACTIVE' : 'ACQUIRE_FAILED',
    };
  }
  if (ensured.resource.fake) {
    return { ...ensured, status: 'ACTIVE', resource: { ...ensured.resource, ownerKey } };
  }
  const file = registryPath(target.appiumServer);
  const record = readJson(file, null);
  if (!recordMatchesProcess(record, target.appiumServer, dependencies) || record.ownerToken !== ensured.resource.ownerToken) {
    return {
      ok: false,
      status: 'ACQUIRE_FAILED',
      ownership: 'NONE',
      failureCode: 'IOS_APPIUM_OWNERSHIP_LOST',
      reason: 'framework-managed Appium ownership changed before batch acquisition',
    };
  }
  if (record.ownerKey && record.ownerKey !== ownerKey) {
    const reclaimed = await reclaimStaleAppium(target, record, dependencies);
    if (reclaimed.ok) {
      ensured = await ensureAppium(target, dependencies);
      if (!ensured.ok || ensured.ownership === 'EXTERNAL') {
        return { ...ensured, status: ensured.ok ? 'ACTIVE' : 'ACQUIRE_FAILED' };
      }
      return acquireAppium(target, ownerKey, dependencies);
    }
    const serviceInUse = reclaimed.failureCode === 'IOS_APPIUM_SERVICE_IN_USE';
    return {
      ok: false,
      status: 'ACQUIRE_FAILED',
      ownership: 'NONE',
      failureCode: reclaimed.failureCode || 'IOS_APPIUM_SERVICE_IN_USE',
      retryable: serviceInUse,
      reason: reclaimed.failureCode === 'IOS_APPIUM_OWNERSHIP_UNKNOWN'
        ? 'framework-managed Appium owner cannot be verified safely'
        : 'framework-managed Appium is already owned by another batch',
      diagnostic: {
        code: reclaimed.failureCode || 'IOS_APPIUM_SERVICE_IN_USE',
        stage: 'PLATFORM_RUNTIME_ACQUIRE',
        summary: reclaimed.failureCode === 'IOS_APPIUM_OWNERSHIP_UNKNOWN'
          ? 'framework-managed Appium owner cannot be verified safely'
          : 'framework-managed Appium is already owned by another batch',
        retryable: serviceInUse,
        owner: reclaimed.owner || null,
        ...(serviceInUse
          ? { recovery: { kind: 'WAIT_OR_CANCEL_OWNER_BATCH' } } : {}),
      },
    };
  }
  record.ownerKey = ownerKey;
  record.claimedAt = record.claimedAt || localIso();
  writeJsonAtomic(file, record);
  return { ok: true, status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED', resource: { ...record } };
}

async function releaseAppium(runtime) {
  const ownership = runtime?.ownership || 'NONE';
  const resource = runtime?.resource || {};
  if (ownership === 'NONE' || runtime?.status === 'NOT_REQUIRED') {
    return { ok: true, status: 'NOT_REQUIRED', ownership: 'NONE', released: false };
  }
  if (ownership === 'EXTERNAL') {
    return { ok: true, status: 'RETAINED', ownership: 'EXTERNAL', released: false };
  }
  if (resource.fake) {
    return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: true };
  }
  const file = registryPath(resource.server);
  const record = readJson(file, null);
  if (!record) {
    if (!processAlive(resource.pid)) {
      return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: true, alreadyStopped: true };
    }
    return {
      ok: false,
      status: 'RELEASE_FAILED',
      ownership: 'FRAMEWORK_MANAGED',
      failureCode: 'IOS_APPIUM_OWNERSHIP_LOST',
      reason: 'Appium registry is missing while the recorded process is still alive',
    };
  }
  if (record.ownerToken === resource.ownerToken && record.ownerKey === runtime.ownerKey
    && record.pid === resource.pid && !processAlive(record.pid)) {
    removeRegistryIfOwned(resource.server, resource.ownerToken);
    return { ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: true, alreadyStopped: true };
  }
  if (record.ownerToken !== resource.ownerToken || record.ownerKey !== runtime.ownerKey
    || record.pid !== resource.pid || !recordMatchesProcess(record, resource.server)) {
    return {
      ok: false,
      status: 'RELEASE_FAILED',
      ownership: 'FRAMEWORK_MANAGED',
      failureCode: 'IOS_APPIUM_OWNERSHIP_LOST',
      reason: 'Appium process identity or ownership no longer matches the batch record',
    };
  }
  const stopped = await stopManagedRecord(record);
  if (!stopped.ok) {
    return {
      ok: false,
      status: 'RELEASE_FAILED',
      ownership: 'FRAMEWORK_MANAGED',
      failureCode: 'IOS_APPIUM_STOP_FAILED',
      reason: stopped.reason,
    };
  }
  removeRegistryIfOwned(resource.server, resource.ownerToken);
  return {
    ok: true,
    status: 'RELEASED',
    ownership: 'FRAMEWORK_MANAGED',
    released: true,
    alreadyStopped: stopped.alreadyStopped,
  };
}

module.exports = {
  acquireAppium,
  ensureAppium,
  normalizedServer,
  prepareAppium,
  processAlive,
  recordMatchesProcess,
  registryPath,
  releaseAppium,
  stopManagedRecord,
  reclaimStaleAppium,
  resolveManagedOwner,
};
