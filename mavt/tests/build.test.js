'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildPlugin, buildDefaultPlugin, writeReleaseFileList } = require('../build-plugin');

const repoRoot = path.resolve(__dirname, '..');
const helper = 'scripts/platform/adapters/android/helper/';
const mavtRoot = 'src/mobile-ai-visual-test/';
const inputs = {
  [mavtRoot + 'scripts/coordinator-agent.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/management-service.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/protocol.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/bindings.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/case-service.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/host-capabilities.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/worker-child.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/worker-pool.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/mcp/contract.js']: 'module.exports = {};\n',
  [mavtRoot + 'scripts/lib/action-common.sh']: '#!/bin/sh\nexit 0\n',
  [mavtRoot + 'scripts/platform/adapters/android/ime/AndroidManifest.xml']: '<manifest/>\n',
  [mavtRoot + 'scripts/platform/adapters/android/ime/res/xml/method.xml']: '<input-method/>\n',
  [mavtRoot + 'scripts/platform/adapters/android/ime/src/mavt/android/ime/MavtInputMethodService.java']: 'class MavtInputMethodService {}\n',
  [mavtRoot + 'scripts/platform/adapters/android/ime/src/mavt/android/ime/MavtInputReceiver.java']: 'class MavtInputReceiver {}\n',
  [mavtRoot + helper + 'ArtemisAccessibilityHelper.apk']: Buffer.from([80, 75, 3, 4, 7]),
  [mavtRoot + 'scripts/platform/adapters/ios/action.sh']: '#!/bin/sh\nexit 0\n',
  [mavtRoot + 'scripts/platform/adapters/android/action.sh']: '#!/bin/sh\nexit 0\n',
  [mavtRoot + 'scripts/platform/adapters/harmony/action.sh']: '#!/bin/sh\nexit 0\n',
  [mavtRoot + 'scripts/platform/adapters/harmony/observe.sh']: '#!/bin/sh\nexit 0\n',
  [mavtRoot + 'prompts/case-agent.md']: 'Case prompt\n',
  [mavtRoot + 'references/coordinator-principles.md']: 'Coordinator rules\n',
  [mavtRoot + 'references/case-runtime.md']: 'Case runtime contract\n',
  [mavtRoot + 'scripts/extra-资源.bin']: Buffer.from([0, 255, 10]),
  [mavtRoot + 'scripts/tests/guard.test.js']: 'throw new Error("test only");\n',
  [mavtRoot + 'scripts/self-test.js']: 'console.log("test only");\n',
  'src/mavt-knowledge-manager/scripts/knowledge-manager.js': 'module.exports = {};\n',
  'src/mavt-knowledge-manager/references/knowledge-contract.md': 'Knowledge rules\n',
  'src/mavt-knowledge-manager/assets/knowledge-entry-template.md': 'Knowledge template\n',
  'scripts/mavt-entry.js': '#!/usr/bin/env node\nconsole.log("entry");\n',
  'scripts/mavt-mcp.js': '#!/usr/bin/env node\nconsole.log("mcp");\n',
  'hosts/codex/delegation.md': 'Host rules\n',
  'hosts/codex/harness-requirements.json': '{"schemaVersion":1}\n',
  '.mcp.json': '{"mavt":{"command":"node","args":["./scripts/mavt-mcp.js"],"cwd":"."}}\n',
};
// Deliberate fixture release contract: not derived from the builder or source discovery.
const FIXTURE_RELEASE_FILES = [
  '.codex-plugin/plugin.json', '.mcp.json', 'hosts/codex/delegation.md', 'hosts/codex/harness-requirements.json',
  'runtime/mavt-knowledge-manager/assets/knowledge-entry-template.md',
  'runtime/mavt-knowledge-manager/references/knowledge-contract.md',
  'runtime/mavt-knowledge-manager/scripts/knowledge-manager.js',
  'runtime/mobile-ai-visual-test/prompts/case-agent.md',
  'runtime/mobile-ai-visual-test/references/case-runtime.md',
  'runtime/mobile-ai-visual-test/references/coordinator-principles.md',
  'runtime/mobile-ai-visual-test/scripts/coordinator-agent.js',
  'runtime/mobile-ai-visual-test/scripts/extra-资源.bin',
  'runtime/mobile-ai-visual-test/scripts/lib/action-common.sh',
  'runtime/mobile-ai-visual-test/scripts/mcp/bindings.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/case-service.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/host-capabilities.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/contract.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/management-service.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/protocol.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/worker-child.js',
  'runtime/mobile-ai-visual-test/scripts/mcp/worker-pool.js',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/action.sh',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/helper/ArtemisAccessibilityHelper.apk',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/helper/helper_manifest.json',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/ime/AndroidManifest.xml',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/ime/res/xml/method.xml',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/ime/src/mavt/android/ime/MavtInputMethodService.java',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/android/ime/src/mavt/android/ime/MavtInputReceiver.java',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/harmony/action.sh',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/harmony/observe.sh',
  'runtime/mobile-ai-visual-test/scripts/platform/adapters/ios/action.sh',
  'scripts/mavt-entry.js',
  'scripts/mavt-mcp.js',
  'skills/author-cases/SKILL.md', 'skills/author-cases/agents/openai.yaml',
  'skills/manage-knowledge/SKILL.md', 'skills/manage-knowledge/agents/openai.yaml',
  'skills/run-tests/SKILL.md', 'skills/run-tests/agents/openai.yaml',
];

