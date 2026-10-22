'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildPlugin } = require('../build-plugin');
const sourceRoot = path.resolve(__dirname, '..');
const runtimeSource = path.join(sourceRoot, 'src/mobile-ai-visual-test');
const { importDrafts } = require(path.join(runtimeSource, 'scripts/case/import-drafts'));
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-plugin-integration-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const built = buildPlugin({ outputRoot: path.join(temp, '安装 A') });
  const workspace = path.join(temp, '测试 空间');
  fs.mkdirSync(workspace);
  const cli = (...args) => invoke(path.join(built.pluginRoot, 'scripts/mavt-entry.js'), args);
  return { ...built, temp, workspace, cli };
}
function invoke(script, args, input) {
  const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input) });
  assert.ok(child.stdout.trim(), child.stderr);
  return { code: child.status, data: JSON.parse(child.stdout) };
}
function prepare(runtimeRoot, workspace, caseNos = ['001']) {
  return invoke(path.join(runtimeRoot, 'scripts/coordinator-agent.js'), ['--workspace', workspace], { operation: 'prepareRun', input: { caseNos } });
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().flatMap(relative => {
    const file = path.join(root, relative);
    return fs.statSync(file).isFile() ? [[relative, fs.readFileSync(file).toString('base64')]] : [];
  });
}
test('doctor is read-only and knowledge cannot initialize; workspace initializes before pinning', t => {
  const f = fixture(t);
  const before = snapshot(f.workspace);
  assert.equal(f.cli('doctor', '--workspace', f.workspace).data.status, 'FAILED');
  assert.deepEqual(snapshot(f.workspace), before);
  assert.equal(f.cli('knowledge', '--workspace', f.workspace).code, 2);
  assert.deepEqual(snapshot(f.workspace), before);
  const opened = f.cli('workspace', '--cwd', f.workspace);
  assert.equal(opened.code, 0);
  assert.equal(opened.data.marker.initializationState, 'READY');
  assert.equal(opened.data.bundleId, f.manifest.bundleId);
  assert.ok(opened.data.coordinatorFacade.command.includes(opened.data.runtimeRoot));
  assert.equal(opened.data.coordinatorFacade.documentationRoot, opened.data.runtimeRoot);
  assert.equal(fs.existsSync(path.join(opened.data.runtimeRoot, 'SKILL.md')), false);
  const stable = snapshot(f.workspace);
  assert.equal(f.cli('doctor', '--workspace', f.workspace).code, 0);
  assert.deepEqual(snapshot(f.workspace), stable);
});

