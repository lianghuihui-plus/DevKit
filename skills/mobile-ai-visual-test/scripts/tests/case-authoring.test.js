#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importDrafts } = require('../case/import-drafts');
const { createTestWorkspace } = require('./current-fixture');

function workspaceSnapshot(root) {
  const casesRoot = path.join(root, 'cases');
  if (!fs.existsSync(casesRoot)) return [];
  return fs.readdirSync(casesRoot).sort().map((name) => {
    const caseDir = path.join(casesRoot, name);
    return {
      name,
      caseJson: JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8')),
      source: fs.readFileSync(path.join(caseDir, 'source.md'), 'utf8'),
    };
  });
}

process.env.MAVT_SELF_TEST = '1';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mavt-case-authoring-'));
const workspace = path.join(temp, 'workspace');
createTestWorkspace(workspace);

const imported = importDrafts(workspace, {
  cases: [
    {
      sourceLocator: '/inputs/cases.xlsx#Login!R2',
      title: '账号密码登录成功',
      sourceText: '输入有效账号和密码，点击登录，首页应正常显示。',
    },
    {
      sourceLocator: '/inputs/cases.xlsx#Login!R3:R5',
      title: '密码错误时提示失败',
      sourceText: '输入有效账号和错误密码。\n\n点击登录。\n\n应显示密码错误提示。',
    },
  ],
});

assert.strictEqual(imported.cases.length, 2);
assert.deepStrictEqual(imported.cases.map((item) => item.caseJson.identity.caseNo), ['001', '002']);
assert.strictEqual(new Set(imported.cases.map((item) => item.caseJson.identity.caseKey)).size, 2);
assert.deepStrictEqual(imported.cases.map((item) => item.caseJson.identity.importSource), [
  { kind: 'agent-authored', path: '/inputs/cases.xlsx#Login!R2' },
  { kind: 'agent-authored', path: '/inputs/cases.xlsx#Login!R3:R5' },
]);
assert.strictEqual(imported.cases[1].caseJson.identity.title, '密码错误时提示失败');
assert.strictEqual(fs.readFileSync(imported.cases[1].sourcePath, 'utf8'), '输入有效账号和错误密码。\n\n点击登录。\n\n应显示密码错误提示。');

const reimported = importDrafts(workspace, {
  cases: [{
    sourceLocator: '/inputs/cases.xlsx#Login!R2',
    title: '账号密码登录',
    sourceText: '输入有效账号和密码并登录，确认首页正常显示。',
  }],
});
assert.strictEqual(reimported.cases.length, 1);
assert.strictEqual(reimported.cases[0].caseDir, imported.cases[0].caseDir);
assert.strictEqual(reimported.cases[0].caseJson.identity.caseNo, '001');
assert.strictEqual(reimported.cases[0].caseJson.identity.caseKey, imported.cases[0].caseJson.identity.caseKey);
assert.strictEqual(reimported.cases[0].caseJson.identity.title, '账号密码登录');
assert.strictEqual(fs.readFileSync(reimported.cases[0].sourcePath, 'utf8'), '输入有效账号和密码并登录，确认首页正常显示。');

const mixed = importDrafts(workspace, {
  cases: [{
    sourceLocator: '/inputs/spec.pdf#pages=3-4+/inputs/notes.md#登录补充',
    title: '组合来源用例',
    sourceText: '综合产品说明和补充规则，验证登录后的页面。',
  }],
});
assert.strictEqual(mixed.cases[0].caseJson.identity.caseNo, '003');
assert.strictEqual(mixed.cases[0].caseJson.identity.importSource.kind, 'agent-authored');

const cliWorkspace = path.join(temp, 'cli-workspace');
createTestWorkspace(cliWorkspace);
const requestFile = path.join(temp, 'authoring-request.json');
fs.writeFileSync(requestFile, JSON.stringify({
  cases: [{
    sourceLocator: '/inputs/free-form.pdf#section=account-removal',
    title: '注销账号',
    sourceText: '进入设置并注销账号，确认完成后返回登录页。',
  }],
}));
const cli = childProcess.spawnSync(process.execPath, [
  'scripts/import-cases.js', '--workspace', cliWorkspace, '--request-file', requestFile,
], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: process.env });
assert.strictEqual(cli.status, 0, cli.stderr);
assert.strictEqual(JSON.parse(cli.stdout).cases.length, 1);

const malformedRequestFile = path.join(temp, 'malformed-authoring-request.json');
fs.writeFileSync(malformedRequestFile, JSON.stringify({
  cases: [{ sourceLocator: '/inputs/cases.csv#R2', sourceText: '缺少标题' }],
}));
const malformedCli = childProcess.spawnSync(process.execPath, [
  'scripts/import-cases.js', '--workspace', cliWorkspace, '--request-file', malformedRequestFile,
], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: process.env });
assert.strictEqual(malformedCli.status, 2);
const malformedResponse = JSON.parse(malformedCli.stderr);
assert.deepStrictEqual(malformedResponse.issues, [{
  fieldPath: 'cases[0].title', expected: 'non-empty string', code: 'REQUIRED_FIELD_MISSING',
}]);

const invalidCli = childProcess.spawnSync(process.execPath, ['scripts/import-cases.js'], {
  cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: process.env,
});
assert.strictEqual(invalidCli.status, 2);
const invalidCliResponse = JSON.parse(invalidCli.stderr);
assert.match(invalidCliResponse.usage, /--request-file/);
assert.ok(invalidCliResponse.example.includes('scripts/import-cases.js'));

const beforeInvalid = workspaceSnapshot(workspace);
for (const request of [
  { cases: [] },
  { cases: [{ sourceLocator: 'same', title: 'A', sourceText: 'A' }, { sourceLocator: 'same', title: 'B', sourceText: 'B' }] },
  { cases: [{ sourceLocator: 'missing-title', title: '', sourceText: 'A' }] },
  { cases: [{ sourceLocator: 'blank-source', title: 'A', sourceText: '  \n' }] },
  { cases: [{ sourceLocator: 'unknown-field', title: 'A', sourceText: 'A', steps: [] }] },
]) {
  assert.throws(() => importDrafts(workspace, request), (error) => error?.code === 'CASE_AUTHORING_INPUT_INVALID');
  assert.deepStrictEqual(workspaceSnapshot(workspace), beforeInvalid, 'invalid authoring requests must not mutate cases');
}

fs.rmSync(temp, { recursive: true, force: true });
delete process.env.MAVT_SELF_TEST;
console.log('case authoring passed');
