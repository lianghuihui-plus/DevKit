'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HelperAuthenticationRejected,
  HelperUnavailableBeforeDispatch,
  httpJson,
  ping,
} = require('./android-helper-client');
const {
  canonicalClaimRoot,
  claimAndroidHelperDevice,
  hash,
  readAndroidHelperClaim,
  releaseAndroidHelperClaim,
  removeStaleClaim,
  writeJsonAtomic,
} = require('./android-helper-ownership');

const HELPER_PACKAGE = 'com.artemis.helper';
const HELPER_SERVICE = 'com.artemis.helper/.ArtemisAccessibilityService';
const HELPER_REMOTE = 'tcp:18888';
const MIN_PROTOCOL = 2;
const MIN_VERSION_CODE = 7;

class SessionError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;
    Object.assign(this, options);
  }
}

function defaultCacheRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function helperStateRoot(options = {}) {
  const configured = options.stateRoot || process.env.MAVT_ANDROID_HELPER_STATE_DIR;
  const root = configured
    ? path.resolve(configured)
    : path.join(defaultCacheRoot(), 'mobile-ai-visual-test', 'android-helper');
  if (configured && !path.isAbsolute(configured)) {
    throw new SessionError('ANDROID_HELPER_STATE_DIR_INVALID', 'Android Helper state directory must be absolute');
  }
  if (options.workspaceRoot && isWithin(options.workspaceRoot, root)) {
    throw new SessionError('ANDROID_HELPER_STATE_DIR_INVALID', 'Android Helper state directory must be outside the workspace');
  }
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new SessionError('ANDROID_HELPER_STATE_DIR_INVALID', 'Android Helper state directory must be a private non-symlink directory');
    }
  } else {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }
  return root;
}

function sessionStatePath(options) {
  const root = helperStateRoot(options);
  const deviceDir = path.join(root, hash(options.deviceId));
  fs.mkdirSync(deviceDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(deviceDir, 0o700);
  if (fs.lstatSync(deviceDir).isSymbolicLink()) {
    throw new SessionError('ANDROID_HELPER_STATE_DIR_INVALID', 'Android Helper device state directory must not be a symlink');
  }
  return path.join(deviceDir, `${hash(options.ownerKey)}.json`);
}

function readSecureJson(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new SessionError('ANDROID_HELPER_SESSION_INVALID', 'Android Helper session file is not a private regular file');
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new SessionError('ANDROID_HELPER_SESSION_INVALID', 'Android Helper session file is invalid JSON');
  }
}

function saveJournal(file, journal) {
  journal.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, journal);
  fs.chmodSync(file, 0o600);
  return journal;
}

