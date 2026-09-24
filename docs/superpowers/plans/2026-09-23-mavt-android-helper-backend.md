# MAVT Android Helper Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ARTEMIS Accessibility Helper 作为 MAVT Android 的首选 UI 后端，以原子 PNG+XML snapshot 缩短观察耗时，并保留 UIAutomator/ADB 完整降级路径和严格的动作未知结果语义。

**Architecture:** Android environment binding 冻结 `auto | helper | uiautomator` 策略；batch platform runtime 负责 Helper 安装、认证、adb forward 和释放，token 只保存在 mode 0600 的 host cache 文件中。Android observe/capture/action adapter 根据 runtime session 选择 Helper 或 legacy 后端，MAVT 上层继续只接收现有 PNG、XML、Scene 和 Action Result 契约。

**Tech Stack:** Node.js CommonJS、Bash、ADB、Android AccessibilityService Helper protocol 2、现有 MAVT Case Runtime 和无依赖测试脚本。

**Spec:** `docs/superpowers/specs/2026-09-23-mavt-android-helper-backend-design.md`

**Reviewed baseline:** DevKit `main` at `d71e31612af95b6d598e7442d2f94f52e13b0e17`。

## Global Constraints

- 只修改 worktree `/Users/cm/GitProj/DevKit/.worktrees/mavt-android-helper-backend`，不得修改主检出。
- Helper 固定为 package `com.artemis.helper`、service `com.artemis.helper/.ArtemisAccessibilityService`、device port `18888`、最低 protocol `2`、最低 versionCode `7`。
- Helper full snapshot 只支持 Android API 30+；`auto` 在 acquire 前降级，严格 `helper` 在 acquire 阶段失败。
- Helper timeout 固定为 ping `1000ms`、snapshot `15000ms`、tap/type/global 单 RPC `3000ms`、原生 double tap/定点输入 transaction `5000ms`、自定义间隔 double tap `intervalMs + 4000ms`、long press `durationMs + 3000ms`、swipe `swipeDurationMs(action) + 3500ms`，且不得超过 execution 剩余 deadline。
- Helper snapshot 必须请求 `fields=xml&format=png`；Scene 和证据层继续只接受 PNG。
- `androidUiBackend` 只属于 Android，允许 `auto | helper | uiautomator`，默认 `auto`。
- token 不得写入 workspace、batch、execution、event、日志、stdout/stderr 或 shell argv。
- Helper session 使用 `device-hash + ownerKey` 的确定性 journal；目录 `0700`、文件 `0600`，所有设备副作用前先持久化恢复依据。
- Helper token 为设备级单例；每设备 owner claim 必须在安装、service、forward、token 之前取得，非 owner 不得修改 Helper 状态。
- device claim/lock 使用不受自定义 state dir 影响的 canonical user cache 路径；同一 host 上不同 `MAVT_ANDROID_HELPER_STATE_DIR` 仍竞争同一个 device claim。
- 无 MAVT claim 但匿名 ping 显示 `token_set=true` 时视为外部 ARTEMIS session，禁止升级、重启、覆盖或清 token。
- 只读 snapshot 允许 Helper 失败后降级；动作 POST 开始后禁止自动降级和重放。
- App 安装/卸载/启动/重启、前台应用、PID 和日志继续使用共享 ADB 能力。
- release 必须只撤销本次 acquire 创建的 forward 和 service 状态变化，不覆盖其他 accessibility services。
- `prepare-env` 可以保留已安装 APK，但必须恢复其临时 service、token 和 forward，前后 accessibility 状态一致。
- 不新增 npm/Python 依赖，不修改 HarmonyOS/iOS 行为。
- backend 策略以 CLI `--android-ui-backend` 为唯一非敏感来源；环境变量只传 `MAVT_ANDROID_HELPER_SESSION_STATE`。
- 历史 Android binding 可缺少该字段；不得改变其 `bindingSha`，adapter 参数边界按 `auto` 补默认值。
- 每个实现任务遵循 red-green-refactor，并在提交前运行其列出的回归测试。

---

### Task 1: 固定 Helper 制品与供应链元数据

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper/ArtemisAccessibilityHelper.apk`
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper/helper_manifest.json`
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper/LICENSE`
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper/SOURCE.md`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-bundle.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: 已验证 APK `/Users/cm/GitProj/artemis-helper-png-worktree/packages/artemis-accessibility-helper/ArtemisAccessibilityHelper.apk`。
- Produces: `helper_manifest.json`，字段为 `{package, version_code, version_name, protocol_version, sha256}`；后续 session manager 只通过该 manifest 发现制品。

- [ ] **Step 1: 写制品一致性失败测试并注册 suite**

在 `android-helper-bundle.test.js` 中写入：

```js
#!/usr/bin/env node
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../platform/adapters/android/helper');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'helper_manifest.json'), 'utf8'));
const apk = fs.readFileSync(path.join(root, 'ArtemisAccessibilityHelper.apk'));
assert.strictEqual(manifest.package, 'com.artemis.helper');
assert.strictEqual(manifest.version_code, 7);
assert.strictEqual(manifest.version_name, '1.2.1');
assert.strictEqual(manifest.protocol_version, 2);
assert.strictEqual(crypto.createHash('sha256').update(apk).digest('hex'), manifest.sha256);
assert.ok(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Apache License'));
assert.ok(fs.readFileSync(path.join(root, 'SOURCE.md'), 'utf8').includes('google/artemis'));
assert.ok(fs.readFileSync(path.join(root, 'SOURCE.md'), 'utf8').includes('e85ec0203454aea47330c442be7cdf6664ae034cf9276843559fca90db575c1d'));
console.log('android helper bundle passed');
```

在 `self-test.js` 的 `suites` 中加入：

```js
androidHelperBundle: 'tests/android-helper-bundle.test.js',
```

- [ ] **Step 2: 运行测试确认因文件缺失失败**

Run: `node skills/mobile-ai-visual-test/scripts/tests/android-helper-bundle.test.js`

Expected: FAIL，错误包含 `helper_manifest.json` 或 `ArtemisAccessibilityHelper.apk` 不存在。

- [ ] **Step 3: 验证 PNG patch 输入、复制 APK 并创建固定 manifest**

Run:

```bash
cd /Users/cm/GitProj/artemis-helper-png-worktree/packages/artemis-accessibility-helper
./run_tests.sh
for f in app/build.gradle.kts \
  app/src/main/java/com/artemis/helper/CommandServer.java \
  app/src/main/java/com/artemis/helper/HierarchyDumper.java \
  app/src/main/java/com/artemis/helper/ScreenshotFormat.java \
  run_tests.sh tests/com/artemis/helper/ScreenshotFormatTest.java; do
  shasum -a 256 "$f"
done | shasum -a 256
cd /Users/cm/GitProj/DevKit/.worktrees/mavt-android-helper-backend
mkdir -p skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper
cp /Users/cm/GitProj/artemis-helper-png-worktree/packages/artemis-accessibility-helper/ArtemisAccessibilityHelper.apk \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper/ArtemisAccessibilityHelper.apk
```

Expected: Helper source test PASS，组合输入 SHA-256 为 `e85ec0203454aea47330c442be7cdf6664ae034cf9276843559fca90db575c1d`，复制后的 APK SHA-256 为 manifest 中的 `c2f6622920156f3951b13118efe1c87fcc27ea7e5904d42e61b5a6b849d37626`。这一步把当前未提交 patch 的内容身份冻结下来，避免仅凭 branch 名引用可变源码。

`helper_manifest.json` 写入：

