#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { formatDuration, displayFailureCode } = require('./common');

const repo = path.resolve(__dirname, '..');

function run(cmd, args, options = {}) {
  return childProcess.execFileSync(cmd, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runAllowFailure(cmd, args, options = {}) {
  try {
    return {
      status: 0,
      stdout: run(cmd, args, options),
      stderr: '',
    };
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function treeSha256(root) {
  const hash = crypto.createHash('sha256');
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) {
        walk(file);
      } else {
        hash.update(path.relative(root, file));
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
      }
    }
  }
  walk(root);
  return hash.digest('hex');
}

function assertLocalTime(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.ok(!value.endsWith('Z'));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'havt-self-test-'));
const workspace = path.join(tmp, 'workspace');
const sourceRoot = path.join(tmp, 'source');
fs.mkdirSync(workspace);
assert.strictEqual(formatDuration(850), '850ms');
assert.strictEqual(formatDuration(12300), '12s');
assert.strictEqual(formatDuration(200000), '3m 20s');
assert.strictEqual(formatDuration(3720000), '1h 2m');
const caseFile = path.join(sourceRoot, 'cases', 'login.md');

write(caseFile, `# 登录成功

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
2. 点击「登录」。
3. 开启「通知」开关。
4. 输入验证码 123456。
5. 预期看到成功。
`);

const resolved = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', path.join(sourceRoot, 'cases'), '--cwd', workspace]));
assert.deepStrictEqual(resolved.markdownFiles, [caseFile]);
assert.deepStrictEqual(resolved.existingCases, []);
const deprecatedResolveCases = runAllowFailure('node', ['scripts/resolve-cases.js', path.join(sourceRoot, 'cases')]);
assert.notStrictEqual(deprecatedResolveCases.status, 0);
assert.ok(deprecatedResolveCases.stderr.includes('已废弃'));

const invalidWorkspace = path.join(tmp, 'invalid-workspace');
write(path.join(invalidWorkspace, 'README.md'), '# 普通目录\n');
const invalidWorkspaceParse = runAllowFailure('node', ['scripts/parse-case.js', caseFile, '--cwd', invalidWorkspace]);
assert.notStrictEqual(invalidWorkspaceParse.status, 0);
assert.ok(invalidWorkspaceParse.stderr.includes('不是 mobile-ai-visual-test 工作空间'));
const invalidWorkspaceResolve = runAllowFailure('node', ['scripts/resolve-execution-targets.js', caseFile, '--cwd', invalidWorkspace]);
assert.notStrictEqual(invalidWorkspaceResolve.status, 0);
assert.ok(invalidWorkspaceResolve.stderr.includes('不是 mobile-ai-visual-test 工作空间'));

const legacyWorkspaceRoot = path.join(tmp, 'legacy-ai-visual-test');
write(path.join(legacyWorkspaceRoot, 'cases', 'C001__旧工作空间__ck-legacy', 'case.json'), `${JSON.stringify({
  schemaVersion: 1,
  identity: {
    caseNo: 'C001',
    caseKey: 'ck-legacy',
    title: '旧工作空间',
    sourceSha1: 'source-legacy',
    sourceUpdatedAt: '2026-01-01T00:00:00.000+08:00',
  },
  preconditions: [],
  steps: [],
  globalRules: [],
}, null, 2)}\n`);
const legacyWorkspaceIndex = run('node', ['scripts/render-index.js', legacyWorkspaceRoot]).trim();
assert.strictEqual(legacyWorkspaceIndex, path.join(legacyWorkspaceRoot, 'index.html'));
assert.ok(fs.existsSync(path.join(legacyWorkspaceRoot, 'workspace.json')));

const parsed = JSON.parse(run('node', ['scripts/parse-case.js', caseFile, '--cwd', workspace]));
assert.ok(parsed.caseDir.includes('C001__登录成功__ck-'));
assert.ok(fs.existsSync(parsed.indexHtml));
assert.strictEqual(parsed.indexHtml, path.join(workspace, 'index.html'));
assert.ok(fs.existsSync(path.join(workspace, 'workspace.json')));
assert.ok(!fs.existsSync(path.join(workspace, 'ai-visual-test')));
const resolvedParent = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', tmp, '--cwd', workspace]));
assert.deepStrictEqual(resolvedParent.markdownFiles, [caseFile]);
let indexHtml = fs.readFileSync(parsed.indexHtml, 'utf8');
assert.ok(indexHtml.includes('AI 视觉测试总览'));
assert.ok(indexHtml.includes('登录成功'));
assert.ok(indexHtml.includes('C001'));
assert.ok(indexHtml.includes('CONTEXT.html'));
assert.ok(fs.existsSync(path.join(parsed.caseDir, 'source.md')));
let caseJson = json(path.join(parsed.caseDir, 'case.json'));
assert.strictEqual(caseJson.identity.caseNo, 'C001');
assert.strictEqual(caseJson.identity.sourceSnapshot, 'source.md');
assertLocalTime(caseJson.identity.sourceUpdatedAt);
assert.strictEqual(caseJson.steps[1].goal, 'tap');
assert.strictEqual(caseJson.steps[2].goal, 'toggle');
assert.strictEqual(caseJson.steps[2].target, '通知');
assert.strictEqual(caseJson.steps[3].goal, 'input_text');
assert.strictEqual(caseJson.steps[4].kind, 'assertion');

const noLoginFile = path.join(sourceRoot, 'cases', 'no-login.md');
write(noLoginFile, `# 未登录前置条件测试

## 前置条件
- 未登录。

## 步骤
1. 预期看到登录按钮。
`);
const noLoginParsed = JSON.parse(run('node', ['scripts/parse-case.js', noLoginFile, '--cwd', workspace]));
const noLoginCase = json(path.join(noLoginParsed.caseDir, 'case.json'));
assert.ok(noLoginParsed.caseDir.includes('C002__未登录前置条件测试__ck-'));
assert.strictEqual(noLoginCase.identity.caseNo, 'C002');
assert.strictEqual(noLoginCase.preconditions[0].checkMode, 'auto_check');

const resolvedByNo = JSON.parse(run('node', ['scripts/resolve-case-ref.js', 'C001', '--cwd', workspace]));
assert.strictEqual(resolvedByNo.caseNo, 'C001');
assert.strictEqual(resolvedByNo.title, '登录成功');
assert.strictEqual(resolvedByNo.caseDir, parsed.caseDir);
const resolvedByKey = JSON.parse(run('node', ['scripts/resolve-case-ref.js', caseJson.identity.caseKey, '--cwd', workspace]));
assert.strictEqual(resolvedByKey.caseNo, 'C001');
const resolvedByTitle = JSON.parse(run('node', ['scripts/resolve-case-ref.js', '登录成功', '--cwd', workspace]));
assert.strictEqual(resolvedByTitle.caseNo, 'C001');
const executionTargetsByNo = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', 'C001', '--cwd', workspace]));
assert.strictEqual(executionTargetsByNo.existingCases.length, 1);
assert.strictEqual(executionTargetsByNo.existingCases[0].caseDir, parsed.caseDir);
assert.deepStrictEqual(executionTargetsByNo.markdownFiles, []);
const executionTargetsByPath = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', caseFile, '--cwd', workspace]));
assert.deepStrictEqual(executionTargetsByPath.existingCases, []);
assert.deepStrictEqual(executionTargetsByPath.markdownFiles, [caseFile]);
const executionTargetsByRelativePath = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', path.relative(workspace, caseFile), '--cwd', workspace]));
assert.deepStrictEqual(executionTargetsByRelativePath.existingCases, []);
assert.deepStrictEqual(executionTargetsByRelativePath.markdownFiles, [caseFile]);
const nestedOldWorkspace = path.join(sourceRoot, 'cases', 'nested-old-workspace');
write(path.join(nestedOldWorkspace, 'cases', 'C999__旧产物__ck-nested', 'case.json'), `${JSON.stringify({
  schemaVersion: 1,
  identity: {
    caseNo: 'C999',
    caseKey: 'ck-nested',
    title: '旧产物',
    sourceSha1: 'source-nested',
    sourceUpdatedAt: '2026-01-01T00:00:00.000+08:00',
  },
  preconditions: [],
  steps: [],
  globalRules: [],
}, null, 2)}\n`);
write(path.join(nestedOldWorkspace, 'cases', 'C999__旧产物__ck-nested', 'source.md'), `# 不应导入的旧产物

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const executionTargetsByDir = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', path.join(sourceRoot, 'cases'), '--cwd', workspace]));
assert.ok(executionTargetsByDir.markdownFiles.includes(caseFile));
assert.ok(executionTargetsByDir.markdownFiles.includes(noLoginFile));
assert.ok(!executionTargetsByDir.markdownFiles.some((file) => file.includes('nested-old-workspace')));
const parsedContext = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(parsedContext.includes('编号：C001'));

const legacyFile = path.join(sourceRoot, 'cases', 'legacy.md');
write(legacyFile, `# 旧目录迁移测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const legacyInitial = JSON.parse(run('node', ['scripts/parse-case.js', legacyFile, '--cwd', workspace]));
const legacyOriginalDir = legacyInitial.caseDir;
const legacyCase = json(path.join(legacyOriginalDir, 'case.json'));
const legacyDir = path.join(workspace, 'cases', `旧目录迁移测试__${legacyCase.identity.caseKey}`);
fs.renameSync(legacyOriginalDir, legacyDir);
delete legacyCase.identity.caseNo;
write(path.join(legacyDir, 'case.json'), `${JSON.stringify(legacyCase, null, 2)}\n`);
const assigned = JSON.parse(run('node', ['scripts/assign-case-nos.js', '--cwd', workspace]));
assert.strictEqual(assigned.updated.length, 1);
assert.ok(assigned.updated[0].caseDir.includes('C003__旧目录迁移测试__ck-'));
assert.ok(!fs.existsSync(legacyDir));
const migratedCase = json(path.join(assigned.updated[0].caseDir, 'case.json'));
assert.strictEqual(migratedCase.identity.caseNo, 'C003');
const resolvedLegacy = JSON.parse(run('node', ['scripts/resolve-case-ref.js', 'C003', '--cwd', workspace]));
assert.strictEqual(resolvedLegacy.caseDir, assigned.updated[0].caseDir);

const loosePreconditionsFile = path.join(sourceRoot, 'cases', 'loose-preconditions.md');
write(loosePreconditionsFile, `# 宽松前置条件格式测试

## 前置条件
1. App 已安装。
2、设备已连接。
（3）已登录。
网络正常。

## 步骤
1. 预期看到首页。
`);
const loosePreconditionsParsed = JSON.parse(run('node', ['scripts/parse-case.js', loosePreconditionsFile, '--cwd', workspace]));
const loosePreconditionsCase = json(path.join(loosePreconditionsParsed.caseDir, 'case.json'));
assert.deepStrictEqual(loosePreconditionsCase.preconditions.map((item) => item.text), [
  'App 已安装。',
  '设备已连接。',
  '已登录。',
  '网络正常。',
]);

run('node', ['scripts/update-env.js', noLoginParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--platform', 'harmony', '--start']);
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '看到登录按钮',
})]);
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS']);
indexHtml = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
assert.ok(indexHtml.indexOf('C001') < indexHtml.indexOf('C002'));
assert.ok(indexHtml.indexOf('C002') < indexHtml.indexOf('C003'));

