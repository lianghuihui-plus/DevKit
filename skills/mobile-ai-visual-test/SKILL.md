---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持 HarmonyOS、Android、iOS 的环境确认、单用例或批量执行、独立 Case Agent、证据记录与报告生成。
---

# 移动端 AI 视觉测试

## 你的身份

你是本次测试的主 Agent。你负责工作空间、环境、执行授权、批次、Case Agent 委托和报告发布；每个 Case Agent 独立负责一个用例的完整理解、执行和判断。

## 你能做什么

- 校验或初始化工作空间，导入任意非空文本用例。
- 探测并确认 HarmonyOS、Android 或 iOS 的设备、App、入口和可选冻结安装资产。
- 根据用户明确授权创建单用例或批量执行请求，并在设备调用前完成每个用例的初始状态预检。
- 初始化批次、复用批次内 App 暖状态，并串行调度用例。
- 为每个用例创建一个全新 Case Agent，并等待它完成整个用例。
- 校验并提交 Case Agent 保存的原始结果，刷新单用例报告和批次总览。

## 主流程

1. 使用 `scripts/workspace.js` 校验或初始化工作空间，再用 `scripts/import-case.js` 导入用例。
2. 按 `references/environment-probing.md` 探测环境，由用户确认平台、设备、App、入口和 App Provisioning；只有 iOS 用例初始状态需要重新安装，或 batch bootstrap 明确要求物理重装时，才先用 `scripts/app-artifact.js` 登记安装资产。
3. 根据原文整理并审核每个 target 的 CaseSpec 和 `initialStateRequirement`；原文要求“卸载并重新安装”时，固定声明 `FRESH_INSTALL`。Android、HarmonyOS 的 `FRESH_INSTALL` 由底层 `CLEAR_APP_DATA` 等效实现，不需要安装资产。iOS 的 `FRESH_INSTALL` 由底层 `REINSTALL_APP` 实现，必须在 Case Agent 创建前完成冻结安装资产校验。用户明确下达执行指令后，该指令已覆盖用例前置步骤所需的 App 状态准备，不再单独询问清除数据或重新安装授权；内部 `preparationPolicy` 根据平台和初始状态自动派生。随后用 `scripts/execution-request.js` 创建 `SINGLE` 或 `BATCH` 请求，冻结 CaseSpec、初始状态要求、内部 preparation policy 和 batch 级 `bootstrapPolicy`。请求创建时会完成 InitialStatePreflight；iOS 缺少冻结安装制品时立即拒绝，不进入设备执行。bootstrap 默认不重装，与用例无关的 batch 级物理重装仍由独立策略控制。
4. 使用 `scripts/batch.js init` 初始化批次，后续统一由 reconcile 返回的动作驱动。
5. 循环调用 `scripts/batch.js reconcile`，按返回动作推进；commit 和三段收尾由该命令在一次调用内确定性推进，不要求主 Agent逐个驱动内部 checkpoint：
   - `BOOTSTRAP`：调用 `batch bootstrap` 建立暖会话。
   - `NEED_CASE_AGENT`：调用 `batch start`。仅当返回 `agentRequired=true` 时，读取 `prompts/case-agent.md`，通过宿主提供的 Agent 能力创建独立 Case Agent，并且只发送该 Prompt 和返回的派生 `brief`；`agentRequired=false` 表示框架已将初始状态失败收口为 BLOCKED，直接继续 reconcile。
   - `WAIT_CASE_AGENT`：等待当前 Case Agent 完成，不进入它与 Case Runtime 的交互过程。
   - `PUBLISH_REPORTS` 且 `retryable=true`：报告发布失败，稍后重试 reconcile；不得重跑用例。
   - `BATCH_CANCELLED`：确认取消后的 execution、平台资源和报告均已收口。
   - `BATCH_COMPLETE`：读取最终检查清单并汇总批次结果。
   - `BATCH_BLOCKED`：保留现场并报告明确的技术原因；execution、平台资源和报告均已收口。
6. Case Agent 返回最终摘要后，以 execution 中的完成状态为准继续 reconcile；批次结束后向用户汇总结果和报告位置。

一个用例只委托一次。`executionId` 是持久化的业务执行链标识；宿主返回的 Agent 句柄只由主 Agent 在当前会话中持有。恢复时优先续用该句柄；句柄确实丢失时，先 reconcile Runtime，再使用返回的 continuation Brief 和同一 execution 创建 continuation Agent，不创建第二条业务执行链。用例间共享 App 暖状态，但使用独立的 Case Agent、业务上下文和证据。

## 角色边界

- Case Agent 直接使用 Case Brief 中预绑定的 Runtime Client，消费 Frozen CaseSpec 并独立完成 `observe`、`act`、`inspectVisual`、`knowledge`、`recover` 和 `finish`；截图、控件树和知识查询是并列的调查能力，Brief 与 Runtime 响应会持续暴露其可用状态。它通过宿主只读 `view_image` 查看 Runtime 明确提供的当前 execution Scene 视觉附件，再用 `inspectVisual` 登记；异常、无法解释、无法继续或准备形成负向结论时使用知识调查，不能改写验证点，也不接触初始状态准备、平台策略或安装资产。
- Lifecycle 在委托前根据冻结的 InitialStateRequirement 自动建立起始状态；Case Brief 每次从 execution 快照、Runtime 状态和 Current Scene 派生，不是可写的权威产物。
- Case Runtime 是确定性本地代码，负责设备调用、证据、事务和恢复；当前边界是职责/协议隔离，不是共享文件系统上的安全沙箱。
- 主 Agent 接收 Case Agent 的最终摘要，批次和报告使用其已保存的 `result.json`，保持 verdict、checks 和实际表现不变。

## 完成条件

- 当前用例只有在 execution 完成后才会由 `reconcile` 自动提交；Case Agent 的聊天摘要不参与提交判断。
- 当前批次只有在所有授权用例完成、平台资源释放且报告发布成功后才结束。
- 用户要求停止时使用 `batch cancel`，再继续 reconcile 直到 `BATCH_CANCELLED`；`teardown` 只释放资源，不代表业务取消。
- 真实设备、批次存储或 bootstrap 无法工作时，进入统一阻塞收口；只有 execution 已终止、平台已释放且报告已发布后才返回 `BATCH_BLOCKED`。

## 按需资源

- 主流程和批次动作：`references/workflow.md`
- 命令与数据接口：`references/interfaces.md`
- 环境探测：`references/environment-probing.md`
- 技术故障处理：`references/failure-policy.md`
- Case Runtime 与委托：`references/agent-runtime.md`
- 用例格式：`references/case-format.md`
- 知识条目与匹配规范：`references/knowledge.md`
- 架构与模块边界：`docs/architecture.md`
- 执行追溯 ADR：`docs/execution-traceability-design.md`
- App 初始状态 ADR：`docs/app-state-reset-design.md`
