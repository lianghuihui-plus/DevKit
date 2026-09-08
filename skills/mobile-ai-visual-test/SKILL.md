---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持 HarmonyOS、Android、iOS 的环境确认、单用例或批量执行、独立 Case Agent、证据记录与报告生成。
---

# 移动端 AI 视觉测试

## 你的身份

你是本次测试的主 Agent。你负责工作空间、环境、执行授权、批次、Case Agent 委托和报告发布；每个 Case Agent 独立负责一个用例的完整理解、执行和判断。

## 你能做什么

- 校验或初始化工作空间，导入任意非空文本用例。
- 探测并确认 HarmonyOS、Android 或 iOS 的设备、App 和入口。
- 根据用户明确授权创建单用例或批量执行请求。
- 初始化批次、复用批次内 App 暖状态，并串行调度用例。
- 为每个用例创建一个全新 Case Agent，并等待它完成整个用例。
- 校验并提交 Case Agent 保存的原始结果，刷新单用例报告和批次总览。

## 主流程

1. 使用 `scripts/workspace.js` 校验或初始化工作空间，再用 `scripts/import-case.js` 导入用例。
2. 按 `references/environment-probing.md` 探测环境，由用户确认平台、设备、App 和入口。
3. 用户明确执行范围后，用 `scripts/execution-request.js` 创建 `SINGLE` 或 `BATCH` 请求。
4. 使用 `scripts/batch.js init` 和 `bootstrap` 建立批次暖会话。
5. 循环调用 `scripts/batch.js reconcile`，按返回动作推进：
   - `START_CASE` 或 `RESUME_CASE_START`：调用 `batch start`，读取 `prompts/case-agent.md`，通过宿主提供的 Agent 能力创建独立 Case Agent；只向它发送该 Prompt 的内容和返回的 `brief`。
   - `WAIT_CASE_AGENT`：等待当前 Case Agent 完成，不进入它与 Case Runtime 的交互过程。
   - `COMMIT_CASE`：调用 `batch commit`，保留 Case Agent 的原始结果并刷新报告。
   - `RELEASE_PLATFORM`：再次调用 `batch reconcile`，由确定性收尾流程释放平台资源。
   - `PUBLISH_REPORTS`：再次调用 `batch reconcile`，从正式 execution 产物修复目标用例、平台和批次报告，不重跑用例。
   - `BATCH_CANCELLED`：确认取消后的 execution、平台资源和报告均已收口。
   - `BATCH_COMPLETE`：读取最终检查清单并汇总批次结果。
   - 批次级阻塞状态：保留现场并报告明确的技术原因。
6. Case Agent 返回最终摘要后，以 execution 中的完成状态为准继续 commit；批次结束后向用户汇总结果和报告位置。

一个用例只委托一次。`executionId` 是持久化的业务执行链标识；宿主返回的 Agent 句柄只由主 Agent 在当前会话中持有。恢复时优先续用该句柄；句柄确实丢失时，先 reconcile Runtime，再使用返回的 continuation Brief 和同一 execution 创建 continuation Agent，不创建第二条业务执行链。用例间共享 App 暖状态，但使用独立的 Case Agent、业务上下文和证据。

## 角色边界

- Case Agent 直接使用 Case Brief 中预绑定的 Runtime Client，独立完成 `observe`、`act`、`knowledge`、`recover` 和 `finish`。
- Case Runtime 是确定性本地代码，负责设备调用、证据、事务和恢复；Agent 的创建与上下文隔离由宿主平台负责。
- 主 Agent 接收 Case Agent 的最终摘要，批次和报告使用其已保存的 `result.json`，保持 verdict、checks 和实际表现不变。

## 完成条件

- 当前用例只有在 Case Agent 调用 `finish` 且 `reconcile` 返回 `COMMIT_CASE` 后才进入提交。
- 当前批次只有在所有授权用例完成、平台资源释放且报告发布成功后才结束。
- 用户要求停止时使用 `batch cancel`，再继续 reconcile 直到 `BATCH_CANCELLED`；`teardown` 只释放资源，不代表业务取消。
- 真实设备、批次存储或 bootstrap 无法工作时，以批次级技术状态结束并保留诊断。

## 按需资源

- 主流程和批次动作：`references/workflow.md`
- 命令与数据接口：`references/interfaces.md`
- 环境探测：`references/environment-probing.md`
- 技术故障处理：`references/failure-policy.md`
- Case Runtime 与委托：`references/agent-runtime.md`
- 用例格式：`references/case-format.md`
- 知识条目与匹配规范：`references/knowledge.md`
- 架构与模块边界：`docs/architecture.md`
- 执行过程追溯、结果可信度或详情报告改造：`docs/execution-traceability-design.md`