```json
{
  "package": "com.artemis.helper",
  "version_code": 7,
  "version_name": "1.2.1",
  "protocol_version": 2,
  "sha256": "c2f6622920156f3951b13118efe1c87fcc27ea7e5904d42e61b5a6b849d37626"
}
```

`SOURCE.md` 必须记录：上游 `https://github.com/google/artemis`、base commit `371aa6df56880643da57b30da936e9812fb0ec66`、本地 patch branch `codex/helper-png-snapshot`、上述 source-input SHA-256、APK SHA-256、`format=png` 契约和 `./build_apk.sh` 构建命令。`LICENSE` 使用 ARTEMIS 仓库 Apache-2.0 原文。

- [ ] **Step 4: 运行制品测试和 manifest 覆盖测试**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-bundle.test.js
node skills/mobile-ai-visual-test/scripts/tests/architecture-boundaries.test.js
```

Expected: 两项 PASS。

- [ ] **Step 5: 提交制品边界**

```bash
git add skills/mobile-ai-visual-test/scripts/platform/adapters/android/helper \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-bundle.test.js \
  skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): bundle Android accessibility helper"
```

---

### Task 2: 冻结 Android UI 后端策略

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/lib/execution-environment.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/target-binding.js`
- Modify: `skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-service.js`
- Modify: `skills/mobile-ai-visual-test/scripts/lib/coordinator-interface-contract.js`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/probe.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-env.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/runtime.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/observe.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/capture.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/action.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-app.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/coordinator-agent-facing.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-capability-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/references/coordinator/methods/confirm-run.md`

**Interfaces:**
- Consumes: environment binding object。
- Produces: `binding.androidUiBackend: 'auto' | 'helper' | 'uiautomator'`；Coordinator public schema 接受并冻结该字段；`environmentAdapterArgs()` 对 Android probe/runtime/observe/action/capture 添加 `--android-ui-backend <value>`；`environmentPrepareArgs(binding)` 复用 probe 参数生成 prepare CLI。

- [ ] **Step 1: 写 binding 规范化失败测试**

在 `contract.test.js` 覆盖：

```js
const autoAndroid = normalizeEnvironmentBinding({
  platform: 'android', deviceId: 'android-1', appId: 'com.example', entry: '.MainActivity',
}, 'android');
assert.strictEqual(autoAndroid.androidUiBackend, 'auto');
assert.strictEqual(normalizeEnvironmentBinding({ ...autoAndroid, androidUiBackend: 'helper' }, 'android').androidUiBackend, 'helper');
assert.strictEqual(normalizeEnvironmentBinding({ ...autoAndroid, androidUiBackend: 'uiautomator' }, 'android').androidUiBackend, 'uiautomator');
assert.throws(() => normalizeEnvironmentBinding({ ...autoAndroid, androidUiBackend: 'invalid' }, 'android'), /androidUiBackend/);
assert.throws(() => normalizeEnvironmentBinding({
  platform: 'ios', deviceId: 'ios-1', appId: 'com.example', androidUiBackend: 'helper',
}, 'ios'), /only belong to android/);
assert.deepStrictEqual(
  environmentAdapterArgs({ ...autoAndroid, androidUiBackend: 'helper' }, 'observe').slice(-2),
  ['--android-ui-backend', 'helper'],
);
assert.deepStrictEqual(
  environmentAdapterArgs({platform:'android', deviceId:'legacy', appId:'com.example', entry:'.Main'}, 'runtime').slice(-2),
  ['--android-ui-backend', 'auto'],
);
assert.strictEqual(safeEnvironmentSummary({ binding: autoAndroid }).androidUiBackend, 'auto');
const legacyBinding = {platform:'android', deviceId:'legacy', appId:'com.example', entry:'.Main'};
assert.deepStrictEqual(validateBinding(legacyBinding), legacyBinding);
assert.strictEqual(bindingSha(validateBinding(legacyBinding)), bindingSha(legacyBinding));
```

另用历史 environment/batch fixture 断言缺少字段时原 `bindingSha` 和确认记录仍有效，但 runtime/adapter 参数得到 `auto`。在 `coordinator-agent-facing.test.js` 断言 `CONFIRM_BINDING` 接受 `androidUiBackend:'helper'`、拒绝非法值，并断言导出的 `environmentPrepareArgs({platform:'android', deviceId:'d1', androidUiBackend:'helper'})` 包含 `--android-ui-backend helper`。在 `agent-capability-contract.test.js` 保留 `d71e316` 新增的 act/runPlan 粒度指导断言。

- [ ] **Step 2: 运行测试确认字段尚未规范化**

Run: `node skills/mobile-ai-visual-test/scripts/tests/contract.test.js`

Expected: FAIL，默认 binding 中缺少 `androidUiBackend`。

- [ ] **Step 3: 实现平台所有权和 adapter 参数**

在 `execution-environment.js` 增加：

```js
const ANDROID_UI_BACKENDS = new Set(['auto', 'helper', 'uiautomator']);

function normalizeAndroidUiBackend(value) {
  const backend = String(value || 'auto').trim().toLowerCase();
  if (!ANDROID_UI_BACKENDS.has(backend)) {
    throw new Error(`ENVIRONMENT_BINDING_MISMATCH: invalid androidUiBackend ${value}`);
  }
  return backend;
}
```

`target-binding.js` 只在字段显式存在时校验/规范化 `auto|helper|uiautomator` 并拒绝非 Android ownership，缺失时保持缺失；`normalizeEnvironmentBinding` 才为新执行环境 snapshot 写入默认值。不要在 `validateBinding()` 中补默认值；`environmentAdapterArgs` 对所有 Android purpose 使用 `binding.androidUiBackend || 'auto'`，保证历史 target binding 不改 hash也能显式传参。

Coordinator 的 `BINDING`/`BINDING_SCHEMA`、字段说明增加该枚举，Android binding template 显式给出 `androidUiBackend:'auto'`；`coordinator-interface-contract.js` 的 probe/prepare 命令都声明 `androidUiBackend: flag(false, ..., {enum:['auto','helper','uiautomator']})`，并给 prepare 补上其命令示例已经使用但 schema 尚未声明的 optional `device` flag。`environmentPrepareArgs(binding)` 返回 `environmentAdapterArgs(binding, 'probe')`，自动初始化调用 `prepare-env` 时使用该函数，从冻结 binding 传递同一值。所有 Android shell adapter（包括共享 ADB 的 `prepare-app.sh`）先接受并校验 `--android-ui-backend`，本任务仍保持现有行为；`probe.sh` 在 `capabilities.androidUiBackend` 返回 `{requested}`。后续任务只能读取已经解析的 CLI 变量，不能另从 `MAVT_ANDROID_UI_BACKEND` 取第二份策略。

- [ ] **Step 4: 更新确认文档并运行契约测试**

在 `confirm-run.md` 的 binding 表增加：

```text
binding.androidUiBackend | 否 | Android only；auto（默认）、helper、uiautomator
```

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/contract.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js
node skills/mobile-ai-visual-test/scripts/tests/coordinator-agent-facing.test.js
node skills/mobile-ai-visual-test/scripts/tests/agent-capability-contract.test.js
node skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js
```

Expected: 五项 PASS；最新 `main` 的 run-plan selection guidance 断言仍通过。

- [ ] **Step 5: 提交后端策略契约**

