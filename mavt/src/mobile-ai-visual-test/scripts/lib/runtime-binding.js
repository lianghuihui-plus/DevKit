'use strict';

const fs = require('fs');
const path = require('path');
const { bundleError, bundleForRuntime, bundleLocations, DIGEST, isVerifiedManifest, managedDirectories, plainPath, RUNTIME_RELATIVE_ROOT, verifyBundle } = require('./runtime-bundle');
const { withFileLock } = require('./execution-lifecycle');
const DEFAULT_ROOT = path.resolve(__dirname, '../..');
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const runCommand = (runtimeRoot, statePath) => `${quote(process.execPath)} ${quote(path.join(runtimeRoot, 'scripts/coordinator-agent.js'))} --state ${quote(statePath)}`;
function invalid(message) { throw bundleError('MAVT_RUNTIME_BINDING_INVALID', message); }
function pathsFor(workspace, batchId) {
  if (typeof batchId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(batchId)) invalid('invalid Run id');
  return { directory: path.join(workspace, 'runs', batchId), state: path.join(workspace, 'runs', batchId, 'coordinator-state.json'), binding: path.join(workspace, 'runs', batchId, 'runtime-binding.json') };
}
function readPlainJson(root, relative) {
  return JSON.parse(fs.readFileSync(plainPath(root, relative, 'file'), 'utf8'));
}
function readRunBinding(workspace, batchId, options = {}) {
  const locations = pathsFor(workspace, batchId);
  try {
    const state = readPlainJson(workspace, `runs/${batchId}/coordinator-state.json`);
    const hasBinding = fs.existsSync(locations.binding);
    const commandManaged = typeof state.command === 'string' && state.command.includes('/.mavt/runtime-bundles/');
    if (!hasBinding) {
      if (state.runtimeBindingRequired || commandManaged) invalid('managed Run binding is missing');
      return { state, binding: null, locations };
    }
    if (state.runtimeBindingRequired !== true || !commandManaged) invalid('conflicting managed/legacy evidence');
    const binding = readPlainJson(workspace, `runs/${batchId}/runtime-binding.json`);
    if (binding.schemaVersion !== 1 || binding.type !== 'mavtRuntimeBinding' || binding.batchId !== batchId || !DIGEST.test(binding.bundleId)
      || binding.hostId !== 'codex' || !DIGEST.test(binding.hostProfileSha) || binding.runtimeRelativeRoot !== RUNTIME_RELATIVE_ROOT
      || typeof binding.originPluginVersion !== 'string' || !binding.originPluginVersion) invalid('unsupported binding');
    plainPath(workspace, '.mavt/runtime-bundles', 'directory');
    const bundleRoot = path.join(workspace, '.mavt/runtime-bundles', binding.bundleId);
    const verified = options.verifiedBundle || options.verifiedBundles?.get(binding.bundleId);
    if (verified?.bundleRoot === bundleRoot && verified.error) throw verified.error;
    const manifest = verified?.bundleRoot === bundleRoot && isVerifiedManifest(verified.manifest, bundleRoot, binding.bundleId)
      ? verified.manifest : verifyBundle(bundleRoot, binding.bundleId);
    const resolved = bundleLocations(bundleRoot, manifest);
    const host = manifest.files.find(f => f.path === 'hosts/codex/delegation.md');
    if (!host || host.sha256 !== binding.hostProfileSha) invalid('host profile identity mismatch');
    if (state.type !== 'coordinatorRun' || state.workspace !== workspace || state.batchId !== batchId || state.statePath !== locations.state
      || state.command !== runCommand(resolved.runtimeRoot, locations.state)) invalid('Coordinator location/command mismatch');
    return { binding, state, locations, ...resolved };
  } catch (error) {
    if (String(error.code).startsWith('MAVT_RUNTIME_')) throw error;
    invalid(error.message);
  }
}
function assertRunRuntime(workspace, batchId, runtimeRoot = DEFAULT_ROOT) {
  workspace = path.resolve(workspace);
  const locations = pathsFor(workspace, batchId);
  // Standalone maintenance may precede Coordinator creation. Managed code may not.
  if (!fs.existsSync(locations.state)) {
    if (bundleForRuntime(runtimeRoot) || fs.existsSync(locations.binding)) invalid('managed Coordinator state missing');
    return null;
  }
  const loaded = readRunBinding(workspace, batchId);
  if (!loaded.binding) {
    if (bundleForRuntime(runtimeRoot)) invalid('legacy Run cannot be adopted by a plugin bundle');
    return null;
  }
  if (path.resolve(runtimeRoot) !== loaded.runtimeRoot) invalid('command is executing from another runtime');
  return loaded.binding;
}
function publishManagedRun(state, runtimeRoot = DEFAULT_ROOT) {
  const managed = bundleForRuntime(runtimeRoot);
  if (!managed) return false;
  const { workspace, batchId } = state;
  const locations = pathsFor(workspace, batchId);
  const expectedRoot = path.join(workspace, '.mavt/runtime-bundles', managed.bundleId);
  if (managed.bundleRoot !== expectedRoot) invalid('Run must be created from the workspace pinned bundle');
  if (state.statePath !== locations.state || state.command !== runCommand(runtimeRoot, locations.state)) invalid('invalid initial command binding');
  const host = managed.manifest.files.find(f => f.path === 'hosts/codex/delegation.md');
  if (!host) invalid('Codex host profile is missing');
  managedDirectories(workspace);
  const runs = path.join(workspace, 'runs');
  if (!fs.existsSync(runs)) fs.mkdirSync(runs, { recursive: true });
  plainPath(workspace, 'runs', 'directory');
  const binding = { schemaVersion: 1, type: 'mavtRuntimeBinding', batchId, bundleId: managed.bundleId,
    originPluginVersion: managed.manifest.pluginVersion, hostId: 'codex', hostProfileSha: host.sha256, runtimeRelativeRoot: RUNTIME_RELATIVE_ROOT };
  return withFileLock(path.join(workspace, '.mavt/run-staging/.publish.lock'), () => {
    if (fs.existsSync(locations.directory)) invalid('Run directory already exists; inspect it before retrying');
    const staging = fs.mkdtempSync(path.join(workspace, '.mavt/run-staging/run-'));
    state.runtimeBindingRequired = true;
    state.revision = 1;
    try {
      fs.writeFileSync(path.join(staging, 'runtime-binding.json'), `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' });
      fs.writeFileSync(path.join(staging, 'coordinator-state.json'), `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(staging, locations.directory);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return true;
  });
}
function assertExecutionRuntime(executionDir, runtimeRoot = DEFAULT_ROOT) {
  const execDir = path.resolve(executionDir);
  const file = path.join(execDir, 'execution.json');
  if (!fs.existsSync(file)) {
    if (bundleForRuntime(runtimeRoot)) invalid('execution identity missing');
    return null;
  }
  const execution = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!execution.batchId) {
    if (bundleForRuntime(runtimeRoot)) invalid('plugin execution must belong to a bound Run');
    return null;
  }
  let workspace = path.dirname(execDir);
  while (!fs.existsSync(path.join(workspace, 'workspace.json'))) {
    const parent = path.dirname(workspace);
    if (parent === workspace) {
      if (bundleForRuntime(runtimeRoot)) invalid('execution workspace missing');
      return null;
    }
    workspace = parent;
  }
  return assertRunRuntime(workspace, execution.batchId, runtimeRoot);
}
module.exports = { assertExecutionRuntime, assertRunRuntime, pathsFor, publishManagedRun, readRunBinding, runCommand };