function defaultRunAdb({ deviceId, args, stdin, timeoutMs = 15000 }) {
  const adbArgs = args[0] === 'devices' ? args : ['-s', deviceId, ...args];
  const result = childProcess.spawnSync('adb', adbArgs, {
    encoding: 'utf8',
    input: stdin || undefined,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

function adb(options, args, settings = {}) {
  const result = (options.runAdb || defaultRunAdb)({
    deviceId: options.deviceId,
    args,
    stdin: settings.stdin,
    timeoutMs: settings.timeoutMs,
  });
  if (result.status !== 0) {
    throw new SessionError(
      settings.failureCode || 'ANDROID_HELPER_ADB_FAILED',
      String(result.stderr || result.stdout || `adb ${args.join(' ')} failed`).trim(),
    );
  }
  return String(result.stdout || '').trim();
}

function parseServices(value) {
  const text = String(value || '').trim();
  if (!text || text === 'null') return [];
  return [...new Set(text.split(':').map((item) => item.trim()).filter(Boolean))];
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function readAccessibilityState(options, androidUserId) {
  const services = parseServices(adb(options, [
    'shell', 'settings', '--user', androidUserId, 'get', 'secure', 'enabled_accessibility_services',
  ]));
  const enabled = adb(options, [
    'shell', 'settings', '--user', androidUserId, 'get', 'secure', 'accessibility_enabled',
  ]) || '0';
  return { services, enabled };
}

function writeServices(options, androidUserId, services) {
  adb(options, [
    'shell', 'settings', '--user', androidUserId, 'put', 'secure',
    'enabled_accessibility_services', services.join(':'),
  ]);
}

function writeAccessibilityEnabled(options, androidUserId, enabled) {
  adb(options, [
    'shell', 'settings', '--user', androidUserId, 'put', 'secure', 'accessibility_enabled', String(enabled),
  ]);
}

function forwardEntries(options) {
  const stdout = adb(options, ['forward', '--list']);
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, local, remote] = line.split(/\s+/);
    return { serial, local, remote };
  }).filter((entry) => entry.serial === options.deviceId);
}

function removeForward(options, localPort) {
  if (!localPort) return;
  adb(options, ['forward', '--remove', `tcp:${localPort}`]);
}

function readTransportId(options) {
  adb(options, ['get-state']);
  const devices = adb(options, ['devices', '-l']);
  const line = devices.split(/\r?\n/).find((entry) => entry.split(/\s+/)[0] === options.deviceId);
  const transport = line?.match(/(?:^|\s)transport_id:(\d+)(?:\s|$)/)?.[1];
  if (!transport) throw new SessionError('ANDROID_HELPER_TRANSPORT_UNKNOWN', 'adb transport_id is unavailable');
  return transport;
}

function bundleInfo(options = {}) {
  const directory = options.bundleDir || path.resolve(__dirname, '../helper');
  const manifestPath = path.join(directory, 'helper_manifest.json');
  const apkPath = path.join(directory, 'ArtemisAccessibilityHelper.apk');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(apkPath)).digest('hex');
  if (actual !== manifest.sha256) throw new SessionError('ANDROID_HELPER_BUNDLE_INVALID', 'bundled Helper APK hash mismatch');
  return { directory, manifest, apkPath };
}

