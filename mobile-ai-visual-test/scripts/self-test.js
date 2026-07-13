#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { caseContractSha, formatDuration, displayFailureCode } = require('./common');

const repo = path.resolve(__dirname, '..');
process.env.MAVT_SELF_TEST = '1';
process.env.MAVT_SELF_TEST_SKIP_CASE_RESTART = '1';

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

function recordPreconditions(caseDir, platform, executionId, status = 'PASS', reason = 'self-test precondition satisfied') {
  const caseJson = json(path.join(caseDir, 'case.json'));
  for (const item of caseJson.preconditions || []) {
    const event = {
      type: 'precondition',
      id: item.id,
      status,
      reason,
      resolution: status === 'PREPARED' ? 'self_test_prepare' : 'self_test',
    };
    run('node', ['scripts/run-case.js', caseDir, '--platform', platform, '--record-json', JSON.stringify(event), '--execution-id', executionId]);
  }
}

function recordGlobalFlowScan(caseDir, platform, executionId, reason = 'self-test global Flow scan') {
  void caseDir;
  void platform;
  void executionId;
  void reason;
}

function ensureObservationArtifacts(caseDir, platform, executionId, event) {
  const execDir = path.join(caseDir, 'platforms', platform, 'executions', executionId);
  const artifacts = event.artifacts || {};
  const paths = [];
  if (artifacts.screenshot) paths.push(artifacts.screenshot);
  if (artifacts.layout) paths.push(artifacts.layout);
  if (Array.isArray(artifacts.logs)) paths.push(...artifacts.logs);
  for (const item of paths) {
    write(path.join(execDir, item), `self-test artifact: ${item}\n`);
  }
}

function recordObservationEvent(caseDir, platform, executionId, event) {
  const observation = { ...event, source: 'observe.sh' };
  ensureObservationArtifacts(caseDir, platform, executionId, observation);
  return run('node', ['scripts/run-case.js', caseDir, '--platform', platform, '--record-observation-json', JSON.stringify(observation), '--execution-id', executionId], {
    env: { ...process.env, MAVT_OBSERVATION_WRITER: '1' },
  });
}

function recordStepObservation(caseDir, platform, executionId, stepId, label = `${stepId}-evidence`) {
  const screenshot = `screenshots/${label}.png`;
  recordObservationEvent(caseDir, platform, executionId, {
    type: 'observation',
    stepId,
    label,
    artifacts: { screenshot },
  });
  return screenshot;
}

function recordPassAssertion(caseDir, platform, executionId, stepId, reason, evidence) {
  return run('node', ['scripts/run-case.js', caseDir, '--platform', platform, '--record-json', JSON.stringify({
    type: 'assertion',
    stepId,
    status: 'PASS',
    reason,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  }), '--execution-id', executionId]);
}

function recordActionResult(caseDir, platform, executionId, event) {
  const actionEvent = { source: 'action.sh', ...event };
  return run('node', ['scripts/run-case.js', caseDir, '--platform', platform, '--record-action-json', JSON.stringify(actionEvent), '--execution-id', executionId], {
    env: { ...process.env, MAVT_ACTION_WRITER: '1' },
  });
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
const parsedForIsolationContract = JSON.parse(run('node', ['scripts/parse-case.js', caseFile, '--cwd', workspace]));
assert.strictEqual(json(path.join(parsedForIsolationContract.caseDir, 'case.json')).isolation.requireCleanRestart, 'auto');
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
assert.strictEqual(noLoginCase.preconditions[0].checkMode, 'manual_context');
assert.notStrictEqual(caseContractSha(noLoginCase), caseContractSha({
  ...noLoginCase,
  preconditions: [
    ...noLoginCase.preconditions,
    { id: 'pre-999', text: '账号具备灰度资格。', checkMode: 'manual_context', hints: [] },
  ],
}));

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

const isolationNoteFile = path.join(sourceRoot, 'cases', 'isolation-note.md');
write(isolationNoteFile, `# 隔离补充测试

## 前置条件
- App 已安装。

## 步骤
1. 查看页面入口。
`);
const isolationNoteParsed = JSON.parse(run('node', ['scripts/parse-case.js', isolationNoteFile, '--cwd', workspace]));
run('node', ['scripts/apply-note.js', isolationNoteParsed.caseDir, '--type', 'isolation', '--text', '不需要冷启动，允许隔离降级执行']);
const isolationNoteCase = json(path.join(isolationNoteParsed.caseDir, 'case.json'));
assert.strictEqual(isolationNoteCase.isolation.requireCleanRestart, false);
assert.ok(isolationNoteCase.isolation.reason.includes('允许隔离降级'));

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

const preflightRiskFile = path.join(sourceRoot, 'cases', 'preflight-risk.md');
write(preflightRiskFile, `# 前置条件预检风险测试

## 前置条件
- 已有一篇草稿。
- 真实支付完成。

## 步骤
1. 预期看到订单详情。
`);
const preflightRiskParsed = JSON.parse(run('node', ['scripts/parse-case.js', preflightRiskFile, '--cwd', workspace]));
const preflight = JSON.parse(run('node', ['scripts/preflight-preconditions.js', noLoginParsed.caseDir, loosePreconditionsParsed.caseDir, preflightRiskParsed.caseDir, '--platform', 'harmony', '--cwd', workspace]));
const preflightRiskCaseNo = json(path.join(preflightRiskParsed.caseDir, 'case.json')).identity.caseNo;
assert.strictEqual(preflight.type, 'preconditionPreflight');
assert.strictEqual(preflight.summary.totalCases, 3);
assert.ok(preflight.groups.some((item) => item.status === 'READY' && item.text.includes('App 已安装')));
assert.ok(preflight.groups.some((item) => item.status === 'CONFIRM' && item.text.includes('已登录')));
assert.ok(preflight.groups.some((item) => item.status === 'CONFIRM' && item.text.includes('未登录')));
assert.ok(preflight.groups.some((item) => item.status === 'NEEDS_SETUP' && item.text.includes('草稿')));
assert.ok(preflight.groups.some((item) => item.status === 'UNSUPPORTED' && item.text.includes('真实支付')));
assert.strictEqual(preflight.cases.find((item) => item.caseNo === preflightRiskCaseNo).status, 'UNSUPPORTED');

run('node', ['scripts/update-env.js', noLoginParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const noLoginStart = JSON.parse(run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--platform', 'harmony', '--start']));
recordPreconditions(noLoginParsed.caseDir, 'harmony', noLoginStart.executionId);
recordGlobalFlowScan(noLoginParsed.caseDir, 'harmony', noLoginStart.executionId);
recordPassAssertion(noLoginParsed.caseDir, 'harmony', noLoginStart.executionId, 'step-001', '看到登录按钮', recordStepObservation(noLoginParsed.caseDir, 'harmony', noLoginStart.executionId, 'step-001', 'step-001-login'));
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', noLoginStart.executionId]);
indexHtml = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
assert.ok(indexHtml.indexOf('C001') < indexHtml.indexOf('C002'));
assert.ok(indexHtml.indexOf('C002') < indexHtml.indexOf('C003'));
assert.ok(indexHtml.includes('class="case-preconditions"'));
assert.ok(indexHtml.includes('class="precondition-tag confirm"'));
assert.ok(indexHtml.includes('<b>需确认</b><em>未登录。</em>'));
assert.ok(indexHtml.includes('class="precondition-tag needs_setup"'));
assert.ok(indexHtml.includes('<b>需准备</b><em>已有一篇草稿。</em>'));
assert.ok(indexHtml.includes('class="precondition-tag unsupported"'));
assert.ok(indexHtml.includes('<b>不支持</b><em>真实支付完成。</em>'));

const manyPreconditionsFile = path.join(sourceRoot, 'cases', 'many-preconditions.md');
write(manyPreconditionsFile, `# 多前置条件展示测试

## 前置条件
- 条件一已满足。
- 条件二已满足。
- 条件三已满足。
- 条件四已满足。
- 条件五已满足。
- 条件六已满足。

## 步骤
1. 预期看到首页。
`);
const manyPreconditionsParsed = JSON.parse(run('node', ['scripts/parse-case.js', manyPreconditionsFile, '--cwd', workspace]));
run('node', ['scripts/render-index.js', workspace]);
const manyPreconditionsIndex = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
assert.ok(manyPreconditionsIndex.includes('<b>需确认</b><em>条件五已满足。</em>'));
assert.ok(!manyPreconditionsIndex.includes('<b>需确认</b><em>条件六已满足。</em>'));
assert.ok(manyPreconditionsIndex.includes('还有 1 条前置条件'));
assert.ok(manyPreconditionsParsed.caseDir.includes('多前置条件展示测试'));

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
recordPreconditions(multiPlatformParsed.caseDir, 'harmony', harmonyPlatformStart.executionId);
recordGlobalFlowScan(multiPlatformParsed.caseDir, 'harmony', harmonyPlatformStart.executionId);
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
recordPreconditions(multiPlatformParsed.caseDir, 'android', androidPlatformStart.executionId);
recordGlobalFlowScan(multiPlatformParsed.caseDir, 'android', androidPlatformStart.executionId);
recordPassAssertion(multiPlatformParsed.caseDir, 'android', androidPlatformStart.executionId, 'step-001', 'Android 看到首页', recordStepObservation(multiPlatformParsed.caseDir, 'android', androidPlatformStart.executionId, 'step-001', 'step-001-android-home'));
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
assert.ok(!indexHtml.includes('<div class="pass-rate"><span>通过率</span><b>'));
assert.ok(indexHtml.includes('<span class="platform-pass-rate"><em>通过率</em><b>100%</b>'));
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
recordPreconditions(partialPlatformParsed.caseDir, 'harmony', partialHarmonyStart.executionId);
recordGlobalFlowScan(partialPlatformParsed.caseDir, 'harmony', partialHarmonyStart.executionId);
recordPassAssertion(partialPlatformParsed.caseDir, 'harmony', partialHarmonyStart.executionId, 'step-001', 'Harmony 看到首页', recordStepObservation(partialPlatformParsed.caseDir, 'harmony', partialHarmonyStart.executionId, 'step-001', 'step-001-harmony-home'));
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
assert.strictEqual(probeNoHdc.ready, false);
assert.ok(probeNoHdc.diagnostics.some((item) => item.id === 'hdcMissing' && item.level === 'ERROR'));
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
  type: 'precondition',
  id: 'pre-001',
  status: 'PASS',
  reason: '重复确认 App 已安装',
})]);
recordGlobalFlowScan(parsed.caseDir, 'harmony', started.executionId);
recordObservationEvent(parsed.caseDir, 'harmony', started.executionId, {
  type: 'observation',
  stepId: 'step-001',
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
});
run('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'decision',
  stepId: 'step-001',
  decision: 'act',
  reason: '需要打开 App',
})]);
recordActionResult(parsed.caseDir, 'harmony', started.executionId, {
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
});
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
assert.strictEqual(metrics.actions.restartApp, 0);
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
assert.ok(refreshedHtml.includes('源用例、执行契约或前置条件 Flow 已变更'));
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
recordPreconditions(parsed.caseDir, 'harmony', currentSourceStart.executionId);
recordGlobalFlowScan(parsed.caseDir, 'harmony', currentSourceStart.executionId);
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
recordPreconditions(parsed.caseDir, 'harmony', invalidStart.executionId);
recordGlobalFlowScan(parsed.caseDir, 'harmony', invalidStart.executionId);
const invalidEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({ type: 'observation', label: 'bad', scope: 'global', artifacts: { screenshot: '../bad.png' } }), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(invalidEvent.status, 0);
assert.ok(invalidEvent.stderr.includes('Invalid artifact path'));
const forgedObservationEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'observation',
  scope: 'global',
  label: 'forged-observation',
  source: 'observe.sh',
  artifacts: { screenshot: 'screenshots/forged-observation.png' },
}), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(forgedObservationEvent.status, 0);
assert.ok(forgedObservationEvent.stderr.includes('OBSERVATION_SOURCE_REQUIRED'));
const missingActionSourceEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
}), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(missingActionSourceEvent.status, 0);
assert.ok(missingActionSourceEvent.stderr.includes('ACTION_RESULT_SOURCE_REQUIRED'));
const forgedActionSourceEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  source: 'action.sh',
  action: 'launchApp',
  ok: true,
}), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(forgedActionSourceEvent.status, 0);
assert.ok(forgedActionSourceEvent.stderr.includes('ACTION_RESULT_SOURCE_REQUIRED'));
const stepActionWithoutFlowScan = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-action-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  source: 'action.sh',
  action: 'tap',
  ok: true,
}), '--execution-id', invalidStart.executionId], { env: { ...process.env, MAVT_ACTION_WRITER: '1' } });
assert.strictEqual(stepActionWithoutFlowScan.status, 0);
const invalidCoordinateEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  source: 'action.sh',
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
  source: 'action.sh',
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

