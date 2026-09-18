#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillRoot = path.resolve(__dirname, '../..');
const cli = path.join(skillRoot, 'scripts', 'knowledge-manager.js');

function entry(id) {
  return `# ${id} 页面规则

## 适用范围
- App: com.example.test
- Platform: harmony

## 可观察现象
首页中的 Nemo 分类入口没有展示，但 Kids 分类正常可见。

## 结论与处理建议
该现象是已确认的平台差异。

## 追溯信息
产品确认，2026-09-18。
`;
}

function invoke(args) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: skillRoot,
    encoding: 'utf8',
  });
}

function run(args) {
  const result = invoke(args);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, '');
  return JSON.parse(result.stdout);
}

function runFailure(args) {
  const result = invoke(args);
  assert.strictEqual(result.status, 2, result.stdout);
  assert.strictEqual(result.stdout, '');
  return JSON.parse(result.stderr);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-knowledge-cli-'));
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(path.join(workspace, 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'workspace.json'), `${JSON.stringify({
  schemaVersion: 1,
  type: 'mobile-ai-visual-test-workspace',
  initializationState: 'READY',
}, null, 2)}\n`);

const inspected = run(['inspect', '--workspace', workspace]);
assert.strictEqual(inspected.status, 'VALID');
assert.strictEqual(inspected.entryCount, 0);
assert.deepStrictEqual(run(['list', '--workspace', workspace]).entries, []);
assert.strictEqual(run(['validate', '--workspace', workspace]).status, 'VALID');

const draft = path.join(temp, 'draft.md');
const request = path.join(temp, 'request.json');
fs.writeFileSync(draft, entry('K-cli-001'));
fs.writeFileSync(request, `${JSON.stringify({
  schemaVersion: 1,
  reason: 'CLI 新增测试',
  operations: [{ type: 'ADD', draftPath: draft }],
}, null, 2)}\n`);

const prepared = run(['prepare', '--workspace', workspace, '--request', request]);
assert.strictEqual(prepared.status, 'PREPARED');
assert.match(prepared.planHash, /^[a-f0-9]{64}$/);
const applied = run([
  'apply', '--workspace', workspace, '--request', request, '--plan-hash', prepared.planHash,
]);
assert.strictEqual(applied.status, 'APPLIED');
assert.strictEqual(applied.changes[0].entryId, 'K-cli-001');
assert.deepStrictEqual(run(['list', '--workspace', workspace]).entries.map((item) => item.entryId), ['K-cli-001']);
assert.match(run(['show', '--workspace', workspace, '--entry-id', 'K-cli-001']).content, /^# K-cli-001/);
assert.strictEqual(run(['validate', '--workspace', workspace]).entryCount, 1);

assert.strictEqual(runFailure(['unknown']).code, 'COMMAND_INVALID');
assert.strictEqual(runFailure(['inspect']).code, 'ARGUMENT_REQUIRED');
assert.strictEqual(runFailure(['inspect', '--workspace', workspace, '--workspace', workspace]).code, 'ARGUMENT_DUPLICATE');
assert.strictEqual(runFailure(['inspect', '--workspace', workspace, '--extra', 'x']).code, 'ARGUMENT_UNKNOWN');
assert.strictEqual(runFailure(['show', '--workspace', workspace]).code, 'ARGUMENT_REQUIRED');

fs.rmSync(temp, { recursive: true, force: true });
console.log('knowledge manager CLI passed');