function installedVersionCode(options) {
  const result = (options.runAdb || defaultRunAdb)({
    deviceId: options.deviceId,
    args: ['shell', 'dumpsys', 'package', HELPER_PACKAGE],
    timeoutMs: 15000,
  });
  if (result.status !== 0) return 0;
  const match = String(result.stdout || '').match(/versionCode=(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function inspectAndroidHelper(options) {
  const requested = String(options.androidUiBackend || 'auto');
  let sdk = 0;
  let versionCode = 0;
  let enabled = false;
  let protocolVersion = null;
  let cleanupError = null;
  try {
    sdk = Number(adb(options, ['shell', 'getprop', 'ro.build.version.sdk']));
    versionCode = installedVersionCode(options);
    const androidUserId = adb(options, ['shell', 'am', 'get-current-user']);
    const accessibility = readAccessibilityState(options, androidUserId);
    enabled = accessibility.enabled !== '0' && accessibility.services.includes(HELPER_SERVICE);
    if (sdk >= 30 && versionCode > 0 && enabled) {
      let port = null;
      try {
        port = adb(options, ['forward', 'tcp:0', HELPER_REMOTE], { failureCode: 'ANDROID_HELPER_FORWARD_FAILED' });
        const response = await requestPing(options, { localPort: Number(port), token: '' }, 1000);
        const protocol = Number(response?.protocol_version);
        protocolVersion = Number.isInteger(protocol) && protocol > 0 ? protocol : null;
      } catch {
        protocolVersion = null;
      } finally {
        if (port) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              removeForward(options, port);
              cleanupError = null;
              break;
            } catch (error) {
              cleanupError = new SessionError(
                'ANDROID_HELPER_FORWARD_CLEANUP_FAILED',
                'Android Helper probe could not remove its temporary adb forward',
                { cause: error },
              );
            }
          }
        }
      }
    }
  } catch {
    // The surrounding environment probe reports connector/device failures.
  }
  if (cleanupError) throw cleanupError;
  return {
    requested,
    installed: versionCode > 0,
    enabled,
    compatible: sdk >= 30,
    versionCode,
    protocolVersion,
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function provisioningLockPath(options) {
  return path.join(canonicalClaimRoot(options), `${hash(options.deviceId)}.prepare.lock`);
}

async function withProvisioningLock(options, operation) {
  const file = provisioningLockPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    throw new SessionError('ANDROID_HELPER_OWNERSHIP_UNKNOWN', 'Android Helper prepare lock directory is a symbolic link');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const take = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`);
    fs.closeSync(fd);
  };
  try {
    take();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lockStat = fs.lstatSync(file);
    if (lockStat.isSymbolicLink() || !lockStat.isFile() || (lockStat.mode & 0o077) !== 0) {
      throw new SessionError('ANDROID_HELPER_OWNERSHIP_UNKNOWN', 'Android Helper prepare lock is not a private regular file');
    }
    let lock = null;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* handled below */ }
    const ageMs = (() => {
      try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; }
    })();
    if (lock && processAlive(Number(lock.pid))) {
      throw new SessionError('ANDROID_HELPER_IN_USE', 'Android Helper provisioning is already running', { retryable: true });
    }
    if (!lock && ageMs <= 30000) {
      throw new SessionError('ANDROID_HELPER_OWNERSHIP_UNKNOWN', 'Android Helper prepare lock is unreadable', { retryable: true });
    }
    fs.unlinkSync(file);
    take();
  }
  try {
    return await operation();
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.nonce === nonce) fs.unlinkSync(file);
    } catch { /* A replaced lock belongs to another recovery attempt. */ }
  }
}

async function verifyAndroidHelperProvisioning(options) {
  const policy = String(options.androidUiBackend || 'auto');
  if (policy === 'uiautomator') {
    return { id: 'androidAccessibilityHelper', ok: true, required: false, stage: 'disabled' };
  }
  const required = policy === 'helper';
  try {
    return await withProvisioningLock(options, async () => {
      const prepareOptions = {
        ...options,
        ownerKey: `prepare-${hash(options.deviceId)}`,
        kind: 'PREPARE',
        androidUiBackend: 'helper',
      };
      const acquired = await acquireAndroidHelper(prepareOptions);
      if (acquired.status !== 'ACTIVE') {
        return {
          id: 'androidAccessibilityHelper', ok: false, required, stage: 'failed',
          failureCode: acquired.failureCode || 'ANDROID_HELPER_PREPARE_FAILED',
          retryable: Boolean(acquired.retryable),
        };
      }
      const released = await releaseAndroidHelper({ ...prepareOptions, runtime: acquired });
      if (!released.ok) {
        return {
          id: 'androidAccessibilityHelper', ok: false, required: true, stage: 'cleanup_failed',
          failureCode: released.failureCode || 'ANDROID_HELPER_RELEASE_FAILED',
          retryable: false,
        };
      }
      return {
        id: 'androidAccessibilityHelper', ok: true, required, stage: 'verified',
        versionCode: Number(acquired.resource?.androidHelper?.versionCode || MIN_VERSION_CODE),
        protocolVersion: Number(acquired.resource?.androidHelper?.protocolVersion || MIN_PROTOCOL),
      };
    });
  } catch (error) {
    return {
      id: 'androidAccessibilityHelper', ok: false, required, stage: 'failed',
      failureCode: error.code || 'ANDROID_HELPER_PREPARE_FAILED',
      retryable: Boolean(error.retryable),
    };
  }
}

function pushToken(options, androidUserId, token) {
  const tokenExtra = token ? ` --es token ${token}` : '';
  const command = `am broadcast --user ${androidUserId} -n ${HELPER_PACKAGE}/.TokenReceiver -a ${HELPER_PACKAGE}.SET_TOKEN${tokenExtra}\n`;
  adb(options, ['shell'], { stdin: command, failureCode: 'ANDROID_HELPER_TOKEN_PUSH_FAILED' });
}

async function requestPing(options, session, timeoutMs = 1000) {
  if (options.requestPing) return options.requestPing(session, { timeoutMs });
  if (!session.token) {
    return (await httpJson({
      host: '127.0.0.1', port: session.localPort, method: 'GET', requestPath: '/ping',
      headers: {}, timeoutMs, kind: 'READ_ONLY',
    })).value;
  }
  return ping(session, { timeoutMs });
}

function validatePing(value) {
  if (value?.authenticated !== true || value?.token_set !== true
    || Number(value.protocol_version) < MIN_PROTOCOL || Number(value.version_code) < MIN_VERSION_CODE) {
    throw new SessionError('ANDROID_HELPER_PROTOCOL_INVALID', 'Android Helper authenticated ping did not meet the minimum protocol');
  }
}

function resourceFromJournal(journal, file) {
  return {
    backend: 'helper',
    sessionId: `helper-${hash(journal.ownerKey)}`,
    sessionStatePath: file,
    protocolVersion: journal.protocolVersion,
    versionCode: journal.versionCode,
    generation: journal.generation,
  };
}

function activeResult(journal, file) {
  return {
    schemaVersion: 1,
    type: 'platformRuntimeResult',
    platform: 'android',
    operation: 'acquire',
    ok: true,
    status: 'ACTIVE',
    ownership: 'FRAMEWORK_MANAGED',
    resource: { androidHelper: resourceFromJournal(journal, file) },
  };
}

function unavailable(policy, failureCode, reason, details = {}) {
  if (policy === 'auto') {
    return {
      schemaVersion: 1, type: 'platformRuntimeResult', platform: 'android', operation: 'acquire',
      ok: true, status: 'NOT_REQUIRED', ownership: 'NONE', failureCode, reason,
      resource: { androidHelper: { backend: 'uiautomator' } }, ...details,
    };
  }
  return {
    schemaVersion: 1, type: 'platformRuntimeResult', platform: 'android', operation: 'acquire',
    ok: false, status: 'ACQUIRE_FAILED', ownership: 'NONE', failureCode, reason, ...details,
  };
}

async function detectExternalSession(options, journal, file) {
  journal.forwardBaseline = forwardEntries(options);
  journal.forwardIntent = 'EXTERNAL_PROBE';
  journal.phase = 'EXTERNAL_PROBE_INTENT';
  saveJournal(file, journal);
  const port = adb(options, ['forward', 'tcp:0', HELPER_REMOTE], { failureCode: 'ANDROID_HELPER_FORWARD_FAILED' });
  journal.probeLocalPort = Number(port);
  journal.phase = 'EXTERNAL_PROBE_ACTIVE';
  saveJournal(file, journal);
  let response = null;
  let reachable = false;
  try {
    response = await requestPing(options, { localPort: Number(port), token: '' }, 1000);
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    removeForward(options, port);
    journal.probeLocalPort = null;
    journal.forwardIntent = null;
    journal.phase = 'EXTERNAL_PROBE_COMPLETE';
    saveJournal(file, journal);
  }
  if (reachable && response?.token_set === true) {
    throw new SessionError('ANDROID_HELPER_EXTERNAL_SESSION', 'an external ARTEMIS token session is active');
  }
  if (reachable && typeof response?.token_set !== 'boolean') {
    throw new SessionError('ANDROID_HELPER_EXTERNAL_STATE_UNKNOWN', 'the service on the Helper port cannot be identified safely');
  }
  if (!reachable && journal.priorAccessibilityState.services.includes(HELPER_SERVICE)) {
    throw new SessionError('ANDROID_HELPER_EXTERNAL_STATE_UNKNOWN', 'an enabled Helper service cannot be identified safely');
  }
}

async function rollbackJournal(options, journal, file) {
  const failures = [];
  if (journal.token) {
    try { pushToken(options, journal.androidUserId, ''); journal.token = null; } catch (error) { failures.push(error); }
  }
  if (journal.ownsForward && journal.localPort) {
    try { removeForward(options, journal.localPort); journal.ownsForward = false; } catch (error) { failures.push(error); }
  } else if (journal.forwardIntent && Array.isArray(journal.forwardBaseline)) {
    try {
      const baseline = new Set(journal.forwardBaseline.map((entry) => `${entry.local}|${entry.remote}`));
      const candidates = forwardEntries(options).filter((entry) => entry.remote === HELPER_REMOTE
        && !baseline.has(`${entry.local}|${entry.remote}`));
      if (candidates.length > 1) {
        throw new SessionError('ANDROID_HELPER_OWNERSHIP_UNKNOWN', 'multiple new Helper forwards match an interrupted intent');
      }
      if (candidates.length === 1) removeForward(options, candidates[0].local.replace(/^tcp:/, ''));
      journal.forwardIntent = null;
    } catch (error) { failures.push(error); }
  }
  if (journal.ownsServiceChange && journal.priorAccessibilityState) {
    try {
      const current = readAccessibilityState(options, journal.androidUserId);
      const services = current.services.filter((service) => service !== HELPER_SERVICE);
      writeServices(options, journal.androidUserId, services);
      if (String(journal.priorAccessibilityState.enabled) === '0'
        && sameSet(services, journal.priorAccessibilityState.services)) {
        writeAccessibilityEnabled(options, journal.androidUserId, '0');
      }
      journal.ownsServiceChange = false;
    } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    journal.phase = 'ROLLBACK_FAILED';
    journal.rollbackFailure = failures[0].message;
    saveJournal(file, journal);
    return { ok: false, error: failures[0] };
  }
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return { ok: true };
}

async function recoverStaleOwner(options, claim) {
  const journal = readSecureJson(claim.sessionStatePath);
  if (!journal || journal.ownerKey !== claim.ownerKey || journal.deviceId !== claim.deviceId) {
    return { ok: false, failureCode: 'ANDROID_HELPER_OWNERSHIP_UNKNOWN' };
  }
  const rollback = await rollbackJournal(options, journal, claim.sessionStatePath);
  if (!rollback.ok) return { ok: false, failureCode: 'ANDROID_HELPER_STALE_CLEANUP_FAILED' };
  return removeStaleClaim(options, claim);
}

async function ensureAndroidHelperSession(options) {
  const journal = readSecureJson(options.sessionStatePath);
  if (!journal || journal.phase !== 'ACTIVE') {
    throw new SessionError('ANDROID_HELPER_SESSION_INVALID', 'Android Helper session is not active');
  }
  const claim = readAndroidHelperClaim(journal.deviceId, options);
  if (!claim || claim.ownerKey !== journal.ownerKey || claim.sessionStatePath !== options.sessionStatePath) {
    throw new SessionError('ANDROID_HELPER_OWNERSHIP_LOST', 'Android Helper device claim no longer belongs to this session');
  }
  const runOptions = { ...options, deviceId: journal.deviceId };
  const user = adb(runOptions, ['shell', 'am', 'get-current-user']);
  const transportId = readTransportId(runOptions);
  const forwarded = forwardEntries(runOptions).some((entry) => entry.local === `tcp:${journal.localPort}` && entry.remote === HELPER_REMOTE);
  if (user !== journal.androidUserId || transportId !== journal.transportId || !forwarded) {
    throw new SessionError('ANDROID_HELPER_SESSION_STALE', 'Android Helper session identity or forward changed');
  }
  const secret = {
    deviceId: journal.deviceId,
    transportId: journal.transportId,
    localPort: journal.localPort,
    token: journal.token,
    protocolVersion: journal.protocolVersion,
    versionCode: journal.versionCode,
    helperVersion: journal.helperVersion,
    generation: journal.generation,
    ownerKey: journal.ownerKey,
    androidUserId: journal.androidUserId,
  };
  const response = await requestPing(runOptions, secret, 1000);
  validatePing(response);
  return secret;
}

async function repairAndroidHelperSession(options) {
  const journal = readSecureJson(options.sessionStatePath);
  if (!journal || journal.phase !== 'ACTIVE') {
    throw new SessionError('ANDROID_HELPER_SESSION_INVALID', 'Android Helper session is not active');
  }
  const claim = readAndroidHelperClaim(journal.deviceId, options);
  if (!claim || claim.ownerKey !== journal.ownerKey || claim.sessionStatePath !== options.sessionStatePath) {
    throw new SessionError('ANDROID_HELPER_OWNERSHIP_LOST', 'Android Helper claim changed before repair');
  }
  const runOptions = { ...options, deviceId: journal.deviceId };
  if (adb(runOptions, ['shell', 'am', 'get-current-user']) !== journal.androidUserId
    || readTransportId(runOptions) !== journal.transportId) {
    throw new SessionError('ANDROID_HELPER_SESSION_STALE', 'Android user or transport changed before repair');
  }
  const forwarded = forwardEntries(runOptions).some((entry) => entry.local === `tcp:${journal.localPort}` && entry.remote === HELPER_REMOTE);
  if (!forwarded) {
    journal.forwardIntent = 'SESSION_REPAIR';
    saveJournal(options.sessionStatePath, journal);
    journal.localPort = Number(adb(runOptions, ['forward', 'tcp:0', HELPER_REMOTE], {
      failureCode: 'ANDROID_HELPER_FORWARD_FAILED',
    }));
    journal.ownsForward = true;
    journal.generation = Number(journal.generation || 1) + 1;
    saveJournal(options.sessionStatePath, journal);
  }
  const accessibility = readAccessibilityState(runOptions, journal.androidUserId);
  if (!accessibility.services.includes(HELPER_SERVICE)) {
    writeServices(runOptions, journal.androidUserId, [...accessibility.services, HELPER_SERVICE]);
    writeAccessibilityEnabled(runOptions, journal.androidUserId, '1');
  }
  pushToken(runOptions, journal.androidUserId, journal.token);
  return ensureAndroidHelperSession({ ...options, deviceId: journal.deviceId });
}

async function reauthenticateAndroidHelperSession(options) {
  const journal = readSecureJson(options.sessionStatePath);
  if (!journal || journal.phase !== 'ACTIVE') {
    throw new SessionError('ANDROID_HELPER_SESSION_INVALID', 'Android Helper session is not active');
  }
  const claim = readAndroidHelperClaim(journal.deviceId, options);
  if (!claim || claim.ownerKey !== journal.ownerKey || claim.sessionStatePath !== options.sessionStatePath) {
    throw new SessionError('ANDROID_HELPER_OWNERSHIP_LOST', 'Android Helper claim changed before reauthentication');
  }
  const runOptions = { ...options, deviceId: journal.deviceId };
  if (adb(runOptions, ['shell', 'am', 'get-current-user']) !== journal.androidUserId
    || readTransportId(runOptions) !== journal.transportId
    || !forwardEntries(runOptions).some((entry) => entry.local === `tcp:${journal.localPort}` && entry.remote === HELPER_REMOTE)) {
    throw new SessionError('ANDROID_HELPER_SESSION_STALE', 'Android Helper session changed before reauthentication');
  }
  pushToken(runOptions, journal.androidUserId, journal.token);
  return ensureAndroidHelperSession({ ...options, deviceId: journal.deviceId });
}

async function acquireAndroidHelper(options) {
  const policy = String(options.androidUiBackend || 'auto');
  if (policy === 'uiautomator') {
    return unavailable('auto', null, null);
  }
  let file;
  try {
    file = sessionStatePath(options);
  } catch (error) {
    return unavailable(policy, error.code || 'ANDROID_HELPER_STATE_DIR_INVALID', error.message);
  }
  let sdk;
  try {
    sdk = Number(adb(options, ['shell', 'getprop', 'ro.build.version.sdk']));
  } catch (error) {
    return unavailable(policy, error.code, error.message);
  }
  if (!Number.isInteger(sdk) || sdk < 30) {
    return unavailable(policy, 'ANDROID_HELPER_REQUIRES_API_30', 'Android Helper snapshot requires Android API 30 or newer');
  }

  let claim = claimAndroidHelperDevice({ ...options, sessionStatePath: file });
  if (claim.stale) {
    const recovered = await recoverStaleOwner(options, claim.claim);
    if (!recovered.ok) return unavailable(policy, recovered.failureCode, 'stale Android Helper owner could not be recovered');
    claim = claimAndroidHelperDevice({ ...options, sessionStatePath: file });
  }
  if (!claim.ok) {
    const inUse = claim.failureCode === 'ANDROID_HELPER_IN_USE';
    return unavailable(policy, claim.failureCode, inUse
      ? 'Android Helper is owned by another active batch' : 'Android Helper ownership cannot be established', {
      retryable: Boolean(claim.retryable),
      diagnostic: {
        code: claim.failureCode,
        stage: 'PLATFORM_RUNTIME_ACQUIRE',
        summary: inUse ? 'Android Helper is owned by another active batch' : 'Android Helper ownership cannot be established',
        retryable: Boolean(claim.retryable),
        owner: claim.owner || null,
        ...(inUse ? { recovery: { kind: 'WAIT_OR_CANCEL_OWNER_BATCH' } } : {}),
      },
    });
  }

  if (claim.resumed) {
    try {
      const existing = await ensureAndroidHelperSession({ ...options, sessionStatePath: file });
      const journal = readSecureJson(file);
      return activeResult({ ...journal, ...existing }, file);
    } catch {
      const journal = readSecureJson(file);
      if (journal) await rollbackJournal(options, journal, file);
      releaseAndroidHelperClaim(options);
      return acquireAndroidHelper(options);
    }
  }

  const journal = {
    schemaVersion: 1,
    phase: 'CLAIMED',
    ownerKey: options.ownerKey,
    deviceId: options.deviceId,
    androidUserId: null,
    transportId: null,
    priorAccessibilityState: null,
    ownsServiceChange: false,
    localPort: null,
    ownsForward: false,
    token: null,
    protocolVersion: null,
    versionCode: null,
    helperVersion: null,
    generation: 1,
  };
  saveJournal(file, journal);

  try {
    journal.androidUserId = adb(options, ['shell', 'am', 'get-current-user']);
    journal.transportId = readTransportId(options);
    journal.priorAccessibilityState = readAccessibilityState(options, journal.androidUserId);
    journal.phase = 'PRIOR_STATE_RECORDED';
    saveJournal(file, journal);

    await detectExternalSession(options, journal, file);
    const bundle = bundleInfo(options);
    const installed = installedVersionCode(options);
    if (installed < Number(bundle.manifest.version_code)) {
      adb(options, ['install', '-r', '-g', bundle.apkPath], { failureCode: 'ANDROID_HELPER_INSTALL_FAILED', timeoutMs: 120000 });
    }
    journal.phase = 'INSTALLED';
    saveJournal(file, journal);

    if (!journal.priorAccessibilityState.services.includes(HELPER_SERVICE)) {
      journal.ownsServiceChange = true;
      journal.phase = 'SERVICE_ENABLE_INTENT';
      saveJournal(file, journal);
      writeServices(options, journal.androidUserId, [...journal.priorAccessibilityState.services, HELPER_SERVICE]);
      writeAccessibilityEnabled(options, journal.androidUserId, '1');
    }
    journal.phase = 'SERVICE_ENABLED';
    journal.forwardBaseline = forwardEntries(options);
    journal.forwardIntent = 'SESSION';
    saveJournal(file, journal);
    journal.localPort = Number(adb(options, ['forward', 'tcp:0', HELPER_REMOTE], { failureCode: 'ANDROID_HELPER_FORWARD_FAILED' }));
    journal.ownsForward = true;
    journal.phase = 'FORWARD_CREATED';
    saveJournal(file, journal);

    journal.token = (options.randomToken || (() => crypto.randomBytes(32).toString('hex')))();
    journal.phase = 'TOKEN_INTENT';
    saveJournal(file, journal);
    pushToken(options, journal.androidUserId, journal.token);
    journal.phase = 'TOKEN_PUSHED';
    saveJournal(file, journal);

    const deadline = Date.now() + 10000;
    let response;
    let lastError;
    do {
      try {
        response = await requestPing(options, {
          localPort: journal.localPort, token: journal.token,
        }, 1000);
        validatePing(response);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) break;
        await (options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(250);
      }
    } while (Date.now() < deadline);
    if (lastError) throw lastError;
    journal.protocolVersion = Number(response.protocol_version);
    journal.versionCode = Number(response.version_code);
    journal.helperVersion = response.version_name || bundle.manifest.version_name;
    journal.phase = 'ACTIVE';
    saveJournal(file, journal);
    return activeResult(journal, file);
  } catch (error) {
    const rollback = await rollbackJournal(options, journal, file);
    if (rollback.ok) releaseAndroidHelperClaim(options);
    return unavailable(policy, error.code || 'ANDROID_HELPER_ACQUIRE_FAILED', error.message, {
      ...(rollback.ok ? {} : { rollbackFailure: rollback.error?.message || 'rollback failed' }),
    });
  }
}

async function releaseAndroidHelper(options) {
  const helper = options.runtime?.resource?.androidHelper;
  const file = helper?.sessionStatePath;
  if (!file || !fs.existsSync(file)) {
    return {
      schemaVersion: 1, type: 'platformRuntimeResult', platform: 'android', operation: 'release',
      ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: false, alreadyReleased: true,
    };
  }
  let journal;
  try {
    journal = readSecureJson(file);
    if (!journal || journal.ownerKey !== options.ownerKey || journal.deviceId !== options.deviceId) {
      throw new SessionError('ANDROID_HELPER_OWNERSHIP_LOST', 'release owner does not match the Helper session');
    }
    const claim = readAndroidHelperClaim(options.deviceId, options);
    if (!claim || claim.ownerKey !== options.ownerKey || claim.sessionStatePath !== file) {
      throw new SessionError('ANDROID_HELPER_OWNERSHIP_LOST', 'release owner does not hold the Helper device claim');
    }
    const rollback = await rollbackJournal(options, journal, file);
    if (!rollback.ok) throw rollback.error;
    const released = releaseAndroidHelperClaim(options);
    if (!released.ok) throw new SessionError(released.failureCode, 'failed to release Android Helper claim');
    return {
      schemaVersion: 1, type: 'platformRuntimeResult', platform: 'android', operation: 'release',
      ok: true, status: 'RELEASED', ownership: 'FRAMEWORK_MANAGED', released: true,
    };
  } catch (error) {
    return {
      schemaVersion: 1, type: 'platformRuntimeResult', platform: 'android', operation: 'release',
      ok: false, status: 'RELEASE_FAILED', ownership: 'FRAMEWORK_MANAGED',
      failureCode: error.code || 'ANDROID_HELPER_RELEASE_FAILED', reason: error.message,
    };
  }
}

function parseRuntimeArgs(argv) {
  const values = { androidUiBackend: 'auto' };
  const flags = new Map([
    ['--operation', 'operation'],
    ['--owner-key', 'ownerKey'],
    ['--runtime-json', 'runtimeJson'],
    ['--device', 'deviceId'],
    ['--android-ui-backend', 'androidUiBackend'],
    ['--app', 'appId'],
    ['--entry', 'entry'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const field = flags.get(argv[index]);
    const value = argv[index + 1];
    if (!field || value === undefined || value.startsWith('--')) throw new Error(`Android runtime invalid argument: ${argv[index] || 'missing'}`);
    values[field] = value;
  }
  if (!['auto', 'helper', 'uiautomator'].includes(values.androidUiBackend)) throw new Error('Android runtime invalid --android-ui-backend');
  if (!['acquire', 'release'].includes(values.operation)) throw new Error('Android runtime requires --operation acquire|release');
  if (!values.deviceId || !values.ownerKey) throw new Error('Android runtime requires --device and --owner-key');
  if (values.operation === 'release' && !values.runtimeJson) throw new Error('Android runtime release requires --runtime-json');
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const values = parseRuntimeArgs(argv);
  const options = {
    deviceId: values.deviceId,
    ownerKey: values.ownerKey,
    androidUiBackend: values.androidUiBackend,
    workspaceRoot: process.env.MAVT_ANDROID_HELPER_WORKSPACE_ROOT || undefined,
  };
  const result = values.operation === 'acquire'
    ? await acquireAndroidHelper(options)
    : await releaseAndroidHelper({ ...options, runtime: JSON.parse(values.runtimeJson) });
  process.stdout.write(`${JSON.stringify({ ...result, time: result.time || localIso() })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'ANDROID_HELPER_RUNTIME_FAILED'}: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  HELPER_PACKAGE,
  HELPER_REMOTE,
  HELPER_SERVICE,
  SessionError,
  acquireAndroidHelper,
  bundleInfo,
  defaultRunAdb,
  ensureAndroidHelperSession,
  helperStateRoot,
  inspectAndroidHelper,
  localIso,
  main,
  parseRuntimeArgs,
  provisioningLockPath,
  readSecureJson,
  reauthenticateAndroidHelperSession,
  repairAndroidHelperSession,
  releaseAndroidHelper,
  rollbackJournal,
  sessionStatePath,
  verifyAndroidHelperProvisioning,
};
