#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importSource } = require('../case/import-source');
const { sourceSha } = require('../execution/contracts/case-contract');
const { createTestWorkspace } = require('./current-fixture');
const {
  WORKSPACE_TYPE,
  ensureWorkspace,
  resolveExternalInput,
} = require('../lib/workspace');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function snapshot(root) {
  const values = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      values.push(`${path.relative(root, file)}:${stat.isDirectory() ? 'dir' : fs.readFileSync(file, 'utf8')}`);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return values;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-workspace-'));
const repo = path.resolve(__dirname, '../..');

const empty = path.join(temp, 'empty');
fs.mkdirSync(empty);
const initialized = ensureWorkspace(empty, { now: '2026-08-13T10:00:00.000Z' });
assert.strictEqual(initialized.initialized, true);
assert.strictEqual(initialized.marker.type, WORKSPACE_TYPE);
assert.strictEqual(initialized.marker.initializationState, 'READY');
for (const name of ['workspace.json', 'cases', 'knowledge', 'index.html', 'report-metadata.json']) assert.ok(fs.existsSync(path.join(empty, name)), name);
const emptyIndex = fs.readFileSync(path.join(empty, 'index.html'), 'utf8');
for (const text of ['移动端 AI 视觉测试', '测试执行总览', '三平台执行分布', '用例执行情况', '暂无用例。', '显示 0 / 0']) {
  assert.ok(emptyIndex.includes(text), text);
}
assert.strictEqual(emptyIndex.includes('暂无测试结果。'), false);
const emptyReportMetadata = JSON.parse(fs.readFileSync(path.join(empty, 'report-metadata.json'), 'utf8'));
assert.match(emptyReportMetadata.reportRendererSha, /^report-renderer-[0-9a-f]{16}$/);
assert.ok(emptyReportMetadata.rendererFiles.includes('scripts/report/index-renderer.js'));
for (const dependency of [
  'scripts/lib/execution-artifact-manifest.js',
  'scripts/lib/execution-lifecycle.js',
  'scripts/execution/contracts/case-contract.js',
  'scripts/lib/batch-contract.js',
]) assert.ok(emptyReportMetadata.rendererFiles.includes(dependency), dependency);
assert.strictEqual(fs.existsSync(path.join(empty, 'runs')), false);
assert.strictEqual(fs.existsSync(path.join(empty, 'flows')), false);

const dsStoreOnly = path.join(temp, 'ds-store-only');
fs.mkdirSync(dsStoreOnly);
write(path.join(dsStoreOnly, '.DS_Store'), 'ignored');
assert.strictEqual(ensureWorkspace(dsStoreOnly).initialized, true);
assert.ok(fs.existsSync(path.join(dsStoreOnly, '.DS_Store')));

const valid = path.join(temp, 'valid');
fs.mkdirSync(valid);
write(path.join(valid, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: WORKSPACE_TYPE, initializationState: 'READY' }));
write(path.join(valid, 'custom.txt'), 'preserve');
assert.strictEqual(ensureWorkspace(valid).initialized, false);
assert.strictEqual(fs.readFileSync(path.join(valid, 'custom.txt'), 'utf8'), 'preserve');

for (const [name, marker] of [
  ['broken-json', '{'],
  ['wrong-type', JSON.stringify({ schemaVersion: 1, type: 'other' })],
  ['unknown-schema', JSON.stringify({ schemaVersion: 99, type: WORKSPACE_TYPE })],
]) {
  const root = path.join(temp, name);
  fs.mkdirSync(root);
  write(path.join(root, 'workspace.json'), marker);
  write(path.join(root, 'keep.txt'), 'unchanged');
  const before = snapshot(root);
  expectCode(() => ensureWorkspace(root), 'WORKSPACE_INVALID');
  assert.deepStrictEqual(snapshot(root), before, `${name} must not be mutated`);
}

