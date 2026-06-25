#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { formatDuration } = require('./common');

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

function assertLocalTime(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.ok(!value.endsWith('Z'));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'havt-self-test-'));
assert.strictEqual(formatDuration(850), '850ms');
assert.strictEqual(formatDuration(12300), '12s');
assert.strictEqual(formatDuration(200000), '3m 20s');
assert.strictEqual(formatDuration(3720000), '1h 2m');
const caseFile = path.join(tmp, 'cases', 'login.md');

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

const resolved = JSON.parse(run('node', ['scripts/resolve-cases.js', path.join(tmp, 'cases')]));
assert.deepStrictEqual(resolved.files, [caseFile]);

const parsed = JSON.parse(run('node', ['scripts/parse-case.js', caseFile, '--cwd', tmp]));
assert.ok(parsed.caseDir.includes('C001__登录成功__ck-'));
assert.ok(fs.existsSync(parsed.indexHtml));
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

const noLoginFile = path.join(tmp, 'cases', 'no-login.md');
write(noLoginFile, `# 未登录前置条件测试

## 前置条件
- 未登录。

## 步骤
1. 预期看到登录按钮。
`);
const noLoginParsed = JSON.parse(run('node', ['scripts/parse-case.js', noLoginFile, '--cwd', tmp]));
const noLoginCase = json(path.join(noLoginParsed.caseDir, 'case.json'));
assert.ok(noLoginParsed.caseDir.includes('C002__未登录前置条件测试__ck-'));
assert.strictEqual(noLoginCase.identity.caseNo, 'C002');
assert.strictEqual(noLoginCase.preconditions[0].checkMode, 'auto_check');

const resolvedByNo = JSON.parse(run('node', ['scripts/resolve-case-ref.js', 'C001', '--cwd', tmp]));
assert.strictEqual(resolvedByNo.caseNo, 'C001');
assert.strictEqual(resolvedByNo.title, '登录成功');
assert.strictEqual(resolvedByNo.caseDir, parsed.caseDir);
const resolvedByKey = JSON.parse(run('node', ['scripts/resolve-case-ref.js', caseJson.identity.caseKey, '--cwd', tmp]));
assert.strictEqual(resolvedByKey.caseNo, 'C001');
const resolvedByTitle = JSON.parse(run('node', ['scripts/resolve-case-ref.js', '登录成功', '--cwd', tmp]));
assert.strictEqual(resolvedByTitle.caseNo, 'C001');
const executionTargetsByNo = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', 'C001', '--cwd', tmp]));
assert.strictEqual(executionTargetsByNo.existingCases.length, 1);
assert.strictEqual(executionTargetsByNo.existingCases[0].caseDir, parsed.caseDir);
assert.deepStrictEqual(executionTargetsByNo.markdownFiles, []);
const executionTargetsByPath = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', caseFile, '--cwd', tmp]));
assert.deepStrictEqual(executionTargetsByPath.existingCases, []);
assert.deepStrictEqual(executionTargetsByPath.markdownFiles, [caseFile]);
const executionTargetsByRelativePath = JSON.parse(run('node', ['scripts/resolve-execution-targets.js', 'cases/login.md', '--cwd', tmp]));
assert.deepStrictEqual(executionTargetsByRelativePath.existingCases, []);
assert.deepStrictEqual(executionTargetsByRelativePath.markdownFiles, [caseFile]);
const parsedContext = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(parsedContext.includes('编号：C001'));

