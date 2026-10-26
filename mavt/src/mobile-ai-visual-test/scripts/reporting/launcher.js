'use strict';
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { safeId } = require('./repository');
const { reportingError } = require('./errors');

function childEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'TMPDIR']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
}
function verifiedEntry(workspace, bundleId, runtimeRoot) {
  const { verifyBundle, plainPath, bundleLocations } = require('../lib/runtime-bundle');
  const root = path.join(path.resolve(workspace), '.mavt/runtime-bundles', safeId(bundleId));
  const manifest = verifyBundle(root, bundleId);
  const locations = bundleLocations(root, manifest);
  if (runtimeRoot && path.resolve(runtimeRoot) !== locations.runtimeRoot)
    throw reportingError('REPORTING_BUNDLE_INVALID');
  return plainPath(root, 'runtime/mobile-ai-visual-test/scripts/reporting/worker.js', 'file');
}
function launchWorker(claim, workspace, options = {}) {
  if (!claim || typeof claim.nonce !== 'string') throw reportingError('REPORTING_WORKER_CLAIM_LOST');
  const entry = verifiedEntry(workspace, claim.bundleId, claim.runtimeRoot);
  const args = [entry, 'run', path.resolve(workspace), claim.nonce];
  if (options.configDir) args.push(path.resolve(options.configDir));
  const child = (options.spawn || spawn)(process.execPath, args, {
    detached: true, stdio: 'ignore', env: childEnvironment(), cwd: path.resolve(workspace)
  });
  // Failed spawn returns no pid, then emits error on the next tick. The
  // synchronous failure below releases the reservation; consume its later event
  // so that an optional upload cannot terminate the Coordinator/tool process.
  child.once('error', () => {});
  if (!child.pid) throw reportingError('REPORTING_WORKER_LAUNCH_FAILED');
  child.unref();
  return child;
}
function checkConnection(options = {}) {
  const entry = path.join(__dirname, 'worker.js');
  const args = [entry, 'check'];
  if (options.configDir) args.push(path.resolve(options.configDir));
  const child = (options.spawnSync || spawnSync)(process.execPath, args, {
    timeout: 15000, maxBuffer: 65536, encoding: 'utf8', env: childEnvironment(), stdio: ['ignore', 'pipe', 'ignore']
  });
  if (child.error?.code === 'ETIMEDOUT') return { ok: false, code: 'REPORTING_TIMEOUT' };
  try {
    const result = JSON.parse(child.stdout);
    if (result && typeof result.ok === 'boolean' && (result.code === null || /^REPORTING_[A-Z_]+$/.test(result.code)))
      return result;
  } catch {}
  return { ok: false, code: 'REPORTING_CONNECTION_FAILED' };
}
module.exports = { launchWorker, checkConnection, verifiedEntry };