```bash
git add skills/mobile-ai-visual-test/scripts/lib/execution-environment.js \
  skills/mobile-ai-visual-test/scripts/lib/target-binding.js \
  skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-contract.js \
  skills/mobile-ai-visual-test/scripts/coordinator/agent-facing-service.js \
  skills/mobile-ai-visual-test/scripts/lib/coordinator-interface-contract.js \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/probe.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-env.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/runtime.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/observe.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/capture.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/action.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-app.sh \
  skills/mobile-ai-visual-test/scripts/tests/contract.test.js \
  skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js \
  skills/mobile-ai-visual-test/scripts/tests/coordinator-agent-facing.test.js \
  skills/mobile-ai-visual-test/scripts/tests/agent-capability-contract.test.js \
  skills/mobile-ai-visual-test/references/coordinator/methods/confirm-run.md
git commit -m "feat(mavt): freeze Android UI backend policy"
```

---

### Task 3: 实现认证 HTTP client 和原子 snapshot 文件写入

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/lib/android-helper-client.js`
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/atoms/helper-snapshot.js`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-client.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: mode 0600 session JSON `{deviceId, transportId, localPort, token, protocolVersion, generation}`。
- Produces:
  - `ping(session, options) -> Promise<PingInfo>`
  - `snapshotToFiles(session, {screenshotPath, layoutPath, timeoutMs}) -> Promise<SnapshotMetadata>`
  - `performAction(session, command, params, options) -> Promise<ActionReply>`
  - errors `HelperUnavailableBeforeDispatch`、`HelperAuthenticationRejected` 和 `HelperActionOutcomeUnknown`，每个 error 都包含 `phase: 'BEFORE_DISPATCH' | 'AUTH_REJECTED' | 'POST_DISPATCH_UNKNOWN'`。

- [ ] **Step 1: 写本地 HTTP server 契约测试**

`android-helper-client.test.js` 启动 `http.createServer`，断言：

```js
assert.strictEqual(request.headers['x-artemis-token'], 'secret-token');
assert.strictEqual(request.url, '/snapshot?fields=xml&format=png');
```

server 返回 1x1 PNG Base64、XML、`success:true`、`screenshot_format: 'png'`、`screenshot_media_type: 'image/png'`。测试必须验证输出文件、宽高、atomic timing；再覆盖非法 HTTP status、超过 `64 MiB` 响应、非法 PNG signature、空 XML、写第二个目标失败时两个目标均不存在，以及：

```js
await assert.rejects(() => snapshotToFiles(session, outputs), /screenshot_format/);
await assert.rejects(() => performAction(session, 'tap', {x: 1, y: 2}, {timeoutMs: 10}), (error) => {
  assert.strictEqual(error.code, 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN');
  return true;
});
assert.ok(!capturedLogs.includes('secret-token'));
```

注册：

```js
androidHelperClient: 'tests/android-helper-client.test.js',
```

- [ ] **Step 2: 运行测试确认 module 缺失**

Run: `node skills/mobile-ai-visual-test/scripts/tests/android-helper-client.test.js`

Expected: FAIL，`Cannot find module .../android-helper-client`。

- [ ] **Step 3: 实现 client，不把大内容写 stdout**

核心请求签名：

```js
async function requestJson(session, request) {
  return httpJson({
    host: '127.0.0.1', port: session.localPort,
    method: request.method || 'GET', path: request.path,
    headers: { 'X-Artemis-Token': session.token },
    body: request.body, timeoutMs: request.timeoutMs,
  });
}
```

`httpJson` 必须限制 response body 为 `64 MiB`，区分连接建立前失败、401 和请求开始后的不确定失败。`performAction` 的 HTTP body 必须是扁平 `{cmd, ...params}`，与 Helper protocol 2 的 `executeCommand(cmd, json)` 一致，不能嵌套 `params`。`snapshotToFiles` 先校验 HTTP status、JSON、`success`、格式字段、PNG signature 和非空 XML，再分别写入目标目录的 staging 文件；提交顺序固定为 XML first、PNG last（PNG 是 commit marker），启动时清理同请求遗留 staging/不完整目标，任何校验或 rename 失败都删除本次两个目标。返回值不得包含 `screenshot_base64`、token 或 XML 正文。

`helper-snapshot.js` 只接收 `--session-state --screenshot-out --layout-out --timeout-ms`，stdout 返回小型 JSON metadata。启动时使用 `lstat` 拒绝 symlink，并校验 session 文件 mode 不允许 group/other read。

- [ ] **Step 4: 运行 client 和 PNG 回归测试**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-client.test.js
node skills/mobile-ai-visual-test/scripts/tests/action-spatial-evidence.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js
```

Expected: 三项 PASS。

- [ ] **Step 5: 提交 Helper client**

```bash
git add skills/mobile-ai-visual-test/scripts/platform/adapters/android/lib/android-helper-client.js \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/atoms/helper-snapshot.js \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-client.test.js \
  skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): add authenticated Android helper client"
```

---

### Task 4: 实现 batch acquire/release 和安全会话状态

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/lib/android-helper-session.js`
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/lib/android-helper-ownership.js`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-runtime.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/atoms/helper-snapshot.js`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/runtime.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/batch/device-session.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-runtime.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: `{deviceId, ownerKey, androidUiBackend}` 和 Task 1 bundle manifest。
- Produces:
  - `acquireAndroidHelper(options) -> platformRuntimeResult`
  - `releaseAndroidHelper(options) -> platformRuntimeResult`
  - `ensureAndroidHelperSession({sessionStatePath, kind, forceReattach}) -> secretSession`
  - `claimAndroidHelperDevice({deviceId, ownerKey, workspaceRoot}) -> ClaimResult`
  - `releaseAndroidHelperClaim({deviceId, ownerKey}) -> ClaimResult`
  - non-sensitive `resource.androidHelper.sessionStatePath`
  - secret cache journal `{schemaVersion, phase, ownerKey, deviceId, androidUserId, transportId, priorAccessibilityState, ownsServiceChange, localPort, ownsForward, token, protocolVersion, versionCode, generation}`，目录 `0700`、文件 `0600`。
- Test seam: `runAdb({deviceId, args, stdin, timeoutMs}) -> {status, stdout, stderr}`；token 只能出现在 `stdin`。

- [ ] **Step 1: 写 fake ADB 生命周期测试**

`android-helper-runtime.test.js` 使用注入的 `runAdb` 和 `requestPing`，记录命令序列。至少断言：

```js
assert.deepStrictEqual(calls.forward, ['forward', 'tcp:0', 'tcp:18888']);
assert.ok(calls.some((call) => call.args.at(-1) === 'shell'
  && call.stdin.includes('com.artemis.helper.SET_TOKEN')));
assert.strictEqual(calls.some((call) => call.args.includes('secret-token')), false);
assert.strictEqual(fs.statSync(result.resource.androidHelper.sessionStatePath).mode & 0o077, 0);
assert.strictEqual(JSON.stringify(result).includes('secret-token'), false);
assert.deepStrictEqual(released.enabledServices, ['existing.reader/.Service']);
assert.strictEqual(fs.existsSync(result.resource.androidHelper.sessionStatePath), false);
```

另覆盖：

