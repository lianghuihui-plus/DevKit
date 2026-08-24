# HarmonyOS T-704 切换前前向验证记录

> **历史归档：** 本文记录原子切换前的验收现场，不代表当前入口状态。当前验收结果以 `../harmony-post-cutover-validation-2026-08-18.md` 为准。

> 验证日期：2026-08-18
> 结论：**通过，可进入 T-705 原子切换准备。** 该结论仅覆盖当前阶段的 HarmonyOS 交付范围，不表示 Android、iOS 已通过真机验证。

## 1. 验证范围

- 设备：HUAWEI Mate 60 Pro，`2MM0224125000204`，API 24。
- App：`com.codemao.hos.lunar`，入口 `EntryAbility`。
- 目标实现：`agent-implementation-46f4fdfae74329bb`。
- 隔离工作空间：`/private/tmp/mavt-harmony-forward.tNRtM4`。
- 批次：`batch-harmony-forward`，4 个独立 case session。
- runner：验证时使用 `scripts/tests/harmony-forward-validation.js`；正式切换完成后，该一次性 runner 已清理，本文保留当时结果与审计信息。

## 2. 真机批次结果

| Case | 结果 | 关键覆盖 | 指标摘要 |
| --- | --- | --- | --- |
| 启动页直接检查 | PASS / DIRECT_EVIDENCE | 当前页已满足时不执行多余动作 | 0 action，2 observation，plan revision 1 |
| 暖状态页面转换 | PASS / DIRECT_EVIDENCE | 从学习中心进入我的页面，现场确认入口后修订计划 | warm reused，1 action，plan revision 2 |
| 异常与知识调查 | PASS / DIRECT_EVIDENCE | 命中 Android 播放页知识后评估为 `NOT_APPLICABLE` | 1 query，1 assessment，知识未进入结论引用 |
| 显式冷启动例外 | PASS / DIRECT_EVIDENCE | 仅因原文明示冷启动，执行一次受控 recovery | PID `34548 → 35979`，generation 2，recovery 1 |

批次最终状态为 `COMPLETED`，4 个 case 均有独立 session、result、metrics、completion 和 `CONTEXT` 报告。批次共启动 App 2 次：首次 bootstrap 1 次，原文明示的 recovery 1 次；普通 case 切换没有冷启动。

## 3. 门禁发现与修复

### 3.1 未确认前台状态被标记为可用

首次批次的业务截图捕获到锁屏黑屏，adapter 返回 `inTargetApp=null`，但设备网关按“不是 false”将证据标记为 `usable=true`。

修复：`scripts/agent/device-gateway.js` 改为只有 `inTargetApp === true` 才标记证据可用，并在 `scripts/tests/device-gateway.test.js` 增加前台状态未知的回归场景。

该修复改变 implementation SHA，因此首次批次没有继续执行；验证重新创建完整批次，证明框架不会跨实现版本混写 execution。

### 3.2 Core 测试依赖系统日期

`scripts/tests/execution-core.test.js` 的三处 `beginOperation` 未传 fixture 时间，固定在 2026-08-13 创建的 execution 会在后续日期运行时误触发 30 分钟时限。

修复：从 `openCase.execution.startedAt` 派生 `openNow` 并显式传入。运行时 30 分钟硬时限没有改变。

## 4. 产物审计

以下 8 项机器审计全部为 `true`：

- 全部 case 已提交完成。
- 每个 case 使用独立 Agent session。
- `appStartCount === 1 + recoveryCount`。
- result 中的业务证据均位于当前 execution 且文件存在。
- 每个 case 的 Markdown/HTML 报告存在。
- 每个 case 的可信 completion 存在。
- 所有 operation 均已关闭。
- execution、completion 与目标 implementation 一致。

## 5. 自动化门禁

以下检查全部通过：

```bash
node scripts/self-test.js
MAVT_SELF_TEST=1 node scripts/build-agent-contract.js --role case-executor --platform harmony --profile agent-driven
MAVT_SELF_TEST=1 node scripts/build-agent-contract.js --role case-executor --platform android --profile agent-driven
MAVT_SELF_TEST=1 node scripts/build-agent-contract.js --role case-executor --platform ios --profile agent-driven
git diff --check
```

全量自测覆盖 contract、platform、report、workspace、execution Core、warm session、Agent、knowledge、eval、integration、device gateway 和历史 regression。受控 FAIL、INCONCLUSIVE、BLOCKED、时限停止、进程中断、App recovery 和不确定动作不重放由自动化 suite 覆盖，未在真机上制造破坏性业务故障。

## 6. 范围声明

- HarmonyOS：当前阶段真机门禁通过。
- Android：adapter 和目标契约已构建，真机验证因无在线设备延后。
- iOS：adapter 和目标契约已构建，真机验证因 WDA `xcodebuild code 70` 延后。
- T-705 可以开始准备原子切换发布单元；在 T-706 前，正式 `SKILL.md`、manifest 和现有业务执行核心仍保持不变。