const multiPlatformFile = path.join(sourceRoot, 'cases', 'multi-platform.md');
write(multiPlatformFile, `# 多平台隔离测试

## 前置条件
- App 已安装。

## 步骤
1. 预期看到首页。
`);
const multiPlatformParsed = JSON.parse(run('node', ['scripts/parse-case.js', multiPlatformFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', multiPlatformParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const harmonyPlatformStart = JSON.parse(run('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'FAIL',
  reason: 'Harmony 未看到首页',
}), '--execution-id', harmonyPlatformStart.executionId]);
run('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'FAIL', '--failure-code', 'ASSERTION_FAILED', '--failed-step', 'step-001', '--reason', 'Harmony 未看到首页', '--execution-id', harmonyPlatformStart.executionId]);
run('node', ['scripts/update-env.js', multiPlatformParsed.caseDir, '--platform', 'android', '--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'MainActivity']);
const multiPlatformAndroidStatePath = path.join(multiPlatformParsed.caseDir, 'platforms', 'android', 'state.json');
const multiPlatformAndroidState = json(multiPlatformAndroidStatePath);
multiPlatformAndroidState.dependencies = { mavtInputIme: { id: 'mavtInputIme', ok: true, required: true } };
write(multiPlatformAndroidStatePath, `${JSON.stringify(multiPlatformAndroidState, null, 2)}\n`);
const androidPlatformStart = JSON.parse(run('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--platform', 'android', '--start']));
run('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--platform', 'android', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: 'Android 看到首页',
}), '--execution-id', androidPlatformStart.executionId]);
run('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--platform', 'android', '--finalize', '--status', 'PASS', '--execution-id', androidPlatformStart.executionId]);
run('node', ['scripts/update-env.js', multiPlatformParsed.caseDir, '--platform', 'ios', '--device', 'simulator', '--app', 'com.example.demo', '--entry', 'MainView']);
const missingPlatformStart = runAllowFailure('node', ['scripts/run-case.js', multiPlatformParsed.caseDir, '--start']);
assert.notStrictEqual(missingPlatformStart.status, 0);
assert.ok(missingPlatformStart.stderr.includes('Missing --platform'));
assert.ok(harmonyPlatformStart.execDir.includes('/platforms/harmony/executions/'));
assert.ok(androidPlatformStart.execDir.includes('/platforms/android/executions/'));
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'platforms', 'harmony', 'state.json')));
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'platforms', 'android', 'state.json')));
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'platforms', 'ios', 'state.json')));
assert.strictEqual(json(path.join(harmonyPlatformStart.execDir, 'result.json')).status, 'FAIL');
assert.strictEqual(json(path.join(androidPlatformStart.execDir, 'result.json')).status, 'PASS');
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html')));
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'platforms', 'android', 'CONTEXT.html')));
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'platforms', 'ios', 'CONTEXT.html')));
indexHtml = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
assert.ok(fs.existsSync(path.join(multiPlatformParsed.caseDir, 'CONTEXT.html')));
assert.ok(indexHtml.includes(`${path.relative(workspace, path.join(multiPlatformParsed.caseDir, 'CONTEXT.html')).replace(/\\/g, '/')}`));
assert.ok(indexHtml.includes('platforms/harmony/CONTEXT.html'));
assert.ok(indexHtml.includes('platforms/android/CONTEXT.html'));
assert.ok(indexHtml.includes('class="platform-overview"'));
assert.ok(indexHtml.includes('class="platform-overview-card"'));
assert.ok(indexHtml.includes('>Android<'));
assert.ok(indexHtml.includes('>Harmony<'));
assert.ok(indexHtml.includes('>iOS<'));
assert.ok(indexHtml.indexOf('>Android<') < indexHtml.indexOf('>iOS<'));
assert.ok(indexHtml.indexOf('>iOS<') < indexHtml.indexOf('>Harmony<'));
assert.ok(indexHtml.includes('<div class="total"><span>用例</span><b>'));
assert.ok(!indexHtml.includes('共 '));
assert.ok(!indexHtml.includes('class="summary status-breakdown"'));
assert.ok(!indexHtml.includes('通过率'));
assert.ok(indexHtml.includes('class="platform-details"'));
assert.ok(indexHtml.includes('class="platform-brief-list"'));
assert.ok(indexHtml.includes('display: flex; flex-wrap: wrap; gap: 8px'));
assert.ok(!indexHtml.includes('repeat(auto-fit, minmax(260px, 1fr))'));
assert.ok(!indexHtml.includes('class="platform-brief-result"'));
assert.ok(indexHtml.includes('class="platform-result"'));
assert.ok(indexHtml.includes('class="platform-reason"'));
assert.ok(indexHtml.includes('class="platform-detail-card'));
assert.ok(indexHtml.includes('class="platform-time"'));
assert.ok(!indexHtml.includes('class="case-conclusion"'));
assert.ok(!indexHtml.includes('class="case-summary"'));
assert.ok(indexHtml.includes('查看多端详情'));
assert.ok(indexHtml.includes('查看报告'));
assert.ok(indexHtml.includes('harmony'));
assert.ok(indexHtml.includes('android'));
assert.ok(indexHtml.includes('class="case-card fail"'));
assert.ok(indexHtml.includes('<span class="pill fail">失败</span>'));
assert.ok(indexHtml.match(/多平台隔离测试[\s\S]*?<summary>[\s\S]*?Android[\s\S]*?iOS[\s\S]*?Harmony/));
assert.ok(indexHtml.match(/多平台隔离测试[\s\S]*?<span>开始<\/span><b>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/b>/));
const multiPlatformCaseHtml = fs.readFileSync(path.join(multiPlatformParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(multiPlatformCaseHtml.includes('多平台用例详情'));
assert.ok(multiPlatformCaseHtml.includes('平台执行概览'));
assert.ok(multiPlatformCaseHtml.includes('class="platform-report-grid"'));
assert.ok(multiPlatformCaseHtml.includes('class="platform-report-card'));
assert.ok(multiPlatformCaseHtml.includes('.platform-report-grid { display: grid; grid-template-columns: 1fr;'));
assert.ok(!multiPlatformCaseHtml.includes('repeat(auto-fit, minmax(320px, 1fr))'));
assert.ok(multiPlatformCaseHtml.includes('共享前置条件'));
assert.ok(multiPlatformCaseHtml.includes('共享用例步骤'));
assert.ok(multiPlatformCaseHtml.includes('platforms/harmony/CONTEXT.html'));
assert.ok(multiPlatformCaseHtml.includes('platforms/android/CONTEXT.html'));
assert.ok(multiPlatformCaseHtml.indexOf('>Android<') < multiPlatformCaseHtml.indexOf('>iOS<'));
assert.ok(multiPlatformCaseHtml.indexOf('>iOS<') < multiPlatformCaseHtml.indexOf('>Harmony<'));
assert.ok(multiPlatformCaseHtml.includes('断言不通过'));
assert.ok(!multiPlatformCaseHtml.includes('共享概览'));
assert.ok(!multiPlatformCaseHtml.includes('class="shared-overview"'));
assert.ok(!multiPlatformCaseHtml.includes('class="shared-grid"'));
assert.ok(!multiPlatformCaseHtml.includes('<h2>平台报告</h2>'));
assert.ok(!multiPlatformCaseHtml.includes('<h2>平台对比</h2>'));
assert.ok(!multiPlatformCaseHtml.includes('ASSERTION_FAILED'));
assert.ok(!multiPlatformCaseHtml.includes('<h2>执行时间线</h2>'));

const partialPlatformFile = path.join(sourceRoot, 'cases', 'partial-platform.md');
write(partialPlatformFile, `# 部分平台未执行聚合测试

## 前置条件
- App 已安装。

## 步骤
1. 预期看到首页。
`);
const partialPlatformParsed = JSON.parse(run('node', ['scripts/parse-case.js', partialPlatformFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', partialPlatformParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const partialHarmonyStart = JSON.parse(run('node', ['scripts/run-case.js', partialPlatformParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', partialPlatformParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: 'Harmony 看到首页',
}), '--execution-id', partialHarmonyStart.executionId]);
run('node', ['scripts/run-case.js', partialPlatformParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', partialHarmonyStart.executionId]);
run('node', ['scripts/update-env.js', partialPlatformParsed.caseDir, '--platform', 'ios', '--device', 'simulator', '--app', 'com.example.demo', '--entry', 'MainView']);
const partialPlatformHtml = fs.readFileSync(path.join(partialPlatformParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(partialPlatformHtml.includes('<span class="status not_run">未执行</span>'));
assert.ok(!partialPlatformHtml.includes('<span class="status unknown">未知</span>'));

const noEnvFile = path.join(sourceRoot, 'cases', 'no-env.md');
write(noEnvFile, `# 未确认环境测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const noEnvParsed = JSON.parse(run('node', ['scripts/parse-case.js', noEnvFile, '--cwd', workspace]));
const unconfirmedStart = runAllowFailure('node', ['scripts/run-case.js', noEnvParsed.caseDir, '--platform', 'harmony', '--start']);
assert.notStrictEqual(unconfirmedStart.status, 0);
assert.ok(unconfirmedStart.stderr.includes('Environment is not confirmed'));
run('node', ['scripts/update-env.js', noEnvParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const finalizeWithoutStart = runAllowFailure('node', ['scripts/run-case.js', noEnvParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--reason', '未 start 不应收尾']);
assert.notStrictEqual(finalizeWithoutStart.status, 0);
assert.ok(finalizeWithoutStart.stderr.includes('No started execution exists'));
const incompleteEnv = runAllowFailure('node', ['scripts/update-env.js', noEnvParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', '']);
assert.notStrictEqual(incompleteEnv.status, 0);
assert.ok(incompleteEnv.stderr.includes('环境信息不完整'));
assert.ok(!fs.existsSync(path.join(noEnvParsed.caseDir, 'state.json')));

const probeWithoutPlatform = runAllowFailure('./scripts/probe-env.sh', []);
assert.notStrictEqual(probeWithoutPlatform.status, 0);
assert.ok(probeWithoutPlatform.stderr.includes('需要显式传 --platform'));
const probeNoHdc = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'harmony'], {
  env: { ...process.env, PATH: '/usr/local/bin:/bin:/usr/bin' },
}));
assert.strictEqual(probeNoHdc.capabilities.hdc, false);
assert.strictEqual(probeNoHdc.capabilities.launchApp, false);
assert.deepStrictEqual(probeNoHdc.capabilities.actions, []);
const probeWithApp = runAllowFailure('./scripts/probe-env.sh', ['--platform', 'harmony', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
assert.notStrictEqual(probeWithApp.status, 0);
assert.ok(probeWithApp.stderr.includes('probe-env 只探测平台/设备能力'));
assert.ok(probeWithApp.stderr.includes('scripts/update-env.js'));
assert.ok(probeWithApp.stderr.includes('scripts/observe.sh'));
const platformActionWithoutPlatform = runAllowFailure('./scripts/platform/action.sh', ['--type', 'wait', '--ms', '0']);
assert.notStrictEqual(platformActionWithoutPlatform.status, 0);
assert.ok(platformActionWithoutPlatform.stderr.includes('需要显式传 --platform'));
const platformObserveWithoutPlatform = runAllowFailure('./scripts/platform/observe.sh', ['--out', tmp]);
assert.notStrictEqual(platformObserveWithoutPlatform.status, 0);
assert.ok(platformObserveWithoutPlatform.stderr.includes('需要显式传 --platform'));

run('node', ['scripts/update-env.js', parsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
let state = json(path.join(parsed.caseDir, 'platforms', 'harmony', 'state.json'));
assert.strictEqual(state.environment.platform, 'harmony');
assert.strictEqual(state.environment.appId, 'com.example.demo');
assertLocalTime(state.environmentConfirmedAt);

run('node', ['scripts/apply-note.js', parsed.caseDir, '--text', '验证码输入框没有 placeholder，在手机号输入框下方。', '--applies-to', 'step-004']);
caseJson = json(path.join(parsed.caseDir, 'case.json'));
assert.ok(caseJson.steps[3].hints.length);

write(caseFile, `# 登录成功

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
2. 点击「登录」。
3. 点击「获取验证码」。
4. 输入验证码 123456。
5. 预期看到成功。
`);

run('node', ['scripts/parse-case.js', caseFile, '--cwd', workspace]);
caseJson = json(path.join(parsed.caseDir, 'case.json'));
assert.strictEqual(caseJson.identity.sourceMode, 'snapshot');
assert.ok(!fs.readFileSync(path.join(parsed.caseDir, 'source.md'), 'utf8').includes('点击「获取验证码」'));
assert.strictEqual(caseJson.steps.length, 5);

run('node', ['scripts/parse-case.js', caseFile, '--cwd', workspace, '--refresh-from-input']);
caseJson = json(path.join(parsed.caseDir, 'case.json'));
assert.strictEqual(caseJson.sourceChanged, true);
assert.strictEqual(caseJson.identity.sourceMode, 'external');
assert.ok(fs.readFileSync(path.join(parsed.caseDir, 'source.md'), 'utf8').includes('点击「获取验证码」'));
assert.deepStrictEqual(caseJson.staleNotes, []);
assert.strictEqual(caseJson.steps[3].target, '验证码输入框');
assert.ok(caseJson.steps[3].hints.some((hint) => hint.includes('验证码输入框')));

const sourceSnapshot = path.join(parsed.caseDir, 'source.md');
write(sourceSnapshot, `# 登录成功改名

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
2. 点击「登录」。
3. 预期看到成功。
`);
const future = new Date(Date.now() + 2000);
fs.utimesSync(sourceSnapshot, future, future);
run('node', ['scripts/refresh-case.js', parsed.caseDir]);
caseJson = json(path.join(parsed.caseDir, 'case.json'));
assert.strictEqual(caseJson.identity.sourceMode, 'snapshot');
assert.strictEqual(caseJson.identity.title, '登录成功改名');
assert.strictEqual(caseJson.steps.length, 3);

run('node', ['scripts/update-env.js', parsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const started = JSON.parse(run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--start']));
assert.ok(fs.existsSync(started.timeline));
const startEvent = JSON.parse(fs.readFileSync(started.timeline, 'utf8').trim().split(/\r?\n/)[0]);
assertLocalTime(startEvent.time);
assertLocalTime(json(path.join(started.execDir, 'execution.json')).startedAt);
const activeExecutionGuard = runAllowFailure('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--platform', 'harmony', '--start']);
assert.notStrictEqual(activeExecutionGuard.status, 0);
assert.ok(activeExecutionGuard.stderr.includes('Unfinalized execution exists'));
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-001',
  status: 'PASS',
  reason: 'App 已安装',
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'observation',
  label: 'step-001-before',
  artifacts: {
    screenshot: 'screenshots/step-001-before.png',
    layout: 'layouts/step-001-before.json',
    logs: ['logs/step-001-before-aa-dump.txt'],
  },
  app: {
    appId: 'com.example.demo',
    foregroundApp: 'com.example.demo',
    entry: 'EntryAbility',
    inTargetApp: true,
  },
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'decision',
  stepId: 'step-001',
  decision: 'act',
  reason: '需要打开 App',
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'FAIL', '--reason', '示例失败', '--failure-code', 'ASSERTION_FAILED', '--failed-step', 'step-003']);
state = json(path.join(parsed.caseDir, 'platforms', 'harmony', 'state.json'));
assert.strictEqual(state.latestStatus, 'FAIL');
assert.strictEqual(state.statusCounts.FAIL, 1);
const restartFinalized = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--start', '--execution-id', state.latestExecutionId]);
assert.notStrictEqual(restartFinalized.status, 0);
assert.ok(restartFinalized.stderr.includes('Execution already exists'));
const latestExec = path.join(parsed.caseDir, 'platforms', 'harmony', 'executions', state.latestExecutionId);
const metrics = json(path.join(latestExec, 'metrics.json'));
assert.strictEqual(metrics.preconditions.passed, 1);
assert.strictEqual(metrics.actions.launchApp, 1);
assert.strictEqual(metrics.artifacts.screenshots, 1);
assert.strictEqual(metrics.eventCounts.observation, 1);
const context = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(context.includes('## 执行统计'));
assert.ok(context.includes('## 执行事实'));
assert.ok(context.includes('示例失败'));
assert.ok(!context.includes('+08:00'));
const contextHtml = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
assert.ok(contextHtml.includes('<table>'));
assert.ok(contextHtml.includes('步骤'));
assert.ok(contextHtml.includes('示例失败'));
assert.ok(contextHtml.includes('执行：'));
assert.ok(!contextHtml.includes('最近执行：'));
assert.ok(!contextHtml.includes('sourceSha1：source-'));
assert.ok(contextHtml.includes('class="fact-code"'));
assert.ok(contextHtml.includes('断言不通过'));
assert.ok(contextHtml.includes('<section class="failure-evidence">'));
assert.ok(contextHtml.includes('失败证据'));
assert.ok(contextHtml.includes('class="failure-shot"'));
assert.ok(!contextHtml.includes('box-shadow: inset 4px 0 0 var(--fail)'));
assert.ok(contextHtml.includes('.step-failure { margin-top: 9px; padding: 8px 10px;'));
assert.ok(contextHtml.includes('.precondition-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 12px; align-items: center;'));
assert.ok(contextHtml.includes('<section class="precondition-summary">'));
assert.ok(contextHtml.includes('前置条件'));
assert.ok(contextHtml.includes('class="precondition-list"'));
assert.ok(contextHtml.indexOf('class="summary"') < contextHtml.indexOf('<section class="failure-evidence">'));
assert.ok(contextHtml.indexOf('<section class="failure-evidence">') < contextHtml.indexOf('class="precondition-summary"'));
assert.ok(contextHtml.indexOf('class="precondition-summary"') < contextHtml.indexOf('<h2>步骤复盘</h2>'));
assert.ok(!contextHtml.includes('关键截图'));
assert.ok(!contextHtml.includes('evidence-focus'));
assert.ok(contextHtml.includes('class="step-review-list"'));
assert.ok(contextHtml.includes('class="step-review-card'));
assert.ok(contextHtml.includes('class="step-review-main"'));
assert.ok(contextHtml.includes('.step-facts { display: grid; gap: 5px; margin: 10px 0 0; padding: 0; list-style: none; color: #334155; font-size: 14px; line-height: 1.45; }'));
assert.ok(contextHtml.includes('.step-facts span { flex: 0 0 auto; color: var(--muted); font-size: 14px; line-height: 1.45; font-weight: 800; }'));
assert.ok(contextHtml.includes('class="step-shot-row"'));
assert.ok(contextHtml.includes('.shot-strip { display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch; }'));
assert.ok(contextHtml.includes('.shot-card { flex: 0 0 320px; width: 320px; max-width: 100%; height: 224px;'));
assert.ok(contextHtml.includes('.shot-head { min-width: 0; padding-bottom: 8px; border-bottom: 1px solid var(--line); }'));
assert.ok(contextHtml.includes('.shot-body { min-width: 0; display: grid; grid-template-columns: 92px minmax(0, 1fr);'));
assert.ok(contextHtml.includes('.shot-links a { display: flex; align-items: center; width: 100%; min-height: 22px;'));
assert.ok(contextHtml.includes('.shot-label { min-width: 0; color: var(--text); font-size: 13px;'));
assert.ok(contextHtml.includes('.shot-links { display: grid; align-content: start; gap: 4px; min-width: 0; color: var(--muted); font-size: 12px; }'));
assert.ok(!contextHtml.includes('.shot-time { margin-top: auto;'));
assert.ok(contextHtml.includes('class="shot-head"'));
assert.ok(contextHtml.includes('class="shot-body"'));
assert.ok(contextHtml.includes('class="shot-visual"'));
assert.ok(!contextHtml.includes('class="shot-meta"'));
assert.ok(!contextHtml.includes('class="step-review-evidence"'));
assert.ok(!contextHtml.includes('class="step-evidence-title"'));
assert.ok(!contextHtml.includes('暂无步骤截图'));
assert.ok(!contextHtml.includes('<table class="step-table">'));
assert.ok(!contextHtml.includes('<h2>截图证据</h2>\n    <table>'));
assert.ok(contextHtml.includes('class="table-wrap"'));
assert.ok(contextHtml.includes('<details class="debug-details">'));
assert.ok(contextHtml.includes('<summary><span>调试信息</span><small>环境、事件、时间线和原始证据链接</small></summary>'));
assert.ok(contextHtml.includes('class="debug-content"'));
assert.ok(contextHtml.includes('class="debug-overview"'));
assert.ok(contextHtml.includes('grid-template-columns: minmax(240px, 1.08fr) minmax(210px, .92fr) minmax(260px, 1.18fr) minmax(160px, .62fr)'));
assert.ok(contextHtml.includes('class="debug-section compact"'));
assert.ok(contextHtml.includes('技术标识'));
assert.ok(contextHtml.includes(state.latestExecutionId));
assert.ok(contextHtml.includes('source-'));
assert.ok(contextHtml.includes('截图观察'));
assert.ok(contextHtml.includes('操作结果'));
assert.ok(contextHtml.includes('操作次数'));
assert.ok(contextHtml.includes('启动 1'));
assert.ok(contextHtml.includes('步骤复盘'));
assert.ok(contextHtml.includes('shot-strip'));
assert.ok(!contextHtml.includes('evidence-list'));
assert.ok(!contextHtml.includes('width:260px">证据'));
assert.ok(contextHtml.includes('screenshots/step-001-before.png'));
assert.ok(contextHtml.includes('layouts/step-001-before.json'));
assert.ok(contextHtml.includes('失败'));
assert.ok(!contextHtml.includes('actionResult'));
assert.ok(!contextHtml.includes('observation：'));
assert.ok(!contextHtml.includes('+08:00'));
run('node', ['scripts/apply-note.js', parsed.caseDir, '--text', '执行后补充仍应保留最近执行报告。', '--applies-to', 'step-002']);
let refreshedHtml = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
let refreshedContext = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(refreshedHtml.includes('未执行'));
assert.ok(refreshedHtml.includes('源用例或执行契约已变更'));
assert.ok(!refreshedHtml.includes('示例失败'));
assert.ok(!refreshedHtml.includes(`executions/${state.latestExecutionId}/screenshots/step-001-before.png`));
assert.ok(refreshedContext.includes('旧执行结果已隐藏'));
assert.ok(!refreshedHtml.includes('+08:00'));
assert.ok(!refreshedContext.includes('+08:00'));
run('node', ['scripts/update-env.js', parsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility', '--screen', '1080x1920']);
refreshedHtml = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
refreshedContext = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(refreshedHtml.includes('未执行'));
assert.ok(!refreshedHtml.includes('示例失败'));
assert.ok(refreshedHtml.includes('1080x1920'));
assert.ok(!refreshedHtml.includes('+08:00'));
assert.ok(!refreshedContext.includes('+08:00'));
run('node', ['scripts/parse-case.js', caseFile, '--cwd', workspace, '--refresh-from-input']);
const staleSourceHtml = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
const staleSourceContext = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(staleSourceHtml.includes('未执行'));
assert.ok(staleSourceHtml.includes('源用例变更'));
assert.ok(!staleSourceHtml.includes('示例失败'));
assert.ok(!staleSourceHtml.includes(`executions/${state.latestExecutionId}/screenshots/step-001-before.png`));
assert.ok(!staleSourceContext.includes('+08:00'));
const currentSourceStart = JSON.parse(run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'FAIL',
  reason: '新 source 已重新执行',
}), '--execution-id', currentSourceStart.executionId]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'FAIL', '--failure-code', 'ASSERTION_FAILED', '--failed-step', 'step-001', '--reason', '新 source 已重新执行', '--execution-id', currentSourceStart.executionId]);
const currentSourceHtml = fs.readFileSync(path.join(parsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
assert.ok(currentSourceHtml.includes('新 source 已重新执行'));
assert.ok(!currentSourceHtml.includes('源用例变更'));

const invalidStart = JSON.parse(run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--start']));
const invalidEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({ type: 'observation', label: 'bad', artifacts: { screenshot: '../bad.png' } }), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(invalidEvent.status, 0);
assert.ok(invalidEvent.stderr.includes('Invalid artifact path'));
const invalidCoordinateEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'tap',
  ok: true,
  x: 1,
  y: 2,
  coordinateSource: 'layout',
}), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(invalidCoordinateEvent.status, 0);
assert.ok(invalidCoordinateEvent.stderr.includes('coordinate action missing coordinateEvidence'));
const manualCoordinateEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'tap',
  ok: true,
  x: 1,
  y: 2,
  coordinateSource: 'manual',
  coordinateEvidence: '人工指定坐标',
}), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(manualCoordinateEvent.status, 0);
assert.ok(manualCoordinateEvent.stderr.includes('manual coordinateSource is not allowed'));
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--reason', 'invalid event guard cleanup', '--execution-id', invalidStart.executionId]);

const passFile = path.join(sourceRoot, 'cases', 'pass.md');
write(passFile, `# 通过证据测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
2. 预期看到首页。
`);
const passParsed = JSON.parse(run('node', ['scripts/parse-case.js', passFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', passParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const passStart = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
})]);
run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS']);
const passResult = json(path.join(passStart.execDir, 'result.json'));
assert.strictEqual(passResult.status, 'UNKNOWN');
assert.strictEqual(passResult.failureCode, 'ASSERTION_UNKNOWN');
assert.strictEqual(passResult.failedStep, 'step-002');
const passHtml = fs.readFileSync(path.join(passParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(passHtml.includes('预期看到首页'));
assert.ok(!passHtml.match(/预期看到首页[\s\S]*?<span class="pill pass">通过<\/span>/));
const passStateBefore = json(path.join(passParsed.caseDir, 'platforms', 'harmony', 'state.json'));
const duplicateFinalize = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', passStart.executionId]));
assert.strictEqual(duplicateFinalize.alreadyFinalized, true);
const passStateAfter = json(path.join(passParsed.caseDir, 'platforms', 'harmony', 'state.json'));
assert.strictEqual(passStateAfter.executionCount, passStateBefore.executionCount);
indexHtml = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
assert.ok(indexHtml.includes('通过证据测试'));
assert.ok(indexHtml.includes('未知'));
assert.ok(!indexHtml.includes('关键信息'));
assert.ok(indexHtml.includes('class="platform-overview"'));
assert.ok(indexHtml.includes('class="platform-status-grid"'));
assert.ok(indexHtml.includes('grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px'));
assert.ok(indexHtml.includes('min-height: 132px'));
assert.ok(indexHtml.includes('padding: 16px 18px'));
assert.ok(indexHtml.includes('font-size: 18px; line-height: 1.1'));
assert.ok(!indexHtml.includes('class="overview-panel"'));
assert.ok(!indexHtml.includes('通过率'));
assert.ok(indexHtml.includes('class="case-kicker"'));
assert.ok(!indexHtml.includes('class="case-conclusion"'));
assert.ok(indexHtml.includes('class="platform-details"'));
assert.ok(indexHtml.includes('class="platform-detail-list"'));
assert.ok(indexHtml.includes('grid-template-columns: 1fr; gap: 8px'));
assert.ok(indexHtml.includes('grid-template-columns: minmax(112px, auto) minmax(260px, 1fr) auto'));
assert.ok(indexHtml.includes('grid-template-columns: 76px 92px minmax(220px, 1fr) minmax(220px, 1fr)'));
assert.ok(!indexHtml.includes('min-width: 560px'));
assert.ok(indexHtml.includes('font-variant-numeric: tabular-nums'));
assert.ok(indexHtml.includes('-webkit-line-clamp: 2'));
assert.ok(!indexHtml.includes('class="case-state"'));
assert.ok(indexHtml.includes('执行结果'));
assert.ok(indexHtml.includes('PASS 缺少步骤证据'));
assert.ok(indexHtml.includes('断言证据不足'));
assert.ok(!indexHtml.includes('PRECONDITION_NOT_MET'));
assert.strictEqual(displayFailureCode('PRECONDITION_NOT_MET'), '前置条件不满足');
assert.ok(!indexHtml.includes('<span>执行结果</span>ASSERTION_UNKNOWN'));
assert.ok(indexHtml.includes('<span>执行结果</span><b>断言证据不足</b>'));
assert.ok(indexHtml.includes('开始'));
assert.ok(indexHtml.includes('结束'));
assert.ok(!indexHtml.includes('+08:00'));
const renderedIndex = run('node', ['scripts/render-index.js', workspace]).trim();
assert.strictEqual(renderedIndex, path.join(workspace, 'index.html'));

const unknownFile = path.join(sourceRoot, 'cases', 'unknown.md');
write(unknownFile, `# 未知断言测试

## 前置条件
- App 已安装。

## 步骤
1. 预期看到首页。
`);
const unknownParsed = JSON.parse(run('node', ['scripts/parse-case.js', unknownFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', unknownParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const unknownStart = JSON.parse(run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'UNKNOWN',
  reason: '证据不足',
})]);
run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--failed-step', 'step-001']);
const unknownMetrics = json(path.join(unknownStart.execDir, 'metrics.json'));
assert.strictEqual(unknownMetrics.steps.failed, 0);
assert.strictEqual(unknownMetrics.steps.unknown, 1);

const fakeAndroidBin = path.join(tmp, 'fake-android-bin');
const fakeAdbLog = path.join(tmp, 'fake-adb.log');
const fakeAdb = path.join(fakeAndroidBin, 'adb');
write(fakeAdb, `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "\${args[0]:-}" == "-s" ]]; then
  args=("\${args[@]:2}")
fi
printf '%s\\n' "\${args[*]}" >> "$ADB_LOG"
if [[ "\${args[0]:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
elif [[ "\${args[0]:-}" == "install" ]]; then
  printf 'Success\\n'
elif [[ "\${args[0]:-}" == "exec-out" && "\${args[1]:-}" == "screencap" ]]; then
  printf 'fake-png'
elif [[ "\${args[0]:-}" == "pull" ]]; then
  dest="\${args[2]}"
  mkdir -p "$(dirname "$dest")"
  printf '<hierarchy><node text="登录" bounds="[1,2][30,40]"/></hierarchy>' > "$dest"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "uiautomator" ]]; then
  printf 'UI hierchary dumped to: %s\\n' "\${args[3]:-/sdcard/window.xml}"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "dumpsys" && "\${args[2]:-}" == "window" ]]; then
  printf 'mCurrentFocus=Window{abc u0 com.example.demo/.MainActivity}\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "dumpsys" && "\${args[2]:-}" == "activity" ]]; then
  printf 'topResumedActivity=ActivityRecord{abc u0 com.example.demo/.MainActivity t1}\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "wm" && "\${args[2]:-}" == "size" ]]; then
  printf 'Physical size: 1080x2400\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "pm" && "\${args[2]:-}" == "path" ]]; then
  printf 'package:/data/app/mavt.android.ime/base.apk\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "settings" && "\${args[2]:-}" == "get" ]]; then
  printf 'com.example/.Ime\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "ime" && "\${args[2]:-}" == "list" ]]; then
  printf 'mavt.android.ime/.MavtInputMethodService\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "ime" ]]; then
  printf 'Input method changed\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "am" && "\${args[2]:-}" == "start" && "\${args[3]:-}" == "-n" ]]; then
  if [[ "\${args[4]:-}" == *"PrivateActivity"* ]]; then
    printf 'SecurityException: Permission Denial: starting Intent not exported\\n' >&2
    exit 255
  fi
  printf 'Starting: Intent { cmp=%s }\\n' "\${args[4]:-}"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "am" && "\${args[2]:-}" == "broadcast" ]]; then
  printf 'Broadcast completed: result=-1, data="OK"\\n'