- `uiautomator -> NOT_REQUIRED`，且没有 Helper ADB 调用。
- API 29 下 `auto -> NOT_REQUIRED/backend=uiautomator`、严格 `helper -> ACQUIRE_FAILED`，且没有安装或启用 service。
- service 启动延迟时按 1 秒单次 timeout 轮询，10 秒 readiness budget 内成功，不依赖固定 sleep。
- service/forward/token/ping 各阶段失败都会逆序回滚；只有回滚成功后 `auto` 才能返回 fallback。
- acquire 在 forward 后被中断，再用同一 `ownerKey` 调用时读取同一 journal，清理或续接而不是创建第二个 forward。
- acquire 在 claim 后、完整 journal mutation phase 前被中断时，同 owner 从 `CLAIMED` journal 继续；其他 owner 只能按 owner 状态等待或安全回收。
- external-session 探测或正式 forward 创建在 `adb forward tcp:0` 返回前后中断时，通过预先记录的 forward baseline/intent 识别唯一新增 forward；结果不唯一时返回 ownership unknown，不删除猜测目标。
- 两个不同 owner 竞争同一 device：活跃 owner 返回 retryable `ANDROID_HELPER_IN_USE` 和 `WAIT_OR_CANCEL_OWNER_BATCH`；终态 owner 先回收再接管；owner 无法确认时返回 `ANDROID_HELPER_OWNERSHIP_UNKNOWN`。非 owner 的 release 不得清 token、forward 或 service。
- 两个 owner 对同一 device 使用不同 `MAVT_ANDROID_HELPER_STATE_DIR` 时仍只能有一个取得 canonical device claim。
- 无 claim、service 已启用且匿名 ping 为 `token_set=true` 或不可确认：`auto` 返回 `NOT_REQUIRED/backend=uiautomator` 和 `ANDROID_HELPER_EXTERNAL_SESSION|ANDROID_HELPER_EXTERNAL_STATE_UNKNOWN`，严格 `helper` 返回 `ACQUIRE_FAILED`；两者均没有 install/service/token mutation。
- 当前 Android user 未启用 service，但 device port 18888 被其他 user/外部 Helper 占用时仍执行匿名 ping并保护其 token；端口返回非 Helper payload 时按 external state unknown 处理。
- `auto` provision 失败 -> fallback `NOT_REQUIRED`；`helper` provision 失败 -> `ACQUIRE_FAILED`；release 每个阶段失败后重试可继续，重复调用仍成功。
- state root 非绝对路径、位于 workspace 内、目录权限过宽或 session symlink 均拒绝。

增加安装签名冲突 fixture：`auto` 必须恢复本次 service/forward 变更后降级；`helper` 返回 `ACQUIRE_FAILED` 且保留 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，两种模式都不得调用 `adb uninstall`。

注册：

```js
androidHelperRuntime: 'tests/android-helper-runtime.test.js',
```

- [ ] **Step 2: 运行测试确认生命周期 module 缺失**

Run: `node skills/mobile-ai-visual-test/scripts/tests/android-helper-runtime.test.js`

Expected: FAIL，缺少 `android-helper-session.js`。

- [ ] **Step 3: 实现 acquire**

session path 必须由 `sha256(deviceId)` 与 `sha256(ownerKey)` 确定，不使用每次重试都变化的随机 id。实现顺序必须固定：

```js
async function acquireAndroidHelper(options) {
  if (options.androidUiBackend === 'uiautomator') return notRequired('uiautomator');
  const sdk = await readAndroidSdk(options.deviceId, options.runAdb);
  if (sdk < 30) return unavailableForPolicy(options.androidUiBackend, 'ANDROID_HELPER_REQUIRES_API_30');
  const claim = await claimAndroidHelperDevice(options);
  if (!claim.ok) return unavailableForPolicy(options.androidUiBackend, claim.failureCode, claim.diagnostic);
  let journal = null;
  try {
    journal = await createOrResumeClaimedJournal(options, claim);
    if (claim.resumed) return recoverOwnerAcquire(options);
    const external = await detectExternalHelperSession(options, journal);
    if (external.tokenSet) throw beforeMutation('ANDROID_HELPER_EXTERNAL_SESSION');
    const before = await readAccessibilityState(options.deviceId, options.runAdb);
    journal = await recordPriorAccessibilityState(journal, before);
    await ensureBundleIntegrity(options.bundle);
    await ensureInstalledVersion(options.deviceId, options.bundle, options.runAdb);
    await ensureServiceEnabled(journal, options.runAdb);
    await createOwnedForward(journal, options.runAdb);
    await createAndPushToken(journal, options.runAdb);
    const ping = await waitUntilReady(journal, {requestTimeoutMs: 1000, budgetMs: 10000});
    validateProtocol(ping, 2, 7);
    return activateJournal(journal, ping);
  } catch (error) {
    const rollback = journal
      ? await rollbackJournal(journal, options.runAdb)
      : {ok: true, status: 'NO_DEVICE_MUTATION'};
    if (rollback.ok) await releaseAndroidHelperClaim(options);
    return failedAcquireForPolicy(options.androidUiBackend, error, rollback);
  }
}
```

`recoverOwnerAcquire` 只有在 claim/owner/device/user/transport/forward 均匹配且认证 ping 成功时才返回既有 active result；`CLAIMED` 且尚无 mutation 时从 external-session 检测继续，中间 phase 按已记录 ownership 续接或回滚后重新 acquire，标记 ACTIVE 但健康检查失败时先执行同 owner 的确定性修复，不能把本 owner 已下发的 token误判成 external session，也不能直接复用陈旧 local port。

所有 journal 变更使用同目录 atomic rename；state root 与 device dir 为 `0700`，session 为 `0600`，并拒绝 symlink。所有对 `enabled_accessibility_services` 的写入都先把 `null`/空串解析为集合，只添加 Helper；release 只移除本次添加的 Helper并保留后来出现的其他 service。记录并校验当前 Android user，所有 `settings` 与 token receiver 命令显式带 `--user <id>`，user 变化视为 session 失效。

`validateProtocol` 必须同时断言 `ping.authenticated === true`、`ping.token_set === true`、`protocol_version >= 2`、`version_code >= 7`；Helper `/ping` 对匿名请求也返回 200，不能把 HTTP 可达误判成认证会话已就绪。

`android-helper-ownership.js` 参考现有 iOS `runtime-ownership.js`：batch claim 保存 `kind:'BATCH'`、ownerKey、workspaceRoot、sessionStatePath 和 claimedAt，使用 canonical user cache 下的短时 per-device lock 原子读写，不能把同步 `withFileLock` 跨越异步 ADB 调用。claim/lock 路径不得由 `MAVT_ANDROID_HELPER_STATE_DIR` 改写。不同 owner 时解析原 workspace 的 batch 状态；ACTIVE 返回可等待诊断，TERMINAL/RECLAIMABLE 才允许按旧 journal 清理，UNKNOWN 一律拒绝接管。prepare 使用 `kind:'PREPARE'`、PID、进程启动身份和 `prepareJournalPath` 的临时 claim；确认进程已退出后仍必须按 journal 清理 owned token/forward/service，恢复成功才可回收，journal 缺失或归属不明确时拒绝接管。release 先核对 claim owner，完成设备清理后才删除 claim。

所有 `adb forward tcp:0 tcp:18888` 前先把当前 device forward baseline 和 intent 写入 journal，返回 local port 后立即提交 ownership。恢复时只回收 baseline 中不存在且 serial/remote/local 唯一匹配的 forward；无法唯一归属时停止并返回 `ANDROID_HELPER_OWNERSHIP_UNKNOWN`。外部 session 探测的临时 forward 遵守同一规则并在 `finally` 中移除。

`pushToken` 必须使用 `spawn('adb', ['-s', deviceId, 'shell'])` 并从 stdin 写入 broadcast 命令；测试注入的 `runAdb` 接口用独立 `stdin` 字段承载该输入，token 不得出现在 host argv。

- [ ] **Step 4: 实现 release 和 runtime shell 边界**

`releaseAndroidHelper` 逐阶段更新 journal 并按 spec 恢复状态；部分失败保留 journal 供下一次 release 继续。`runtime.sh` 接受：