const preconditionTerminalFile = path.join(sourceRoot, 'cases', 'precondition-terminal.md');
write(preconditionTerminalFile, `# 前置条件终态自动收尾测试

## 前置条件
- 真实支付完成。

## 步骤
1. 预期看到支付成功页。
`);
const preconditionTerminalParsed = JSON.parse(run('node', ['scripts/parse-case.js', preconditionTerminalFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', preconditionTerminalParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const preconditionTerminalStart = JSON.parse(run('node', ['scripts/run-case.js', preconditionTerminalParsed.caseDir, '--platform', 'harmony', '--start']));
const unknownPreconditionId = runAllowFailure('node', ['scripts/run-case.js', preconditionTerminalParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-999',
  status: 'BLOCKED',
  reason: '未知前置条件 id 不应触发收尾',
}), '--execution-id', preconditionTerminalStart.executionId]);
assert.notStrictEqual(unknownPreconditionId.status, 0);
assert.ok(unknownPreconditionId.stderr.includes('PRECONDITION_REQUIRED'));
assert.ok(!fs.existsSync(path.join(preconditionTerminalStart.execDir, 'result.json')));
recordPreconditions(preconditionTerminalParsed.caseDir, 'harmony', preconditionTerminalStart.executionId, 'BLOCKED', '前置条件不支持自动处理');
const preconditionTerminalResult = json(path.join(preconditionTerminalStart.execDir, 'result.json'));
assert.strictEqual(preconditionTerminalResult.status, 'BLOCKED');
assert.strictEqual(preconditionTerminalResult.failureCode, 'PRECONDITION_UNSUPPORTED');
assert.strictEqual(json(path.join(preconditionTerminalStart.execDir, 'execution.json')).finalized, true);

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
const missingPrecondition = runAllowFailure('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '未写前置条件就进入步骤',
}), '--execution-id', passStart.executionId]);
assert.notStrictEqual(missingPrecondition.status, 0);
assert.ok(missingPrecondition.stderr.includes('PRECONDITION_REQUIRED'));
recordPreconditions(passParsed.caseDir, 'harmony', passStart.executionId);
const assertionStillNeedsEvidenceWithoutFlowScan = runAllowFailure('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '步骤不再需要 FlowScan，但仍然需要观察证据',
}), '--execution-id', passStart.executionId]);
assert.notStrictEqual(assertionStillNeedsEvidenceWithoutFlowScan.status, 0);
assert.ok(assertionStillNeedsEvidenceWithoutFlowScan.stderr.includes('ASSERTION_EVIDENCE_REQUIRED'));
recordGlobalFlowScan(passParsed.caseDir, 'harmony', passStart.executionId);
const passSkipStep = runAllowFailure('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-002',
  status: 'PASS',
  reason: '试图跳过第一步',
}), '--execution-id', passStart.executionId]);
assert.notStrictEqual(passSkipStep.status, 0);
assert.ok(passSkipStep.stderr.includes('STEP_ORDER_VIOLATION'));
assert.ok(!fs.existsSync(path.join(passStart.execDir, 'result.json')));
const restartWithStepIdAction = runAllowFailure('./scripts/action.sh', ['--case-dir', passParsed.caseDir, '--platform', 'harmony', '--execution-id', passStart.executionId, '--step-id', 'step-001', '--type', 'restartApp', '--settle-ms', '0']);
assert.notStrictEqual(restartWithStepIdAction.status, 0);
assert.ok(restartWithStepIdAction.stderr.includes('STEP_ORDER_VIOLATION'));
const restartWithStepIdRecord = runAllowFailure('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--record-action-json', JSON.stringify({
  source: 'action.sh',
  type: 'actionResult',
  stepId: 'step-001',
  action: 'restartApp',
  ok: true,
}), '--execution-id', passStart.executionId], { env: { ...process.env, MAVT_ACTION_WRITER: '1' } });
assert.notStrictEqual(restartWithStepIdRecord.status, 0);
assert.ok(restartWithStepIdRecord.stderr.includes('STEP_ORDER_VIOLATION'));
const passNakedAssertion = runAllowFailure('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '没有引用观察证据的裸断言',
}), '--execution-id', passStart.executionId]);
assert.notStrictEqual(passNakedAssertion.status, 0);
assert.ok(passNakedAssertion.stderr.includes('ASSERTION_EVIDENCE_REQUIRED'));
recordActionResult(passParsed.caseDir, 'harmony', passStart.executionId, {
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
});
const passMissingEvidence = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', passStart.executionId]));
assert.ok(fs.existsSync(passMissingEvidence.result));
const passMissingEvidenceResult = json(path.join(passStart.execDir, 'result.json'));
assert.strictEqual(passMissingEvidenceResult.status, 'FAIL');
assert.strictEqual(passMissingEvidenceResult.requestedStatus, 'PASS');
assert.strictEqual(passMissingEvidenceResult.failureCode, 'ASSERTION_UNKNOWN');
assert.strictEqual(json(path.join(passStart.execDir, 'execution.json')).finalized, true);
const passHtml = fs.readFileSync(path.join(passParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(passHtml.includes('预期看到首页'));
assert.ok(!passHtml.match(/预期看到首页[\s\S]*?<span class="pill pass">通过<\/span>/));
const passSuccessStart = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--start']));
recordPreconditions(passParsed.caseDir, 'harmony', passSuccessStart.executionId);
recordGlobalFlowScan(passParsed.caseDir, 'harmony', passSuccessStart.executionId);
recordActionResult(passParsed.caseDir, 'harmony', passSuccessStart.executionId, {
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
});
const paceEvidence = recordStepObservation(passParsed.caseDir, 'harmony', passSuccessStart.executionId, 'step-001', 'step-001-after');
const repeatedObservePrecheck = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--check-budget', '--event-type', 'observation', '--step-id', 'step-001', '--execution-id', passSuccessStart.executionId]));
assert.strictEqual(repeatedObservePrecheck.budgetOk, true);
assert.strictEqual(repeatedObservePrecheck.paceHint?.level, 'WARN');
assert.strictEqual(repeatedObservePrecheck.paceHint?.suggestedNextAction, 'assert_or_act');
recordPassAssertion(passParsed.caseDir, 'harmony', passSuccessStart.executionId, 'step-001', 'App 已打开，当前页面满足第一步目标', paceEvidence);
recordPassAssertion(passParsed.caseDir, 'harmony', passSuccessStart.executionId, 'step-002', '看到首页', recordStepObservation(passParsed.caseDir, 'harmony', passSuccessStart.executionId, 'step-002', 'step-002-after'));
run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', passSuccessStart.executionId]);
const passResult = json(path.join(passSuccessStart.execDir, 'result.json'));
assert.strictEqual(passResult.status, 'PASS');
const passStateBefore = json(path.join(passParsed.caseDir, 'platforms', 'harmony', 'state.json'));
const duplicateFinalize = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', passSuccessStart.executionId]));
assert.strictEqual(duplicateFinalize.alreadyFinalized, true);
const passStateAfter = json(path.join(passParsed.caseDir, 'platforms', 'harmony', 'state.json'));
assert.strictEqual(passStateAfter.executionCount, passStateBefore.executionCount);
indexHtml = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
assert.ok(indexHtml.includes('通过证据测试'));
assert.ok(indexHtml.includes('通过'));
assert.ok(!indexHtml.includes('关键信息'));
assert.ok(indexHtml.includes('class="platform-overview"'));
assert.ok(indexHtml.includes('class="platform-status-grid"'));
assert.ok(indexHtml.includes('class="platform-pass-rate"'));
assert.ok(indexHtml.includes('grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px'));
assert.ok(indexHtml.includes('min-height: 132px'));
assert.ok(indexHtml.includes('padding: 16px 18px'));
assert.ok(indexHtml.includes('font-size: 18px; line-height: 1.1'));
assert.ok(!indexHtml.includes('class="overview-panel"'));
assert.ok(indexHtml.includes('<em>通过率</em><b>'));
assert.ok(!indexHtml.includes('class="pass-rate"'));
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
assert.ok(!indexHtml.includes('PASS 缺少步骤证据'));
assert.ok(!indexHtml.includes('PRECONDITION_NOT_MET'));
assert.strictEqual(displayFailureCode('PRECONDITION_NOT_MET'), '前置条件不满足');
assert.ok(!indexHtml.includes('<span>执行结果</span>ASSERTION_UNKNOWN'));
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
recordPreconditions(unknownParsed.caseDir, 'harmony', unknownStart.executionId);
recordGlobalFlowScan(unknownParsed.caseDir, 'harmony', unknownStart.executionId);
run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'UNKNOWN',
  reason: '证据不足',
}), '--execution-id', unknownStart.executionId]);
run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--failed-step', 'step-001', '--execution-id', unknownStart.executionId]);
const unknownResult = json(path.join(unknownStart.execDir, 'result.json'));
assert.strictEqual(unknownResult.status, 'FAIL');
assert.strictEqual(unknownResult.requestedStatus, 'UNKNOWN');
assert.strictEqual(unknownResult.failureCode, 'ASSERTION_UNKNOWN');
const unknownMetrics = json(path.join(unknownStart.execDir, 'metrics.json'));
assert.strictEqual(unknownMetrics.steps.failed, 0);
assert.strictEqual(unknownMetrics.steps.unknown, 1);

