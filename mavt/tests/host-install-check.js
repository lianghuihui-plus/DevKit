#!/usr/bin/env node
'use strict';

// Opt-in no-device check against a real Codex CLI. All registrations live in a
// fresh CODEX_HOME; this never reads/copies account credentials or user config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

async function inspectSkills(cli, env, cwd) {
  const child = cp.spawn(cli, ['app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0;
  let buffer = '';
  child.stderr.on('data', () => {});
  child.stdout.on('data', bytes => {
    buffer += bytes;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(item.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(item.id);
        if (item.error) waiter.reject(new Error(JSON.stringify(item.error)));
        else waiter.resolve(item.result);
      }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout: ${method}`)); }, 25000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  try {
    await call('initialize', { clientInfo: { name: 'mavt_release_check', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const response = await call('skills/list', { cwds: [cwd], forceReload: true });
    const errors = response.data.flatMap(row => row.errors || []);
    assert.deepEqual(errors, []);
    const skills = response.data.flatMap(row => row.skills).filter(skill => skill.pluginId && /^mavt:/.test(skill.name));
    assert.deepEqual(skills.map(skill => skill.name).sort(), ['mavt:author-cases', 'mavt:manage-knowledge', 'mavt:run-tests']);
    assert.equal(skills.every(skill => skill.enabled), true);
    const displayNames = {
      'mavt:author-cases': 'MAVT 用例编写',
      'mavt:run-tests': 'MAVT 测试执行',
      'mavt:manage-knowledge': 'MAVT 知识管理',
    };
    for (const skill of skills) {
      assert.equal(skill.interface?.displayName, displayNames[skill.name]);
      assert.ok(skill.interface.shortDescription.length >= 25 && skill.interface.shortDescription.length <= 64);
    }
    return skills.map(({ name, path: skillPath, enabled, interface: metadata }) => ({ name, path: skillPath, enabled, interface: metadata }));
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    child.stdin.end();
    child.kill('SIGTERM');
  }
}
async function main() {
  const [cli, marketplaceRoot] = process.argv.slice(2);
  assert.ok(cli && path.isAbsolute(cli) && marketplaceRoot && path.isAbsolute(marketplaceRoot), 'usage: host-install-check.js /absolute/codex /absolute/marketplace');
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-host-install-')));
  const env = { ...process.env, CODEX_HOME: path.join(temp, 'codex-home') };
  fs.mkdirSync(env.CODEX_HOME);
  const run = args => {
    const result = cp.spawnSync(cli, args, { cwd: temp, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  try {
    const publisher = path.join(temp, 'publisher');
    fs.cpSync(marketplaceRoot, publisher, { recursive: true });
    const version = run(['--version']);
    run(['plugin', 'marketplace', 'add', publisher]);
    const installation = JSON.parse(run(['plugin', 'add', 'mavt@mavt-local', '--json']));
    const list = JSON.parse(run(['plugin', 'list', '--json']));
    const skills = await inspectSkills(cli, env, temp);
    // The installed entry actually works from a cwd outside the repository.
    const installedRoot = path.resolve(path.dirname(skills[0].path), '../..');
    const workspace = path.join(temp, '工作 空间');
    fs.mkdirSync(workspace);
    const opened = cp.spawnSync(process.execPath, [path.join(installedRoot, 'scripts/mavt-entry.js'), 'workspace', '--cwd', workspace], { encoding: 'utf8', cwd: temp });
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    const binding = JSON.parse(opened.stdout);
    assert.equal(binding.marker.initializationState, 'READY');
    const node = (script, args, input) => {
      const result = cp.spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: temp, input: input === undefined ? undefined : JSON.stringify(input) });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const draft = path.join(temp, 'draft.json');
    fs.writeFileSync(draft, JSON.stringify({ cases: [{ sourceLocator: '/fixture/install#1', title: '安装验证', sourceText: '只验证离线绑定。' }] }));
    node(path.join(binding.runtimeRoot, 'scripts/import-cases.js'), ['--workspace', workspace, '--request-file', draft]);
    node(path.join(binding.runtimeRoot, 'scripts/coordinator-agent.js'), ['--workspace', workspace], { operation: 'prepareRun', input: { caseNos: ['001'] } });
    const batchId = fs.readdirSync(path.join(workspace, 'runs'))[0];
    const publisherPlugin = path.join(publisher, 'plugins/mavt');
    const metadataFile = path.join(publisherPlugin, '.codex-plugin/plugin.json');
    const metadata = JSON.parse(fs.readFileSync(metadataFile));
    metadata.version = '0.1.2-verification';
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    fs.appendFileSync(path.join(publisherPlugin, 'runtime/mobile-ai-visual-test/scripts/case-runtime/runtime-core.js'), '\n// Host upgrade verification B\n');
    const manifest = require(path.join(binding.runtimeRoot, 'scripts/lib/runtime-bundle')).createManifest(publisherPlugin, metadata.version);
    fs.writeFileSync(path.join(publisherPlugin, 'bundle.manifest.json'), JSON.stringify(manifest));
    const upgrade = JSON.parse(run(['plugin', 'add', 'mavt@mavt-local', '--json']));
    const upgradedSkills = await inspectSkills(cli, env, temp);
    assert.equal(upgradedSkills.every(skill => skill.path.includes('/0.1.2-verification/')), true);
    assert.ok(installedRoot.startsWith(`${env.CODEX_HOME}${path.sep}`), 'old cache target must belong to temporary home');
    const oldCacheRemovedByInstaller = !fs.existsSync(installedRoot);
    if (!oldCacheRemovedByInstaller) fs.renameSync(installedRoot, installedRoot + '-retired');
    const upgradedRoot = path.resolve(path.dirname(upgradedSkills[0].path), '../..');
    const resumed = node(path.join(upgradedRoot, 'scripts/mavt-entry.js'), ['resume', '--workspace', workspace, '--run', batchId]);
    assert.equal(resumed.bundleId, binding.bundleId);
    const cancelled = node(path.join(binding.runtimeRoot, 'scripts/coordinator-agent.js'), ['--state', path.join(workspace, 'runs', batchId, 'coordinator-state.json')], { operation: 'cancelRun', input: { reason: 'host check, no devices' } });
    assert.equal(cancelled.data.content.runOutcome, 'CANCELLED');
    console.log(JSON.stringify({ status: 'PASS', version, installation, list, skills, upgrade, upgradedSkills,
      bundleId: binding.bundleId, upgradedBundleId: manifest.bundleId, resumeAfterOldCacheRemoved: true, cancelledBeforeDeviceConfirmation: true,
      oldCacheRemovedByInstaller, temporaryHomeRemoved: true }, null, 2));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