```text
--operation acquire|release
--owner-key <key>
--runtime-json <json>
--device <serial>
--android-ui-backend auto|helper|uiautomator
```

shell 只负责参数转发到 Node module；token 不经过 shell。`device-session.js` 的 runtime 调用继续使用 `environmentAdapterArgs`，release 使用保存的 runtime resource。

`device-session.js` 还要通过 `MAVT_ANDROID_HELPER_WORKSPACE_ROOT` 把 `workspaceRoot` 传入 runtime process，使 session manager 拒绝 workspace 内的 `MAVT_ANDROID_HELPER_STATE_DIR`。`ensureAndroidHelperSession` 在请求前核对 owner、device、Android user、transport id 和 forward；只读 snapshot 可在 forward 失效或 service rebind 后修复一次。HTTP 401 只重新下发同一 token一次。action 只允许在第一个 POST 前调用该函数；transaction 开始后的 transport 异常由 client 原样升级为 unknown。

本任务必须同步修改 `helper-snapshot.js`：每次 snapshot 先调用 `ensureAndroidHelperSession({kind:'READ_ONLY'})`；snapshot 自身遇到 401、forward 失效或 service 无响应时，在再次确认 claim 后执行一次允许的修复并只重试一次。没有该接线，Task 3 CLI 会绕过 owner/user/transport 校验。

- [ ] **Step 5: 运行 lifecycle 回归**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-runtime.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-runtime.test.js
node skills/mobile-ai-visual-test/scripts/tests/warm-session-current.test.js
node skills/mobile-ai-visual-test/scripts/tests/batch-cancellation.test.js
```

Expected: 四项 PASS。

- [ ] **Step 6: 提交 runtime 生命周期**

```bash
git add skills/mobile-ai-visual-test/scripts/platform/adapters/android/lib/android-helper-session.js \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/lib/android-helper-ownership.js \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/atoms/helper-snapshot.js \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/runtime.sh \
  skills/mobile-ai-visual-test/scripts/batch/device-session.js \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-runtime.test.js \
  skills/mobile-ai-visual-test/scripts/tests/platform-runtime.test.js \
  skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): manage Android helper runtime lifecycle"
```

---

### Task 5: 将 batch session 安全传入 Android adapter

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/session/android-helper-session-service.js`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-session-lifecycle.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/device-port.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: execution `runtime.json.sessionRef.platformRuntimePath`。
- Produces: `androidHelperAdapterEnvironment(execDir, binding) -> NodeJS.ProcessEnv`；adapter 只通过 `MAVT_ANDROID_HELPER_SESSION_STATE` 获取 cache path，backend 策略仍来自 CLI `--android-ui-backend`。

- [ ] **Step 1: 写 session 引用和泄密测试**

创建 platform runtime fixture：

```js
writeJsonAtomic(sessionRef.platformRuntimePath, {
  schemaVersion: 1, type: 'batchPlatformRuntime', batchId: sessionRef.batchId,
  platform: 'android', bindingSha: bindingSha(binding), ownerKey: 'batch-owner-1',
  status: 'ACTIVE', ownership: 'FRAMEWORK_MANAGED',
  resource: { androidHelper: {
    backend: 'helper', sessionId: 'helper-session-1',
    sessionStatePath: '/secure/cache/helper-session-1.json', protocolVersion: 2, versionCode: 7,
  }},
});
```

断言 runner 收到：

```js
assert.strictEqual(options.env.MAVT_ANDROID_HELPER_SESSION_STATE, '/secure/cache/helper-session-1.json');
assert.strictEqual(args.includes('secret-token'), false);
```

并覆盖 runtime 文件缺失、platform/bindingSha/batchId/ownerKey 不匹配、Helper session path 非绝对路径或位于 execution/workspace 内时不设置 env并返回明确错误。另分别覆盖合法选择：`helper` 只接受 `ACTIVE/FRAMEWORK_MANAGED/backend=helper`；`auto` 接受该 active 状态或 acquire 已记录的 `NOT_REQUIRED/NONE/backend=uiautomator`；`uiautomator` 只接受 `NOT_REQUIRED/NONE`。后两种合法 legacy 状态必须清除 session env并继续执行，不能被误判为 runtime 损坏。

- [ ] **Step 2: 运行测试确认 Android 尚未读取 platform runtime**

Run: `node skills/mobile-ai-visual-test/scripts/tests/android-helper-session-lifecycle.test.js`

Expected: FAIL，runner env 中没有 session path。

- [ ] **Step 3: 实现 session service 和 runner env**

`android-helper-session-service.js` 只读取 non-secret runtime resource，并先从继承环境中删除任何旧的 `MAVT_ANDROID_HELPER_SESSION_STATE`：

```js
function androidHelperAdapterEnvironment(execDir, binding) {
  const env = { ...process.env };
  delete env.MAVT_ANDROID_HELPER_SESSION_STATE;
  if (binding.platform !== 'android') return env;
  const runtime = readJson(path.join(execDir, 'runtime.json'), null);
  const platformRuntime = runtime?.sessionRef?.platformRuntimePath
    ? readJson(runtime.sessionRef.platformRuntimePath, null) : null;
  const helper = platformRuntime?.resource?.androidHelper;
  const selection = validateAndroidRuntimeReference(runtime?.sessionRef, platformRuntime, binding, helper, execDir);
  return selection.backend === 'helper'
    ? { ...env, MAVT_ANDROID_HELPER_SESSION_STATE: helper.sessionStatePath }
    : env;
}
```

`validateAndroidRuntimeReference` 校验 `platformRuntime.type/batchId/status/platform/bindingSha/ownerKey/ownership`、冻结 policy 与 resource backend 的合法组合和绝对 cache path，并要求 `batchId === runtime.sessionRef.batchId`，但不读取 secret 文件。历史 binding 缺字段时 policy 按 `auto` 解释。测试先在父进程放入一个伪造的 stale session env，证明 active Helper、合法 legacy fallback、无效 runtime 三条路径都先清除继承值，只有第一条写入已验证路径。`defaultRunner` 使用 `env: options.env || process.env`；observe/action/capture 调用均传入此环境。不得读取 secret session 内容或把它复制进 execution，也不得创建 `MAVT_ANDROID_UI_BACKEND` 第二配置源。

- [ ] **Step 4: 运行 device port 与 session 回归**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-session-lifecycle.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js
node skills/mobile-ai-visual-test/scripts/tests/case-runtime.test.js
```

Expected: 三项 PASS。

- [ ] **Step 5: 提交 session 传播边界**

```bash
git add skills/mobile-ai-visual-test/scripts/session/android-helper-session-service.js \
  skills/mobile-ai-visual-test/scripts/platform/device-port.js \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-session-lifecycle.test.js \
  skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js \
  skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): bind Android helper session to adapters"
```

---

### Task 6: 接入原子 PNG+XML observe/capture 与只读降级

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/observe.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/capture.sh`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-observation.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: CLI `--android-ui-backend`、`MAVT_ANDROID_HELPER_SESSION_STATE` 和 Task 3 `helper-snapshot.js`。
- Produces: 与当前完全相同的 `observation`/`capture` artifact paths；新增 `technicalSignals.androidUiBackend`。

- [ ] **Step 1: 写 Helper 成功、auto fallback、strict failure 测试**

fixture helper snapshot command 写入测试 PNG/XML，并返回：

```json
{"ok":true,"backend":"helper","helperVersion":"1.2.1","protocolVersion":2,"atomicElapsedMs":120,"requestElapsedMs":180}
```