function write(root, relative, value) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value);
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-build-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, '源码 repo');
  for (const [relative, value] of Object.entries(inputs)) write(source, relative, value);
  const apk = inputs[mavtRoot + helper + 'ArtemisAccessibilityHelper.apk'];
  write(source, mavtRoot + helper + 'helper_manifest.json', JSON.stringify({
    sha256: crypto.createHash('sha256').update(apk).digest('hex'),
  }));
  for (const name of ['author-cases', 'run-tests', 'manage-knowledge']) {
    write(source, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Test entry\n---\n`);
    write(source, `skills/${name}/agents/openai.yaml`, `interface:\n  display_name: "${name}"\n  short_description: "Test entry metadata for ${name}"\n`);
  }
  write(source, '.codex-plugin/plugin.json', fs.readFileSync(path.join(repoRoot, '.codex-plugin/plugin.json')));
  write(source, 'release-files.json', JSON.stringify({ schemaVersion: 1, files: FIXTURE_RELEASE_FILES }));
  fs.chmodSync(path.join(source, mavtRoot + 'scripts/lib/action-common.sh'), 0o755);
  fs.chmodSync(path.join(source, 'scripts/mavt-entry.js'), 0o755);
  return { temp, source, output: path.join(temp, '中文 output') };
}

function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix)).sort().flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, relative));
    return stat.isDirectory() ? inventory(root, relative) : [{
      path: relative, bytes: fs.readFileSync(path.join(root, relative)).toString('base64'),
      executable: Boolean(stat.mode & 0o111),
    }];
  });
}

test('release builds preserve runtime resources and executable bits with repeatable output', (t) => {
  const { source, output, temp } = fixture(t);
  write(source, mavtRoot + 'SKILL.md', 'development role must not ship');
  write(source, mavtRoot + 'docs/local-test-result.md', 'business evidence');
  write(source, mavtRoot + 'scripts/.DS_Store', 'junk');
  write(source, mavtRoot + 'scripts/dev.zip', 'archive');
  const first = buildPlugin({ repoRoot: source, outputRoot: output });
  const second = buildPlugin({ repoRoot: source, outputRoot: path.join(temp, '第二次 build') });
  assert.deepEqual(inventory(first.marketplaceRoot), inventory(second.marketplaceRoot));
  assert.equal(first.manifest.bundleId, second.manifest.bundleId);
  assert.equal(first.manifest.pluginVersion, '0.3.6');
  const files = inventory(first.pluginRoot).map((entry) => entry.path);
  assert.deepEqual(files, [...FIXTURE_RELEASE_FILES, 'runtime/mobile-ai-visual-test/mcp-transport.json', 'bundle.manifest.json'].sort());
  const apk = path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test', helper, 'ArtemisAccessibilityHelper.apk');
  assert.deepEqual(fs.readFileSync(apk), inputs[mavtRoot + helper + 'ArtemisAccessibilityHelper.apk']);
  const executable = path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/lib/action-common.sh');
  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  const index = JSON.parse(fs.readFileSync(path.join(output, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(index.name, 'mavt-local');
  assert.equal(path.resolve(output, index.plugins[0].source.path), first.pluginRoot);
  const plugin = JSON.parse(fs.readFileSync(path.join(first.pluginRoot, '.codex-plugin/plugin.json')));
  assert.equal(plugin.mcpServers, './.mcp.json');
  assert.equal(fs.existsSync(path.join(first.pluginRoot, 'scripts/mavt-mcp.js')), true);
  assert.equal(fs.existsSync(path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp')), true);
});

test('the default build registers a relocatable MCP server and pins the Case transport', t => {
  const { source, temp } = fixture(t);
  const output = path.join(temp, 'mcp-output');
  const built = buildPlugin({ repoRoot: source, outputRoot: output });
  const relocated = path.join(temp, 'relocated');
  fs.renameSync(output, relocated);
  const pluginRoot = path.join(relocated, 'plugins/mavt');
  const plugin = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin/plugin.json')));
  assert.equal(plugin.mcpServers, './.mcp.json');
  const registration = JSON.parse(fs.readFileSync(path.join(pluginRoot, plugin.mcpServers))).mavt;
  assert.equal(path.resolve(pluginRoot, registration.cwd, registration.args[0]), path.join(pluginRoot, 'scripts/mavt-mcp.js'));
  for (const relative of FIXTURE_RELEASE_FILES.filter(name => name.startsWith('runtime/mobile-ai-visual-test/scripts/mcp/'))) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relative)), true, relative);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'runtime/mobile-ai-visual-test/mcp-transport.json'))),
    { schemaVersion: 1, transport: 'MCP' });
  assert.equal(built.manifest.bundleId, buildPlugin({ repoRoot: source, outputRoot: path.join(temp, 'same-build') }).manifest.bundleId);
});

test('development builds can retain runnable regression files', (t) => {
  const { source, output } = fixture(t);
  const result = buildPlugin({ repoRoot: source, outputRoot: output, includeTests: true });
  assert.ok(fs.existsSync(path.join(result.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/tests/guard.test.js')));
  assert.ok(fs.existsSync(path.join(result.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/self-test.js')));
});

test('missing or corrupt Helper APK fails before publishing output', (t) => {
  const { source, output } = fixture(t);
  const apk = path.join(source, mavtRoot, helper, 'ArtemisAccessibilityHelper.apk');
  fs.unlinkSync(apk);
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /ArtemisAccessibilityHelper\.apk/);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(apk, 'corrupted');
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /Helper.*hash|APK.*digest|APK.*hash/i);
  assert.equal(fs.existsSync(output), false);
});

test('nested and excluded symbolic links cannot smuggle external files into release', (t) => {
  const { source, output } = fixture(t);
  const external = path.join(source, 'private.txt');
  fs.writeFileSync(external, 'private');
  const link = path.join(source, mavtRoot, 'scripts/tests/secret');
  fs.symlinkSync(external, link);
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /symbolic|symlink/i);
  assert.equal(fs.existsSync(output), false);
});

test('missing plugin entry reports actionable source path', (t) => {
  const { source, output } = fixture(t);
  fs.unlinkSync(path.join(source, 'scripts/mavt-entry.js'));
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /mavt-entry\.js/);
  assert.equal(fs.existsSync(output), false);
});

test('missing Android action script fails instead of shipping a partial platform', (t) => {
  const { source, output } = fixture(t);
  fs.unlinkSync(path.join(source, mavtRoot, 'scripts/platform/adapters/android/action.sh'));
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /android.*action\.sh/);
  assert.equal(fs.existsSync(output), false);
});

test('committed inventory rejects missing runtime documentation and atoms before sealing', (t) => {
  const { source, output } = fixture(t);
  fs.unlinkSync(path.join(source, mavtRoot, 'references/case-runtime.md'));
  fs.unlinkSync(path.join(source, mavtRoot, 'scripts/platform/adapters/harmony/observe.sh'));
  const before = fs.readFileSync(path.join(source, 'release-files.json'));
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), (error) => {
    assert.match(error.message, /case-runtime\.md/);
    assert.match(error.message, /harmony\/observe\.sh/);
    return true;
  });
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(path.join(source, 'release-files.json')), before);
});

test('new source files require explicit release inventory approval', (t) => {
  const { source, output } = fixture(t);
  write(source, mavtRoot + 'scripts/unreviewed-runtime.js', 'module.exports = {};\n');
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /unexpected.*unreviewed-runtime\.js/i);
  assert.equal(fs.existsSync(output), false);
});

test('only explicit file-list generation approves an intended new runtime file', (t) => {
  const { source, output } = fixture(t);
  write(source, mavtRoot + 'scripts/new-approved-runtime.js', 'module.exports = {};\n');
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /Unexpected/);
  const result = writeReleaseFileList({ repoRoot: source });
  assert.equal(result.filename, path.join(source, 'release-files.json'));
  assert.equal(fs.existsSync(output), false);
  const built = buildPlugin({ repoRoot: source, outputRoot: output });
  assert.equal(fs.readFileSync(path.join(built.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/new-approved-runtime.js'), 'utf8'), 'module.exports = {};\n');
});

test('explicit inventory generation rejects a dangling symbolic-link destination', (t) => {
  const { source, temp } = fixture(t);
  const filename = path.join(source, 'release-files.json');
  const external = path.join(temp, 'must-not-create.json');
  fs.unlinkSync(filename);
  fs.symlinkSync(external, filename);
  assert.throws(() => writeReleaseFileList({ repoRoot: source }), /symbolic|symlink/i);
  assert.equal(fs.existsSync(external), false);
});

test('release inventory rejects malformed and duplicate controlled paths', (t) => {
  const { source, output } = fixture(t);
  for (const entry of ['../outside', '/absolute', 'runtime/../outside', 'runtime\\outside', '', 'bundle.manifest.json', 'scripts', '.codex-plugin/plugin.json/extra']) {
    write(source, 'release-files.json', JSON.stringify({ schemaVersion: 1, files: [...FIXTURE_RELEASE_FILES, entry] }));
    assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /invalid.*release.*path/i);
  }
  write(source, 'release-files.json', JSON.stringify({ schemaVersion: 1, files: [...FIXTURE_RELEASE_FILES, FIXTURE_RELEASE_FILES[0]] }));
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /duplicate/i);
  assert.equal(fs.existsSync(output), false);
});

test('actual checked-in release sources build against their independent committed inventory', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-real-release-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const result = buildPlugin({ repoRoot, outputRoot: path.join(temp, 'marketplace') });
  const files = inventory(result.pluginRoot).map((entry) => entry.path);
  assert.ok(files.includes('runtime/mobile-ai-visual-test/scripts/lib/runtime-bundle.js'));
  assert.ok(files.includes('runtime/mobile-ai-visual-test/scripts/lib/runtime-binding.js'));
  assert.ok(files.includes('runtime/mobile-ai-visual-test/references/case-runtime.md'));
  assert.ok(files.includes('runtime/mobile-ai-visual-test/scripts/platform/adapters/harmony/observe.sh'));
});

test('build refuses to overwrite user files but accepts an explicitly empty destination', (t) => {
  const { source, output } = fixture(t);
  fs.mkdirSync(output);
  write(output, 'keep.txt', 'user data');
  assert.throws(() => buildPlugin({ repoRoot: source, outputRoot: output }), /empty|exists|nonempty/i);
  assert.equal(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'user data');
  fs.unlinkSync(path.join(output, 'keep.txt'));
  assert.ok(buildPlugin({ repoRoot: source, outputRoot: output }).manifest.bundleId);
});

test('default publication keeps one marketplace path and archives the complete previous build', t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  buildPlugin({ repoRoot: source, outputRoot: output });
  const before = inventory(output);
  const plugin = JSON.parse(fs.readFileSync(path.join(source, '.codex-plugin/plugin.json')));
  plugin.version = '99.0.0';
  write(source, '.codex-plugin/plugin.json', JSON.stringify(plugin));
  const published = buildDefaultPlugin({ repoRoot: source });
  assert.equal(published.marketplaceRoot, output);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'plugins/mavt/.codex-plugin/plugin.json'))).version, '99.0.0');
  assert.deepEqual(inventory(published.archivedMarketplaceRoot), before);
  assert.equal(path.dirname(published.archivedMarketplaceRoot), path.join(source, 'dist/archive'));
});

test('the first default publication works without an existing output directory', t => {
  const { source } = fixture(t);
  const published = buildDefaultPlugin({ repoRoot: source });
  assert.equal(published.marketplaceRoot, path.join(source, 'dist/mavt-marketplace'));
  assert.equal(published.archivedMarketplaceRoot, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(published.pluginRoot, '.codex-plugin/plugin.json'))).version, '0.3.6');
});

for (const point of ['before-archive', 'after-archive', 'after-publish']) test(`default publication recovers a killed publisher at ${point}`, t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  buildPlugin({ repoRoot: source, outputRoot: output });
  const before = inventory(output);
  write(source, mavtRoot + 'references/case-runtime.md', 'Updated runtime documentation\n');
  const crashed = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const original = fs.renameSync;
    fs.renameSync = function(from, to) {
      const archiving = from === process.argv[2];
      if (archiving && process.argv[3] === 'before-archive') process.kill(process.pid, 'SIGKILL');
      const value = original.apply(this, arguments);
      if (archiving && process.argv[3] === 'after-archive' || to === process.argv[2] && process.argv[3] === 'after-publish') process.kill(process.pid, 'SIGKILL');
      return value;
    };
    require(${JSON.stringify(path.join(repoRoot, 'build-plugin.js'))}).buildDefaultPlugin({repoRoot: process.argv[1]});
  `, source, output, point], { encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const expected = point === 'after-publish' ? inventory(output) : before;
  // Recovery must happen before building: even broken sources must not leave
  // the previous installed marketplace inaccessible or leave a stale lock.
  fs.unlinkSync(path.join(source, mavtRoot + 'references/case-runtime.md'));
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /missing/i);
  assert.deepEqual(inventory(output), expected);
  assert.equal(fs.existsSync(path.join(source, 'dist/.mavt-marketplace.publish-lock')), false);
  assert.equal(fs.existsSync(path.join(source, 'dist/.mavt-marketplace.publish.json')), false);
  write(source, mavtRoot + 'references/case-runtime.md', inputs[mavtRoot + 'references/case-runtime.md']);
  assert.ok(buildDefaultPlugin({ repoRoot: source }).manifest.bundleId, 'retry publishes successfully');
});