for (const name of ['ordinary-project', 'forged-shape']) {
  const root = path.join(temp, name);
  fs.mkdirSync(root);
  if (name === 'ordinary-project') write(path.join(root, 'package.json'), '{}');
  else {
    fs.mkdirSync(path.join(root, 'cases'));
    fs.mkdirSync(path.join(root, 'knowledge'));
    fs.mkdirSync(path.join(root, 'runs'));
    write(path.join(root, 'index.html'), 'fake');
  }
  const before = snapshot(root);
  expectCode(() => ensureWorkspace(root), 'WORKSPACE_INVALID');
  assert.deepStrictEqual(snapshot(root), before);
  const render = childProcess.spawnSync(process.execPath, ['scripts/report/render-index.js', root], { cwd: repo, encoding: 'utf8' });
  assert.notStrictEqual(render.status, 0);
  assert.match(render.stderr, /WORKSPACE_INVALID/);
  assert.deepStrictEqual(snapshot(root), before, 'report rendering must not initialize or mutate an invalid workspace');
}

const parent = path.join(temp, 'parent-marker');
const child = path.join(parent, 'child');
fs.mkdirSync(child, { recursive: true });
write(path.join(parent, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: WORKSPACE_TYPE, initializationState: 'READY' }));
write(path.join(child, 'file.txt'), 'not empty');
expectCode(() => ensureWorkspace(child), 'WORKSPACE_INVALID');

const interrupted = path.join(temp, 'interrupted');
fs.mkdirSync(interrupted);
assert.throws(() => ensureWorkspace(interrupted, { interruptAfterArtifacts: true }), /MAVT_WORKSPACE_INIT_INTERRUPTED/);
const interruptedMarker = JSON.parse(fs.readFileSync(path.join(interrupted, 'workspace.json'), 'utf8'));
assert.strictEqual(interruptedMarker.initializationState, 'INITIALIZING');
const resumed = ensureWorkspace(interrupted, { now: '2026-08-13T10:01:00.000Z' });
assert.strictEqual(resumed.resumedInitialization, true);
assert.strictEqual(resumed.marker.initializationState, 'READY');

const missingRoot = path.join(temp, 'missing');
expectCode(() => ensureWorkspace(missingRoot), 'WORKSPACE_INVALID');
const fileRoot = path.join(temp, 'file-root');
write(fileRoot, 'file');
expectCode(() => ensureWorkspace(fileRoot), 'WORKSPACE_INVALID');