test('pinned Run resumes/cancels after A disappears and B installed; commands cannot switch code', t => {
  const f = fixture(t);
  const opened = f.cli('workspace', '--cwd', f.workspace).data;
  importDrafts(f.workspace, { cases: [{ sourceLocator: '/fixture/a.md#1', title: '原型用例', sourceText: '打开目标页面，检查标题。' }] });
  const started = prepare(opened.runtimeRoot, f.workspace);
  assert.equal(started.code, 0);
  assert.equal(started.data.result.outcome, 'NEED_USER_CONFIRMATION');
  const runs = fs.readdirSync(path.join(f.workspace, 'runs'));
  assert.equal(runs.length, 1);
  const run = runs[0];
  const statePath = path.join(f.workspace, 'runs', run, 'coordinator-state.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  assert.equal(state.runtimeBindingRequired, true);
  const builtB = buildPlugin({ outputRoot: path.join(f.temp, '安装 B') });
  // Change actual code + profile in a disposable publisher tree, then reseal it.
  fs.appendFileSync(path.join(builtB.pluginRoot, 'runtime/mobile-ai-visual-test/scripts/case-runtime/runtime-core.js'), '\n// version B probe\n');
  fs.appendFileSync(path.join(builtB.pluginRoot, 'hosts/codex/delegation.md'), '\nVersion B\n');
  const { createManifest } = require(path.join(runtimeSource, 'scripts/lib/runtime-bundle'));
  const manifestB = createManifest(builtB.pluginRoot, '0.1.1');
  fs.writeFileSync(path.join(builtB.pluginRoot, 'bundle.manifest.json'), JSON.stringify(manifestB));
  fs.renameSync(f.pluginRoot, f.pluginRoot + '-gone');
  const entryB = path.join(builtB.pluginRoot, 'scripts/mavt-entry.js');
  const resume = invoke(entryB, ['resume', '--workspace', f.workspace, '--run', run]);
  assert.equal(resume.code, 0);
  assert.equal(resume.data.bundleId, opened.bundleId);
  assert.equal(resume.data.coordinatorFacade.command, state.command);
  const b = invoke(entryB, ['workspace', '--cwd', f.workspace]).data;
  assert.notEqual(b.bundleId, opened.bundleId);
  const before = snapshot(path.dirname(statePath));
  const wrong = invoke(path.join(b.runtimeRoot, 'scripts/coordinator-agent.js'), ['--state', statePath], { operation: 'advanceRun', input: {} });
  assert.equal(wrong.code, 2);
  assert.deepEqual(snapshot(path.dirname(statePath)), before, 'wrong runtime must not write diagnostics or telemetry');
  const cancelled = invoke(path.join(opened.runtimeRoot, 'scripts/coordinator-agent.js'), ['--state', statePath], { operation: 'cancelRun', input: { reason: 'user requested no device test' } });
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.data.data.content.runOutcome, 'CANCELLED');
  const resumed = invoke(entryB, ['resume', '--workspace', f.workspace, '--run', run]);
  assert.equal(resumed.code, 0);
  // Missing binding must also reject original commands, even malformed input.
  fs.unlinkSync(path.join(path.dirname(statePath), 'runtime-binding.json'));
  const missingBefore = snapshot(path.dirname(statePath));
  const missing = invoke(path.join(opened.runtimeRoot, 'scripts/coordinator-agent.js'), ['--state', statePath], { operation: 'advanceRun', input: {} });
  assert.equal(missing.code, 2);
  assert.deepEqual(snapshot(path.dirname(statePath)), missingBefore);
  assert.equal(invoke(entryB, ['resume', '--workspace', f.workspace, '--run', run]).data.code, 'MAVT_RUNTIME_BINDING_INVALID');
});

test('multiple Runs require a choice; abandoned staging is diagnostic only', t => {
  const f = fixture(t);
  const opened = f.cli('workspace', '--cwd', f.workspace).data;
  importDrafts(f.workspace, { cases: [{ sourceLocator: '/fixture/a.md#1', title: '用例', sourceText: '检查标题。' }] });
  assert.equal(prepare(opened.runtimeRoot, f.workspace).code, 0);
  assert.equal(prepare(opened.runtimeRoot, f.workspace).code, 0);
  const res = f.cli('resume', '--workspace', f.workspace);
  assert.equal(res.data.outcome, 'NEED_RUN_SELECTION');
  assert.equal(res.data.candidates.length, 2);
  fs.mkdirSync(path.join(f.workspace, '.mavt/run-staging/run-abandoned'));
  const before = snapshot(f.workspace);
  const doc = f.cli('doctor', '--workspace', f.workspace);
  assert.equal(doc.data.staging.runs.includes('run-abandoned'), true);
  assert.deepEqual(snapshot(f.workspace), before);
});
test('parallel snapshot publishers converge on one complete bundle and allow safe lock retries', async t => {
  const f = fixture(t);
  require(path.join(runtimeSource, 'scripts/lib/workspace')).ensureWorkspace(f.workspace);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.pluginRoot, 'scripts/mavt-entry.js'), 'workspace', '--cwd', f.workspace]);
    let output = '';
    let stderr = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, data: JSON.parse(output), stderr }); }
      catch (error) { reject(new Error(`${error.message}: ${stderr}`)); }
    });
  });
  const results = await Promise.all(Array.from({ length: 6 }, run));
  assert.ok(results.some(result => result.code === 0));
  for (const result of results) {
    if (result.code !== 0) {
      assert.equal(result.data.code, 'EXECUTION_LOCKED');
      assert.equal((await run()).code, 0);
    } else assert.equal(result.data.bundleId, f.manifest.bundleId);
  }
  const published = fs.readdirSync(path.join(f.workspace, '.mavt/runtime-bundles'));
  assert.deepEqual(published, [f.manifest.bundleId]);
});
