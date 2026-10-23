'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertWorkspace } = require('../lib/workspace');
const { bundleError, bundleLocations, plainPath, sha256, verifyBundle } = require('../lib/runtime-bundle');
const { readRunBinding } = require('../lib/runtime-binding');
const { assertActiveDispatch } = require('../lib/dispatch-lease');
function invalid(message) { throw bundleError('MAVT_MCP_CONTEXT_INVALID', message); }
function workspacePath(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace) invalid('workspace must be a canonical absolute path');
  const canonical = fs.realpathSync(workspace);
  plainPath(path.parse(canonical).root, canonical.slice(path.parse(canonical).root.length), 'directory');
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
  if (!['author', 'knowledge', 'coordinator', 'case', 'reporting'].includes(binding.role) || !['workspace', 'run', 'execution'].includes(binding.scope) ||
    binding.scope === 'run' && (binding.role !== 'coordinator' || !binding.batchId) || binding.scope === 'workspace' && binding.batchId) invalid('invalid role/scope');
  if (binding.role === 'reporting' && binding.scope !== 'workspace') invalid('Reporting requires workspace scope');
  if (binding.scope === 'execution') {
    if (binding.role !== 'case') invalid('execution scope requires Case role');
    resolveCaseBinding(binding, bundleLocations(path.join(binding.workspace, '.mavt/runtime-bundles', binding.bundleId), manifest), manifest);
  } else if (binding.role === 'case') invalid('Case role requires execution scope');
  const record = { schemaVersion: 1, ...binding };
  const directory = path.join(binding.workspace, '.mavt/mcp-contexts');
  fs.mkdirSync(directory, { recursive: true }); plainPath(binding.workspace, '.mavt/mcp-contexts', 'directory');
  const id = crypto.randomBytes(24).toString('hex');
  const bytes = JSON.stringify(record);
  fs.writeFileSync(path.join(directory, `${id}.json`), bytes + '\n', { flag: 'wx', mode: 0o600 });
  return { contextRef: `mavt-context:${Buffer.from(JSON.stringify({ workspace: binding.workspace, id, digest: sha256(bytes) })).toString('base64url')}`,
    ...bundleLocations(path.join(binding.workspace, '.mavt/runtime-bundles', binding.bundleId), manifest),
    workspace: binding.workspace, role: record.role, scope: record.scope, ...(record.batchId ? { batchId: record.batchId } : {}),
    ...(record.executionId ? { executionId: record.executionId, dispatchSequence: record.dispatchSequence } : {}) };
}
function resolveCaseBinding(record, locations, manifest) {
  const { workspace, batchId, executionId, caseProtocolSha, dispatchSequence, execDir } = record;
  if (typeof batchId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(batchId) ||
    typeof executionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(executionId) ||
    typeof caseProtocolSha !== 'string' || !caseProtocolSha || !Number.isInteger(dispatchSequence) || dispatchSequence < 1 ||
    typeof execDir !== 'string' || !path.isAbsolute(execDir) || path.resolve(execDir) !== execDir) invalid('invalid Case binding');
  const relative = path.relative(workspace, execDir).split(path.sep);
  if (relative.length !== 6 || relative[0] !== 'cases' || relative[2] !== 'platforms' || relative[4] !== 'executions' || relative[5] !== executionId) invalid('Case execution path is outside its scope');
  plainPath(workspace, path.relative(workspace, execDir), 'directory');
  const execution = JSON.parse(fs.readFileSync(plainPath(execDir, 'execution.json', 'file'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(plainPath(execDir, 'runtime.json', 'file'), 'utf8'));
  if (execution.schemaVersion !== 14 || execution.executionId !== executionId || execution.batchId !== batchId ||
    execution.caseProtocolSha !== caseProtocolSha || runtime.executionId !== executionId ||
    runtime.sessionRef?.statePath !== path.join(workspace, 'runs', batchId, 'batch.json')) invalid('Case execution identity or protocol changed');
  const loaded = readRunBinding(workspace, batchId, { verifiedBundle: { bundleRoot: locations.bundleRoot, manifest } });
  if (!loaded.binding || loaded.bundleId !== record.bundleId) invalid('Case Run bundle mismatch');
  assertActiveDispatch(path.join(workspace, 'runs', batchId, 'handoffs', executionId), executionId, dispatchSequence);
  return { execDir, execution, runtime, state: loaded.state, statePath: loaded.locations.state };
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
    if (record.role === 'reporting' && (record.scope !== 'workspace' || record.batchId || record.executionId)) invalid('Reporting requires workspace scope');
    if (expected.role && record.role !== expected.role || expected.scope && record.scope !== expected.scope) invalid('context role/scope mismatch');
    if (!/^[a-f0-9]{64}$/.test(record.bundleId)) invalid('invalid bundle identity');
    const bundleRoot = plainPath(record.workspace, `.mavt/runtime-bundles/${record.bundleId}`, 'directory');
    const manifest = verifyBundle(bundleRoot, record.bundleId);
    const locations = bundleLocations(bundleRoot, manifest);
    if (record.scope === 'execution') {
      if (record.role !== 'case') invalid('Case role/scope mismatch');
      return { ...record, ...locations, ...resolveCaseBinding(record, locations, manifest) };
    }
    if (record.batchId) {
      const loaded = readRunBinding(record.workspace, record.batchId, { verifiedBundle: { bundleRoot, manifest } });
      if (!loaded.binding || loaded.bundleId !== record.bundleId) invalid('Run bundle mismatch');
      return { ...record, ...locations, state: loaded.state, statePath: loaded.locations.state };
    }
    return { ...record, ...locations };
  } catch (error) {
    if (String(error.code).startsWith('MAVT_RUNTIME_') || String(error.code).startsWith('HANDOFF_') ||
      error.code === 'MAVT_MCP_CONTEXT_INVALID' || error.code === 'WORKSPACE_INVALID') throw error;
    invalid(error.message);
  }
}
module.exports = { createContext, resolveContext, existingPath, safeTree, safeWorkspace, workspacePath };
