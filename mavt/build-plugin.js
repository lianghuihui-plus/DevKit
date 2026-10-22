#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_REPO = __dirname;
const MAVT = 'src/mobile-ai-visual-test';
const KNOWLEDGE = 'src/mavt-knowledge-manager';
const RELEASE_FILE_LIST = 'release-files.json';
const MAPPINGS = [
  [`${MAVT}/scripts`, 'runtime/mobile-ai-visual-test/scripts'],
  [`${MAVT}/prompts`, 'runtime/mobile-ai-visual-test/prompts'],
  [`${MAVT}/references`, 'runtime/mobile-ai-visual-test/references'],
  [`${KNOWLEDGE}/scripts`, 'runtime/mavt-knowledge-manager/scripts'],
  [`${KNOWLEDGE}/references`, 'runtime/mavt-knowledge-manager/references'],
  [`${KNOWLEDGE}/assets`, 'runtime/mavt-knowledge-manager/assets'],
  ['scripts', 'scripts'],
  ['hosts', 'hosts'],
  ['skills', 'skills'],
  ['.codex-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ['.mcp.json', '.mcp.json'],
];
const REQUIRED = [
  '.mcp.json',
  'scripts/mavt-entry.js',
  'scripts/mavt-mcp.js',
  `${MAVT}/scripts/mcp/management-service.js`,
  `${MAVT}/scripts/mcp/protocol.js`,
  `${MAVT}/scripts/mcp/bindings.js`,
  `${MAVT}/scripts/mcp/case-service.js`,
  `${MAVT}/scripts/mcp/host-capabilities.js`,
  `${MAVT}/scripts/mcp/worker-child.js`,
  `${MAVT}/scripts/mcp/worker-pool.js`,
  `${MAVT}/scripts/mcp/contract.js`,
  'hosts/codex/delegation.md',
  'hosts/codex/harness-requirements.json',
  ...['author-cases', 'run-tests', 'manage-knowledge']
    .flatMap((name) => [`skills/${name}/SKILL.md`, `skills/${name}/agents/openai.yaml`]),
  `${MAVT}/scripts/coordinator-agent.js`,
  `${MAVT}/scripts/lib/action-common.sh`,
  `${MAVT}/references/coordinator-principles.md`,
  `${KNOWLEDGE}/scripts/knowledge-manager.js`,
  `${KNOWLEDGE}/assets/knowledge-entry-template.md`,
  ...['AndroidManifest.xml', 'res/xml/method.xml',
    'src/mavt/android/ime/MavtInputMethodService.java', 'src/mavt/android/ime/MavtInputReceiver.java']
    .map((name) => `${MAVT}/scripts/platform/adapters/android/ime/${name}`),
  ...['android', 'ios', 'harmony'].map((platform) => `${MAVT}/scripts/platform/adapters/${platform}/action.sh`),
  `${MAVT}/scripts/platform/adapters/android/helper/ArtemisAccessibilityHelper.apk`,
  `${MAVT}/scripts/platform/adapters/android/helper/helper_manifest.json`,
];

function ordinaryStat(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Required build source is missing: ${filename}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in build inputs: ${filename}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Build input is not an ordinary file or directory: ${filename}`);
  return stat;
}

function checkSourcePath(repoRoot, relative) {
  let current = repoRoot;
  ordinaryStat(current);
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    ordinaryStat(current);
  }
}

function excluded(relative, includeTests) {
  const parts = relative.split('/');
  if (parts.some((name) => ['.git', '.DS_Store', '__MACOSX', 'node_modules', '.cache', 'coverage'].includes(name))) return true;
  if (/\.(zip|tmp|bak|swp)$|~$/i.test(parts.at(-1))) return true;
  return !includeTests && (parts.includes('tests') || parts.includes('__tests__') || /^(self-test\.[cm]?js|.+\.test\.[cm]?js)$/.test(parts.at(-1)));
}

function collect(repoRoot, sourceRelative, destination, includeTests, files) {
  const source = path.join(repoRoot, sourceRelative);
  const stat = ordinaryStat(source);
  if (stat.isDirectory()) {
    // Inspect excluded trees too: a symlink is an invalid build input, never an implicit omission.
    for (const name of fs.readdirSync(source).sort()) {
      collect(repoRoot, `${sourceRelative}/${name}`, `${destination}/${name}`, includeTests, files);
    }
  } else if (!excluded(destination, includeTests)) {
    files.push({ source, destination, mode: stat.mode & 0o777 });
  }
}

function collectMappings(repoRoot, includeTests, outputRoot) {
  const files = [];
  for (const [source, destination] of MAPPINGS) {
    const mappedRoot = path.join(repoRoot, source);
    if (outputRoot && (outputRoot === mappedRoot || outputRoot.startsWith(mappedRoot + path.sep))) {
      throw new Error(`Build output cannot be inside a source tree: ${mappedRoot}`);
    }
    checkSourcePath(repoRoot, source);
    collect(repoRoot, source, destination, includeTests, files);
  }
  return files;
}

function validateReleasePaths(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files) || !value.files.length) {
    throw new Error('Invalid release file list schema: require schemaVersion: 1 and a nonempty files array.');
  }
  const unique = new Set();
  for (const relative of value.files) {
    const parts = typeof relative === 'string' ? relative.split('/') : [];
    if (!parts.length || /[\\\x00-\x1f\x7f]/.test(relative) ||
        parts.some((part) => !part || part === '.' || part === '..') ||
        !MAPPINGS.some(([source, destination]) => source.endsWith('/plugin.json') || destination === '.mcp.json'
          ? relative === destination : relative.startsWith(destination + '/')) ||
        excluded(relative, false)) {
      throw new Error(`Invalid release file path: ${JSON.stringify(relative)}`);
    }
    if (unique.has(relative)) throw new Error(`Duplicate release file path: ${relative}`);
    unique.add(relative);
  }
  return unique;
}

function checkReleaseFileList(repoRoot, files) {
  checkSourcePath(repoRoot, RELEASE_FILE_LIST);
  const expected = validateReleasePaths(JSON.parse(fs.readFileSync(path.join(repoRoot, RELEASE_FILE_LIST), 'utf8')));
  // --include-tests may add regression files, but the production closure is unchanged.
  const actual = new Set(files.filter((file) => !excluded(file.destination, false)).map((file) => file.destination));
  const missing = [...expected].filter((relative) => !actual.has(relative));
  const unexpected = [...actual].filter((relative) => !expected.has(relative));
  if (missing.length || unexpected.length) {
    throw new Error(`Release file list mismatch.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${unexpected.length ? ` Unexpected: ${unexpected.join(', ')}.` : ''} Restore missing inputs; for intended source changes explicitly run node build-plugin.js --write-file-list and review the release-files.json diff.`);
  }
}

function writeReleaseFileList({ repoRoot = DEFAULT_REPO } = {}) {
  repoRoot = path.resolve(repoRoot);
  const files = collectMappings(repoRoot, false)
    .map((file) => file.destination)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const value = { schemaVersion: 1, files };
  validateReleasePaths(value);
  ordinaryStat(repoRoot);
  const filename = path.join(repoRoot, RELEASE_FILE_LIST);
  // existsSync follows links and reports false for dangling links; lstat must see them.
  let destinationExists = false;
  try { fs.lstatSync(filename); destinationExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destinationExists && !ordinaryStat(filename).isFile()) throw new Error(`Release file list must be an ordinary file: ${filename}`);
  writeJson(filename, value);
  return { filename, count: files.length };
}

function inspectDestination(outputRoot) {
  try {
    const stat = fs.lstatSync(outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(outputRoot).length) {
      throw new Error(`Build output must be nonexistent or an empty ordinary directory: ${outputRoot}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
}

function buildPlugin({ repoRoot = DEFAULT_REPO, outputRoot, includeTests = false } = {}) {
  if (!outputRoot || !path.isAbsolute(outputRoot)) throw new Error('Provide an absolute outputRoot (--output /absolute/path).');
  repoRoot = path.resolve(repoRoot);
  outputRoot = path.resolve(outputRoot);
  inspectDestination(outputRoot);
  const files = collectMappings(repoRoot, includeTests, outputRoot);
  checkReleaseFileList(repoRoot, files);
  for (const relative of REQUIRED) {
    checkSourcePath(repoRoot, relative);
    if (!ordinaryStat(path.join(repoRoot, relative)).isFile()) throw new Error(`Required build source must be a file: ${relative}`);
  }
  const helperRoot = path.join(repoRoot, MAVT, 'scripts/platform/adapters/android/helper');
  const helper = JSON.parse(fs.readFileSync(path.join(helperRoot, 'helper_manifest.json'), 'utf8'));
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(helperRoot, 'ArtemisAccessibilityHelper.apk'))).digest('hex');
  if (actualHash !== helper.sha256) throw new Error('Android Helper APK hash does not match helper_manifest.json. Restore the bundled APK and matching manifest.');
  const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, '.codex-plugin/plugin.json'), 'utf8'));
  if (plugin.name !== 'mavt' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(plugin.version) || plugin.skills !== './skills/' || plugin.mcpServers !== './.mcp.json') {
    throw new Error('Invalid MAVT plugin manifest: require name, semantic version, ./skills/ and ./.mcp.json entries.');
  }
  const registration = JSON.parse(fs.readFileSync(path.join(repoRoot, '.mcp.json'), 'utf8'));
  if (Object.keys(registration).join(',') !== 'mavt' || registration.mavt.command !== 'node' ||
    JSON.stringify(registration.mavt.args) !== JSON.stringify(['./scripts/mavt-mcp.js']) || registration.mavt.cwd !== '.') {
    throw new Error('Invalid MAVT MCP registration: require a plugin-relative Node entry and root cwd.');
  }
  const { createManifest, verifyBundle } = require('./src/mobile-ai-visual-test/scripts/lib/runtime-bundle');
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outputRoot), '.mavt-build-'));
  try {
    const pluginRoot = path.join(staging, 'plugins/mavt');
    for (const file of files) {
      const target = path.join(pluginRoot, file.destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, file.mode);
    }
    writeJson(path.join(pluginRoot, 'runtime/mobile-ai-visual-test/mcp-transport.json'),
      { schemaVersion: 1, transport: 'MCP' });
    const manifest = createManifest(pluginRoot, plugin.version);
    writeJson(path.join(pluginRoot, 'bundle.manifest.json'), manifest);
    verifyBundle(pluginRoot, manifest.bundleId);
    writeJson(path.join(staging, '.agents/plugins/marketplace.json'), {
      name: 'mavt-local', interface: { displayName: 'MAVT Local' },
      plugins: [{
        name: 'mavt', source: { source: 'local', path: './plugins/mavt' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools',
      }],
    });
    inspectDestination(outputRoot);
    if (fs.existsSync(outputRoot)) fs.rmdirSync(outputRoot);
    fs.renameSync(staging, outputRoot);
    return { marketplaceRoot: outputRoot, pluginRoot: path.join(outputRoot, 'plugins/mavt'), manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--write-file-list') {
    process.stdout.write(JSON.stringify(writeReleaseFileList()) + '\n');
    return;
  }
  let outputRoot = path.join(DEFAULT_REPO, 'dist/mavt-marketplace');
  let includeTests = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output' && argv[index + 1]) outputRoot = argv[++index];
    else if (argv[index] === '--include-tests') includeTests = true;
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}. Usage: node build-plugin.js --output /absolute/path [--include-tests]`);
  }
  const result = buildPlugin({ outputRoot, includeTests });
  process.stdout.write(JSON.stringify({ marketplaceRoot: result.marketplaceRoot, pluginRoot: result.pluginRoot, bundleId: result.manifest.bundleId }) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`MAVT build failed: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { buildPlugin, writeReleaseFileList };
