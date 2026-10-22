'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const apiPath = '../lib/runtime-bundle';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, '发布 包');
  fs.mkdirSync(path.join(plugin, 'runtime/mobile-ai-visual-test/scripts'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hosts/codex'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'runtime/mobile-ai-visual-test/scripts/main.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(plugin, 'hosts/codex/delegation.md'), '独立上下文\n');
  return { root, plugin };
}
function seal(plugin, version = '0.1.0') {
  const { createManifest } = require(apiPath);
  const manifest = createManifest(plugin, version);
  fs.writeFileSync(path.join(plugin, 'bundle.manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('manifest identity survives relocation and version display changes, but tracks modes and bytes', t => {
  const { plugin, root } = fixture(t);
  const { createManifest, verifyBundle } = require(apiPath);
  const a = seal(plugin);
  assert.deepEqual(a.files.map(f => f.path), ['hosts/codex/delegation.md', 'runtime/mobile-ai-visual-test/scripts/main.sh']);
  const want = crypto.createHash('sha256').update(JSON.stringify({ schemaVersion: 1, files: a.files })).digest('hex');
  assert.equal(a.bundleId, want);
  assert.equal(a.bundleId, createManifest(plugin, '99.0.0').bundleId);
  const relocated = path.join(root, 'new location');
  fs.cpSync(plugin, relocated, { recursive: true });
  assert.equal(verifyBundle(relocated, a.bundleId).bundleId, a.bundleId);
  fs.chmodSync(path.join(relocated, 'runtime/mobile-ai-visual-test/scripts/main.sh'), 0o644);
  assert.throws(() => verifyBundle(relocated, a.bundleId), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
});

test('rejects missing, extra and modified resources instead of accepting a stale manifest', t => {
  const { plugin } = fixture(t);
  const { verifyBundle } = require(apiPath);
  const manifest = seal(plugin);
  const file = path.join(plugin, 'hosts/codex/delegation.md');
  fs.writeFileSync(file, 'changed');
  assert.throws(() => verifyBundle(plugin, manifest.bundleId), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  fs.unlinkSync(file);
  assert.throws(() => verifyBundle(plugin, manifest.bundleId), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  fs.writeFileSync(file, '独立上下文\n');
  fs.writeFileSync(path.join(plugin, 'hosts/extra'), 'extra');
  assert.throws(() => verifyBundle(plugin, manifest.bundleId), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
});

test('rejects symlink trees, malformed paths, duplicated records and identity substitution', t => {
  const { plugin, root } = fixture(t);
  const { createManifest, verifyBundle } = require(apiPath);
  const manifest = seal(plugin);
  for (const badPath of ['../escape', '/tmp/escape', 'hosts/../hosts/codex/delegation.md', 'hosts\\x', 'hosts//x']) {
    fs.writeFileSync(path.join(plugin, 'bundle.manifest.json'), JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], path: badPath }] }));
    assert.throws(() => verifyBundle(plugin), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  }
  fs.writeFileSync(path.join(plugin, 'bundle.manifest.json'), JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
  assert.throws(() => verifyBundle(plugin), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  fs.writeFileSync(path.join(plugin, 'bundle.manifest.json'), JSON.stringify({ ...manifest, pluginVersion: { invalid: 'version' } }));
  assert.throws(() => verifyBundle(plugin), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  seal(plugin);
  assert.throws(() => verifyBundle(plugin, '0'.repeat(64)), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  fs.symlinkSync(root, path.join(plugin, 'hosts/link'));
  assert.throws(() => createManifest(plugin, '0.1.0'), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
});

test('snapshot is reusable and independent of installation, corrupt published copy is never replaced', t => {
  const { plugin, root } = fixture(t);
  const { pinBundle, verifyBundle } = require(apiPath);
  const { ensureWorkspace } = require('../lib/workspace');
  const workspace = path.join(root, '工作 区');
  fs.mkdirSync(workspace);
  ensureWorkspace(workspace);
  const manifest = seal(plugin);
  const pinned = pinBundle(plugin, workspace);
  assert.equal(pinned.bundleId, manifest.bundleId);
  assert.equal(pinned.bundleRoot, path.join(workspace, '.mavt/runtime-bundles', manifest.bundleId));
  assert.deepEqual(pinBundle(plugin, workspace), pinned);
  fs.renameSync(plugin, plugin + '-removed');
  verifyBundle(pinned.bundleRoot, manifest.bundleId);
  fs.writeFileSync(path.join(pinned.bundleRoot, 'hosts/codex/delegation.md'), 'broken');
  assert.throws(() => pinBundle(plugin + '-removed', workspace), { code: 'MAVT_RUNTIME_BUNDLE_INVALID' });
  assert.equal(fs.readFileSync(path.join(pinned.bundleRoot, 'hosts/codex/delegation.md'), 'utf8'), 'broken');
});
test('first snapshot tolerates another publisher creating managed parent after the existence check', t => {
  const { plugin, root } = fixture(t);
  const { pinBundle, verifyBundle } = require(apiPath);
  const { ensureWorkspace } = require('../lib/workspace');
  const workspace = path.join(root, 'parallel-workspace');
  fs.mkdirSync(workspace);
  ensureWorkspace(workspace);
  const manifest = seal(plugin);
  const original = fs.mkdirSync;
  let raced = false;
  fs.mkdirSync = function (target, ...options) {
    if (!raced && target === path.join(workspace, '.mavt')) {
      raced = true;
      original(target);
    }
    return original(target, ...options);
  };
  try { verifyBundle(pinBundle(plugin, workspace).bundleRoot, manifest.bundleId); }
  finally { fs.mkdirSync = original; }
  assert.equal(raced, true);
});
test('a process killed before snapshot rename never publishes an incomplete bundle', t => {
  const { plugin, root } = fixture(t);
  const { pinBundle, verifyBundle } = require(apiPath);
  const workspace = path.join(root, 'crash-workspace');
  fs.mkdirSync(workspace);
  require('../lib/workspace').ensureWorkspace(workspace);
  const manifest = seal(plugin);
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    fs.renameSync = () => process.exit(92);
    require(process.argv[1]).pinBundle(process.argv[2], process.argv[3]);
  `, require.resolve(apiPath), plugin, workspace], { encoding: 'utf8' });
  assert.equal(child.status, 92, child.stderr);
  const copies = path.join(workspace, '.mavt/runtime-bundles');
  assert.equal(fs.existsSync(path.join(copies, manifest.bundleId)), false);
  assert.equal(fs.readdirSync(copies).filter(name => name.startsWith('.staging-')).length, 1);
  verifyBundle(pinBundle(plugin, workspace).bundleRoot, manifest.bundleId);
});
