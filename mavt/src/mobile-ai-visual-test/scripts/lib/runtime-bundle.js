'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./execution-lifecycle');

const DIGEST = /^[a-f0-9]{64}$/;
const RUNTIME_RELATIVE_ROOT = 'runtime/mobile-ai-visual-test';
function bundleError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code, exitCode: 2 });
}
function invalid(message) { throw bundleError('MAVT_RUNTIME_BUNDLE_INVALID', message); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function plainPath(root, relative = '', kind = null) {
  const parts = relative ? relative.split('/') : [];
  if (parts.some(p => !p || p === '.' || p === '..') || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative)) invalid('non-canonical relative path');
  let target = path.resolve(root);
  for (const part of ['', ...parts]) {
    if (part) target = path.join(target, part);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) invalid(`not an ordinary file/directory: ${target}`);
    if (target !== path.join(root, relative) && !stat.isDirectory()) invalid(`parent is not a directory: ${target}`);
  }
  const stat = fs.lstatSync(target);
  if (kind === 'file' && !stat.isFile() || kind === 'directory' && !stat.isDirectory()) invalid(`wrong path type: ${target}`);
  return target;
}
function recordsFor(root) {
  const files = [];
  function visit(relative) {
    const file = plainPath(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
    } else {
      files.push({ path: relative, sha256: sha256(fs.readFileSync(file)), executable: Boolean(stat.mode & 0o111) });
    }
  }
  for (const directory of ['hosts', 'runtime']) { plainPath(root, directory, 'directory'); visit(directory); }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function identity(files) { return sha256(JSON.stringify({ schemaVersion: 1, files })); }
function createManifest(root, pluginVersion) {
  try {
    const files = recordsFor(root);
    if (!files.length || typeof pluginVersion !== 'string' || !pluginVersion) invalid('empty bundle/version');
    return { schemaVersion: 1, bundleId: identity(files), pluginVersion, files };
  } catch (error) {
    if (error.code === 'MAVT_RUNTIME_BUNDLE_INVALID') throw error;
    invalid(error.message);
  }
}
function verifyBundle(root, expectedId = null) {
  if (!fs.existsSync(root)) throw bundleError('MAVT_RUNTIME_BUNDLE_MISSING', root);
  try {
    const file = plainPath(root, 'bundle.manifest.json', 'file');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.schemaVersion !== 1 || !DIGEST.test(manifest.bundleId) || typeof manifest.pluginVersion !== 'string' || !manifest.pluginVersion || !Array.isArray(manifest.files)) invalid('unsupported manifest');
    let previous = '';
    for (const record of manifest.files) {
      if (!record || typeof record.path !== 'string' || !/^(runtime|hosts)\//.test(record.path) || record.path <= previous
        || !DIGEST.test(record.sha256) || typeof record.executable !== 'boolean'
        || Object.keys(record).sort().join(',') !== 'executable,path,sha256') invalid('invalid, duplicate or unsorted record');
      plainPath(root, record.path, 'file');
      previous = record.path;
    }
    if (identity(manifest.files) !== manifest.bundleId || expectedId && manifest.bundleId !== expectedId) invalid('bundle identity mismatch');
    if (JSON.stringify(recordsFor(root)) !== JSON.stringify(manifest.files)) invalid('bundle files, bytes or executable bits mismatch');
    return manifest;
  } catch (error) {
    if (error.code === 'MAVT_RUNTIME_BUNDLE_INVALID') throw error;
    invalid(error.message);
  }
}
function managedDirectories(workspace) {
  plainPath(workspace, '', 'directory');
  for (const relative of ['.mavt', '.mavt/runtime-bundles', '.mavt/run-staging']) {
    const target = path.join(workspace, relative);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    plainPath(workspace, relative, 'directory');
  }
}
function bundleLocations(bundleRoot, manifest) {
  return { bundleId: manifest.bundleId, bundleRoot,
    runtimeRoot: path.join(bundleRoot, RUNTIME_RELATIVE_ROOT),
    documentationRoot: path.join(bundleRoot, RUNTIME_RELATIVE_ROOT),
    knowledgeRoot: path.join(bundleRoot, 'runtime/mavt-knowledge-manager'),
    hostProfilePath: path.join(bundleRoot, 'hosts/codex/delegation.md') };
}
function pinBundle(pluginRoot, workspace) {
  require('./workspace').assertWorkspace(workspace);
  const manifest = verifyBundle(pluginRoot);
  managedDirectories(workspace);
  const bundleRoot = path.join(workspace, '.mavt/runtime-bundles', manifest.bundleId);
  return withFileLock(path.join(workspace, '.mavt/runtime-bundles', `.${manifest.bundleId}.lock`), () => {
    if (!fs.existsSync(bundleRoot)) {
      const staging = fs.mkdtempSync(path.join(workspace, '.mavt/runtime-bundles/.staging-'));
      try {
        for (const record of manifest.files) {
          const source = plainPath(pluginRoot, record.path, 'file');
          const target = path.join(staging, record.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(target, record.executable ? 0o755 : 0o644);
        }
        fs.writeFileSync(path.join(staging, 'bundle.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
        verifyBundle(staging, manifest.bundleId);
        fs.renameSync(staging, bundleRoot);
      } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    }
    const fixed = verifyBundle(bundleRoot, manifest.bundleId);
    return bundleLocations(bundleRoot, fixed);
  });
}
function bundleForRuntime(runtimeRoot) {
  const resolved = path.resolve(runtimeRoot);
  const bundleRoot = path.resolve(resolved, '../..');
  // A distribution (including one removed/corrupted after startup) is distinguishable
  // from the standalone source tree without relying on a manifest's existence.
  if (path.join(bundleRoot, RUNTIME_RELATIVE_ROOT) !== resolved) return null;
  const manifest = verifyBundle(bundleRoot);
  return { bundleRoot, manifest, ...bundleLocations(bundleRoot, manifest) };
}
module.exports = { DIGEST, RUNTIME_RELATIVE_ROOT, bundleError, bundleForRuntime, bundleLocations, createManifest, managedDirectories, pinBundle, plainPath, sha256, verifyBundle };