断言成功 observation：

```js
assert.strictEqual(result.artifacts.screenshot, 'screenshots/observation-helper.png');
assert.strictEqual(result.artifacts.layout, 'layouts/observation-helper.xml');
assert.strictEqual(result.technicalSignals.androidUiBackend.selected, 'helper');
assert.strictEqual(result.technicalSignals.layoutCapture.status, 'AVAILABLE');
assert.deepStrictEqual(result.technicalSignals.captureTiming.order, ['helperSnapshot']);
assert.strictEqual(legacyDumpCalls, 0);
assert.strictEqual(legacyScreenshotCalls, 0);
```

auto fixture 让 helper 命令失败，断言 legacy 两个 atom 各执行一次，selected 为 `uiautomator` 且 fallback code 为 `ANDROID_HELPER_SNAPSHOT_FAILED`。strict helper 模式无论 session env 缺失还是 snapshot 失败都必须非零退出，不产生半成品 screenshot/layout，绝不能落入 legacy。另用 barrier fixture 证明 helper snapshot、logs、foreground 在同一时间窗启动，并验证 helper 失败后才启动 legacy dump/screenshot，避免两套 UI observation 同时竞争设备。

- [ ] **Step 2: 运行测试确认 observe 仍固定 legacy**

Run: `node skills/mobile-ai-visual-test/scripts/tests/android-helper-observation.test.js`

Expected: FAIL，Helper fixture 未被调用。

- [ ] **Step 3: 在 observe.sh 实现 backend router**

关键分支：

```bash
if [[ "$android_ui_backend" != "uiautomator" \
   && -n "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" ]]; then
  if helper_meta="$(node "$atoms_dir/helper-snapshot.js" \
      --session-state "$MAVT_ANDROID_HELPER_SESSION_STATE" \
      --screenshot-out "$local_png" --layout-out "$local_xml" \
      --timeout-ms "$helper_timeout_ms")"; then
    selected_backend="helper"
  elif [[ "$android_ui_backend" == "helper" ]]; then
    exit_with_helper_snapshot_failure
  else
    fallback_code="ANDROID_HELPER_SNAPSHOT_FAILED"
  fi
fi
if [[ "$android_ui_backend" == "helper" && -z "${MAVT_ANDROID_HELPER_SESSION_STATE:-}" ]]; then
  exit_with_helper_snapshot_failure "ANDROID_HELPER_SESSION_MISSING"
fi
if [[ "$selected_backend" != "helper" ]]; then
  capture_legacy_layout_and_png
fi
```

Helper snapshot 与 `logs.sh`、`foreground.sh` 并行，分别保存 PID、等待并记录 timing；legacy fallback 只能在 Helper 子进程失败后启动。组装 JSON 时只解析小型 helper metadata，不读取 Base64，并保留既有 `technicalSignals.layoutCapture` 与 `captureTiming` shape；Helper 成功时 `order:['helperSnapshot']`，fallback 时继续使用 `['layout','screenshot']`。

- [ ] **Step 4: capture.sh 使用相同只读路由**

截图-only capture 调用 `helper-snapshot.js`，layout 输出用 `mktemp` 创建并由 `trap` 无条件删除；Helper 失败按同一策略回退到 `screenshot.sh`。最终 artifact 仍只有 `screenshots/<label>.png`。strict Helper 失败不得保留 screenshot，auto fallback 的 capture timing 必须标记 selected backend 和 fallback code。

- [ ] **Step 5: 运行观察和证据契约回归**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-observation.test.js
node skills/mobile-ai-visual-test/scripts/tests/android-layout-capture.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js
node skills/mobile-ai-visual-test/scripts/tests/publication-integrity.test.js
```

Expected: 五项 PASS。

- [ ] **Step 6: 提交原子观察**

```bash
git add skills/mobile-ai-visual-test/scripts/platform/adapters/android/observe.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/capture.sh \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-observation.test.js \
  skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js \
  skills/mobile-ai-visual-test/scripts/tests/platform-capture.test.js \
  skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): use atomic Helper observations on Android"
```

---

### Task 7: 接入完整界面动作并禁止未知动作重放

**Files:**
- Create: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/atoms/helper-action.js`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/action.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/device-port.js`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-action.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/case-runtime.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/self-test.js`

**Interfaces:**
- Consumes: MAVT normalized action、Helper session path、Task 3 `performAction()`。
- Produces: `helperActionTransaction(action) -> {supported, steps, timeoutMs}` 和 schema 2 Action Result，transport 为 `ANDROID_HELPER_HTTP`；pre-dispatch unavailable/unsupported 状态允许 `auto` fallback，transaction 第一个 POST 开始后禁止 fallback。

- [ ] **Step 1: 写动作映射和 no-replay 测试**

覆盖 transaction 映射：

```js
assert.deepStrictEqual(helperActionTransaction({type:'inputText', text:'中文', mode:'replace'}).steps,
  [{kind:'rpc', cmd:'type', params:{text:'中文', append:false}}]);
assert.deepStrictEqual(helperActionTransaction({type:'inputText', x:10, y:20, text:'追加', mode:'append'}).steps,
  [{kind:'rpc', cmd:'tap', params:{x:10,y:20}}, {kind:'rpc', cmd:'type', params:{text:'追加', append:true}}]);
assert.deepStrictEqual(helperActionTransaction({type:'doubleTap', x:10, y:20, intervalMs:120}).steps,
  [{kind:'rpc', cmd:'tap', params:{x:10,y:20}}, {kind:'wait', ms:120}, {kind:'rpc', cmd:'tap', params:{x:10,y:20}}]);
assert.strictEqual(helperActionTransaction({type:'longPress', x:10, y:20, durationMs:499}).supported, false);
assert.strictEqual(helperActionTransaction({type:'swipe', fromX:0, fromY:0, toX:1, toY:0, velocity:40000}).supported, false);
assert.strictEqual(helperActionTransaction({type:'swipe', fromX:0, fromY:0, toX:2000, toY:0, velocity:200}).supported, false);
assert.deepStrictEqual(helperActionTransaction({type:'back'}).steps,
  [{kind:'rpc', cmd:'global', params:{action:'back'}}]);
```

覆盖以下执行：

1. Helper success：ADB action call count 为 0。
2. preflight unavailable + auto：ADB action call count 为 1。
3. POST timeout：result `command.status=UNKNOWN`，ADB action call count 为 0。
4. 第一个 transaction step 成功、第二个显式 `success=false`：result `command.status=ACCEPTED/deviceExecution.status=FAILED`，ADB action call count 为 0。
5. HTTP 401：先重新核对 claim owner，再下发原 token并只重试该 RPC 一次；claim 丢失时不覆盖 token，HTTP 500 和断链不重试。
6. strict helper preflight/参数不支持：action.sh 输出合法 `REJECTED/NOT_EXECUTED` JSON 并 exit 0，不被 Case Runtime 误记为 unknown。
7. strict helper session env 缺失：结果同样为已知 REJECTED，legacy action call count 为 0。
8. long-press during-action capture：Helper RPC 与既有 ADB screenshot 并行，结果保留 `duringActionCapture`，且不调用 legacy long-press atom。

Case Runtime 测试必须断言第三种产生 `actionOutcomeUnknown` event，并在重新 observe 前没有第二次动作调用。

- [ ] **Step 2: 运行测试确认 Helper 动作尚未路由**

Run: `node skills/mobile-ai-visual-test/scripts/tests/android-helper-action.test.js`

Expected: FAIL，Helper action CLI 不存在。

