'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveManagedOwner } = require('../../ios/lib/runtime-ownership');

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function defaultCacheRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
}

function canonicalClaimRoot(options = {}) {
  return path.resolve(options.claimRoot || path.join(defaultCacheRoot(), 'mobile-ai-visual-test', 'android-helper-claims'));
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('ANDROID_HELPER_OWNERSHIP_UNKNOWN: claim directory must not be a symbolic link');
}

function claimPath(deviceId, options = {}) {
  return path.join(canonicalClaimRoot(options), `${hash(deviceId)}.json`);
}

function readJson(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function withClaimLock(deviceId, options, operation) {
  const root = canonicalClaimRoot(options);
  ensurePrivateDirectory(root);
  const lock = path.join(root, `${hash(deviceId)}.lock`);
  let fd;
  try {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lock);
      if (Date.now() - stat.mtimeMs <= 30000) {
        return { ok: false, failureCode: 'ANDROID_HELPER_OWNERSHIP_BUSY', retryable: true };
      }
      fs.unlinkSync(lock);
      fd = fs.openSync(lock, 'wx', 0o600);
    }
    return operation();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fd !== undefined && fs.existsSync(lock)) fs.unlinkSync(lock);
  }
}

function claimAndroidHelperDevice(options) {
  return withClaimLock(options.deviceId, options, () => {
    const file = claimPath(options.deviceId, options);
    const existing = readJson(file);
    if (fs.existsSync(file) && !existing) {
      return { ok: false, failureCode: 'ANDROID_HELPER_OWNERSHIP_UNKNOWN', reason: 'device claim is unreadable' };
    }
    if (existing?.ownerKey === options.ownerKey && existing?.deviceId === options.deviceId) {
      return { ok: true, resumed: true, claim: existing, claimPath: file };
    }
    if (existing) {
      const ownerOptions = {
        ...options,
        workspaceRoot: existing.workspaceRoot || options.workspaceRoot,
      };
      const owner = (options.resolveOwnerStatus || resolveManagedOwner)(existing.ownerKey, ownerOptions);
      if (owner?.status === 'ACTIVE') {
        return {
          ok: false,
          failureCode: 'ANDROID_HELPER_IN_USE',
          retryable: true,
          owner,
          claim: existing,
        };
      }
      if (!['TERMINAL', 'RECLAIMABLE'].includes(owner?.status)) {
        return {
          ok: false,
          failureCode: 'ANDROID_HELPER_OWNERSHIP_UNKNOWN',
          retryable: false,
          owner,
          claim: existing,
        };
      }
      return { ok: false, stale: true, failureCode: 'ANDROID_HELPER_STALE_OWNER', owner, claim: existing, claimPath: file };
    }
    const claim = {
      schemaVersion: 1,
      kind: options.kind || 'BATCH',
      deviceId: options.deviceId,
      ownerKey: options.ownerKey,
      workspaceRoot: options.workspaceRoot ? path.resolve(options.workspaceRoot) : null,
      sessionStatePath: options.sessionStatePath,
      claimedAt: options.now || new Date().toISOString(),
    };
    writeJsonAtomic(file, claim);
    return { ok: true, resumed: false, claim, claimPath: file };
  });
}

function readAndroidHelperClaim(deviceId, options = {}) {
  return readJson(claimPath(deviceId, options));
}

function releaseAndroidHelperClaim(options) {
  return withClaimLock(options.deviceId, options, () => {
    const file = claimPath(options.deviceId, options);
    const claim = readJson(file);
    if (!claim) return { ok: true, released: false };
    if (claim.ownerKey !== options.ownerKey || claim.deviceId !== options.deviceId) {
      return { ok: false, failureCode: 'ANDROID_HELPER_OWNERSHIP_LOST' };
    }
    fs.unlinkSync(file);
    return { ok: true, released: true };
  });
}

function removeStaleClaim(options, expectedClaim) {
  return withClaimLock(options.deviceId, options, () => {
    const file = claimPath(options.deviceId, options);
    const current = readJson(file);
    if (!current) return { ok: true, released: false };
    if (current.ownerKey !== expectedClaim.ownerKey || current.sessionStatePath !== expectedClaim.sessionStatePath) {
      return { ok: false, failureCode: 'ANDROID_HELPER_OWNERSHIP_LOST' };
    }
    fs.unlinkSync(file);
    return { ok: true, released: true };
  });
}

module.exports = {
  canonicalClaimRoot,
  claimAndroidHelperDevice,
  claimPath,
  hash,
  readAndroidHelperClaim,
  releaseAndroidHelperClaim,
  removeStaleClaim,
  writeJsonAtomic,
};