test('default publication preserves a corrupt prior build for diagnosis', t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  buildPlugin({ repoRoot: source, outputRoot: output });
  write(output, 'plugins/mavt/runtime/mobile-ai-visual-test/references/case-runtime.md', 'changed by another operation');
  const before = inventory(output);
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /invalid|mismatch/i);
  assert.deepEqual(inventory(output), before);
  assert.equal(fs.existsSync(path.join(source, 'dist/archive')), false);
});

for (const point of ['empty-before-removal', 'empty-after-removal', 'missing-before-publish']) test(`first publication recovers at ${point} before rebuilding broken sources`, t => {
  const { source, output: reference } = fixture(t);
  buildPlugin({ repoRoot: source, outputRoot: reference });
  const expected = inventory(reference);
  const output = path.join(source, 'dist/mavt-marketplace');
  if (point.startsWith('empty')) fs.mkdirSync(output, { recursive: true });
  const crashed = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const rmdir = fs.rmdirSync, rename = fs.renameSync;
    fs.rmdirSync = function(filename) {
      if (filename === process.argv[2] && process.argv[3] === 'empty-before-removal') process.kill(process.pid, 'SIGKILL');
      const result = rmdir.apply(this, arguments);
      if (filename === process.argv[2] && process.argv[3] === 'empty-after-removal') process.kill(process.pid, 'SIGKILL');
      return result;
    };
    fs.renameSync = function(from, to) {
      if (to === process.argv[2] && process.argv[3] === 'missing-before-publish') process.kill(process.pid, 'SIGKILL');
      return rename.apply(this, arguments);
    };
    require(${JSON.stringify(path.join(repoRoot, 'build-plugin.js'))}).buildDefaultPlugin({repoRoot: process.argv[1]});
  `, source, output, point], { encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  fs.unlinkSync(path.join(source, mavtRoot + 'references/case-runtime.md'));
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /missing/i);
  assert.deepEqual(inventory(output), expected);
  assert.equal(fs.existsSync(path.join(source, 'dist/.mavt-marketplace.publish.json')), false);
});

test('default publication preserves an identified live publisher lock', t => {
  const { source } = fixture(t);
  const lock = path.join(source, 'dist/.mavt-marketplace.publish-lock');
  fs.mkdirSync(lock, { recursive: true });
  const owner = `owner-${crypto.randomUUID()}.json`;
  write(lock, owner, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
  const before = inventory(lock);
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /lock.*held/i);
  assert.deepEqual(inventory(lock), before);
});

for (const phase of ['release', 'reclaim']) test(`interruption while ${phase === 'release' ? 'releasing' : 'reclaiming'} a lock remains recoverable`, t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  buildPlugin({ repoRoot: source, outputRoot: output });
  const before = inventory(output);
  const lock = path.join(source, 'dist/.mavt-marketplace.publish-lock');
  const killAt = event => {
    const result = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      const rename = fs.renameSync, unlink = fs.unlinkSync;
      const lock = process.argv[2], event = process.argv[3];
      const ownerFile = file => path.dirname(file) === lock && path.basename(file).startsWith('owner-');
      fs.renameSync = function(from, to) {
        const result = rename.apply(this, arguments);
        if (event === 'journal' && to.endsWith('.publish.json') || event === 'release' && from === lock || event === 'reclaim' && ownerFile(from)) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      fs.unlinkSync = function(file) {
        const result = unlink.apply(this, arguments);
        if (event !== 'journal' && ownerFile(file)) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      require(${JSON.stringify(path.join(repoRoot, 'build-plugin.js'))}).buildDefaultPlugin({repoRoot: process.argv[1]});
    `, source, lock, event], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
  };
  if (phase === 'reclaim') killAt('journal');
  killAt(phase);
  fs.unlinkSync(path.join(source, mavtRoot + 'references/case-runtime.md'));
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /missing/i);
  assert.deepEqual(inventory(output), before);
  assert.equal(fs.existsSync(lock), false);
});