- [ ] **Step 3: 实现 helper-action.js 和映射**

`helper-action.js` CLI 接受 `--session-state <path> --action-json <json> --timeout-ms <ms>`，导出映射函数供单测使用，并在发送第一个 POST 前调用 `ensureAndroidHelperSession({kind:'ACTION'})`。action body 固定为扁平 `{cmd, ...params}`。preflight unavailable 或 transaction 参数不受支持时 exit `20`、stdout 为空、stderr 只输出非敏感 code；只要第一个 POST 已开始，stdout 必须输出 schema 2 Action Result并 exit 0。若某个 POST 得到 HTTP 401，因为服务端尚未执行该 RPC，可以在再次确认 claim owner 后重新下发 token并只重试该 RPC 一次；claim 丢失时禁止下发 token，已有成功 transaction step 则输出 `ACCEPTED/FAILED`，没有成功 step 则输出 `REJECTED/NOT_EXECUTED`。其他 POST 异常不得 reattach 或重试。关键状态：

```js
function unknownResult(action, elapsedMs, message) {
  return {
    schemaVersion: 2, type: 'actionResult', platform: 'android', action,
    command: {status: 'UNKNOWN', transport: 'ANDROID_HELPER_HTTP', elapsedMs},
    deviceExecution: {status: 'UNVERIFIED', verification: 'NONE'},
    failureCode: 'ANDROID_HELPER_ACTION_OUTCOME_UNKNOWN',
    message,
  };
}
```

Helper `success=false` 已经越过认证并进入 action handler，返回 `command.status='ACCEPTED'`、`deviceExecution.status='FAILED'`；只有 transaction 尚未开始的本地校验/preflight 才能成为 `REJECTED/NOT_EXECUTED`。action POST timeout、断链、截断响应和非 401 HTTP error 返回 exit 0 和 `UNKNOWN` JSON，使 adapter 不会进入 fallback 分支。Action Result 不得回显 input text。

`swipe` 必须复用 `action-contract.js` 的 `swipeDurationMs()` 并把结果作为 Helper `duration`；当前 APK 会限幅到 50-5000ms，因此范围外与 long press 一样属于 pre-dispatch unsupported。自定义 double tap 的 host wait 失败属于已执行第一 tap 的已知 partial failure，返回 `ACCEPTED/FAILED`；只有无法判断 RPC 是否到达设备的 transport failure 才返回 `UNKNOWN`。

- [ ] **Step 4: action.sh 路由完整 UI 动作**

Helper 支持集合固定为：

```bash
helper_actions='tap doubleTap toggle longPress inputText swipe back home'
```

`launchApp/restartApp/wait` 继续当前实现。long-press during-action capture 继续使用独立 `screenshot.sh`；Helper 只执行长按 RPC。

auto 仅在 helper-action exit 20 时调用 legacy atom。Helper strict 模式捕获 exit 20，生成 schema 2 `REJECTED/NOT_EXECUTED` JSON并 exit 0；任何 `UNKNOWN` JSON 原样交给 Device Port。对于 transaction，第一次 Helper POST 后设置 `dispatched=true`，后续 wait/RPC 失败都禁止进入 legacy 分支。

- [ ] **Step 5: Device Port 一般化 unknown 处理**

在保留 iOS transport 归一逻辑的前提下，为所有平台增加 Action Result unknown 检查：

```js
if (kind === 'ACTION' && adapterResult.command?.status === 'UNKNOWN') {
  throw contractError('ACTION_OUTCOME_UNKNOWN', failureText(adapterResult) || 'device action outcome is unknown', {
    actionOutcomeUnknown: true,
    adapterResult,
  });
}
```

iOS 原有 transport/session failure 仍使用现有 `IOS_ACTION_OUTCOME_UNKNOWN` 路径，不能删除 `ios-session-lifecycle.test.js` 覆盖。Case Runtime 的 act 与最新 `main` 强化后的 runPlan 都必须在 unknown 后停止并要求 observe，不得重放单动作或整个 plan。

- [ ] **Step 6: 运行动作、输入和 unknown 回归**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-action.test.js
node skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js
node skills/mobile-ai-visual-test/scripts/tests/case-runtime.test.js
node skills/mobile-ai-visual-test/scripts/tests/runtime-enhancements.test.js
node skills/mobile-ai-visual-test/scripts/tests/action-spatial-evidence.test.js
node skills/mobile-ai-visual-test/scripts/tests/ios-session-lifecycle.test.js
node skills/mobile-ai-visual-test/scripts/tests/agent-capability-contract.test.js
```

Expected: 七项 PASS。

- [ ] **Step 7: 提交动作后端**

```bash
git add skills/mobile-ai-visual-test/scripts/platform/adapters/android/atoms/helper-action.js \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/action.sh \
  skills/mobile-ai-visual-test/scripts/platform/device-port.js \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-action.test.js \
  skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js \
  skills/mobile-ai-visual-test/scripts/tests/case-runtime.test.js \
  skills/mobile-ai-visual-test/scripts/self-test.js
git commit -m "feat(mavt): route Android UI actions through Helper"
```

---

### Task 8: 环境诊断、人工准备和文档

**Files:**
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/probe.sh`
- Modify: `skills/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-env.sh`
- Modify: `skills/mobile-ai-visual-test/references/installation.md`
- Modify: `skills/mobile-ai-visual-test/references/commands/environment.md`
- Modify: `skills/mobile-ai-visual-test/references/environment-probing.md`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js`
- Modify: `skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js`

**Interfaces:**
- Consumes: Helper bundle/status 和 `androidUiBackend`。
- Produces: probe capability `androidHelper`、prepare dependency `androidAccessibilityHelper`、用户可操作的安装/释放说明。

- [ ] **Step 1: 写 probe/prepare 输出测试**

fake ADB 覆盖 API 29、API 30 未安装、已安装未启用、已安装可 ping 四种状态。断言：

```js
assert.deepStrictEqual(probe.capabilities.androidHelper, {
  requested: 'auto', installed: true, enabled: true,
  compatible: true, versionCode: 7, protocolVersion: 2,
});
assert.strictEqual(prepare.dependencies.find((item) => item.id === 'androidAccessibilityHelper').ok, true);
```

`uiautomator` 模式下 helper dependency 为 `{required:false, stage:'disabled'}`，不安装、不启用。`auto` 下 Helper 签名冲突为非 required dependency failure，但 MAVT IME 成功时整个 prepare 仍 `ok:true`；严格 `helper` 下同一问题使 prepare `ok:false`。存在其他活跃 device claim 时，auto 跳过 Helper mutation并保留 legacy readiness，strict helper 返回 retryable dependency failure。另覆盖临时 prepare claim 并发、正常释放，以及进程分别在 service/forward/token 后退出时由下次调用按 prepare journal stale reclaim。journal 缺失或 forward ownership 不唯一必须拒绝接管。每个 prepare fixture 都断言调用前后的 `accessibility_enabled` 和 enabled services 完全一致，且没有残留 forward/token/claim/journal。

- [ ] **Step 2: 运行测试确认当前 probe 没有 Helper 状态**

Run: `node skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js`

Expected: FAIL，`capabilities.androidHelper` 缺失。

- [ ] **Step 3: 实现只读 probe 和显式 prepare**

probe 不安装或修改持久状态，只读取 SDK、package、enabled services；仅当 service 原本已启用时才创建临时 forward/ping，并在同一调用的 `finally` 中移除 forward。API < 30 报告 `compatible:false`；missing package 报告 `preparable:true`，不能因为尚未安装就阻止环境确认。

prepare-env 在 `auto/helper` 下调用 session manager 的 `verifyProvisioning()`：原子取得 `kind:'PREPARE'` 的临时 device claim并创建 deterministic prepare journal；有其他活跃或未知 owner 时不得继续。取得 claim 后先用匿名 ping 检查外部 `token_set`，确认没有外部 session 才允许保留 APK 安装/升级；若需要协议验证，只能在每次 mutation 前更新 journal，再临时启用 service、创建 forward、生成 token 和 ping，并在 `finally` 中清 token、移除 forward、恢复进入前 accessibility 状态。恢复完成后删除 journal并释放 claim。prepare 返回前再次读取状态并比较；恢复失败时即使 `auto` 也返回 `ok:false`，因为不能带着泄漏状态继续。

IME 准备规则固定为：`auto` 同时准备 Helper 和 MAVT IME以保证完整降级；`uiautomator` 只准备 MAVT IME；严格 `helper` 不要求 MAVT IME。

prepare dependency 不含 token、forward port 或 cache path。

- [ ] **Step 4: 更新安装和环境文档**

文档必须说明：

- Helper 是 Android adapter 内部依赖，不向 Case Agent 暴露。
- `auto/helper/uiautomator` 的差异。
- APK 保留安装；prepare 不保留 service/forward/token；batch release 会移除 forward、清 token，并在框架本次启用 service 时恢复原 service 状态。
- 人工诊断命令：

```bash
scripts/probe-env.sh --platform android --device '<serial>' --android-ui-backend auto
scripts/prepare-env.sh --platform android --device '<serial>' --android-ui-backend auto
```

- [ ] **Step 5: 运行文档与环境回归**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js
node skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js
node skills/mobile-ai-visual-test/scripts/tests/formal-entrypoints.test.js
```