const blockingPriorityFile = path.join(sourceRoot, 'cases', 'blocking-priority.md');
write(blockingPriorityFile, `# 阻塞优先级测试

## 前置条件
- App 已安装。

## 步骤
1. 预期看到首页。
`);
const blockingPriorityParsed = JSON.parse(run('node', ['scripts/parse-case.js', blockingPriorityFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', blockingPriorityParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const blockingPriorityStart = JSON.parse(run('node', ['scripts/run-case.js', blockingPriorityParsed.caseDir, '--platform', 'harmony', '--start']));
recordPreconditions(blockingPriorityParsed.caseDir, 'harmony', blockingPriorityStart.executionId);
recordGlobalFlowScan(blockingPriorityParsed.caseDir, 'harmony', blockingPriorityStart.executionId);
run('node', ['scripts/run-case.js', blockingPriorityParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'UNKNOWN',
  reason: '先记录一个证据不足断言',
}), '--execution-id', blockingPriorityStart.executionId]);
run('node', ['scripts/run-case.js', blockingPriorityParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'BLOCKED', '--failure-code', 'TOOL_ERROR', '--failed-step', 'step-001', '--reason', '随后工具失败应优先归为阻塞', '--execution-id', blockingPriorityStart.executionId]);
const blockingPriorityResult = json(path.join(blockingPriorityStart.execDir, 'result.json'));
assert.strictEqual(blockingPriorityResult.status, 'BLOCKED');
assert.strictEqual(blockingPriorityResult.failureCode, 'TOOL_ERROR');

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
state_file="\${ADB_STATE:-}"
if [[ -z "$state_file" ]]; then
  state_file="$(dirname "$ADB_LOG")/fake-adb-state"
fi
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
  mkdir -p "$(dirname "$state_file")"
  printf '34567\\n' > "$state_file"
  printf 'Starting: Intent { cmp=%s }\\n' "\${args[4]:-}"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "am" && "\${args[2]:-}" == "force-stop" ]]; then
  if [[ "\${ADB_FORCE_STOP_FAIL:-}" == "1" ]]; then
    printf 'Failure [not stopped]\\n' >&2
    exit 1
  fi
  mkdir -p "$(dirname "$state_file")"
  : > "$state_file"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "am" && "\${args[2]:-}" == "broadcast" ]]; then
  printf 'Broadcast completed: result=-1, data="OK"\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "monkey" ]]; then
  mkdir -p "$(dirname "$state_file")"
  printf '45678\\n' > "$state_file"
  printf 'Events injected: 1\\n'
