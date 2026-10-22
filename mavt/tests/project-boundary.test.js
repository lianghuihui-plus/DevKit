'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

test('MAVT owns complete runtime and knowledge sources within one project', () => {
  for (const relative of [
    'src/mobile-ai-visual-test/SKILL.md',
    'src/mobile-ai-visual-test/README.md',
    'src/mobile-ai-visual-test/scripts/self-test.js',
    'src/mobile-ai-visual-test/scripts/tests/runtime-binding.test.js',
    'src/mobile-ai-visual-test/prompts/case-agent.md',
    'src/mobile-ai-visual-test/references/coordinator-principles.md',
    'src/mavt-knowledge-manager/SKILL.md',
    'src/mavt-knowledge-manager/scripts/knowledge-manager.js',
    'src/mavt-knowledge-manager/scripts/self-test.js',
    'src/mavt-knowledge-manager/scripts/tests/mavt-compatibility.test.js',
    'src/mavt-knowledge-manager/references/workflow.md',
    'src/mavt-knowledge-manager/assets/knowledge-entry-template.md',
    'package.json',
  ]) {
    assert.ok(fs.existsSync(path.join(projectRoot, relative)), `Project-local source missing: ${relative}`);
  }
});

test('relocating only the project preserves build, knowledge regression and installed entry', { timeout: 120000 }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-project-isolation-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, '独立 MAVT');
  fs.cpSync(projectRoot, source, {
    recursive: true,
    filter: filename => !['dist', '.git', 'node_modules', 'verification'].includes(path.basename(filename)),
  });
  const marketplace = path.join(temp, 'marketplace');
  const run = (relative, args = []) => {
    const result = spawnSync(process.execPath, [path.join(source, relative), ...args], {
      cwd: temp, encoding: 'utf8', timeout: 90000,
    });
    assert.equal(result.status, 0, `${relative}\n${result.error || ''}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const built = JSON.parse(run('build-plugin.js', ['--output', marketplace]));
  assert.equal(built.pluginRoot, path.join(marketplace, 'plugins/mavt'));
  run('src/mavt-knowledge-manager/scripts/self-test.js');
  run('src/mobile-ai-visual-test/scripts/build-agent-facing-docs.js', ['--check']);
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  const smoke = JSON.parse(run('tests/installed-smoke.js', [built.pluginRoot, workspace]));
  assert.equal(smoke.status, 'PASS');
  assert.equal(smoke.bundleId, built.bundleId);
});