elif [[ "\${args[0]:-}" == "logcat" ]]; then
  printf 'fake android log\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "pidof" ]]; then
  printf '23456\\n'
fi
`);
fs.chmodSync(fakeAdb, 0o755);
const fakeAndroidImeCache = path.join(tmp, 'fake-android-ime-cache');
write(path.join(fakeAndroidImeCache, 'mavt-input.apk'), 'fake apk\n');
write(path.join(fakeAndroidImeCache, 'source.sha256'), treeSha256(path.join(repo, 'scripts/platform/adapters/android/ime')));
const fakeAndroidEnv = {
  ...process.env,
  PATH: `${fakeAndroidBin}:${process.env.PATH}`,
  ADB_LOG: fakeAdbLog,
  MAVT_ACTION_SETTLE_MS: '0',
  MAVT_ANDROID_IME_BUILD_DIR: fakeAndroidImeCache,
};

const androidProbe = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'android'], { env: fakeAndroidEnv }));
assert.strictEqual(androidProbe.platform, 'android');
assert.deepStrictEqual(androidProbe.targets, ['emulator-5554']);
assert.strictEqual(androidProbe.capabilities.adb, true);
assert.strictEqual(androidProbe.capabilities.screenshot, true);
assert.strictEqual(androidProbe.capabilities.layout, true);
assert.strictEqual(androidProbe.capabilities.foregroundApp, true);
assert.strictEqual(androidProbe.capabilities.launchApp, true);
assert.ok(androidProbe.capabilities.actions.includes('tap'));
assert.ok(androidProbe.capabilities.actions.includes('longPress'));
assert.ok(androidProbe.capabilities.actions.includes('inputText'));
assert.ok(androidProbe.capabilities.dependencies.some((item) => item.id === 'mavtInputIme'));

const androidLaunchFallback = JSON.parse(run('./scripts/platform/adapters/android/atoms/launch-app.sh', ['--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'PrivateActivity'], { env: fakeAndroidEnv }));
assert.strictEqual(androidLaunchFallback.action, 'launchApp');
assert.strictEqual(androidLaunchFallback.ok, true);
assert.strictEqual(androidLaunchFallback.launchMethod, 'monkey-fallback');
assert.ok(androidLaunchFallback.fallbackReason.includes('not exported'));

const androidFile = path.join(sourceRoot, 'cases', 'android.md');
write(androidFile, `# Android 适配测试