elif [[ "\${args[0]:-}" == "logcat" ]]; then
  printf 'fake android log\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "pidof" ]]; then
  if [[ -s "$state_file" ]]; then
    cat "$state_file"
  else
    exit 1
  fi
fi
`);
fs.chmodSync(fakeAdb, 0o755);
const fakeAdbState = path.join(tmp, 'fake-adb-state');
const fakeAndroidImeCache = path.join(tmp, 'fake-android-ime-cache');
write(path.join(fakeAndroidImeCache, 'mavt-input.apk'), 'fake apk\n');
write(path.join(fakeAndroidImeCache, 'source.sha256'), treeSha256(path.join(repo, 'scripts/platform/adapters/android/ime')));
const fakeAndroidEnv = {
  ...process.env,
  PATH: `${fakeAndroidBin}:${process.env.PATH}`,
  ADB_LOG: fakeAdbLog,
  ADB_STATE: fakeAdbState,
  MAVT_ACTION_SETTLE_MS: '0',
  MAVT_ANDROID_IME_BUILD_DIR: fakeAndroidImeCache,
};

const androidProbe = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'android'], { env: fakeAndroidEnv }));
assert.strictEqual(androidProbe.platform, 'android');
assert.deepStrictEqual(androidProbe.targets, ['emulator-5554']);
assert.strictEqual(androidProbe.ready, true);
assert.ok(Array.isArray(androidProbe.diagnostics));
assert.ok(!androidProbe.diagnostics.some((item) => item.level === 'ERROR'));
assert.strictEqual(androidProbe.capabilities.adb, true);
assert.strictEqual(androidProbe.capabilities.screenshot, true);
assert.strictEqual(androidProbe.capabilities.layout, true);
assert.strictEqual(androidProbe.capabilities.foregroundApp, true);
assert.strictEqual(androidProbe.capabilities.launchApp, true);
assert.ok(androidProbe.capabilities.actions.includes('restartApp'));
assert.ok(androidProbe.capabilities.actions.includes('tap'));
assert.ok(androidProbe.capabilities.actions.includes('longPress'));
assert.ok(androidProbe.capabilities.actions.includes('inputText'));
assert.ok(androidProbe.capabilities.dependencies.some((item) => item.id === 'mavtInputIme'));
const androidProbeNoAdb = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'android'], { env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/bin:/usr/bin` } }));
assert.strictEqual(androidProbeNoAdb.ready, false);
assert.ok(androidProbeNoAdb.diagnostics.some((item) => item.id === 'adbMissing' && item.level === 'ERROR'));

const androidLaunchFallback = JSON.parse(run('./scripts/platform/adapters/android/atoms/launch-app.sh', ['--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'PrivateActivity'], { env: fakeAndroidEnv }));
assert.strictEqual(androidLaunchFallback.action, 'launchApp');
assert.strictEqual(androidLaunchFallback.ok, true);
assert.strictEqual(androidLaunchFallback.launchMethod, 'monkey-fallback');
assert.ok(androidLaunchFallback.fallbackReason.includes('not exported'));

fs.writeFileSync(fakeAdbState, '23456\n');
const androidRestart = JSON.parse(run('./scripts/platform/adapters/android/atoms/restart-app.sh', ['--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'MainActivity'], { env: fakeAndroidEnv }));
assert.strictEqual(androidRestart.action, 'restartApp');
assert.strictEqual(androidRestart.ok, true);
assert.strictEqual(androidRestart.restart, true);
assert.strictEqual(androidRestart.coldStartVerified, true);
assert.strictEqual(androidRestart.oldPid, '23456');
assert.strictEqual(androidRestart.newPid, '34567');
assert.strictEqual(androidRestart.stopMethod, 'am-force-stop');

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
recordPreconditions(androidParsed.caseDir, 'android', androidStart.executionId);
recordGlobalFlowScan(androidParsed.caseDir, 'android', androidStart.executionId);
const androidObservation = JSON.parse(run('./scripts/observe.sh', ['--case-dir', androidParsed.caseDir, '--platform', 'android', '--execution-id', androidStart.executionId, '--step-id', 'step-001', '--label', 'step-001-before'], { env: fakeAndroidEnv }));
assert.strictEqual(androidObservation.platform, 'android');
assert.strictEqual(androidObservation.label, '001-step-001-before');
assert.strictEqual(androidObservation.artifacts.screenshot, 'screenshots/001-step-001-before.png');
assert.strictEqual(androidObservation.artifacts.layout, 'layouts/001-step-001-before.xml');
assert.strictEqual(androidObservation.app.foregroundApp, 'com.example.demo');
assert.strictEqual(androidObservation.app.entry, 'MainActivity');
assert.strictEqual(androidObservation.app.inTargetApp, true);
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

const fakeIosEnv = {
  ...process.env,
  MAVT_IOS_FAKE: '1',
  MAVT_ACTION_SETTLE_MS: '0',
};
const fakeIosDevice = '00000000-0000-0000-0000-000000000000';
const iosProbe = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'ios', '--device', fakeIosDevice], { env: fakeIosEnv }));
assert.strictEqual(iosProbe.platform, 'ios');
assert.deepStrictEqual(iosProbe.targets, [fakeIosDevice]);
assert.strictEqual(iosProbe.capabilities.connector, 'appium-xcuitest');
assert.strictEqual(iosProbe.capabilities.deviceType, 'simulator');
assert.strictEqual(iosProbe.capabilities.implemented, true);
assert.strictEqual(iosProbe.capabilities.screenshot, true);
assert.strictEqual(iosProbe.capabilities.layout, true);
assert.strictEqual(iosProbe.capabilities.foregroundApp, true);
assert.strictEqual(iosProbe.ready, true);
assert.ok(Array.isArray(iosProbe.diagnostics));
assert.ok(!iosProbe.diagnostics.some((item) => item.level === 'ERROR'));
assert.ok(iosProbe.capabilities.actions.includes('restartApp'));
assert.ok(iosProbe.capabilities.actions.includes('tap'));
assert.ok(iosProbe.capabilities.actions.includes('toggle'));
assert.ok(iosProbe.capabilities.actions.includes('longPress'));
assert.ok(iosProbe.capabilities.actions.includes('inputText'));
assert.ok(iosProbe.capabilities.actions.includes('swipe'));
assert.ok(iosProbe.capabilities.actions.includes('back'));
assert.ok(iosProbe.capabilities.actions.includes('home'));
assert.ok(iosProbe.capabilities.actions.includes('wait'));
assert.strictEqual(iosProbe.capabilities.logs, true);

const iosRealDeviceProbe = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'ios', '--device', fakeIosDevice, '--device-type', 'realDevice'], { env: fakeIosEnv }));
assert.strictEqual(iosRealDeviceProbe.capabilities.deviceType, 'realDevice');
assert.strictEqual(iosRealDeviceProbe.capabilities.logs, false);
assert.strictEqual(iosRealDeviceProbe.ready, true);
assert.ok(iosRealDeviceProbe.diagnostics.some((item) => item.id === 'iosRealDeviceLogsUnavailable' && item.level === 'WARN'));

const iosRestart = JSON.parse(run('./scripts/platform/adapters/ios/atoms/restart-app.sh', ['--device', fakeIosDevice, '--app', 'com.example.demo'], { env: fakeIosEnv }));
assert.strictEqual(iosRestart.action, 'restartApp');
assert.strictEqual(iosRestart.ok, true);
assert.strictEqual(iosRestart.restart, true);
assert.strictEqual(iosRestart.coldStartVerified, true);
assert.strictEqual(iosRestart.verification, 'fake-appium-app-state');
assert.strictEqual(iosRestart.stateAfterTerminate, 1);
assert.strictEqual(iosRestart.stateAfterActivate, 4);

