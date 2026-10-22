'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { createManifest, pinBundle } = require('../lib/runtime-bundle');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(path.join(plugin, 'runtime/mobile-ai-visual-test/scripts'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hosts/codex'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'hosts/codex/delegation.md'), 'profile');
  fs.writeFileSync(path.join(plugin, 'runtime/mobile-ai-visual-test/scripts/coordinator-agent.js'), 'code');
  fs.writeFileSync(path.join(plugin, 'bundle.manifest.json'), JSON.stringify(createManifest(plugin, '0.1.0')));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  require('../lib/workspace').ensureWorkspace(workspace);
  const pinned = pinBundle(plugin, workspace);
  const api = require('../lib/runtime-binding');
  const batchId = 'batch-probe';
  const statePath = path.join(workspace, 'runs', batchId, 'coordinator-state.json');
  const state = { type: 'coordinatorRun', workspace, batchId, statePath, command: api.runCommand(pinned.runtimeRoot, statePath), phase: 'PREPARING', revision: 1 };
  return { api, root, workspace, pinned, state, statePath, batchId };
}
test('publishes paired binding/state, refuses overwrite, and validates runtime identity', t => {
  const { api, workspace, pinned, state, batchId, statePath } = fixture(t);
  assert.equal(api.publishManagedRun(state, pinned.runtimeRoot), true);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).runtimeBindingRequired, true);
  const binding = api.assertRunRuntime(workspace, batchId, pinned.runtimeRoot);
  assert.equal(binding.bundleId, pinned.bundleId);
  assert.equal(binding.runtimeRelativeRoot, 'runtime/mobile-ai-visual-test');
  assert.equal(binding.hostId, 'codex');
  assert.throws(() => api.publishManagedRun(state, pinned.runtimeRoot), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
  assert.throws(() => api.assertRunRuntime(workspace, batchId), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
  assert.throws(() => api.assertRunRuntime(workspace, '../escape', pinned.runtimeRoot), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
});
test('required or managed-command evidence prevents missing binding from masquerading as legacy', t => {
  const { api, workspace, pinned, state, batchId, statePath } = fixture(t);
  api.publishManagedRun(state, pinned.runtimeRoot);
  fs.unlinkSync(path.join(path.dirname(statePath), 'runtime-binding.json'));
  assert.throws(() => api.assertRunRuntime(workspace, batchId, pinned.runtimeRoot), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
  const altered = JSON.parse(fs.readFileSync(statePath));
  delete altered.runtimeBindingRequired;
  fs.writeFileSync(statePath, JSON.stringify(altered));
  assert.throws(() => api.assertRunRuntime(workspace, batchId), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
});
test('unmanaged legacy remains usable from source but cannot be adopted by plugin', t => {
  const { api, workspace, pinned, state, batchId, statePath } = fixture(t);
  state.command = 'node /legacy/coordinator.js';
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
  assert.equal(api.assertRunRuntime(workspace, batchId), null);
  assert.throws(() => api.assertRunRuntime(workspace, batchId, pinned.runtimeRoot), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
});
test('standalone synthetic execution trees keep source behavior without a workspace marker', t => {
  const { api, root, pinned } = fixture(t);
  const execution = path.join(root, 'isolated-execution');
  fs.mkdirSync(execution);
  fs.writeFileSync(path.join(execution, 'execution.json'), JSON.stringify({ schemaVersion: 14, executionId: 'exec-1', batchId: 'batch-isolated' }));
  assert.equal(api.assertExecutionRuntime(execution), null);
  assert.throws(() => api.assertExecutionRuntime(execution, pinned.runtimeRoot), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
});
test('resume validation checks host hash, state command, and missing code before returning command', t => {
  const { api, workspace, pinned, state, batchId, statePath } = fixture(t);
  api.publishManagedRun(state, pinned.runtimeRoot);
  const file = path.join(path.dirname(statePath), 'runtime-binding.json');
  const binding = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...binding, hostProfileSha: '0'.repeat(64) }));
  assert.throws(() => api.readRunBinding(workspace, batchId), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
  fs.writeFileSync(file, JSON.stringify(binding));
  const original = fs.readFileSync(statePath);
  fs.writeFileSync(statePath, JSON.stringify({ ...state, command: 'node /wrong/code.js' }));
  assert.throws(() => api.readRunBinding(workspace, batchId), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
  fs.writeFileSync(statePath, original);
  fs.renameSync(pinned.bundleRoot, pinned.bundleRoot + '-gone');
  assert.throws(() => api.readRunBinding(workspace, batchId), { code: 'MAVT_RUNTIME_BUNDLE_MISSING' });
});
test('process death before paired directory publication leaves no visible Run', t => {
  const { api, workspace, pinned, state, batchId } = fixture(t);
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const original = fs.renameSync;
    const state = JSON.parse(process.argv[2]);
    fs.renameSync = (source, target) => {
      if (target === require('path').dirname(state.statePath)) process.exit(91);
      return original(source, target);
    };
    require(process.argv[1]).publishManagedRun(state, process.argv[3]);
  `, require.resolve('../lib/runtime-binding'), JSON.stringify(state), pinned.runtimeRoot], { encoding: 'utf8' });
  assert.equal(child.status, 91, child.stderr);
  assert.equal(fs.existsSync(path.join(workspace, 'runs', batchId)), false);
  const stages = fs.readdirSync(path.join(workspace, '.mavt/run-staging')).filter(name => name.startsWith('run-'));
  assert.equal(stages.length, 1);
  const staged = path.join(workspace, '.mavt/run-staging', stages[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, 'coordinator-state.json'))).runtimeBindingRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, 'runtime-binding.json'))).batchId, batchId);
  assert.throws(() => api.readRunBinding(workspace, batchId), { code: 'MAVT_RUNTIME_BINDING_INVALID' });
});