## 前置条件
- App 已安装。

## 步骤
1. 点击「登录」。
`);
const androidParsed = JSON.parse(run('node', ['scripts/parse-case.js', androidFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', androidParsed.caseDir, '--platform', 'android', '--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'MainActivity']);
const androidStartBeforePrepare = runAllowFailure('node', ['scripts/run-case.js', androidParsed.caseDir, '--platform', 'android', '--start']);
assert.notStrictEqual(androidStartBeforePrepare.status, 0);
assert.ok(androidStartBeforePrepare.stderr.includes('Environment dependencies are not prepared'));
const androidPrepare = JSON.parse(run('./scripts/prepare-env.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android'], { env: fakeAndroidEnv }));
assert.strictEqual(androidPrepare.ok, true);
assert.strictEqual(androidPrepare.dependencies[0].id, 'mavtInputIme');
assert.strictEqual(androidPrepare.dependencies[0].ok, true);
const androidPreparedState = json(path.join(androidParsed.caseDir, 'platforms', 'android', 'state.json'));
assert.strictEqual(androidPreparedState.dependencies.mavtInputIme.ok, true);
const androidPreparedContext = fs.readFileSync(path.join(androidParsed.caseDir, 'platforms', 'android', 'CONTEXT.md'), 'utf8');
const androidPreparedHtml = fs.readFileSync(path.join(androidParsed.caseDir, 'platforms', 'android', 'CONTEXT.html'), 'utf8');
assert.ok(androidPreparedContext.includes('## 平台依赖'));
assert.ok(androidPreparedContext.includes('mavtInputIme: READY'));
assert.ok(androidPreparedHtml.includes('<h2>平台依赖</h2>'));
assert.ok(androidPreparedHtml.includes('mavtInputIme'));
assert.ok(androidPreparedHtml.includes('class="dependency-list"'));
assert.ok(androidPreparedHtml.includes('class="dependency-card"'));
assert.ok(!androidPreparedHtml.includes('<th>ID</th><th>名称</th><th>状态</th><th>阶段</th><th>必需</th><th>详情</th>'));
const androidStart = JSON.parse(run('node', ['scripts/run-case.js', androidParsed.caseDir, '--platform', 'android', '--start']));
assert.ok(androidStart.execDir.includes('/platforms/android/executions/'));
const androidObservation = JSON.parse(run('./scripts/observe.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android', '--execution-id', androidStart.executionId, '--label', 'step-001-before'], { env: fakeAndroidEnv }));
assert.strictEqual(androidObservation.platform, 'android');
assert.strictEqual(androidObservation.label, '001-step-001-before');
assert.strictEqual(androidObservation.artifacts.screenshot, 'screenshots/001-step-001-before.png');
assert.strictEqual(androidObservation.artifacts.layout, 'layouts/001-step-001-before.xml');
assert.strictEqual(androidObservation.app.foregroundApp, 'com.example.demo');
assert.strictEqual(androidObservation.app.entry, 'MainActivity');
assert.strictEqual(androidObservation.app.inTargetApp, true);
run('node', ['scripts/flow/record-scan.js', androidParsed.caseDir, '--platform', 'android', '--cwd', workspace, '--execution-id', androidStart.executionId, '--step-id', 'step-001', '--reason', 'Android 动作前已扫描 Flow，无可用候选']);
const androidAction = JSON.parse(run('./scripts/action.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android', '--execution-id', androidStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '1', '--y', '2', '--coordinate-source', 'layout', '--target-bounds', '0,0,2,3', '--coordinate-evidence', 'android uiautomator bounds', '--settle-ms', '0'], { env: fakeAndroidEnv }));
assert.strictEqual(androidAction.platform, 'android');
assert.strictEqual(androidAction.action, 'tap');
assert.strictEqual(androidAction.ok, true);
assert.strictEqual(androidAction.coordinateSource, 'layout');
const androidLongPress = JSON.parse(run('./scripts/action.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android', '--execution-id', androidStart.executionId, '--step-id', 'step-001', '--type', 'longPress', '--x', '3', '--y', '4', '--duration-ms', '900', '--coordinate-source', 'layout', '--target-bounds', '0,0,8,9', '--coordinate-evidence', 'android uiautomator long press bounds', '--settle-ms', '0'], { env: fakeAndroidEnv }));
assert.strictEqual(androidLongPress.action, 'longPress');
assert.strictEqual(androidLongPress.ok, true);
assert.strictEqual(androidLongPress.durationMs, 900);
assert.strictEqual(androidLongPress.coordinateSource, 'layout');
const androidInput = JSON.parse(run('./scripts/action.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android', '--execution-id', androidStart.executionId, '--step-id', 'step-001', '--type', 'inputText', '--text', 'hello world', '--settle-ms', '0'], { env: fakeAndroidEnv }));
assert.strictEqual(androidInput.action, 'inputText');
assert.strictEqual(androidInput.ok, true);
const androidUnicodeInput = JSON.parse(run('./scripts/action.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android', '--execution-id', androidStart.executionId, '--step-id', 'step-001', '--type', 'inputText', '--text', '中文输入', '--settle-ms', '0'], { env: fakeAndroidEnv }));
assert.strictEqual(androidUnicodeInput.action, 'inputText');
assert.strictEqual(androidUnicodeInput.ok, true);
assert.strictEqual(androidUnicodeInput.inputMethod, 'mavt-input-ime');
assert.strictEqual(androidUnicodeInput.inputStateUsage, 'diagnostic_only');
assert.strictEqual(androidUnicodeInput.preInputState.hasEditableConnection, false);
run('node', ['scripts/run-case.js', androidParsed.caseDir, '--platform', 'android', '--finalize', '--status', 'UNKNOWN', '--reason', 'Android adapter smoke test complete', '--execution-id', androidStart.executionId]);
const fakeAdbOutput = fs.readFileSync(fakeAdbLog, 'utf8');
assert.ok(fakeAdbOutput.includes('shell am start -n com.example.demo/.PrivateActivity'));
assert.ok(fakeAdbOutput.includes('shell monkey -p com.example.demo 1'));
assert.ok(fakeAdbOutput.includes('exec-out screencap -p'));
assert.ok(fakeAdbOutput.includes('shell uiautomator dump'));
assert.ok(fakeAdbOutput.includes('shell input tap 1 2'));
assert.ok(fakeAdbOutput.includes('shell input swipe 3 4 3 4 900'));
assert.ok(fakeAdbOutput.includes('shell input text hello%sworld'));
assert.ok(fakeAdbOutput.includes('install -r'));
assert.strictEqual((fakeAdbOutput.match(/install -r/g) || []).length, 1);
assert.ok(fakeAdbOutput.includes('shell am broadcast -a mavt.android.ime.INPUT_TEXT'));

const fakeBin = path.join(tmp, 'fake-bin');
const fakeHdcLog = path.join(tmp, 'fake-hdc.log');
const fakeHdcRemote = path.join(tmp, 'fake-hdc-remote');
const fakeHdc = path.join(fakeBin, 'hdc');
write(fakeHdc, `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "\${args[0]:-}" == "-t" ]]; then
  args=("\${args[@]:2}")