const iosFile = path.join(sourceRoot, 'cases', 'ios.md');
write(iosFile, `# iOS 适配测试

## 前置条件
- App 已安装。

## 步骤
1. 点击「登录」。
`);
const iosParsed = JSON.parse(run('node', ['scripts/parse-case.js', iosFile, '--cwd', workspace]));
run('node', [
  'scripts/update-env.js',
  iosParsed.caseDir,
  '--platform', 'ios',
  '--device', fakeIosDevice,
  '--app', 'com.example.demo',
  '--device-type', 'realDevice',
  '--xcode-org-id', 'TEAM123456',
  '--xcode-signing-id', 'Apple Development',
  '--updated-wda-bundle-id', 'com.example.WebDriverAgentRunner',
  '--allow-provisioning-device-registration',
  '--wda-launch-timeout', '180000',
  '--show-xcode-log', 'false',
  '--use-new-wda', 'true',
]);
const iosStateBeforePrepare = json(path.join(iosParsed.caseDir, 'platforms', 'ios', 'state.json'));
assert.strictEqual(iosStateBeforePrepare.environment.entry, undefined);
assert.strictEqual(iosStateBeforePrepare.environment.deviceType, 'realDevice');
assert.strictEqual(iosStateBeforePrepare.environment.xcodeOrgId, 'TEAM123456');
assert.strictEqual(iosStateBeforePrepare.environment.xcodeSigningId, 'Apple Development');
assert.strictEqual(iosStateBeforePrepare.environment.updatedWDABundleId, 'com.example.WebDriverAgentRunner');
assert.strictEqual(iosStateBeforePrepare.environment.allowProvisioningDeviceRegistration, true);
assert.strictEqual(iosStateBeforePrepare.environment.wdaLaunchTimeout, '180000');
assert.strictEqual(iosStateBeforePrepare.environment.showXcodeLog, false);
assert.strictEqual(iosStateBeforePrepare.environment.useNewWDA, true);
const iosStartBeforePrepare = runAllowFailure('node', ['scripts/run-case.js', iosParsed.caseDir, '--platform', 'ios', '--start']);
assert.notStrictEqual(iosStartBeforePrepare.status, 0);
assert.ok(iosStartBeforePrepare.stderr.includes('iosAutomation'));
const iosPrepare = JSON.parse(run('./scripts/prepare-env.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios'], { env: fakeIosEnv }));
assert.strictEqual(iosPrepare.ok, true);
assert.ok(iosPrepare.dependencies.some((item) => item.id === 'iosAutomation' && item.ok));
const iosPreparedState = json(path.join(iosParsed.caseDir, 'platforms', 'ios', 'state.json'));
assert.strictEqual(iosPreparedState.dependencies.iosAutomation.ok, true);
const iosStart = JSON.parse(run('node', ['scripts/run-case.js', iosParsed.caseDir, '--platform', 'ios', '--start']));
assert.ok(iosStart.execDir.includes('/platforms/ios/executions/'));
recordPreconditions(iosParsed.caseDir, 'ios', iosStart.executionId);
recordGlobalFlowScan(iosParsed.caseDir, 'ios', iosStart.executionId);
const iosObservation = JSON.parse(run('./scripts/observe.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--label', 'step-001-before'], { env: fakeIosEnv }));
assert.strictEqual(iosObservation.platform, 'ios');
assert.strictEqual(iosObservation.label, '001-step-001-before');
assert.strictEqual(iosObservation.artifacts.screenshot, 'screenshots/001-step-001-before.png');
assert.strictEqual(iosObservation.artifacts.layout, 'layouts/001-step-001-before.xml');
assert.strictEqual(iosObservation.app.foregroundApp, 'com.example.demo');
assert.strictEqual(iosObservation.app.entry, null);
assert.strictEqual(iosObservation.app.inTargetApp, true);
const iosAction = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '10', '--y', '20', '--coordinate-source', 'layout', '--target-bounds', '8,18,12,22', '--coordinate-evidence', 'ios xcuitest frame', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosAction.platform, 'ios');
assert.strictEqual(iosAction.action, 'tap');
assert.strictEqual(iosAction.ok, true);
assert.strictEqual(iosAction.coordinateSource, 'layout');
const iosToggle = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'toggle', '--x', '12', '--y', '22', '--coordinate-source', 'layout', '--target-bounds', '8,18,16,26', '--coordinate-evidence', 'ios xcuitest switch frame', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosToggle.action, 'toggle');
assert.strictEqual(iosToggle.ok, true);
assert.strictEqual(iosToggle.coordinateSource, 'layout');
const iosLongPress = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'longPress', '--x', '30', '--y', '40', '--duration-ms', '900', '--coordinate-source', 'layout', '--target-bounds', '20,30,40,50', '--coordinate-evidence', 'ios xcuitest long press frame', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosLongPress.action, 'longPress');
assert.strictEqual(iosLongPress.ok, true);
assert.strictEqual(iosLongPress.durationMs, 900);
const iosSwipe = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'swipe', '--from-x', '30', '--from-y', '200', '--to-x', '30', '--to-y', '80', '--duration-ms', '300', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosSwipe.action, 'swipe');
assert.strictEqual(iosSwipe.ok, true);
const iosInput = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'inputText', '--text', '中文输入', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosInput.action, 'inputText');
assert.strictEqual(iosInput.ok, true);
assert.strictEqual(iosInput.inputMethod, 'wda-set-value');
const iosInputWithCoordinates = runAllowFailure('./scripts/platform/adapters/ios/action.sh', ['--device', fakeIosDevice, '--app', 'com.example.demo', '--type', 'inputText', '--x', '1', '--y', '2', '--text', 'hello'], { env: fakeIosEnv });
assert.notStrictEqual(iosInputWithCoordinates.status, 0);
assert.ok(iosInputWithCoordinates.stderr.includes('iOS inputText 只向已聚焦输入框输入文本'));
const iosWait = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'wait', '--ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosWait.action, 'wait');
assert.strictEqual(iosWait.ok, true);
assert.strictEqual(iosWait.ms, 0);
const iosBack = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'back', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosBack.action, 'back');
assert.strictEqual(iosBack.ok, true);
const iosHome = JSON.parse(run('./scripts/action.sh', ['--case-dir', iosParsed.caseDir, '--platform', 'ios', '--execution-id', iosStart.executionId, '--step-id', 'step-001', '--type', 'home', '--settle-ms', '0'], { env: fakeIosEnv }));
assert.strictEqual(iosHome.action, 'home');
assert.strictEqual(iosHome.ok, true);
run('node', ['scripts/run-case.js', iosParsed.caseDir, '--platform', 'ios', '--finalize', '--status', 'UNKNOWN', '--reason', 'iOS adapter smoke test complete', '--execution-id', iosStart.executionId]);

const fakeBin = path.join(tmp, 'fake-bin');
const fakeHdcLog = path.join(tmp, 'fake-hdc.log');
const fakeHdcRemote = path.join(tmp, 'fake-hdc-remote');
const fakeHdcState = path.join(tmp, 'fake-hdc-state');
const fakeHdc = path.join(fakeBin, 'hdc');
write(fakeHdc, `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "\${args[0]:-}" == "-t" ]]; then
  args=("\${args[@]:2}")
fi
printf '%s\\n' "\${args[*]}" >> "$HDC_LOG"
state_file="\${HDC_STATE:-$HDC_REMOTE_DIR/state}"
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
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "aa" && "\${args[2]:-}" == "force-stop" ]]; then
  if [[ "\${HDC_FORCE_STOP_FAIL:-}" == "1" ]]; then
    printf 'error: failed to force stop process.\\nError Code:10104002\\n' >&2
    exit 1
  fi
  if [[ "\${args[3]:-}" == "-b" ]]; then
    printf 'error: failed to force stop process.\\nError Code:10104002  Error Message:Failed to retrieve specified package information.\\n'
    exit 0
  fi
  mkdir -p "$(dirname "$state_file")"
  : > "$state_file"
  printf 'force stop process successfully.\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "aa" && "\${args[2]:-}" == "start" ]]; then
  mkdir -p "$(dirname "$state_file")"
  printf '23456\\n' > "$state_file"
  printf 'start ability successfully.\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "pidof" ]]; then
  if [[ -s "$state_file" ]]; then
    cat "$state_file"
  else
    exit 1
  fi
fi
`);
fs.chmodSync(fakeHdc, 0o755);
const fakeEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HDC_LOG: fakeHdcLog, HDC_REMOTE_DIR: fakeHdcRemote, HDC_STATE: fakeHdcState, MAVT_ACTION_SETTLE_MS: '0' };