process.env.MAVT_SELF_TEST = '1';
const importWorkspace = path.join(temp, 'import-workspace');
createTestWorkspace(importWorkspace);
const external = path.join(temp, 'external');
fs.mkdirSync(external);
const inputs = [
  ['plain.txt', '随便看看，没有固定格式。'],
  ['no-steps.md', '# 只有标题\n\n这里没有步骤列表。'],
  ['table.md', '| 操作 | 结果 |\n| --- | --- |\n| 任意内容 | 任意结果 |'],
  ['ambiguous.case', '可能检查一下当前页面'],
  ['input-value.md', '输入文字，但没有使用引号，也应接受。'],
];
for (const [inputIndex, [name, content]] of inputs.entries()) {
  const file = path.join(external, name);
  write(file, content);
  const imported = importSource(importWorkspace, file);
  assert.strictEqual(fs.readFileSync(imported.sourcePath, 'utf8'), content);
  assert.strictEqual(imported.caseJson.identity.title, path.basename(file, path.extname(file)));
  assert.strictEqual(imported.caseJson.identity.caseNo, String(inputIndex + 1).padStart(3, '0'));
  assert.strictEqual('steps' in imported.caseJson, false);
  assert.strictEqual('preconditions' in imported.caseJson, false);
  assert.strictEqual('globalRules' in imported.caseJson, false);
  assert.strictEqual(fs.existsSync(path.join(imported.caseDir, 'CONTEXT.html')), true);
  const sourceSignal = content.trim().split(/\r?\n/).filter(Boolean).pop().replace(/^\s*#+\s*/, '');
  assert.ok(fs.readFileSync(path.join(imported.caseDir, 'CONTEXT.html'), 'utf8').includes(sourceSignal));
  const indexHtml = fs.readFileSync(path.join(importWorkspace, 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('查看用例内容'));
  assert.ok(indexHtml.includes('data-case-filter="NOT_RUN"'));
  assert.strictEqual(indexHtml.includes('暂无平台执行记录'), false);
}

const refreshFile = path.join(external, 'refresh.md');
write(refreshFile, '第一次内容');
const first = importSource(importWorkspace, refreshFile);
write(refreshFile, '第二次内容');
const second = importSource(importWorkspace, refreshFile);
assert.strictEqual(first.caseDir, second.caseDir);
assert.strictEqual(first.caseJson.identity.caseNo, second.caseJson.identity.caseNo);
assert.notStrictEqual(first.caseJson.identity.sourceSha, second.caseJson.identity.sourceSha);
assert.strictEqual(fs.readFileSync(second.sourcePath, 'utf8'), '第二次内容');
assert.ok(fs.readFileSync(path.join(second.caseDir, 'CONTEXT.html'), 'utf8').includes('第二次内容'));
assert.strictEqual(fs.readFileSync(path.join(second.caseDir, 'CONTEXT.html'), 'utf8').includes('第一次内容'), false);

for (const stage of ['draft', 'source', 'case', 'report']) {
  const file = path.join(external, `interrupted-${stage}.md`);
  const frozenText = `中断阶段 ${stage} 的首次冻结内容`;
  write(file, frozenText);
  assert.throws(() => importSource(importWorkspace, file, { interruptAfter: stage }), /MAVT_CASE_IMPORT_INTERRUPTED/);
  write(file, `中断阶段 ${stage} 后被修改的外部内容`);
  const resumed = importSource(importWorkspace, file);
  assert.strictEqual(fs.readFileSync(resumed.sourcePath, 'utf8'), frozenText);
  assert.strictEqual(resumed.caseJson.identity.sourceSha, sourceSha(frozenText));
  assert.strictEqual(fs.existsSync(path.join(resumed.caseDir, 'case-import.draft.json')), false);
  assert.strictEqual(fs.existsSync(path.join(resumed.caseDir, 'CONTEXT.html')), true);
}

for (const [name, content] of [['empty.md', ''], ['blank.md', ' \n\t'], ['bom.md', '\ufeff \r\n\t']]) {
  const file = path.join(external, name);
  write(file, content);
  const before = snapshot(importWorkspace);
  assert.throws(() => importSource(importWorkspace, file), (error) => error?.code === 'CASE_INPUT_EMPTY');
  assert.deepStrictEqual(snapshot(importWorkspace), before, `${name} must not leave case artifacts`);
}
assert.throws(() => importSource(importWorkspace, path.join(external, 'missing.md')), (error) => error?.code === 'CASE_INPUT_UNREADABLE');

const absoluteInput = resolveExternalInput(path.join(external, 'plain.txt'), importWorkspace);
assert.strictEqual(absoluteInput, path.join(external, 'plain.txt'));
const relativeInput = resolveExternalInput('../external/plain.txt', importWorkspace);
assert.strictEqual(relativeInput, path.join(temp, 'external', 'plain.txt'));

const realWorkspace = path.join(temp, 'real-import-workspace');
fs.mkdirSync(realWorkspace);
write(path.join(realWorkspace, 'workspace.json'), JSON.stringify({ schemaVersion: 1, type: WORKSPACE_TYPE }));
assert.strictEqual(importSource(realWorkspace, path.join(external, 'plain.txt')).caseJson.identity.title, 'plain');
delete process.env.MAVT_SELF_TEST;
assert.throws(() => importSource(importWorkspace, path.join(external, 'plain.txt')), /test workspace is not available/);

fs.rmSync(temp, { recursive: true, force: true });
console.log('workspace passed');