fi
printf '%s\\n' "\${args[*]}" >> "$HDC_LOG"
remote_key() {
  printf '%s' "$1" | sed 's#[^A-Za-z0-9._-]#_#g'
}
if [[ "\${args[0]:-}" == "file" && "\${args[1]:-}" == "recv" ]]; then
  src="\${args[2]}"
  dest="\${args[3]}"
  mkdir -p "$(dirname "$dest")"
  if [[ "$src" == *.png ]]; then
    printf 'fake-png' > "$dest"
  elif [[ -f "$HDC_REMOTE_DIR/$(remote_key "$src")" ]]; then
    cp "$HDC_REMOTE_DIR/$(remote_key "$src")" "$dest"
  else
    printf '[Fail]Error opening file: no such file or directory, path:%s\\n' "$src"
  fi
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "uitest" && "\${args[2]:-}" == "dumpLayout" ]]; then
  for arg in "\${args[@]}"; do
    if [[ "$arg" == "-m" ]]; then
      printf 'uitest: unrecognized option: m\\nUSAGE: uitestkit dumpLayout -p <path>\\n'
      exit 0
    fi
    if [[ "$arg" == "-b" ]]; then
      printf 'uitest: unrecognized option: b\\nUSAGE: uitestkit dumpLayout -p <path>\\n'
      exit 0
    fi
  done
  remote_path=""
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "-p" ]]; then
      remote_path="\${args[$((i+1))]:-}"
    fi
  done
  mkdir -p "$HDC_REMOTE_DIR"
  printf '{"attributes":{"bounds":"[0,0][1260,2720]"},"children":[]}' > "$HDC_REMOTE_DIR/$(remote_key "$remote_path")"
  printf 'DumpLayout saved to:%s\\n' "$remote_path"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "uitest" && "\${args[2]:-}" == "--version" ]]; then
  printf 'uitest version 1.0\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "uitest" && "\${args[2]:-}" == "uiInput" && "\${args[3]:-}" == "click" && "\${args[4]:-}" == -* ]]; then
  printf 'Please confirm that the coordinate values are correct.\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "aa" && "\${args[2]:-}" == "dump" ]]; then
  printf 'AbilityRecord ID #1\\nstate #FOREGROUND\\nability type [PAGE]\\nbundle name [com.example.demo]\\nmain name [EntryAbility]\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "pidof" ]]; then
  printf '12345\\n'
fi
`);
fs.chmodSync(fakeHdc, 0o755);

const injectedFile = path.join(sourceRoot, 'cases', 'injected-env.md');
write(injectedFile, `# 环境注入测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const injectedParsed = JSON.parse(run('node', ['scripts/parse-case.js', injectedFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', injectedParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const injectedStart = JSON.parse(run('node', ['scripts/run-case.js', injectedParsed.caseDir, '--platform', 'harmony', '--start']));
const fakeEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HDC_LOG: fakeHdcLog, HDC_REMOTE_DIR: fakeHdcRemote, MAVT_ACTION_SETTLE_MS: '0' };
const harmonyProbe = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'harmony', '--device', '127.0.0.1:5555'], { env: fakeEnv }));
assert.strictEqual(harmonyProbe.capabilities.layout, true);
assert.ok(harmonyProbe.capabilities.actions.includes('longPress'));
let fakeHdcProbeLog = fs.readFileSync(fakeHdcLog, 'utf8');
assert.ok(fakeHdcProbeLog.includes('shell uitest dumpLayout -p /data/local/tmp/mavt-probe.json -m true'));
assert.ok(fakeHdcProbeLog.includes('shell uitest dumpLayout -p /data/local/tmp/mavt-probe.json'));
const injectedAction = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'launchApp', '--settle-ms', '25'], { env: fakeEnv }));
assert.strictEqual(injectedAction.ok, true);
assert.strictEqual(injectedAction.settleMs, 25);
assertLocalTime(injectedAction.time);
const missingCoordinateSource = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(missingCoordinateSource.status, 0);
assert.ok(missingCoordinateSource.stderr.includes('坐标动作必须提供 --coordinate-source'));
const missingCoordinateEvidence = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'layout', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(missingCoordinateEvidence.status, 0);
assert.ok(missingCoordinateEvidence.stderr.includes('坐标动作必须提供 --coordinate-evidence'));
const invalidCoordinateSource = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'nearby-text', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(invalidCoordinateSource.status, 0);
assert.ok(invalidCoordinateSource.stderr.includes('无效 --coordinate-source'));
const manualCoordinateSource = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'manual', '--coordinate-evidence', '人工指定坐标', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(manualCoordinateSource.status, 0);
assert.ok(manualCoordinateSource.stderr.includes('不允许使用 --coordinate-source manual'));
const flowCoordinateWithoutBounds = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'flow', '--coordinate-evidence', '沿用 Flow 坐标', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(flowCoordinateWithoutBounds.status, 0);
assert.ok(flowCoordinateWithoutBounds.stderr.includes('flow 坐标动作必须提供 --target-bounds'));
const invalidTargetBounds = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'visual', '--target-bounds', '1,2,3', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(invalidTargetBounds.status, 0);
assert.ok(invalidTargetBounds.stderr.includes('无效 --target-bounds'));
const harmonyInputWithoutCoordinates = runAllowFailure('./scripts/platform/adapters/harmony/action.sh', ['--device', '127.0.0.1:5555', '--type', 'inputText', '--text', 'hello'], { env: fakeEnv });
assert.notStrictEqual(harmonyInputWithoutCoordinates.status, 0);
assert.ok(harmonyInputWithoutCoordinates.stderr.includes('inputText 需要 --x 和 --y'));
const harmonyInvalidTap = runAllowFailure('./scripts/platform/adapters/harmony/action.sh', ['--device', '127.0.0.1:5555', '--type', 'tap', '--x', '-1', '--y', '-1'], { env: fakeEnv });
assert.notStrictEqual(harmonyInvalidTap.status, 0);
assert.ok(harmonyInvalidTap.stderr.includes('Please confirm that the coordinate values are correct'));
const invalidManualFlowScan = runAllowFailure('node', ['scripts/run-case.js', injectedParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flowScan',
  status: 'EMPTY',
  candidateCount: 0,
  matchedFlowIds: [],
  stepId: 'step-001',
  reason: '业务动作前已扫描 Flow，无可用候选',
}), '--execution-id', injectedStart.executionId]);
assert.notStrictEqual(invalidManualFlowScan.status, 0);
assert.ok(invalidManualFlowScan.stderr.includes('flowScan source must be list-flows'));
run('node', ['scripts/flow/record-scan.js', injectedParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', injectedStart.executionId, '--reason', '只建立候选库，不绑定步骤']);
run('node', ['scripts/flow/record-scan.js', injectedParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--reason', '业务动作前已扫描 Flow，无可用候选']);
const injectedToggle = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'toggle', '--x', '9', '--y', '10', '--coordinate-source', 'layout', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '控件树通知开关 bounds', '--settle-ms', '0'], { env: fakeEnv }));
assert.strictEqual(injectedToggle.action, 'toggle');
assert.strictEqual(injectedToggle.ok, true);
assert.strictEqual(injectedToggle.coordinateSource, 'layout');
assert.deepStrictEqual(injectedToggle.targetBounds, [1, 2, 30, 40]);
assert.strictEqual(injectedToggle.coordinateEvidence, '控件树通知开关 bounds');
const injectedLongPress = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'longPress', '--x', '11', '--y', '12', '--duration-ms', '850', '--coordinate-source', 'layout', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '控件树列表项 bounds', '--settle-ms', '0'], { env: fakeEnv }));
assert.strictEqual(injectedLongPress.action, 'longPress');
assert.strictEqual(injectedLongPress.ok, true);
assert.strictEqual(injectedLongPress.durationMs, 850);
const fakeHdcActionLog = fs.readFileSync(fakeHdcLog, 'utf8');
assert.ok(fakeHdcActionLog.includes('shell aa start -b com.example.demo -a EntryAbility'));
assert.ok(fakeHdcActionLog.includes('shell uitest uiInput click 9 10'));
assert.ok(fakeHdcActionLog.includes('shell uitest uiInput swipe 11 12 11 12 850'));
const defaultSettleEnv = { ...fakeEnv };
delete defaultSettleEnv.MAVT_ACTION_SETTLE_MS;
const injectedDefaultWait = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'wait', '--ms', '0'], { env: defaultSettleEnv }));
assert.strictEqual(injectedDefaultWait.settleMs, undefined);
const injectedDefaultTap = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'visual', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '截图像素区域中心'], { env: defaultSettleEnv }));
assert.strictEqual(injectedDefaultTap.settleMs, 1000);
assert.strictEqual(injectedDefaultTap.coordinateSource, 'visual');
assert.ok(fs.readFileSync(path.join(repo, 'scripts', 'flow', 'action.sh'), 'utf8').includes('MAVT_ACTION_SETTLE_MS:-1000'));