const restartFile = path.join(sourceRoot, 'cases', 'restart-isolation.md');
write(restartFile, `# 每用例冷启动测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const restartParsed = JSON.parse(run('node', ['scripts/parse-case.js', restartFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', restartParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const restartEnv = { ...fakeEnv };
delete restartEnv.MAVT_SELF_TEST_SKIP_CASE_RESTART;
fs.writeFileSync(fakeHdcLog, '');
fs.writeFileSync(fakeHdcState, '12345\n');
const restartStart = JSON.parse(run('node', ['scripts/run-case.js', restartParsed.caseDir, '--platform', 'harmony', '--start'], { env: restartEnv }));
assert.strictEqual(restartStart.appRestart.action, 'restartApp');
assert.strictEqual(restartStart.appRestart.ok, true);
assert.strictEqual(restartStart.appRestart.restart, true);
assert.strictEqual(restartStart.appRestart.coldStartVerified, true);
assert.strictEqual(restartStart.appRestart.oldPid, '12345');
assert.strictEqual(restartStart.appRestart.newPid, '23456');
assert.strictEqual(restartStart.appRestart.stopMethod, 'aa-force-stop');
const restartEvents = fs.readFileSync(restartStart.timeline, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.ok(restartEvents.some((event) => event.type === 'actionResult' && event.action === 'restartApp' && event.ok === true && event.source === 'action.sh'));
const fakeHdcRestartLog = fs.readFileSync(fakeHdcLog, 'utf8');
assert.ok(fakeHdcRestartLog.includes('shell aa force-stop com.example.demo'));
assert.ok(fakeHdcRestartLog.includes('shell aa start -b com.example.demo -a EntryAbility'));
run('node', ['scripts/run-case.js', restartParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--reason', 'restart isolation smoke test', '--execution-id', restartStart.executionId]);

const restartDegradedFile = path.join(sourceRoot, 'cases', 'restart-degraded.md');
write(restartDegradedFile, `# 普通交互隔离降级测试

## 前置条件
- App 已安装。

## 步骤
1. 查看页面入口。
`);
const restartDegradedParsed = JSON.parse(run('node', ['scripts/parse-case.js', restartDegradedFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', restartDegradedParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
fs.writeFileSync(fakeHdcState, '12345\n');
const restartDegradedStart = JSON.parse(run('node', ['scripts/run-case.js', restartDegradedParsed.caseDir, '--platform', 'harmony', '--start'], { env: { ...restartEnv, HDC_FORCE_STOP_FAIL: '1' } }));
assert.strictEqual(restartDegradedStart.appRestart.ok, false);
assert.strictEqual(restartDegradedStart.isolation.compromised, true);
assert.strictEqual(restartDegradedStart.isolation.required, false);
assert.strictEqual(restartDegradedStart.finalized, null);
assert.ok(!fs.existsSync(path.join(restartDegradedStart.execDir, 'result.json')));
run('node', ['scripts/run-case.js', restartDegradedParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--reason', 'restart degraded smoke test', '--execution-id', restartDegradedStart.executionId]);
const restartDegradedMetrics = json(path.join(restartDegradedStart.execDir, 'metrics.json'));
assert.strictEqual(restartDegradedMetrics.stability.isolationCompromised, true);
assert.strictEqual(restartDegradedMetrics.stability.restartFailureCount, 1);
assert.strictEqual(restartDegradedMetrics.stability.appRelaunchAttemptCount, 1);
assert.strictEqual(restartDegradedMetrics.stability.appRelaunchSuccessCount, 0);
assert.strictEqual(restartDegradedMetrics.stability.appRelaunchCount, 0);

const restartSensitiveFile = path.join(sourceRoot, 'cases', 'restart-sensitive.md');
write(restartSensitiveFile, `# 首次进入冷启动敏感测试

## 前置条件
- App 已安装。

## 步骤
1. 首次进入页面。
`);
const restartSensitiveParsed = JSON.parse(run('node', ['scripts/parse-case.js', restartSensitiveFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', restartSensitiveParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
fs.writeFileSync(fakeHdcState, '12345\n');
const restartSensitiveStart = JSON.parse(run('node', ['scripts/run-case.js', restartSensitiveParsed.caseDir, '--platform', 'harmony', '--start'], { env: { ...restartEnv, HDC_FORCE_STOP_FAIL: '1' } }));
assert.strictEqual(restartSensitiveStart.appRestart.ok, false);
assert.strictEqual(restartSensitiveStart.isolation.compromised, true);
assert.strictEqual(restartSensitiveStart.isolation.required, true);
assert.ok(restartSensitiveStart.finalized);
const restartSensitiveResult = json(path.join(restartSensitiveStart.execDir, 'result.json'));
assert.strictEqual(restartSensitiveResult.status, 'BLOCKED');
assert.strictEqual(restartSensitiveResult.failureCode, 'CASE_RESTART_FAILED');
assert.strictEqual(restartSensitiveStart.blockedOnStart, true);
assert.strictEqual(restartSensitiveStart.nextAction, 'stop-current-case');

const restartExplicitOptionalFile = path.join(sourceRoot, 'cases', 'restart-explicit-optional.md');
write(restartExplicitOptionalFile, `# 首次进入但显式允许降级

## 前置条件
- App 已安装。

## 步骤
1. 首次进入页面。
`);
const restartExplicitOptionalParsed = JSON.parse(run('node', ['scripts/parse-case.js', restartExplicitOptionalFile, '--cwd', workspace]));
const restartExplicitOptionalCase = json(path.join(restartExplicitOptionalParsed.caseDir, 'case.json'));
restartExplicitOptionalCase.isolation.requireCleanRestart = false;
write(path.join(restartExplicitOptionalParsed.caseDir, 'case.json'), `${JSON.stringify(restartExplicitOptionalCase, null, 2)}\n`);
run('node', ['scripts/update-env.js', restartExplicitOptionalParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
fs.writeFileSync(fakeHdcState, '12345\n');
const restartExplicitOptionalStart = JSON.parse(run('node', ['scripts/run-case.js', restartExplicitOptionalParsed.caseDir, '--platform', 'harmony', '--start'], { env: { ...restartEnv, HDC_FORCE_STOP_FAIL: '1' } }));
assert.strictEqual(restartExplicitOptionalStart.isolation.required, false);
assert.strictEqual(restartExplicitOptionalStart.isolation.requirementSource, 'case-contract');
assert.strictEqual(restartExplicitOptionalStart.blockedOnStart, false);
assert.strictEqual(restartExplicitOptionalStart.finalized, null);
run('node', ['scripts/run-case.js', restartExplicitOptionalParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'UNKNOWN', '--reason', 'explicit optional restart smoke test', '--execution-id', restartExplicitOptionalStart.executionId]);

const restartExplicitRequiredFile = path.join(sourceRoot, 'cases', 'restart-explicit-required.md');
write(restartExplicitRequiredFile, `# 普通页面但显式要求冷启动

## 前置条件
- App 已安装。

## 步骤
1. 查看页面入口。
`);
const restartExplicitRequiredParsed = JSON.parse(run('node', ['scripts/parse-case.js', restartExplicitRequiredFile, '--cwd', workspace]));
const restartExplicitRequiredCase = json(path.join(restartExplicitRequiredParsed.caseDir, 'case.json'));
restartExplicitRequiredCase.isolation.requireCleanRestart = true;
write(path.join(restartExplicitRequiredParsed.caseDir, 'case.json'), `${JSON.stringify(restartExplicitRequiredCase, null, 2)}\n`);
run('node', ['scripts/update-env.js', restartExplicitRequiredParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
fs.writeFileSync(fakeHdcState, '12345\n');
const restartExplicitRequiredStart = JSON.parse(run('node', ['scripts/run-case.js', restartExplicitRequiredParsed.caseDir, '--platform', 'harmony', '--start'], { env: { ...restartEnv, HDC_FORCE_STOP_FAIL: '1' } }));
assert.strictEqual(restartExplicitRequiredStart.isolation.required, true);
assert.strictEqual(restartExplicitRequiredStart.isolation.requirementSource, 'case-contract');
assert.strictEqual(restartExplicitRequiredStart.blockedOnStart, true);
assert.ok(restartExplicitRequiredStart.finalized);
const restartExplicitRequiredResult = json(path.join(restartExplicitRequiredStart.execDir, 'result.json'));
assert.strictEqual(restartExplicitRequiredResult.status, 'BLOCKED');
assert.strictEqual(restartExplicitRequiredResult.failureCode, 'CASE_RESTART_FAILED');

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
recordPreconditions(injectedParsed.caseDir, 'harmony', injectedStart.executionId);
recordGlobalFlowScan(injectedParsed.caseDir, 'harmony', injectedStart.executionId);
const harmonyProbe = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'harmony', '--device', '127.0.0.1:5555'], { env: fakeEnv }));
assert.strictEqual(harmonyProbe.ready, true);
assert.ok(Array.isArray(harmonyProbe.diagnostics));
assert.ok(!harmonyProbe.diagnostics.some((item) => item.level === 'ERROR'));
assert.strictEqual(harmonyProbe.capabilities.layout, true);
assert.ok(harmonyProbe.capabilities.actions.includes('restartApp'));
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

const missingObserveStepId = runAllowFailure('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--label', 'step-001-missing-step-id'], { env: fakeEnv });
assert.notStrictEqual(missingObserveStepId.status, 0);
assert.ok(missingObserveStepId.stderr.includes('OBSERVATION_SCOPE_REQUIRED'));
const injectedObservation = JSON.parse(run('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--label', '../bad'], { env: fakeEnv }));
assert.strictEqual(injectedObservation.label, '001-bad');
assert.strictEqual(injectedObservation.stepId, 'step-001');
assertLocalTime(injectedObservation.time);
assert.strictEqual(injectedObservation.artifacts.screenshot, 'screenshots/001-bad.png');
assert.strictEqual(injectedObservation.artifacts.layout, 'layouts/001-bad.json');
const injectedObservation2 = JSON.parse(run('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--platform', 'harmony', '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--label', 'step-001-after'], { env: fakeEnv }));
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
recordPreconditions(toolErrorParsed.caseDir, 'harmony', toolErrorStart.executionId);
recordGlobalFlowScan(toolErrorParsed.caseDir, 'harmony', toolErrorStart.executionId);
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
recordPreconditions(rulesParsed.caseDir, 'harmony', rulesStart.executionId);
recordGlobalFlowScan(rulesParsed.caseDir, 'harmony', rulesStart.executionId);
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'rule',
  ruleId: 'rule-001',
  status: 'MATCHED',
  stepId: 'step-001',
  reason: '检测到权限弹窗',
}), '--execution-id', rulesStart.executionId]);
recordActionResult(rulesParsed.caseDir, 'harmony', rulesStart.executionId, {
  type: 'actionResult',
  stepId: 'step-001',
  action: 'tap',
  ok: true,
});
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', rulesStart.executionId]);
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

const preconditionFlowDir = path.join(workspace, 'flows', 'preconditions', 'enter-creation-page');
const universalPreconditionFlow = {
  schemaVersion: 2,
  id: 'flow-enter-creation-page-universal',
  name: '进入创作页',
  usage: 'precondition',
  platform: 'universal',
  startCondition: { description: '当前位于首页，底部展示创作入口' },
  endCondition: { description: '当前位于创作页，页面展示创作标题' },
  steps: [{
    id: 'flow-step-001',
    instruction: '点击底部创作入口',
    action: { type: 'tap', target: '创作入口' },
  }],
};
const androidPreconditionFlow = {
  ...universalPreconditionFlow,
  id: 'flow-enter-creation-page-android',
  platform: 'android',
  startCondition: { description: '当前位于 Android 首页，底部展示创作入口' },
};
write(path.join(preconditionFlowDir, 'flow.json'), `${JSON.stringify(universalPreconditionFlow, null, 2)}\n`);
write(path.join(preconditionFlowDir, 'android', 'flow.json'), `${JSON.stringify(androidPreconditionFlow, null, 2)}\n`);

const harmonyFlowIndex = JSON.parse(run('node', ['scripts/flow/load-precondition-flows.js', '--platform', 'harmony', '--cwd', workspace]));
assert.strictEqual(harmonyFlowIndex.flows.length, 1);
assert.strictEqual(harmonyFlowIndex.flows[0].flowId, universalPreconditionFlow.id);
assert.strictEqual(harmonyFlowIndex.flows[0].platform, 'universal');
const androidFlowIndex = JSON.parse(run('node', ['scripts/flow/load-precondition-flows.js', '--platform', 'android', '--cwd', workspace]));
assert.strictEqual(androidFlowIndex.flows[0].flowId, androidPreconditionFlow.id);
assert.strictEqual(androidFlowIndex.flows[0].platform, 'android');
assert.ok(!fs.existsSync(path.join(repo, 'scripts', 'flow', 'start-recording.js')));
assert.ok(!fs.existsSync(path.join(repo, 'scripts', 'flow', 'record-scan.js')));

const preconditionFlowCaseFile = path.join(sourceRoot, 'cases', 'precondition-flow.md');
write(preconditionFlowCaseFile, `# 前置条件 Flow 执行测试

## 前置条件
- 用户已登录
- 进入创作页

## 步骤
1. 验证创作页内容。
`);
const preconditionFlowParsed = JSON.parse(run('node', ['scripts/parse-case.js', preconditionFlowCaseFile, '--cwd', workspace]));
run('node', ['scripts/update-env.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const preconditionFlowPreflight = JSON.parse(run('node', ['scripts/preflight-preconditions.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--cwd', workspace]));
assert.strictEqual(preconditionFlowPreflight.summary.flowMatchedPreconditions, 1);
assert.strictEqual(preconditionFlowPreflight.cases[0].preconditions[0].resolution, 'confirm');
assert.strictEqual(preconditionFlowPreflight.cases[0].preconditions[1].resolution, 'flow');
assert.strictEqual(preconditionFlowPreflight.cases[0].preconditions[1].flowId, universalPreconditionFlow.id);
assert.ok(preconditionFlowPreflight.cases[0].preconditionPlanSha.startsWith('precondition-plan-'));
const wrongFlowPlan = runAllowFailure('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--start', '--precondition-plan-sha', 'precondition-plan-wrong']);
assert.notStrictEqual(wrongFlowPlan.status, 0);
assert.ok(wrongFlowPlan.stderr.includes('PRECONDITION_FLOW_CHANGED'));

const strictFlowCaseFile = path.join(sourceRoot, 'cases', 'precondition-flow-strict.md');
write(strictFlowCaseFile, `# 前置条件 Flow 严格匹配测试

## 前置条件
- 进入创作页。

## 步骤
1. 验证页面。
`);
const strictFlowParsed = JSON.parse(run('node', ['scripts/parse-case.js', strictFlowCaseFile, '--cwd', workspace]));
const strictFlowPreflight = JSON.parse(run('node', ['scripts/preflight-preconditions.js', strictFlowParsed.caseDir, '--platform', 'harmony', '--cwd', workspace]));
assert.strictEqual(strictFlowPreflight.summary.flowMatchedPreconditions, 0);
assert.notStrictEqual(strictFlowPreflight.cases[0].preconditions[0].resolution, 'flow');

const preconditionFlowStart = JSON.parse(run('node', [
  'scripts/run-case.js',
  preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--start',
  '--precondition-plan-sha', preconditionFlowPreflight.cases[0].preconditionPlanSha,
]));
const preconditionFlowExecution = json(path.join(preconditionFlowStart.execDir, 'execution.json'));
assert.strictEqual(preconditionFlowExecution.preconditionPlanSha, preconditionFlowPreflight.cases[0].preconditionPlanSha);
assert.strictEqual(preconditionFlowExecution.preconditionPlan.preconditions[1].flowId, universalPreconditionFlow.id);
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-001',
  status: 'PASS',
  resolution: 'user_confirmed',
  reason: '用户已确认登录态',
}), '--execution-id', preconditionFlowStart.executionId]);

const entryObservation = JSON.parse(run('./scripts/observe.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', preconditionFlowStart.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--phase', 'entry-check',
], { env: fakeEnv }));
assert.strictEqual(entryObservation.scope, 'precondition-flow');
assert.strictEqual(entryObservation.phase, 'entry-check');
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  usage: 'precondition',
  preconditionId: 'pre-002',
  flowId: universalPreconditionFlow.id,
  status: 'STARTED',
  reason: 'entry-check observation 显示当前位于 Flow 起点',
}), '--execution-id', preconditionFlowStart.executionId]);

const beforeFlowStep = JSON.parse(run('./scripts/observe.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', preconditionFlowStart.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--flow-step-id', 'flow-step-001',
  '--phase', 'before',
], { env: fakeEnv }));
assert.strictEqual(beforeFlowStep.flowStepId, 'flow-step-001');
const preconditionFlowAction = JSON.parse(run('./scripts/action.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', preconditionFlowStart.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--flow-step-id', 'flow-step-001',
  '--type', 'tap',
  '--target', '创作入口',
  '--x', '9',
  '--y', '10',
  '--coordinate-source', 'visual',
  '--target-bounds', '1,2,30,40',
  '--coordinate-evidence', '当前截图中创作入口区域',
  '--settle-ms', '0',
], { env: fakeEnv }));
assert.strictEqual(preconditionFlowAction.scope, 'precondition-flow');
assert.strictEqual(preconditionFlowAction.preconditionId, 'pre-002');
const afterFlowStep = JSON.parse(run('./scripts/observe.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', preconditionFlowStart.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--flow-step-id', 'flow-step-001',
  '--phase', 'after',
], { env: fakeEnv }));
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  usage: 'precondition',
  preconditionId: 'pre-002',
  flowId: universalPreconditionFlow.id,
  flowStepId: 'flow-step-001',
  status: 'STEP_COMPLETED',
  evidenceObservation: afterFlowStep.label,
  reason: '动作成功且已完成动作后观察',
}), '--execution-id', preconditionFlowStart.executionId]);
const endFlowObservation = JSON.parse(run('./scripts/observe.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', preconditionFlowStart.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--phase', 'end-check',
], { env: fakeEnv }));
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  usage: 'precondition',
  preconditionId: 'pre-002',
  flowId: universalPreconditionFlow.id,
  status: 'COMPLETED',
  evidenceObservation: endFlowObservation.label,
  reason: 'end-check observation 显示已到达 Flow 终点',
}), '--execution-id', preconditionFlowStart.executionId]);
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-002',
  status: 'PREPARED',
  resolution: 'flow',
  flowId: universalPreconditionFlow.id,
  evidenceObservation: endFlowObservation.label,
  reason: 'Flow 已完成并验证终点',
}), '--execution-id', preconditionFlowStart.executionId]);
const preconditionFlowStepEvidence = recordStepObservation(preconditionFlowParsed.caseDir, 'harmony', preconditionFlowStart.executionId, 'step-001', 'precondition-flow-case-step');
recordPassAssertion(preconditionFlowParsed.caseDir, 'harmony', preconditionFlowStart.executionId, 'step-001', '创作页内容符合预期', preconditionFlowStepEvidence);
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', preconditionFlowStart.executionId]);
const preconditionFlowResult = json(path.join(preconditionFlowStart.execDir, 'result.json'));
const preconditionFlowMetrics = json(path.join(preconditionFlowStart.execDir, 'metrics.json'));
assert.strictEqual(preconditionFlowResult.status, 'PASS');
assert.strictEqual(preconditionFlowResult.preconditionPlanSha, preconditionFlowPreflight.cases[0].preconditionPlanSha);
assert.strictEqual(preconditionFlowResult.flowAssets[0].flowSha1, preconditionFlowPreflight.cases[0].flowMatches[0].flowSha1);
assert.strictEqual(preconditionFlowMetrics.flows.planned, 1);
assert.strictEqual(preconditionFlowMetrics.flows.completed, 1);
assert.strictEqual(preconditionFlowMetrics.flows.actions, 1);
const preconditionFlowContext = fs.readFileSync(path.join(preconditionFlowParsed.caseDir, 'platforms', 'harmony', 'CONTEXT.md'), 'utf8');
assert.ok(preconditionFlowContext.includes('## 前置条件 Flow'));
assert.ok(!preconditionFlowContext.includes('Flow 扫描'));

const startMismatch = JSON.parse(run('node', [
  'scripts/run-case.js',
  preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--start',
  '--precondition-plan-sha', preconditionFlowPreflight.cases[0].preconditionPlanSha,
]));
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-001',
  status: 'PASS',
  resolution: 'user_confirmed',
  reason: '用户已确认登录态',
}), '--execution-id', startMismatch.executionId]);
const mismatchObservation = JSON.parse(run('./scripts/observe.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', startMismatch.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--phase', 'entry-check',
], { env: fakeEnv }));
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'flow',
  usage: 'precondition',
  preconditionId: 'pre-002',
  flowId: universalPreconditionFlow.id,
  status: 'BLOCKED',
  failureCode: 'PRECONDITION_FLOW_START_MISMATCH',
  evidenceObservation: mismatchObservation.label,
  reason: '当前页面既不是起点也不是终点',
}), '--execution-id', startMismatch.executionId]);
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-002',
  status: 'BLOCKED',
  resolution: 'flow',
  flowId: universalPreconditionFlow.id,
  failureCode: 'PRECONDITION_FLOW_START_MISMATCH',
  evidenceObservation: mismatchObservation.label,
  reason: 'Flow 起点不匹配',
}), '--execution-id', startMismatch.executionId]);
const startMismatchResult = json(path.join(startMismatch.execDir, 'result.json'));
assert.strictEqual(startMismatchResult.status, 'BLOCKED');
assert.strictEqual(startMismatchResult.failureCode, 'PRECONDITION_FLOW_START_MISMATCH');

const alreadySatisfied = JSON.parse(run('node', [
  'scripts/run-case.js',
  preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--start',
  '--precondition-plan-sha', preconditionFlowPreflight.cases[0].preconditionPlanSha,
]));
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-001',
  status: 'PASS',
  resolution: 'user_confirmed',
  reason: '用户已确认登录态',
}), '--execution-id', alreadySatisfied.executionId]);
const alreadySatisfiedObservation = JSON.parse(run('./scripts/observe.sh', [
  '--case-dir', preconditionFlowParsed.caseDir,
  '--platform', 'harmony',
  '--execution-id', alreadySatisfied.executionId,
  '--scope', 'precondition-flow',
  '--precondition-id', 'pre-002',
  '--flow-id', universalPreconditionFlow.id,
  '--phase', 'entry-check',
], { env: fakeEnv }));
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-002',
  status: 'PASS',
  resolution: 'already_satisfied',
  flowId: universalPreconditionFlow.id,
  evidenceObservation: alreadySatisfiedObservation.label,
  reason: 'entry-check observation 显示已经满足 Flow 终点',
}), '--execution-id', alreadySatisfied.executionId]);
const alreadySatisfiedStepEvidence = recordStepObservation(preconditionFlowParsed.caseDir, 'harmony', alreadySatisfied.executionId, 'step-001', 'already-satisfied-case-step');
recordPassAssertion(preconditionFlowParsed.caseDir, 'harmony', alreadySatisfied.executionId, 'step-001', '创作页内容符合预期', alreadySatisfiedStepEvidence);
run('node', ['scripts/run-case.js', preconditionFlowParsed.caseDir, '--platform', 'harmony', '--finalize', '--status', 'PASS', '--execution-id', alreadySatisfied.executionId]);
const alreadySatisfiedMetrics = json(path.join(alreadySatisfied.execDir, 'metrics.json'));
assert.strictEqual(alreadySatisfiedMetrics.flows.started, 0);
assert.strictEqual(alreadySatisfiedMetrics.flows.alreadySatisfied, 1);

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
recordPreconditions(budgetParsed.caseDir, 'harmony', budgetStart.executionId);
for (let i = 0; i < 80; i++) {
  recordObservationEvent(budgetParsed.caseDir, 'harmony', budgetStart.executionId, {
    type: 'observation',
    scope: 'global',
    label: `obs-${i}`,
    artifacts: { screenshot: `screenshots/obs-${i}.png` },
  });
}
write(path.join(budgetStart.execDir, 'screenshots/obs-80.png'), 'self-test artifact: screenshots/obs-80.png\n');
const overBudget = runAllowFailure('node', ['scripts/run-case.js', budgetParsed.caseDir, '--platform', 'harmony', '--record-observation-json', JSON.stringify({
  type: 'observation',
  scope: 'global',
  label: 'obs-80',
  source: 'observe.sh',
  artifacts: { screenshot: 'screenshots/obs-80.png' },
}), '--execution-id', budgetStart.executionId], {
  env: { ...process.env, MAVT_OBSERVATION_WRITER: '1' },
});
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