test('interrupted recursive cleanup cannot leave the recovery journal pointing at a partial candidate', t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  buildPlugin({ repoRoot: source, outputRoot: output });
  const expected = inventory(output);
  for (const point of ['journal', 'cleanup']) {
    const crashed = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      const rename = fs.renameSync, rm = fs.rmSync;
      fs.renameSync = function(from, to) {
        const result = rename.apply(this, arguments);
        if (process.argv[2] === 'journal' && to.endsWith('.publish.json')) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      fs.rmSync = function(filename) {
        if (process.argv[2] === 'cleanup' && /^\\.mavt-(?:publish-|retired-candidate-)/.test(path.basename(filename))) {
          // A recursive removal can be interrupted after any file prefix.
          fs.unlinkSync(path.join(filename, 'plugins/mavt/runtime/mobile-ai-visual-test/references/case-runtime.md'));
          process.kill(process.pid, 'SIGKILL');
        }
        return rm.apply(this, arguments);
      };
      require(${JSON.stringify(path.join(repoRoot, 'build-plugin.js'))}).buildDefaultPlugin({repoRoot: process.argv[1]});
    `, source, point], { encoding: 'utf8', timeout: 10000 });
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  }
  fs.unlinkSync(path.join(source, mavtRoot + 'references/case-runtime.md'));
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /missing/i);
  assert.deepEqual(inventory(output), expected);
  assert.equal(fs.existsSync(path.join(source, 'dist/.mavt-marketplace.publish.json')), false);
});

test('a failed default build leaves the active marketplace and its archive untouched', t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  buildPlugin({ repoRoot: source, outputRoot: output });
  const before = inventory(output);
  fs.unlinkSync(path.join(source, mavtRoot + 'references/case-runtime.md'));
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /missing/i);
  assert.deepEqual(inventory(output), before);
  assert.equal(fs.existsSync(path.join(source, 'dist/archive')), false);
});

test('default publication protects unknown user files and refuses a second publisher', t => {
  const { source } = fixture(t);
  const output = path.join(source, 'dist/mavt-marketplace');
  write(output, 'keep.txt', 'user data');
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /unrecognized|ordinary|build/i);
  assert.equal(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'user data');
  fs.mkdirSync(path.join(source, 'dist/.mavt-marketplace.publish-lock'));
  assert.throws(() => buildDefaultPlugin({ repoRoot: source }), /EEXIST|publish|lock/i);
  assert.equal(fs.existsSync(path.join(source, 'dist/.mavt-marketplace.publish-lock')), true);
});

test('CLI rejects relative output instead of interpreting a caller-dependent path', () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'build-plugin.js'), '--output', 'relative'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute/i);
});