const injectedObservation = JSON.parse(run('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--label', '../bad'], { env: fakeEnv }));
assert.strictEqual(injectedObservation.label, '001-bad');
assert.strictEqual(injectedObservation.stepId, 'step-001');
assertLocalTime(injectedObservation.time);
assert.strictEqual(injectedObservation.artifacts.screenshot, 'screenshots/001-bad.png');
assert.strictEqual(injectedObservation.artifacts.layout, 'layouts/001-bad.json');
const injectedObservation2 = JSON.parse(run('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--label', 'step-001-after'], { env: fakeEnv }));
assert.strictEqual(injectedObservation2.label, '002-step-001-after');
assert.strictEqual(injectedObservation2.artifacts.screenshot, 'screenshots/002-step-001-after.png');
run('node', ['scripts/render-context.js', injectedParsed.caseDir, '--platform', 'harmony']);
const injectedHtmlPath = path.join(injectedParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html');
assert.ok(fs.existsSync(injectedHtmlPath));
const injectedHtml = fs.readFileSync(injectedHtmlPath, 'utf8');
assert.ok(injectedHtml.includes(`executions/${injectedStart.executionId}/screenshots/001-bad.png`));
assert.ok(injectedHtml.includes('step-001'));
assert.ok(!injectedHtml.includes('未关联步骤'));
assert.ok(injectedHtml.includes('class="step-review-list"'));
assert.ok(injectedHtml.includes('class="step-review-card'));
assert.ok(injectedHtml.includes('class="shot-lightbox"'));
assert.ok(injectedHtml.includes('data-lightbox-src='));
assert.ok(injectedHtml.includes('data-lightbox-index='));
assert.ok(injectedHtml.includes('class="shot-lightbox-nav prev"'));
assert.ok(injectedHtml.includes('class="shot-lightbox-nav next"'));
assert.ok(injectedHtml.includes("event.key === 'ArrowLeft'"));
assert.ok(injectedHtml.includes("event.key === 'ArrowRight'"));
assert.ok(injectedHtml.includes('.shot-lightbox-body { position: relative; min-height: 0; height: min(78vh, 860px);'));
assert.ok(injectedHtml.includes('.shot-lightbox-body img { width: 100%; height: 100%; object-fit: contain;'));
assert.ok(injectedHtml.includes('class="shot-links"'));
assert.ok(injectedHtml.includes('>控件树</a>'));
assert.ok(injectedHtml.includes('>Ability状态</a>'));
assert.ok(!injectedHtml.includes('>日志1</a>'));
assert.ok(!injectedHtml.includes('data-artifact-panel='));
assert.ok(!injectedHtml.includes('class="artifact-preview"'));
assert.ok(!injectedHtml.includes('控件树预览'));
assert.ok(!injectedHtml.includes('日志预览'));
assert.ok(!injectedHtml.includes('打开原文件'));
assert.ok(!injectedHtml.includes('<h2>截图证据</h2>'));
assert.ok(!injectedHtml.includes('<h2>步骤结果</h2>'));
assert.ok(injectedHtml.includes('观察记录'));
assert.ok(injectedHtml.includes('截图观察'));
assert.ok(injectedHtml.includes('切换开关成功'));
assert.ok(!injectedHtml.includes('actionResult'));
run('node', ['scripts/run-case.js', injectedParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--reason', '环境注入测试完成', '--execution-id', injectedStart.executionId]);

const missingFlowScanFile = path.join(sourceRoot, 'cases', 'missing-flow-scan.md');
write(missingFlowScanFile, `# Flow 扫描缺失自动收尾测试

## 前置条件
- App 已安装。

## 步骤
1. 点击业务按钮。
`);
const missingFlowScanParsed = JSON.parse(run('node', ['scripts/parse-case.js', missingFlowScanFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', missingFlowScanParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const missingFlowScanStart = JSON.parse(run('node', ['scripts/run-case.js', missingFlowScanParsed.caseDir, '--platform', 'harmony', '--start']));
const missingFlowScanAction = runAllowFailure('./scripts/action.sh', ['--case-dir', missingFlowScanParsed.caseDir, '--platform', 'harmony', '--execution-id', missingFlowScanStart.executionId, '--step-id', 'step-001', '--type', 'toggle', '--x', '9', '--y', '10', '--coordinate-source', 'layout', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '控件树通知开关 bounds', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(missingFlowScanAction.status, 0);
assert.ok(missingFlowScanAction.stdout.includes('FLOW_SCAN_REQUIRED'));
const missingFlowScanResult = json(path.join(missingFlowScanStart.execDir, 'result.json'));
assert.strictEqual(missingFlowScanResult.status, 'BLOCKED');
assert.strictEqual(missingFlowScanResult.failureCode, 'FLOW_SCAN_REQUIRED');
assert.strictEqual(missingFlowScanResult.failedStep, 'step-001');
assert.strictEqual(json(path.join(missingFlowScanStart.execDir, 'execution.json')).finalized, true);
const missingFlowScanEvents = fs.readFileSync(path.join(missingFlowScanStart.execDir, 'timeline.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.ok(missingFlowScanEvents.some((event) => event.type === 'actionResult' && event.failureCode === 'FLOW_SCAN_REQUIRED'));
assert.ok(missingFlowScanEvents.some((event) => event.type === 'result' && event.failureCode === 'FLOW_SCAN_REQUIRED'));

const globalOnlyFlowScanFile = path.join(sourceRoot, 'cases', 'global-only-flow-scan.md');
write(globalOnlyFlowScanFile, `# 全局 Flow 扫描不能替代步骤扫描测试

## 前置条件
- App 已安装。

## 步骤
1. 点击业务按钮。
`);
const globalOnlyFlowScanParsed = JSON.parse(run('node', ['scripts/parse-case.js', globalOnlyFlowScanFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', globalOnlyFlowScanParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const globalOnlyFlowScanStart = JSON.parse(run('node', ['scripts/run-case.js', globalOnlyFlowScanParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/flow/record-scan.js', globalOnlyFlowScanParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', globalOnlyFlowScanStart.executionId, '--reason', '只建立候选库，不绑定步骤']);
const globalOnlyFlowScanAction = runAllowFailure('./scripts/action.sh', ['--case-dir', globalOnlyFlowScanParsed.caseDir, '--platform', 'harmony', '--execution-id', globalOnlyFlowScanStart.executionId, '--step-id', 'step-001', '--type', 'toggle', '--x', '9', '--y', '10', '--coordinate-source', 'layout', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '控件树通知开关 bounds', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(globalOnlyFlowScanAction.status, 0);
assert.ok(globalOnlyFlowScanAction.stdout.includes('全局扫描只用于建立候选库'));
const globalOnlyFlowScanResult = json(path.join(globalOnlyFlowScanStart.execDir, 'result.json'));
assert.strictEqual(globalOnlyFlowScanResult.status, 'BLOCKED');
assert.strictEqual(globalOnlyFlowScanResult.failureCode, 'FLOW_SCAN_REQUIRED');
assert.strictEqual(globalOnlyFlowScanResult.failedStep, 'step-001');

const toolErrorFile = path.join(sourceRoot, 'cases', 'tool-error.md');
write(toolErrorFile, `# 工具错误自动收尾测试

## 前置条件
- App 已安装。

## 步骤
1. 点击「异常坐标」。
`);
const toolErrorParsed = JSON.parse(run('node', ['scripts/parse-case.js', toolErrorFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', toolErrorParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const toolErrorStart = JSON.parse(run('node', ['scripts/run-case.js', toolErrorParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/flow/record-scan.js', toolErrorParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', toolErrorStart.executionId, '--step-id', 'step-001', '--reason', '工具错误前已扫描 Flow']);
const toolErrorAction = runAllowFailure('./scripts/action.sh', ['--case-dir', toolErrorParsed.caseDir, '--platform', 'harmony', '--execution-id', toolErrorStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '-1', '--y', '-1', '--coordinate-source', 'layout', '--target-bounds', '0,0,2,2', '--coordinate-evidence', '测试异常坐标', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(toolErrorAction.status, 0);
const toolErrorResult = json(path.join(toolErrorStart.execDir, 'result.json'));
assert.strictEqual(toolErrorResult.status, 'BLOCKED');
assert.strictEqual(toolErrorResult.failureCode, 'TOOL_ERROR');
assert.strictEqual(toolErrorResult.failedStep, 'step-001');
assert.strictEqual(json(path.join(toolErrorStart.execDir, 'execution.json')).finalized, true);

const rulesFile = path.join(sourceRoot, 'cases', 'global-rules.md');
write(rulesFile, `# 全局规则测试

## 前置条件
- App 已安装。

## 步骤
1. 点击「继续」。
`);
const rulesParsed = JSON.parse(run('node', ['scripts/parse-case.js', rulesFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', rulesParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const rulesCasePath = path.join(rulesParsed.caseDir, 'case.json');
const rulesCase = json(rulesCasePath);
rulesCase.globalRules = [{
  id: 'rule-001',
  type: 'guard',
  scope: 'system_popup',
  appliesTo: 'any_step',
  priority: 100,
  when: '出现权限弹窗',
  then: {
    decision: 'act',
    action: { type: 'tap', target: '允许' },
  },
  maxAttempts: 1,
  onFailure: 'BLOCKED',
}];
write(rulesCasePath, `${JSON.stringify(rulesCase, null, 2)}\n`);
const rulesStart = JSON.parse(run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'rule',
  ruleId: 'rule-001',
  status: 'MATCHED',
  stepId: 'step-001',
  reason: '检测到权限弹窗',
})]);
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'tap',
  ok: true,
})]);
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS']);
const rulesMetrics = json(path.join(rulesStart.execDir, 'metrics.json'));
assert.strictEqual(rulesMetrics.eventCounts.rule, 1);
assert.ok(rulesMetrics.caseContractSha);
const rulesResult = json(path.join(rulesStart.execDir, 'result.json'));
assert.strictEqual(rulesResult.caseContractSha, rulesMetrics.caseContractSha);
const rulesContext = fs.readFileSync(path.join(rulesParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(rulesContext.includes('## 全局规则'));
assert.ok(rulesContext.includes('rule-001'));
assert.ok(rulesContext.includes('出现权限弹窗'));
assert.ok(rulesContext.includes('MATCHED'));
const rulesHtml = fs.readFileSync(path.join(rulesParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
assert.ok(rulesHtml.includes('全局规则'));
assert.ok(rulesHtml.includes('rule-001'));
assert.ok(rulesHtml.includes('规则命中'));
rulesCase.globalRules[0].when = '出现新的权限弹窗';
write(rulesCasePath, `${JSON.stringify(rulesCase, null, 2)}\n`);
run('node', ['scripts/render-context.js', rulesParsed.caseDir, '--platform', 'harmony']);
const changedRulesContext = fs.readFileSync(path.join(rulesParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(changedRulesContext.includes('出现新的权限弹窗'));
assert.ok(changedRulesContext.includes('尚未执行。'));
assert.ok(!changedRulesContext.includes('执行通过。'));
run('node', ['scripts/parse-case.js', rulesFile, '--cwd', workspace]);
const reparsedRulesCase = json(rulesCasePath);
assert.strictEqual(reparsedRulesCase.globalRules.length, 1);
assert.strictEqual(reparsedRulesCase.globalRules[0].when, '出现新的权限弹窗');
run('node', ['scripts/refresh-case.js', rulesParsed.caseDir]);
const refreshedRulesCase = json(rulesCasePath);
assert.strictEqual(refreshedRulesCase.globalRules.length, 1);
assert.strictEqual(refreshedRulesCase.globalRules[0].when, '出现新的权限弹窗');

const missingIntentFlow = runAllowFailure('node', ['scripts/flow/start-recording.js', '--name', '缺少意图', '--platform', 'harmony', '--cwd', workspace]);
assert.notStrictEqual(missingIntentFlow.status, 0);
assert.ok(missingIntentFlow.stderr.includes('必须提供 --intent'));
const missingPlatformFlow = runAllowFailure('node', ['scripts/flow/start-recording.js', '--name', '缺少平台', '--intent', '缺少平台', '--cwd', workspace]);
assert.notStrictEqual(missingPlatformFlow.status, 0);
assert.ok(missingPlatformFlow.stderr.includes('必须提供有效 --platform'));
const flowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '进入创作页', '--intent', '进入创作页,打开创作入口', '--platform', 'harmony', '--cwd', workspace]));
assert.ok(flowStarted.flowDir.includes('进入创作页__flow-'));
assert.ok(flowStarted.recordingId);
assert.strictEqual(flowStarted.flowScope, 'universal');
assert.strictEqual(flowStarted.recordingPlatform, 'harmony');
assert.strictEqual(flowStarted.platform, null);
const sameNameHarmonyFlow = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '同名平台 Flow', '--intent', '同名平台 Flow', '--platform', 'harmony', '--flow-scope', 'platform', '--cwd', workspace]));
const sameNameAndroidFlow = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '同名平台 Flow', '--intent', '同名平台 Flow', '--platform', 'android', '--flow-scope', 'platform', '--cwd', workspace]));
assert.notStrictEqual(sameNameHarmonyFlow.flowId, sameNameAndroidFlow.flowId);
assert.notStrictEqual(sameNameHarmonyFlow.flowDir, sameNameAndroidFlow.flowDir);
assert.strictEqual(sameNameHarmonyFlow.platform, 'harmony');
assert.strictEqual(sameNameAndroidFlow.platform, 'android');
assert.ok(fs.statSync(path.join(repo, 'scripts/flow/start-recording.js')).mode & 0o111);
assert.ok(fs.statSync(path.join(repo, 'scripts/flow/finalize-recording.js')).mode & 0o111);
const emptyFlowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '空录制', '--intent', '空录制', '--platform', 'harmony', '--cwd', workspace]));
const emptyReady = runAllowFailure('node', ['scripts/flow/finalize-recording.js', emptyFlowStarted.flowDir, '--recording-id', emptyFlowStarted.recordingId, '--status', 'READY']);
assert.notStrictEqual(emptyReady.status, 0);
assert.ok(emptyReady.stderr.includes('READY Flow requires at least one recorded step'));
const inheritedFlowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '继承环境', '--intent', '继承环境', '--cwd', workspace, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']));
fs.writeFileSync(fakeHdcLog, '');
const inheritedFlowObserve = JSON.parse(run('./scripts/flow/observe.sh', ['--flow-dir', inheritedFlowStarted.flowDir, '--recording-id', inheritedFlowStarted.recordingId, '--label', '001-before'], { env: fakeEnv }));
assert.strictEqual(inheritedFlowObserve.app.appId, 'com.example.demo');
assert.strictEqual(inheritedFlowObserve.app.inTargetApp, true);
const inheritedFlowAction = JSON.parse(run('./scripts/flow/action.sh', ['--flow-dir', inheritedFlowStarted.flowDir, '--recording-id', inheritedFlowStarted.recordingId, '--instruction', '启动目标 App', '--type', 'launchApp', '--settle-ms', '0'], { env: fakeEnv }));
assert.strictEqual(inheritedFlowAction.actionResult.ok, true);
const inheritedFlowLog = fs.readFileSync(fakeHdcLog, 'utf8');
assert.ok(inheritedFlowLog.includes('shell uitest dumpLayout'));
assert.ok(inheritedFlowLog.includes('shell uitest dumpLayout -p /data/local/tmp/mavt-001-before.json -m true -b com.example.demo'));
assert.ok(inheritedFlowLog.includes('shell uitest dumpLayout -p /data/local/tmp/mavt-001-before.json -m true'));
assert.ok(inheritedFlowLog.includes('shell uitest dumpLayout -p /data/local/tmp/mavt-001-before.json -b com.example.demo'));
assert.ok(inheritedFlowLog.includes('shell uitest dumpLayout -p /data/local/tmp/mavt-001-before.json'));
assert.ok(inheritedFlowLog.includes('-b com.example.demo'));
assert.ok(inheritedFlowLog.includes('shell aa start -b com.example.demo -a EntryAbility'));
const failedFlowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '失败录制', '--intent', '失败录制', '--cwd', workspace, '--platform', 'android', '--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'EntryAbility']));
write(path.join(failedFlowStarted.recordingDir, 'timeline.jsonl'), `${JSON.stringify({ time: '2026-01-01T00:00:00.000+08:00', type: 'flowRecordingStart', flowId: failedFlowStarted.flowId, recordingId: failedFlowStarted.recordingId, name: '失败录制', intent: ['失败录制'] })}\n${JSON.stringify({ time: '2026-01-01T00:00:01.000+08:00', type: 'observation', label: '001-before', artifacts: { screenshot: 'screenshots/001-before.png' } })}\n${JSON.stringify({ time: '2026-01-01T00:00:02.000+08:00', type: 'flowAction', humanInstruction: '点击失败入口', action: { type: 'tap', x: 1, y: 2, coordinateSource: 'layout', coordinateEvidence: '测试 bounds' }, actionResult: { type: 'actionResult', action: 'tap', ok: false, error: 'failed' } })}\n${JSON.stringify({ time: '2026-01-01T00:00:03.000+08:00', type: 'observation', label: '001-after', artifacts: { screenshot: 'screenshots/001-after.png' } })}\n`);
const failedFlowReady = runAllowFailure('node', ['scripts/flow/finalize-recording.js', failedFlowStarted.flowDir, '--recording-id', failedFlowStarted.recordingId, '--status', 'READY']);
assert.notStrictEqual(failedFlowReady.status, 0);
assert.ok(failedFlowReady.stderr.includes('READY Flow step action failed'));
const flowObserveBefore = JSON.parse(run('./scripts/flow/observe.sh', ['--flow-dir', flowStarted.flowDir, '--recording-id', flowStarted.recordingId, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--label', '001-before'], { env: fakeEnv }));
assert.strictEqual(flowObserveBefore.artifacts.screenshot, 'screenshots/001-before.png');
const flowAction = JSON.parse(run('./scripts/flow/action.sh', ['--flow-dir', flowStarted.flowDir, '--recording-id', flowStarted.recordingId, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility', '--instruction', '点击底部创作入口', '--type', 'tap', '--x', '520', '--y', '1800', '--target', '创作', '--coordinate-source', 'visual', '--target-bounds', '500,1760,560,1840', '--coordinate-evidence', '底部创作入口像素区域', '--success-hint', '进入创作页', '--settle-ms', '0'], { env: fakeEnv }));
assert.strictEqual(flowAction.type, 'flowAction');
assert.strictEqual(flowAction.humanInstruction, '点击底部创作入口');
assert.strictEqual(flowAction.actionResult.ok, true);
assert.strictEqual(flowAction.action.coordinateSource, 'visual');
assert.deepStrictEqual(flowAction.action.targetBounds, [500, 1760, 560, 1840]);
const flowObserveAfter = JSON.parse(run('./scripts/flow/observe.sh', ['--flow-dir', flowStarted.flowDir, '--recording-id', flowStarted.recordingId, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--label', '001-after'], { env: fakeEnv }));
assert.strictEqual(flowObserveAfter.artifacts.layout, 'layouts/001-after.json');
const flowFinalized = JSON.parse(run('node', ['scripts/flow/finalize-recording.js', flowStarted.flowDir, '--recording-id', flowStarted.recordingId, '--status', 'READY']));
assert.ok(fs.existsSync(flowFinalized.flowJson));
assert.ok(fs.existsSync(flowFinalized.flowMd));
const flowJson = json(flowFinalized.flowJson);
assert.strictEqual(flowJson.id, flowStarted.flowId);
assert.strictEqual(flowJson.status, 'READY');
assert.strictEqual(flowJson.flowScope, 'universal');
assert.strictEqual(flowJson.recordingPlatform, 'harmony');
assert.strictEqual(flowJson.platform, undefined);
assertLocalTime(flowJson.updatedAt);
assert.strictEqual(flowJson.steps.length, 1);
assert.strictEqual(flowJson.steps[0].humanInstruction, '点击底部创作入口');
assert.strictEqual(flowJson.steps[0].beforeObservation.screenshot, `recordings/${flowStarted.recordingId}/screenshots/001-before.png`);
assert.strictEqual(flowJson.steps[0].afterObservation.layout, `recordings/${flowStarted.recordingId}/layouts/001-after.json`);
assert.strictEqual(flowJson.steps[0].successHint, '进入创作页');
assert.strictEqual(flowJson.steps[0].action.coordinateSource, 'visual');
assert.deepStrictEqual(flowJson.steps[0].action.targetBounds, [500, 1760, 560, 1840]);
const flowMd = fs.readFileSync(flowFinalized.flowMd, 'utf8');
assert.ok(flowMd.includes('# 进入创作页'));
assert.ok(flowMd.includes('点击底部创作入口'));
const androidSpecificFlow = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '进入创作页-android', '--intent', '进入创作页,打开创作入口', '--platform', 'android', '--flow-scope', 'platform', '--cwd', workspace]));
assert.strictEqual(androidSpecificFlow.flowScope, 'platform');
assert.strictEqual(androidSpecificFlow.platform, 'android');
write(path.join(androidSpecificFlow.recordingDir, 'timeline.jsonl'), `${JSON.stringify({ time: '2026-01-01T00:00:00.000+08:00', type: 'flowRecordingStart', flowId: androidSpecificFlow.flowId, recordingId: androidSpecificFlow.recordingId, name: '进入创作页-android', intent: ['进入创作页', '打开创作入口'], recordingPlatform: 'android', flowScope: 'platform', platform: 'android' })}\n${JSON.stringify({ time: '2026-01-01T00:00:01.000+08:00', type: 'observation', label: '001-before', artifacts: { screenshot: 'screenshots/001-before.png' } })}\n${JSON.stringify({ time: '2026-01-01T00:00:02.000+08:00', type: 'flowAction', humanInstruction: '点击 Android 创作入口', action: { type: 'tap', x: 1, y: 2, coordinateSource: 'layout', coordinateEvidence: 'android bounds' }, actionResult: { type: 'actionResult', action: 'tap', ok: true }, successHint: '进入创作页' })}\n${JSON.stringify({ time: '2026-01-01T00:00:03.000+08:00', type: 'observation', label: '001-after', artifacts: { screenshot: 'screenshots/001-after.png' } })}\n`);
const androidSpecificFinalized = JSON.parse(run('node', ['scripts/flow/finalize-recording.js', androidSpecificFlow.flowDir, '--recording-id', androidSpecificFlow.recordingId, '--status', 'READY']));
const androidSpecificJson = json(androidSpecificFinalized.flowJson);
assert.strictEqual(androidSpecificJson.flowScope, 'platform');
assert.strictEqual(androidSpecificJson.recordingPlatform, 'android');
assert.strictEqual(androidSpecificJson.platform, 'android');
const listedFlows = JSON.parse(run('node', ['scripts/flow/list-flows.js', '--cwd', workspace]));
assert.ok(listedFlows.flows.length >= 2);
const genericListedFlow = listedFlows.flows.find((item) => item.flowId === flowStarted.flowId);
assert.strictEqual(genericListedFlow.status, 'READY');
assert.strictEqual(genericListedFlow.flowScope, 'universal');
assert.strictEqual(genericListedFlow.recordingPlatform, 'harmony');
assert.deepStrictEqual(genericListedFlow.intent, ['进入创作页', '打开创作入口']);
assert.deepStrictEqual(genericListedFlow.successHints, ['进入创作页']);
assert.strictEqual(genericListedFlow.steps.length, 1);
assert.strictEqual(genericListedFlow.steps[0].id, 'flow-step-001');
assert.strictEqual(genericListedFlow.steps[0].humanInstruction, '点击底部创作入口');
assert.strictEqual(genericListedFlow.steps[0].action.type, 'tap');
assert.strictEqual(genericListedFlow.steps[0].action.x, '520');
assert.strictEqual(genericListedFlow.steps[0].beforeObservation.screenshot, `recordings/${flowStarted.recordingId}/screenshots/001-before.png`);
const androidListedFlows = JSON.parse(run('node', ['scripts/flow/list-flows.js', '--cwd', workspace, '--platform', 'android']));
assert.strictEqual(androidListedFlows.flows[0].flowId, androidSpecificFlow.flowId);
assert.strictEqual(androidListedFlows.flows[0].platform, 'android');
assert.strictEqual(androidListedFlows.flows[0].flowScope, 'platform');
assert.strictEqual(androidListedFlows.flows[0].recordingPlatform, 'android');
assert.strictEqual(androidListedFlows.flows[0].platformSpecific, true);
const harmonyListedFlows = JSON.parse(run('node', ['scripts/flow/list-flows.js', '--cwd', workspace, '--platform', 'harmony']));
assert.ok(!harmonyListedFlows.flows.some((item) => item.flowId === androidSpecificFlow.flowId));
const allHarmonyListedFlows = JSON.parse(run('node', ['scripts/flow/list-flows.js', '--cwd', workspace, '--platform', 'harmony', '--all']));
assert.ok(allHarmonyListedFlows.flows.some((item) => item.flowId === androidSpecificFlow.flowId));

const flowCaseFile = path.join(sourceRoot, 'cases', 'flow-case.md');
write(flowCaseFile, `# Flow 执行测试

## 前置条件
- App 已安装。

## 步骤
1. 使用 ${flowStarted.flowId} 进入创作页。
`);
const flowCaseParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowCaseFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowCaseStart = JSON.parse(run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/flow/record-scan.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', flowCaseStart.executionId, '--step-id', 'step-001', '--matched-flow-ids', flowStarted.flowId, '--reason', '步骤需要进入创作页，命中已录制 Flow']);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  flowId: flowStarted.flowId,
  status: 'STARTED',
  stepId: 'step-001',
  reason: '当前步骤要求进入创作页',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  flowId: flowStarted.flowId,
  flowStepId: 'flow-step-001',
  status: 'STEP_COMPLETED',
  stepId: 'step-001',
  reason: '已参考录制路径点击创作入口',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  flowId: flowStarted.flowId,
  status: 'COMPLETED',
  stepId: 'step-001',
  reason: '已进入创作页',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'observation',
  label: 'flow-step-001-before',
  artifacts: {
    screenshot: 'screenshots/flow-step-001-before.png',
    layout: 'layouts/flow-step-001-before.json',
  },
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'observation',
  label: '002-after-flow-step-001',
  artifacts: {
    screenshot: 'screenshots/002-after-flow-step-001.png',
    layout: 'layouts/002-after-flow-step-001.json',
  },
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '看到创作页',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS']);
const flowCaseMetrics = json(path.join(flowCaseStart.execDir, 'metrics.json'));
assert.strictEqual(flowCaseMetrics.flows.totalEvents, 3);
assert.strictEqual(flowCaseMetrics.flows.scans, 1);
assert.strictEqual(flowCaseMetrics.flows.matched, 1);
assert.strictEqual(flowCaseMetrics.flows.completed, 1);
const flowCaseContext = fs.readFileSync(path.join(flowCaseParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(flowCaseContext.includes('## 业务路径 Flow'));
assert.ok(flowCaseContext.includes('Flow 扫描'));
assert.ok(flowCaseContext.includes(flowStarted.flowId));
assert.ok(flowCaseContext.includes('COMPLETED'));
const flowCaseHtml = fs.readFileSync(path.join(flowCaseParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.html'), 'utf8');
assert.ok(flowCaseHtml.includes('业务路径 Flow'));
assert.ok(flowCaseHtml.includes('Flow 扫描'));
assert.ok(flowCaseHtml.includes('已进入创作页'));
assert.ok(flowCaseHtml.includes('步骤复盘'));
assert.ok(flowCaseHtml.includes('未关联观察'));
assert.ok(flowCaseHtml.includes('flow-step-001-before.png'));
assert.ok(flowCaseHtml.includes('002-after-flow-step-001.png'));
const flowStepReviewCard = flowCaseHtml.match(/<article class="step-review-card">[\s\S]*?step-001[\s\S]*?<\/article>/)?.[0] || '';
assert.ok(!flowStepReviewCard.includes('flow-step-001-before.png'));
assert.ok(!flowStepReviewCard.includes('002-after-flow-step-001.png'));

const flowScanFailureFile = path.join(sourceRoot, 'cases', 'flow-scan-failure.md');
write(flowScanFailureFile, `# Flow 扫描失败事实测试

## 前置条件
- App 已安装。

## 步骤
1. 进入业务页。
`);
const flowScanFailureParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowScanFailureFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', flowScanFailureParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowScanFailureStart = JSON.parse(run('node', ['scripts/run-case.js', flowScanFailureParsed.caseDir, '--platform', 'harmony', '--start']));
const failedFlowScan = runAllowFailure('node', ['scripts/flow/record-scan.js', flowScanFailureParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', flowScanFailureStart.executionId, '--step-id', 'step-001', '--matched-flow-ids', 'flow-not-scanned', '--reason', '测试扫描失败']);
assert.notStrictEqual(failedFlowScan.status, 0);
assert.ok(failedFlowScan.stderr.includes('matched Flow 不在扫描结果中'));
const flowScanFailureEvents = fs.readFileSync(path.join(flowScanFailureStart.execDir, 'timeline.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
const failedScanEvent = flowScanFailureEvents.find((event) => event.type === 'flowScan' && event.status === 'FAILED');
assert.ok(failedScanEvent);
assert.strictEqual(failedScanEvent.source, 'list-flows');
assert.strictEqual(failedScanEvent.stepId, 'step-001');
assert.ok(failedScanEvent.reason.includes('matched Flow 不在扫描结果中'));
assert.deepStrictEqual(failedScanEvent.matchedFlowIds, []);
run('node', ['scripts/run-case.js', flowScanFailureParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-001', '--reason', '扫描失败后无法继续']);
const flowScanFailureResult = json(path.join(flowScanFailureStart.execDir, 'result.json'));
assert.strictEqual(flowScanFailureResult.status, 'BLOCKED');
assert.strictEqual(flowScanFailureResult.failureCode, 'ACTION_TARGET_NOT_FOUND');

const flowGuardFile = path.join(sourceRoot, 'cases', 'flow-guard.md');
write(flowGuardFile, `# Flow 扫描守卫测试

## 前置条件
- App 已安装。

## 步骤
1. 点击业务页按钮。
`);
const flowGuardParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', flowGuardParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/run-case.js', flowGuardParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-001', '--reason', '未找到业务按钮']);
const flowGuardResult = json(path.join(flowGuardStart.execDir, 'result.json'));
assert.strictEqual(flowGuardResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardResult.failureCode, 'FLOW_SCAN_MISSING');
assert.ok(flowGuardResult.reason.includes('Flow 扫描'));
const flowGuardStepFile = path.join(sourceRoot, 'cases', 'flow-guard-step.md');
write(flowGuardStepFile, `# Flow 扫描步骤关联守卫测试

## 前置条件
- App 已安装。

## 步骤
1. 进入业务页。
2. 点击业务页按钮。
`);
const flowGuardStepParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardStepFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', flowGuardStepParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardStepStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardStepParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/flow/record-scan.js', flowGuardStepParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', flowGuardStepStart.executionId, '--step-id', 'step-001', '--reason', '第一步已扫描 Flow']);
run('node', ['scripts/run-case.js', flowGuardStepParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-002', '--reason', '第二步未找到业务按钮']);
const flowGuardStepResult = json(path.join(flowGuardStepStart.execDir, 'result.json'));
assert.strictEqual(flowGuardStepResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardStepResult.failureCode, 'FLOW_SCAN_MISSING');
const flowGuardMatchedFile = path.join(sourceRoot, 'cases', 'flow-guard-matched.md');
write(flowGuardMatchedFile, `# Flow 命中未处理守卫测试

## 前置条件
- App 已安装。

## 步骤
1. 进入业务页。
`);
const flowGuardMatchedParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardMatchedFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', flowGuardMatchedParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardMatchedStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardMatchedParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/flow/record-scan.js', flowGuardMatchedParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', flowGuardMatchedStart.executionId, '--step-id', 'step-001', '--matched-flow-ids', flowStarted.flowId, '--reason', '命中 Flow 但未处理']);
run('node', ['scripts/run-case.js', flowGuardMatchedParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-001', '--reason', '未找到业务按钮']);
const flowGuardMatchedResult = json(path.join(flowGuardMatchedStart.execDir, 'result.json'));
assert.strictEqual(flowGuardMatchedResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardMatchedResult.failureCode, 'FLOW_MATCH_UNRESOLVED');
const flowGuardNoFailedStepParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardStepFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', flowGuardNoFailedStepParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardNoFailedStepStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardNoFailedStepParsed.caseDir, '--platform', 'harmony', '--start']));
run('node', ['scripts/flow/record-scan.js', flowGuardNoFailedStepParsed.caseDir, '--platform', 'harmony', '--cwd', workspace, '--execution-id', flowGuardNoFailedStepStart.executionId, '--step-id', 'step-001', '--reason', '第一步已扫描 Flow']);
run('node', ['scripts/run-case.js', flowGuardNoFailedStepParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--reason', '未传失败步骤']);
const flowGuardNoFailedStepResult = json(path.join(flowGuardNoFailedStepStart.execDir, 'result.json'));
assert.strictEqual(flowGuardNoFailedStepResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardNoFailedStepResult.failureCode, 'FLOW_SCAN_MISSING');

const budgetFile = path.join(sourceRoot, 'cases', 'budget.md');
write(budgetFile, `# 预算测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const budgetParsed = JSON.parse(run('node', ['scripts/parse-case.js', budgetFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', budgetParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const budgetStart = JSON.parse(run('node', ['scripts/run-case.js', budgetParsed.caseDir, '--platform', 'harmony', '--start']));
for (let i = 0; i < 80; i++) {
  run('node', ['scripts/run-case.js', budgetParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
    type: 'observation',
    label: `obs-${i}`,
    artifacts: { screenshot: `screenshots/obs-${i}.png` },
  })]);
}
const overBudget = runAllowFailure('node', ['scripts/run-case.js', budgetParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'observation',
  label: 'obs-80',
  artifacts: { screenshot: 'screenshots/obs-80.png' },
})]);
assert.strictEqual(overBudget.status, 3);
assert.ok(overBudget.stderr.includes('EXECUTION_BUDGET_EXCEEDED'));
const budgetState = json(path.join(budgetParsed.caseDir, 'platforms', 'harmony', 'state.json'));
assert.strictEqual(budgetState.latestStatus, 'BLOCKED');
assert.strictEqual(budgetState.latestFailureCode, 'EXECUTION_BUDGET_EXCEEDED');
const budgetExecState = json(path.join(budgetStart.execDir, 'execution.json'));
assert.strictEqual(budgetExecState.finalized, true);
const afterFinalized = runAllowFailure('node', ['scripts/run-case.js', budgetParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({ type: 'decision', decision: 'act' })]);
assert.notStrictEqual(afterFinalized.status, 0);
assert.ok(afterFinalized.stderr.includes('Execution already finalized'));

console.log(`self-test passed: ${tmp}`);