Expected: 三项 PASS。

- [ ] **Step 6: 提交诊断和文档**

```bash
git add skills/mobile-ai-visual-test/scripts/platform/adapters/android/probe.sh \
  skills/mobile-ai-visual-test/scripts/platform/adapters/android/prepare-env.sh \
  skills/mobile-ai-visual-test/references/installation.md \
  skills/mobile-ai-visual-test/references/commands/environment.md \
  skills/mobile-ai-visual-test/references/environment-probing.md \
  skills/mobile-ai-visual-test/scripts/tests/platform-contract.test.js \
  skills/mobile-ai-visual-test/scripts/tests/agent-facing-docs.test.js
git commit -m "docs(mavt): document Android Helper backend lifecycle"
```

---

### Task 9: 全量验证、实机能力矩阵和性能门槛

**Files:**
- Create: `docs/superpowers/verification/2026-09-23-mavt-android-helper-backend.md`
- Create: `skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js`

**Interfaces:**
- Consumes: Tasks 1-8 完整实现。
- Produces: 全量测试结果、实机能力矩阵、Helper/legacy 对照数据和无泄密检查。

- [ ] **Step 1: 运行完整自测**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/self-test.js
```

Expected: 所有注册 suite PASS，0 failures。

- [ ] **Step 2: 验证生成契约与 adapter SHA**

Run:

```bash
node skills/mobile-ai-visual-test/scripts/build-agent-contract.js --role case-executor --platform android
node skills/mobile-ai-visual-test/scripts/build-agent-contract.js --role batch-coordinator --platform android
git diff --check
```

Expected: 两条命令输出有效 contract JSON，Android `adapterSha` 已覆盖新增 Helper 文件；`git diff --check` 无输出。

另运行 `git merge-base --is-ancestor main HEAD`，Expected: exit 0，证明实施分支仍包含已审查的最新 main 基线。

- [ ] **Step 3: 在已连接设备验证三种策略**

Run:

```bash
skills/mobile-ai-visual-test/scripts/probe-env.sh --platform android \
  --device '10.240.27.151:37489' --android-ui-backend auto
skills/mobile-ai-visual-test/scripts/prepare-env.sh --platform android \
  --device '10.240.27.151:37489' --android-ui-backend auto
```

实现硬件 smoke runner，内部用 `mkdtemp` 创建临时输出目录，在 `try/finally` 中 acquire/release Helper，只操作 Android Settings。它必须先确认 API >= 30，再验证 snapshot、tap、默认/自定义间隔 doubleTap、longPress、带坐标和当前焦点 replace/append inputText、swipe、back、home，并对每次动作后的 XML/PNG 做结构校验；不得启动或操作业务 App。每个会改变页面的动作都使用可恢复导航，finally 返回 Settings 起始页并释放 Helper。

Run:

```bash
helper_smoke_json="$(node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js \
  --device '10.240.27.151:37489' --backend helper)"
printf '%s\n' "$helper_smoke_json"
auto_smoke_json="$(node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js \
  --device '10.240.27.151:37489' --backend auto)"
printf '%s\n' "$auto_smoke_json"
legacy_smoke_json="$(node skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js \
  --device '10.240.27.151:37489' --backend uiautomator)"
printf '%s\n' "$legacy_smoke_json"
```

Expected: strict Helper case 的 Scene PNG/XML、Action Result 和最终报告均通过完整性检查；auto case 实际选择 Helper；uiautomator case 无回归。三种策略都由 smoke runner 自己在 `finally` 中 release。

- [ ] **Step 4: 验证 fallback 与 unknown 注入**

使用测试注入而非真实动作破坏：

```bash
node skills/mobile-ai-visual-test/scripts/tests/android-helper-observation.test.js
node skills/mobile-ai-visual-test/scripts/tests/android-helper-action.test.js
```

Expected: snapshot 失败可降级；action post-dispatch timeout 产生 UNKNOWN 且 legacy action call count 为 0。

- [ ] **Step 5: 验证凭据和 release**

Run:

```bash
helper_smoke_dir="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).outputDir)' "$helper_smoke_json")"
rg -n "X-Artemis-Token|secret-token|\"token\"" "$helper_smoke_dir" || true
adb -s '10.240.27.151:37489' forward --list
adb -s '10.240.27.151:37489' shell settings get secure enabled_accessibility_services
```

Expected: workspace 不含真实 token；batch release 后没有本次 owned forward；其他 accessibility service 与 acquire 前一致；host session cache journal 和 device claim 已删除。另模拟一次 acquire 在创建 forward 后中断并重新 acquire/release，确认仍只有一个 owned forward；再用第二 owner 竞争同一 device，确认它只能等待且不会覆盖第一个 token。

- [ ] **Step 6: 采集 Helper 与 legacy 性能对照**

先各执行 2 次不计入统计的 warm-up，再按 `helper/uiautomator/uiautomator/helper` 交替顺序各采集 10 次 FULL_SCENE observation，避免页面缓存与固定先后顺序偏差。记录：layout/snapshot device time、adapter end-to-end、PNG bytes、P50/P90。验收条件：

- Helper 10 次全部生成合法 PNG/XML。
- Helper FULL_SCENE P50 低于 legacy FULL_SCENE P50。
- 高复杂度 PNG 长尾单独记录，不用 JPEG 替换证据。
- 结果文件不得包含 token 或 Base64 正文。

将命令、设备信息、原始 10 组数值、P50/P90、能力矩阵和 release 检查结果写入 verification 文档。

- [ ] **Step 7: 最终提交**

```bash
git add docs/superpowers/verification/2026-09-23-mavt-android-helper-backend.md \
  skills/mobile-ai-visual-test/scripts/tests/android-helper-device-smoke.js
git commit -m "test(mavt): verify Android Helper backend end to end"
```