const legacyFile = path.join(tmp, 'cases', 'legacy.md');
write(legacyFile, `# 旧目录迁移测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const legacyInitial = JSON.parse(run('node', ['scripts/parse-case.js', legacyFile, '--cwd', tmp]));
const legacyOriginalDir = legacyInitial.caseDir;
const legacyCase = json(path.join(legacyOriginalDir, 'case.json'));
const legacyDir = path.join(tmp, 'ai-visual-test', 'cases', `旧目录迁移测试__${legacyCase.identity.caseKey}`);
fs.renameSync(legacyOriginalDir, legacyDir);
delete legacyCase.identity.caseNo;
write(path.join(legacyDir, 'case.json'), `${JSON.stringify(legacyCase, null, 2)}\n`);
const assigned = JSON.parse(run('node', ['scripts/assign-case-nos.js', '--cwd', tmp]));
assert.strictEqual(assigned.updated.length, 1);
assert.ok(assigned.updated[0].caseDir.includes('C003__旧目录迁移测试__ck-'));
assert.ok(!fs.existsSync(legacyDir));
const migratedCase = json(path.join(assigned.updated[0].caseDir, 'case.json'));
assert.strictEqual(migratedCase.identity.caseNo, 'C003');
const resolvedLegacy = JSON.parse(run('node', ['scripts/resolve-case-ref.js', 'C003', '--cwd', tmp]));
assert.strictEqual(resolvedLegacy.caseDir, assigned.updated[0].caseDir);

run('node', ['scripts/update-env.js', noLoginParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--start']);
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '看到登录按钮',
})]);
run('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--finalize', '--status', 'PASS']);
indexHtml = fs.readFileSync(path.join(tmp, 'ai-visual-test', 'index.html'), 'utf8');
assert.ok(indexHtml.indexOf('C001') < indexHtml.indexOf('C002'));
assert.ok(indexHtml.indexOf('C002') < indexHtml.indexOf('C003'));

const noEnvFile = path.join(tmp, 'cases', 'no-env.md');
write(noEnvFile, `# 未确认环境测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const noEnvParsed = JSON.parse(run('node', ['scripts/parse-case.js', noEnvFile, '--cwd', tmp]));
const unconfirmedStart = runAllowFailure('node', ['scripts/run-case.js', noEnvParsed.caseDir, '--start']);
assert.notStrictEqual(unconfirmedStart.status, 0);
assert.ok(unconfirmedStart.stderr.includes('Environment is not confirmed'));
const incompleteEnv = runAllowFailure('node', ['scripts/update-env.js', noEnvParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', '']);
assert.notStrictEqual(incompleteEnv.status, 0);
assert.ok(incompleteEnv.stderr.includes('环境信息不完整'));
assert.ok(!json(path.join(noEnvParsed.caseDir, 'state.json')).environmentConfirmedAt);

const probeNoHdc = JSON.parse(run('./scripts/probe-env.sh', ['--platform', 'harmony'], {
  env: { ...process.env, PATH: '/usr/local/bin:/bin:/usr/bin' },
}));
assert.strictEqual(probeNoHdc.capabilities.hdc, false);
assert.strictEqual(probeNoHdc.capabilities.launchApp, false);
assert.deepStrictEqual(probeNoHdc.capabilities.actions, []);

run('node', ['scripts/update-env.js', parsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
let state = json(path.join(parsed.caseDir, 'state.json'));
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

run('node', ['scripts/parse-case.js', caseFile, '--cwd', tmp]);
caseJson = json(path.join(parsed.caseDir, 'case.json'));
assert.strictEqual(caseJson.identity.sourceMode, 'snapshot');
assert.ok(!fs.readFileSync(path.join(parsed.caseDir, 'source.md'), 'utf8').includes('点击「获取验证码」'));
assert.strictEqual(caseJson.steps.length, 5);

run('node', ['scripts/parse-case.js', caseFile, '--cwd', tmp, '--refresh-from-input']);
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
const started = JSON.parse(run('node', ['scripts/run-case.js', parsed.caseDir, '--start']));
assert.ok(fs.existsSync(started.timeline));
const startEvent = JSON.parse(fs.readFileSync(started.timeline, 'utf8').trim().split(/\r?\n/)[0]);
assertLocalTime(startEvent.time);
assertLocalTime(json(path.join(started.execDir, 'execution.json')).startedAt);
const activeExecutionGuard = runAllowFailure('node', ['scripts/run-case.js', noLoginParsed.caseDir, '--start']);
assert.notStrictEqual(activeExecutionGuard.status, 0);
assert.ok(activeExecutionGuard.stderr.includes('Unfinalized execution exists'));
run('node', ['scripts/run-case.js', parsed.caseDir, '--record-json', JSON.stringify({
  type: 'precondition',
  id: 'pre-001',
  status: 'PASS',
  reason: 'App 已安装',
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--record-json', JSON.stringify({
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
run('node', ['scripts/run-case.js', parsed.caseDir, '--record-json', JSON.stringify({
  type: 'decision',
  stepId: 'step-001',
  decision: 'act',
  reason: '需要打开 App',
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
})]);
run('node', ['scripts/run-case.js', parsed.caseDir, '--finalize', '--status', 'FAIL', '--reason', '示例失败', '--failure-code', 'ASSERTION_FAILED', '--failed-step', 'step-003']);
state = json(path.join(parsed.caseDir, 'state.json'));
assert.strictEqual(state.latestStatus, 'FAIL');
assert.strictEqual(state.statusCounts.FAIL, 1);
const restartFinalized = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--start', '--execution-id', state.latestExecutionId]);
assert.notStrictEqual(restartFinalized.status, 0);
assert.ok(restartFinalized.stderr.includes('Execution already exists'));
const latestExec = path.join(parsed.caseDir, 'executions', state.latestExecutionId);
const metrics = json(path.join(latestExec, 'metrics.json'));
assert.strictEqual(metrics.preconditions.passed, 1);
assert.strictEqual(metrics.actions.launchApp, 1);
assert.strictEqual(metrics.artifacts.screenshots, 1);
assert.strictEqual(metrics.eventCounts.observation, 1);
const context = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(context.includes('## 执行统计'));
assert.ok(context.includes('## 执行事实'));
assert.ok(context.includes('示例失败'));
assert.ok(!context.includes('+08:00'));
const contextHtml = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(contextHtml.includes('<table>'));
assert.ok(contextHtml.includes('步骤'));
assert.ok(contextHtml.includes('示例失败'));
assert.ok(contextHtml.includes('截图观察'));
assert.ok(contextHtml.includes('操作结果'));
assert.ok(contextHtml.includes('操作次数'));
assert.ok(contextHtml.includes('启动 1'));
assert.ok(contextHtml.includes('截图证据'));
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
let refreshedHtml = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.html'), 'utf8');
let refreshedContext = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(refreshedHtml.includes('示例失败'));
assert.ok(refreshedHtml.includes(`executions/${state.latestExecutionId}/screenshots/step-001-before.png`));
assert.ok(!refreshedHtml.includes('+08:00'));
assert.ok(!refreshedContext.includes('+08:00'));
run('node', ['scripts/update-env.js', parsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility', '--screen', '1080x1920']);
refreshedHtml = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.html'), 'utf8');
refreshedContext = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(refreshedHtml.includes('示例失败'));
assert.ok(refreshedHtml.includes('1080x1920'));
assert.ok(!refreshedHtml.includes('+08:00'));
assert.ok(!refreshedContext.includes('+08:00'));
run('node', ['scripts/parse-case.js', caseFile, '--cwd', tmp, '--refresh-from-input']);
const staleSourceHtml = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.html'), 'utf8');
const staleSourceContext = fs.readFileSync(path.join(parsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(staleSourceHtml.includes('未执行'));
assert.ok(staleSourceHtml.includes('源用例变更'));
assert.ok(!staleSourceHtml.includes('示例失败'));
assert.ok(!staleSourceHtml.includes(`executions/${state.latestExecutionId}/screenshots/step-001-before.png`));
assert.ok(!staleSourceContext.includes('+08:00'));

const invalidStart = JSON.parse(run('node', ['scripts/run-case.js', parsed.caseDir, '--start']));
const invalidEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--record-json', JSON.stringify({ type: 'observation', label: 'bad', artifacts: { screenshot: '../bad.png' } }), '--execution-id', invalidStart.executionId]);
assert.notStrictEqual(invalidEvent.status, 0);
assert.ok(invalidEvent.stderr.includes('Invalid artifact path'));
const invalidCoordinateEvent = runAllowFailure('node', ['scripts/run-case.js', parsed.caseDir, '--record-json', JSON.stringify({
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
run('node', ['scripts/run-case.js', parsed.caseDir, '--finalize', '--status', 'UNKNOWN', '--reason', 'invalid event guard cleanup', '--execution-id', invalidStart.executionId]);

const passFile = path.join(tmp, 'cases', 'pass.md');
write(passFile, `# 通过证据测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
2. 预期看到首页。
`);
const passParsed = JSON.parse(run('node', ['scripts/parse-case.js', passFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', passParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const passStart = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', passParsed.caseDir, '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'launchApp',
  ok: true,
})]);
run('node', ['scripts/run-case.js', passParsed.caseDir, '--finalize', '--status', 'PASS']);
const passResult = json(path.join(passStart.execDir, 'result.json'));
assert.strictEqual(passResult.status, 'UNKNOWN');
assert.strictEqual(passResult.failureCode, 'ASSERTION_UNKNOWN');
assert.strictEqual(passResult.failedStep, 'step-002');
const passHtml = fs.readFileSync(path.join(passParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(passHtml.includes('预期看到首页'));
assert.ok(!passHtml.match(/预期看到首页[\s\S]*?<span class="pill pass">通过<\/span>/));
const passStateBefore = json(path.join(passParsed.caseDir, 'state.json'));
const duplicateFinalize = JSON.parse(run('node', ['scripts/run-case.js', passParsed.caseDir, '--finalize', '--status', 'PASS', '--execution-id', passStart.executionId]));
assert.strictEqual(duplicateFinalize.alreadyFinalized, true);
const passStateAfter = json(path.join(passParsed.caseDir, 'state.json'));
assert.strictEqual(passStateAfter.executionCount, passStateBefore.executionCount);
indexHtml = fs.readFileSync(path.join(tmp, 'ai-visual-test', 'index.html'), 'utf8');
assert.ok(indexHtml.includes('通过证据测试'));
assert.ok(indexHtml.includes('未知'));
assert.ok(!indexHtml.includes('+08:00'));
const renderedIndex = run('node', ['scripts/render-index.js', tmp]).trim();
assert.strictEqual(renderedIndex, path.join(tmp, 'ai-visual-test', 'index.html'));

const unknownFile = path.join(tmp, 'cases', 'unknown.md');
write(unknownFile, `# 未知断言测试

## 前置条件
- App 已安装。

## 步骤
1. 预期看到首页。
`);
const unknownParsed = JSON.parse(run('node', ['scripts/parse-case.js', unknownFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', unknownParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const unknownStart = JSON.parse(run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'UNKNOWN',
  reason: '证据不足',
})]);
run('node', ['scripts/run-case.js', unknownParsed.caseDir, '--finalize', '--status', 'UNKNOWN', '--failed-step', 'step-001']);
const unknownMetrics = json(path.join(unknownStart.execDir, 'metrics.json'));
assert.strictEqual(unknownMetrics.steps.failed, 0);
assert.strictEqual(unknownMetrics.steps.unknown, 1);

const androidFile = path.join(tmp, 'cases', 'android.md');
write(androidFile, `# Android 未实现测试

## 前置条件
- App 已安装。

## 步骤
1. 点击「登录」。
`);
const androidParsed = JSON.parse(run('node', ['scripts/parse-case.js', androidFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', androidParsed.caseDir, '--platform', 'android', '--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'MainActivity']);
const androidStart = JSON.parse(run('node', ['scripts/run-case.js', androidParsed.caseDir, '--start']));
const androidAction = runAllowFailure('./scripts/action.sh', ['--case-dir', androidParsed.caseDir, '--execution-id', androidStart.executionId, '--platform', 'android', '--step-id', 'step-001', '--type', 'tap', '--x', '1', '--y', '1', '--coordinate-source', 'layout', '--target-bounds', '0,0,2,2', '--coordinate-evidence', 'android placeholder bounds']);
assert.strictEqual(androidAction.status, 64);
const androidActionJson = JSON.parse(androidAction.stdout);
assert.strictEqual(androidActionJson.failureCode, 'PLATFORM_UNIMPLEMENTED');
const androidState = json(path.join(androidParsed.caseDir, 'state.json'));
assert.strictEqual(androidState.latestStatus, 'BLOCKED');
assert.strictEqual(androidState.latestFailureCode, 'PLATFORM_UNIMPLEMENTED');

const fakeBin = path.join(tmp, 'fake-bin');
const fakeHdcLog = path.join(tmp, 'fake-hdc.log');
const fakeHdc = path.join(fakeBin, 'hdc');
write(fakeHdc, `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "\${args[0]:-}" == "-t" ]]; then
  args=("\${args[@]:2}")
fi
printf '%s\\n' "\${args[*]}" >> "$HDC_LOG"
if [[ "\${args[0]:-}" == "file" && "\${args[1]:-}" == "recv" ]]; then
  dest="\${args[3]}"
  mkdir -p "$(dirname "$dest")"
  printf 'fake' > "$dest"
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "aa" && "\${args[2]:-}" == "dump" ]]; then
  printf 'AbilityRecord ID #1\\nstate #FOREGROUND\\nability type [PAGE]\\nbundle name [com.example.demo]\\nmain name [EntryAbility]\\n'
elif [[ "\${args[0]:-}" == "shell" && "\${args[1]:-}" == "pidof" ]]; then
  printf '12345\\n'
fi
`);
fs.chmodSync(fakeHdc, 0o755);

const injectedFile = path.join(tmp, 'cases', 'injected-env.md');
write(injectedFile, `# 环境注入测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const injectedParsed = JSON.parse(run('node', ['scripts/parse-case.js', injectedFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', injectedParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const injectedStart = JSON.parse(run('node', ['scripts/run-case.js', injectedParsed.caseDir, '--start']));
const fakeEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HDC_LOG: fakeHdcLog, MAVT_ACTION_SETTLE_MS: '0' };
const injectedAction = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'launchApp', '--settle-ms', '25'], { env: fakeEnv }));
assert.strictEqual(injectedAction.ok, true);
assert.strictEqual(injectedAction.settleMs, 25);
assertLocalTime(injectedAction.time);
const missingCoordinateSource = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(missingCoordinateSource.status, 0);
assert.ok(missingCoordinateSource.stderr.includes('坐标动作必须提供 --coordinate-source'));
const missingCoordinateEvidence = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'layout', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(missingCoordinateEvidence.status, 0);
assert.ok(missingCoordinateEvidence.stderr.includes('坐标动作必须提供 --coordinate-evidence'));
const invalidCoordinateSource = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'nearby-text', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(invalidCoordinateSource.status, 0);
assert.ok(invalidCoordinateSource.stderr.includes('无效 --coordinate-source'));
const invalidTargetBounds = runAllowFailure('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'visual', '--target-bounds', '1,2,3', '--settle-ms', '0'], { env: fakeEnv });
assert.notStrictEqual(invalidTargetBounds.status, 0);
assert.ok(invalidTargetBounds.stderr.includes('无效 --target-bounds'));
const injectedToggle = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'toggle', '--x', '9', '--y', '10', '--coordinate-source', 'layout', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '控件树通知开关 bounds', '--settle-ms', '0'], { env: fakeEnv }));
assert.strictEqual(injectedToggle.action, 'toggle');
assert.strictEqual(injectedToggle.ok, true);
assert.strictEqual(injectedToggle.coordinateSource, 'layout');
assert.deepStrictEqual(injectedToggle.targetBounds, [1, 2, 30, 40]);
assert.strictEqual(injectedToggle.coordinateEvidence, '控件树通知开关 bounds');
const fakeHdcActionLog = fs.readFileSync(fakeHdcLog, 'utf8');
assert.ok(fakeHdcActionLog.includes('shell aa start -b com.example.demo -a EntryAbility'));
assert.ok(fakeHdcActionLog.includes('shell uitest uiInput click 9 10'));
const defaultSettleEnv = { ...fakeEnv };
delete defaultSettleEnv.MAVT_ACTION_SETTLE_MS;
const injectedDefaultWait = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'wait', '--ms', '0'], { env: defaultSettleEnv }));
assert.strictEqual(injectedDefaultWait.settleMs, undefined);
const injectedDefaultTap = JSON.parse(run('./scripts/action.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--step-id', 'step-001', '--type', 'tap', '--x', '9', '--y', '10', '--coordinate-source', 'visual', '--target-bounds', '1,2,30,40', '--coordinate-evidence', '截图像素区域中心'], { env: defaultSettleEnv }));
assert.strictEqual(injectedDefaultTap.settleMs, 1000);
assert.strictEqual(injectedDefaultTap.coordinateSource, 'visual');
assert.ok(fs.readFileSync(path.join(repo, 'scripts', 'flow', 'action.sh'), 'utf8').includes('MAVT_ACTION_SETTLE_MS:-1000'));

const injectedObservation = JSON.parse(run('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--label', '../bad'], { env: fakeEnv }));
assert.strictEqual(injectedObservation.label, '001-bad');
assertLocalTime(injectedObservation.time);
assert.strictEqual(injectedObservation.artifacts.screenshot, 'screenshots/001-bad.png');
assert.strictEqual(injectedObservation.artifacts.layout, 'layouts/001-bad.json');
const injectedObservation2 = JSON.parse(run('./scripts/observe.sh', ['--case-dir', injectedParsed.caseDir, '--execution-id', injectedStart.executionId, '--label', 'step-001-after'], { env: fakeEnv }));
assert.strictEqual(injectedObservation2.label, '002-step-001-after');
assert.strictEqual(injectedObservation2.artifacts.screenshot, 'screenshots/002-step-001-after.png');
run('node', ['scripts/render-context.js', injectedParsed.caseDir]);
const injectedHtmlPath = path.join(injectedParsed.caseDir, 'CONTEXT.html');
assert.ok(fs.existsSync(injectedHtmlPath));
const injectedHtml = fs.readFileSync(injectedHtmlPath, 'utf8');
assert.ok(injectedHtml.includes(`executions/${injectedStart.executionId}/screenshots/001-bad.png`));
assert.ok(injectedHtml.includes('观察记录'));
assert.ok(injectedHtml.includes('截图观察'));
assert.ok(injectedHtml.includes('切换开关成功'));
assert.ok(!injectedHtml.includes('actionResult'));
run('node', ['scripts/run-case.js', injectedParsed.caseDir, '--finalize', '--status', 'UNKNOWN', '--reason', '环境注入测试完成', '--execution-id', injectedStart.executionId]);

const rulesFile = path.join(tmp, 'cases', 'global-rules.md');
write(rulesFile, `# 全局规则测试

## 前置条件
- App 已安装。

## 步骤
1. 点击「继续」。
`);
const rulesParsed = JSON.parse(run('node', ['scripts/parse-case.js', rulesFile, '--cwd', tmp]));
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
const rulesStart = JSON.parse(run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--record-json', JSON.stringify({
  type: 'rule',
  ruleId: 'rule-001',
  status: 'MATCHED',
  stepId: 'step-001',
  reason: '检测到权限弹窗',
})]);
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--record-json', JSON.stringify({
  type: 'actionResult',
  stepId: 'step-001',
  action: 'tap',
  ok: true,
})]);
run('node', ['scripts/run-case.js', rulesParsed.caseDir, '--finalize', '--status', 'PASS']);
const rulesMetrics = json(path.join(rulesStart.execDir, 'metrics.json'));
assert.strictEqual(rulesMetrics.eventCounts.rule, 1);
assert.ok(rulesMetrics.caseContractSha);
const rulesResult = json(path.join(rulesStart.execDir, 'result.json'));
assert.strictEqual(rulesResult.caseContractSha, rulesMetrics.caseContractSha);
const rulesContext = fs.readFileSync(path.join(rulesParsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(rulesContext.includes('## 全局规则'));
assert.ok(rulesContext.includes('rule-001'));
assert.ok(rulesContext.includes('出现权限弹窗'));
assert.ok(rulesContext.includes('MATCHED'));
const rulesHtml = fs.readFileSync(path.join(rulesParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(rulesHtml.includes('全局规则'));
assert.ok(rulesHtml.includes('rule-001'));
assert.ok(rulesHtml.includes('规则命中'));
rulesCase.globalRules[0].when = '出现新的权限弹窗';
write(rulesCasePath, `${JSON.stringify(rulesCase, null, 2)}\n`);
run('node', ['scripts/render-context.js', rulesParsed.caseDir]);
const changedRulesContext = fs.readFileSync(path.join(rulesParsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(changedRulesContext.includes('出现新的权限弹窗'));
assert.ok(changedRulesContext.includes('尚未执行。'));
assert.ok(!changedRulesContext.includes('执行通过。'));
run('node', ['scripts/parse-case.js', rulesFile, '--cwd', tmp]);
const reparsedRulesCase = json(rulesCasePath);
assert.strictEqual(reparsedRulesCase.globalRules.length, 1);
assert.strictEqual(reparsedRulesCase.globalRules[0].when, '出现新的权限弹窗');
run('node', ['scripts/refresh-case.js', rulesParsed.caseDir]);
const refreshedRulesCase = json(rulesCasePath);
assert.strictEqual(refreshedRulesCase.globalRules.length, 1);
assert.strictEqual(refreshedRulesCase.globalRules[0].when, '出现新的权限弹窗');

const flowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '进入创作页', '--intent', '进入创作页,打开创作入口', '--cwd', tmp]));
assert.ok(flowStarted.flowDir.includes('进入创作页__flow-'));
assert.ok(flowStarted.recordingId);
assert.ok(fs.statSync(path.join(repo, 'scripts/flow/start-recording.js')).mode & 0o111);
assert.ok(fs.statSync(path.join(repo, 'scripts/flow/finalize-recording.js')).mode & 0o111);
const emptyFlowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '空录制', '--intent', '空录制', '--cwd', tmp]));
const emptyReady = runAllowFailure('node', ['scripts/flow/finalize-recording.js', emptyFlowStarted.flowDir, '--recording-id', emptyFlowStarted.recordingId, '--status', 'READY']);
assert.notStrictEqual(emptyReady.status, 0);
assert.ok(emptyReady.stderr.includes('READY Flow requires at least one recorded step'));
const inheritedFlowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '继承环境', '--intent', '继承环境', '--cwd', tmp, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']));
fs.writeFileSync(fakeHdcLog, '');
const inheritedFlowObserve = JSON.parse(run('./scripts/flow/observe.sh', ['--flow-dir', inheritedFlowStarted.flowDir, '--recording-id', inheritedFlowStarted.recordingId, '--label', '001-before'], { env: fakeEnv }));
assert.strictEqual(inheritedFlowObserve.app.appId, 'com.example.demo');
assert.strictEqual(inheritedFlowObserve.app.inTargetApp, true);
const inheritedFlowAction = JSON.parse(run('./scripts/flow/action.sh', ['--flow-dir', inheritedFlowStarted.flowDir, '--recording-id', inheritedFlowStarted.recordingId, '--instruction', '启动目标 App', '--type', 'launchApp', '--settle-ms', '0'], { env: fakeEnv }));
assert.strictEqual(inheritedFlowAction.actionResult.ok, true);
const inheritedFlowLog = fs.readFileSync(fakeHdcLog, 'utf8');
assert.ok(inheritedFlowLog.includes('shell uitest dumpLayout'));
assert.ok(inheritedFlowLog.includes('-b com.example.demo'));
assert.ok(inheritedFlowLog.includes('shell aa start -b com.example.demo -a EntryAbility'));
const failedFlowStarted = JSON.parse(run('node', ['scripts/flow/start-recording.js', '--name', '失败录制', '--intent', '失败录制', '--cwd', tmp, '--platform', 'android', '--device', 'emulator-5554', '--app', 'com.example.demo', '--entry', 'EntryAbility']));
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
const listedFlows = JSON.parse(run('node', ['scripts/flow/list-flows.js', '--cwd', tmp]));
assert.strictEqual(listedFlows.flows.length, 1);
assert.strictEqual(listedFlows.flows[0].flowId, flowStarted.flowId);
assert.strictEqual(listedFlows.flows[0].status, 'READY');
assert.deepStrictEqual(listedFlows.flows[0].intent, ['进入创作页', '打开创作入口']);
assert.deepStrictEqual(listedFlows.flows[0].successHints, ['进入创作页']);
assert.strictEqual(listedFlows.flows[0].steps.length, 1);
assert.strictEqual(listedFlows.flows[0].steps[0].id, 'flow-step-001');
assert.strictEqual(listedFlows.flows[0].steps[0].humanInstruction, '点击底部创作入口');
assert.strictEqual(listedFlows.flows[0].steps[0].action.type, 'tap');
assert.strictEqual(listedFlows.flows[0].steps[0].action.x, '520');
assert.strictEqual(listedFlows.flows[0].steps[0].beforeObservation.screenshot, `recordings/${flowStarted.recordingId}/screenshots/001-before.png`);

const flowCaseFile = path.join(tmp, 'cases', 'flow-case.md');
write(flowCaseFile, `# Flow 执行测试

## 前置条件
- App 已安装。

## 步骤
1. 使用 ${flowStarted.flowId} 进入创作页。
`);
const flowCaseParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowCaseFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', flowCaseParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowCaseStart = JSON.parse(run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flowScan',
  status: 'COMPLETED',
  candidateCount: listedFlows.flows.length,
  matchedFlowIds: [flowStarted.flowId],
  stepId: 'step-001',
  reason: '步骤需要进入创作页，命中已录制 Flow',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flow',
  flowId: flowStarted.flowId,
  status: 'STARTED',
  stepId: 'step-001',
  reason: '当前步骤要求进入创作页',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flow',
  flowId: flowStarted.flowId,
  flowStepId: 'flow-step-001',
  status: 'STEP_COMPLETED',
  stepId: 'step-001',
  reason: '已参考录制路径点击创作入口',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flow',
  flowId: flowStarted.flowId,
  status: 'COMPLETED',
  stepId: 'step-001',
  reason: '已进入创作页',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'observation',
  label: 'flow-step-001-before',
  artifacts: {
    screenshot: 'screenshots/flow-step-001-before.png',
    layout: 'layouts/flow-step-001-before.json',
  },
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'observation',
  label: '002-after-flow-step-001',
  artifacts: {
    screenshot: 'screenshots/002-after-flow-step-001.png',
    layout: 'layouts/002-after-flow-step-001.json',
  },
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--record-json', JSON.stringify({
  type: 'assertion',
  stepId: 'step-001',
  status: 'PASS',
  reason: '看到创作页',
})]);
run('node', ['scripts/run-case.js', flowCaseParsed.caseDir, '--finalize', '--status', 'PASS']);
const flowCaseMetrics = json(path.join(flowCaseStart.execDir, 'metrics.json'));
assert.strictEqual(flowCaseMetrics.flows.totalEvents, 3);
assert.strictEqual(flowCaseMetrics.flows.scans, 1);
assert.strictEqual(flowCaseMetrics.flows.matched, 1);
assert.strictEqual(flowCaseMetrics.flows.completed, 1);
const flowCaseContext = fs.readFileSync(path.join(flowCaseParsed.caseDir, 'CONTEXT.md'), 'utf8');
assert.ok(flowCaseContext.includes('## 业务路径 Flow'));
assert.ok(flowCaseContext.includes('Flow 扫描'));
assert.ok(flowCaseContext.includes(flowStarted.flowId));
assert.ok(flowCaseContext.includes('COMPLETED'));
const flowCaseHtml = fs.readFileSync(path.join(flowCaseParsed.caseDir, 'CONTEXT.html'), 'utf8');
assert.ok(flowCaseHtml.includes('业务路径 Flow'));
assert.ok(flowCaseHtml.includes('Flow 扫描'));
assert.ok(flowCaseHtml.includes('已进入创作页'));
const flowShotSection = flowCaseHtml.match(/<h2>截图证据<\/h2>[\s\S]*?<h2>观察记录<\/h2>/)[0];
const flowStepEvidenceRow = flowShotSection.match(/<td>step-001<\/td>[\s\S]*?<\/tr>/)?.[0] || '';
assert.ok(flowShotSection.includes('flow-step-001-before.png'));
assert.ok(flowShotSection.includes('002-after-flow-step-001.png'));
assert.ok(!flowStepEvidenceRow.includes('flow-step-001-before.png'));
assert.ok(!flowStepEvidenceRow.includes('002-after-flow-step-001.png'));

const flowGuardFile = path.join(tmp, 'cases', 'flow-guard.md');
write(flowGuardFile, `# Flow 扫描守卫测试

## 前置条件
- App 已安装。

## 步骤
1. 点击业务页按钮。
`);
const flowGuardParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', flowGuardParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', flowGuardParsed.caseDir, '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-001', '--reason', '未找到业务按钮']);
const flowGuardResult = json(path.join(flowGuardStart.execDir, 'result.json'));
assert.strictEqual(flowGuardResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardResult.failureCode, 'FLOW_SCAN_MISSING');
assert.ok(flowGuardResult.reason.includes('Flow 扫描'));
const flowGuardStepFile = path.join(tmp, 'cases', 'flow-guard-step.md');
write(flowGuardStepFile, `# Flow 扫描步骤关联守卫测试

## 前置条件
- App 已安装。

## 步骤
1. 进入业务页。
2. 点击业务页按钮。
`);
const flowGuardStepParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardStepFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', flowGuardStepParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardStepStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardStepParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', flowGuardStepParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flowScan',
  status: 'EMPTY',
  candidateCount: 0,
  matchedFlowIds: [],
  stepId: 'step-001',
  reason: '第一步已扫描 Flow',
})]);
run('node', ['scripts/run-case.js', flowGuardStepParsed.caseDir, '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-002', '--reason', '第二步未找到业务按钮']);
const flowGuardStepResult = json(path.join(flowGuardStepStart.execDir, 'result.json'));
assert.strictEqual(flowGuardStepResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardStepResult.failureCode, 'FLOW_SCAN_MISSING');
const flowGuardMatchedFile = path.join(tmp, 'cases', 'flow-guard-matched.md');
write(flowGuardMatchedFile, `# Flow 命中未处理守卫测试

## 前置条件
- App 已安装。

## 步骤
1. 进入业务页。
`);
const flowGuardMatchedParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardMatchedFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', flowGuardMatchedParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardMatchedStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardMatchedParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', flowGuardMatchedParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flowScan',
  status: 'COMPLETED',
  candidateCount: 1,
  matchedFlowIds: [flowStarted.flowId],
  stepId: 'step-001',
  reason: '命中 Flow 但未处理',
})]);
run('node', ['scripts/run-case.js', flowGuardMatchedParsed.caseDir, '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--failed-step', 'step-001', '--reason', '未找到业务按钮']);
const flowGuardMatchedResult = json(path.join(flowGuardMatchedStart.execDir, 'result.json'));
assert.strictEqual(flowGuardMatchedResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardMatchedResult.failureCode, 'FLOW_MATCH_UNRESOLVED');
const flowGuardNoFailedStepParsed = JSON.parse(run('node', ['scripts/parse-case.js', flowGuardStepFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', flowGuardNoFailedStepParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const flowGuardNoFailedStepStart = JSON.parse(run('node', ['scripts/run-case.js', flowGuardNoFailedStepParsed.caseDir, '--start']));
run('node', ['scripts/run-case.js', flowGuardNoFailedStepParsed.caseDir, '--record-json', JSON.stringify({
  type: 'flowScan',
  status: 'EMPTY',
  candidateCount: 0,
  matchedFlowIds: [],
  stepId: 'step-001',
  reason: '第一步已扫描 Flow',
})]);
run('node', ['scripts/run-case.js', flowGuardNoFailedStepParsed.caseDir, '--finalize', '--status', 'BLOCKED', '--failure-code', 'ACTION_TARGET_NOT_FOUND', '--reason', '未传失败步骤']);
const flowGuardNoFailedStepResult = json(path.join(flowGuardNoFailedStepStart.execDir, 'result.json'));
assert.strictEqual(flowGuardNoFailedStepResult.status, 'UNKNOWN');
assert.strictEqual(flowGuardNoFailedStepResult.failureCode, 'FLOW_SCAN_MISSING');

const budgetFile = path.join(tmp, 'cases', 'budget.md');
write(budgetFile, `# 预算测试

## 前置条件
- App 已安装。

## 步骤
1. 打开 App。
`);
const budgetParsed = JSON.parse(run('node', ['scripts/parse-case.js', budgetFile, '--cwd', tmp]));
run('node', ['scripts/update-env.js', budgetParsed.caseDir, '--platform', 'harmony', '--device', '127.0.0.1:5555', '--app', 'com.example.demo', '--entry', 'EntryAbility']);
const budgetStart = JSON.parse(run('node', ['scripts/run-case.js', budgetParsed.caseDir, '--start']));
for (let i = 0; i < 80; i++) {
  run('node', ['scripts/run-case.js', budgetParsed.caseDir, '--record-json', JSON.stringify({
    type: 'observation',
    label: `obs-${i}`,
    artifacts: { screenshot: `screenshots/obs-${i}.png` },
  })]);
}
const overBudget = runAllowFailure('node', ['scripts/run-case.js', budgetParsed.caseDir, '--record-json', JSON.stringify({
  type: 'observation',
  label: 'obs-80',
  artifacts: { screenshot: 'screenshots/obs-80.png' },
})]);
assert.strictEqual(overBudget.status, 3);
assert.ok(overBudget.stderr.includes('EXECUTION_BUDGET_EXCEEDED'));
const budgetState = json(path.join(budgetParsed.caseDir, 'state.json'));
assert.strictEqual(budgetState.latestStatus, 'BLOCKED');
assert.strictEqual(budgetState.latestFailureCode, 'EXECUTION_BUDGET_EXCEEDED');
const budgetExecState = json(path.join(budgetStart.execDir, 'execution.json'));
assert.strictEqual(budgetExecState.finalized, true);
const afterFinalized = runAllowFailure('node', ['scripts/run-case.js', budgetParsed.caseDir, '--record-json', JSON.stringify({ type: 'decision', decision: 'act' })]);
assert.notStrictEqual(afterFinalized.status, 0);
assert.ok(afterFinalized.stderr.includes('Execution already finalized'));

console.log(`self-test passed: ${tmp}`);
