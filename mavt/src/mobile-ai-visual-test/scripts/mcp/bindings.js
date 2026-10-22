'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertWorkspace } = require('../lib/workspace');
const { bundleError, bundleLocations, plainPath, sha256, verifyBundle } = require('../lib/runtime-bundle');
const { readRunBinding } = require('../lib/runtime-binding');
function invalid(message) { throw bundleError('MAVT_MCP_CONTEXT_INVALID', message); }
function workspacePath(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace) invalid('workspace must be a canonical absolute path');
  plainPath(path.parse(workspace).root, workspace.slice(path.parse(workspace).root.length), 'directory');
  return workspace;
}
function existingPath(root, relative) {
  let target = root;
  for (const component of relative.split('/')) {
    target = path.join(target, component);
    try { fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    plainPath(root, path.relative(root, target));
  }
}
function safeTree(workspace, relative) {
  const target = plainPath(workspace, relative);
  if (fs.lstatSync(target).isDirectory()) for (const name of fs.readdirSync(target)) safeTree(workspace, `${relative}/${name}`);
}
function safeWorkspace(workspace, { allowUnready = false } = {}) {
  workspacePath(workspace);
  existingPath(workspace, 'workspace.json');
  if (!allowUnready) assertWorkspace(workspace);
  // Validate fixed roots only. Each operation checks its own target paths; evidence in
  // other Runs must not affect unrelated reads or make them scale with workspace age.
  for (const relative of ['cases', 'knowledge', 'runs', 'app-packages', '.mavt/mcp-contexts', '.mavt/runtime-bundles', '.mavt/run-staging']) existingPath(workspace, relative);
  if (allowUnready) for (const name of fs.readdirSync(workspace)) safeTree(workspace, name);
  return workspace;
}
function createContext(binding) {
  safeWorkspace(binding.workspace);
  const manifest = verifyBundle(path.join(binding.workspace, '.mavt/runtime-bundles', binding.bundleId), binding.bundleId);
  if (!['author', 'knowledge', 'coordinator'].includes(binding.role) || !['workspace', 'run'].includes(binding.scope) ||
    binding.scope === 'run' && (binding.role !== 'coordinator' || !binding.batchId) || binding.scope === 'workspace' && binding.batchId) invalid('invalid role/scope');
  const record = { schemaVersion: 1, ...binding };
  const directory = path.join(binding.workspace, '.mavt/mcp-contexts');
  fs.mkdirSync(directory, { recursive: true }); plainPath(binding.workspace, '.mavt/mcp-contexts', 'directory');
  const id = crypto.randomBytes(24).toString('hex');
  const bytes = JSON.stringify(record);
  fs.writeFileSync(path.join(directory, `${id}.json`), bytes + '\n', { flag: 'wx', mode: 0o600 });
  return { contextRef: `mavt-context:${Buffer.from(JSON.stringify({ workspace: binding.workspace, id, digest: sha256(bytes) })).toString('base64url')}`,
    workspace: binding.workspace, bundleId: manifest.bundleId, role: record.role, scope: record.scope, ...(record.batchId ? { batchId: record.batchId } : {}) };
}
function resolveContext(contextRef, expected = {}) {
  try {
    if (typeof contextRef !== 'string' || !/^mavt-context:[A-Za-z0-9_-]+$/.test(contextRef)) invalid('invalid context reference');
    const token = JSON.parse(Buffer.from(contextRef.slice(13), 'base64url').toString());
    if (Object.keys(token).sort().join(',') !== 'digest,id,workspace' || !/^[a-f0-9]{48}$/.test(token.id) || !/^[a-f0-9]{64}$/.test(token.digest)) invalid('invalid context locator');
    safeWorkspace(token.workspace);
    const filename = plainPath(token.workspace, `.mavt/mcp-contexts/${token.id}.json`, 'file');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (sha256(JSON.stringify(record)) !== token.digest || record.schemaVersion !== 1 || record.workspace !== token.workspace) invalid('context authority changed');
    if (expected.role && record.role !== expected.role || expected.scope && record.scope !== expected.scope) invalid('context role/scope mismatch');
    if (!/^[a-f0-9]{64}$/.test(record.bundleId)) invalid('invalid bundle identity');
    const bundleRoot = plainPath(record.workspace, `.mavt/runtime-bundles/${record.bundleId}`, 'directory');
    const manifest = verifyBundle(bundleRoot, record.bundleId);
    const locations = bundleLocations(bundleRoot, manifest);
    if (record.batchId) {
      const loaded = readRunBinding(record.workspace, record.batchId);
      if (!loaded.binding || loaded.bundleId !== record.bundleId) invalid('Run bundle mismatch');
      return { ...record, ...locations, state: loaded.state, statePath: loaded.locations.state };
    }
    return { ...record, ...locations };
  } catch (error) {
    if (String(error.code).startsWith('MAVT_RUNTIME_') || error.code === 'MAVT_MCP_CONTEXT_INVALID' || error.code === 'WORKSPACE_INVALID') throw error;
    invalid(error.message);
  }
}
module.exports = { createContext, resolveContext, existingPath, safeTree, safeWorkspace, workspacePath };
