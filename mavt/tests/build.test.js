'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { buildPlugin, writeReleaseFileList } = require('../build-plugin');

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
  assert.equal(first.manifest.pluginVersion, '0.2.0');
  const files = inventory(first.pluginRoot).map((entry) => entry.path);
  assert.deepEqual(files, [...FIXTURE_RELEASE_FILES.filter(relative =>
    relative !== '.mcp.json' && relative !== 'scripts/mavt-mcp.js' &&
    !relative.startsWith('runtime/mobile-ai-visual-test/scripts/mcp/')), 'bundle.manifest.json'].sort());
  const apk = path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test', helper, 'ArtemisAccessibilityHelper.apk');
  assert.deepEqual(fs.readFileSync(apk), inputs[mavtRoot + helper + 'ArtemisAccessibilityHelper.apk']);
  const executable = path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/lib/action-common.sh');
  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  const index = JSON.parse(fs.readFileSync(path.join(output, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(index.name, 'mavt-local');
  assert.equal(path.resolve(output, index.plugins[0].source.path), first.pluginRoot);
  const plugin = JSON.parse(fs.readFileSync(path.join(first.pluginRoot, '.codex-plugin/plugin.json')));
  assert.equal(Object.hasOwn(plugin, 'mcpServers'), false, 'ordinary install must not auto-register the MCP catalog');
  assert.equal(fs.existsSync(path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test/mcp-preview.json')), false);
  assert.equal(fs.existsSync(path.join(first.pluginRoot, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(first.pluginRoot, 'scripts/mavt-mcp.js')), false);
  assert.equal(fs.existsSync(path.join(first.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/mcp')), false);
});

test('explicit MCP preview registers the relocatable server and pins the preview marker', t => {
  const { source, temp } = fixture(t);
  const output = path.join(temp, 'preview-output');
  const built = buildPlugin({ repoRoot: source, outputRoot: output, mcpPreview: true });
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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'runtime/mobile-ai-visual-test/mcp-preview.json'))),
    { schemaVersion: 1, mcpPreview: true });
  assert.notEqual(built.manifest.bundleId, buildPlugin({ repoRoot: source, outputRoot: path.join(temp, 'ordinary') }).manifest.bundleId);
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

test('CLI rejects relative output instead of interpreting a caller-dependent path', () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'build-plugin.js'), '--output', 'relative'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute/i);
});
