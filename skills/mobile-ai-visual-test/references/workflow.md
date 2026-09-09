# 执行流程

## 批次状态机

```text
workspace -> import -> probe -> optional artifact registration -> environment confirmation
-> CaseSpec + InitialStateRequirement review -> execution/bootstrap authorization + preflight
-> request -> init -> bootstrap -> NEED_CASE_AGENT -> start + initial-state establishment
-> delegate once -> WAIT_CASE_AGENT -> reconcile auto-commit -> next case
-> FINALIZING -> deterministic finalization -> BATCH_COMPLETE

cancel -> CANCELLING -> deterministic finalization -> BATCH_CANCELLED
fatal -> BLOCKING -> deterministic finalization -> BATCH_BLOCKED
```

环境确认、CaseSpec/初始状态审核和执行授权是三个独立动作。`appProvisioning` 只冻结 App 来源；`bootstrapPolicy` 决定批次启动是否执行与用例无关的物理重装；每个 target 的 `initialStateRequirement` 表达业务所需起点。用例原文的“卸载并重新安装”固定映射为 `FRESH_INSTALL`，再由平台策略解析：Android、HarmonyOS 使用 `CLEAR_APP_DATA` 且不需要安装资产，iOS 使用 `REINSTALL_APP` 且必须预先登记冻结安装资产。用户明确下达执行指令后，用例要求的状态准备已包含在执行范围内；ExecutionRequest 自动派生并冻结内部 preparation policy 和 InitialStatePreflight，不追加授权交互，Case Agent 创建前完成资产校验。

主 Agent 循环处理 `batch reconcile`：

- `BOOTSTRAP`：建立暖会话；只有执行配置明确选择 `REINSTALL_FROZEN` 且冻结制品可用时才安装。
- `NEED_CASE_AGENT`：调用 `batch start`。Lifecycle 先自动建立冻结的初始状态；`agentRequired=true` 时才把 Prompt 和派生 Case Brief 一次性交给新的 Case Agent，`false` 时直接继续 reconcile。
- `WAIT_CASE_AGENT`：等待，不进入 Case Agent 的观察、动作或恢复循环。
- `PUBLISH_REPORTS` 且 `retryable=true`：自动发布失败，稍后重试 reconcile，不重跑用例。
- `BATCH_COMPLETE` / `BATCH_CANCELLED` / `BATCH_BLOCKED`：execution、平台资源和报告均已收口。

`COMMIT_CASE`、`SETTLE_EXECUTIONS`、`RELEASE_PLATFORM` 和 `PUBLISH_REPORTS` 仍是 Batch 内部可审计 checkpoint，但 `scripts/batch.js reconcile` 会在一次调用中自动推进，主 Agent 不逐段编排。返回的 `progress` 保留本次已完成迁移。

Runtime reconcile 只把 `EXECUTION_LOCKED` 视为可重试，并把次数写入 batch state；第三次仍失败时升级为 `FATAL_EXECUTION`。事件存储损坏等错误为 `FATAL_BATCH`。两者都进入 `BLOCKING`，不会无限返回 `WAIT_CASE_AGENT`。

同一批次固定平台、设备、App、入口、App Provisioning、Bootstrap Policy 和有序目标。用例间复用当前 App 暖状态，但 Case Agent、Frozen CaseSpec、execution 上下文和证据相互独立。

## 单用例

Case Agent 从派生 Case Brief 中读取原文、Frozen CaseSpec、初始状态结果和当前 Scene，自主规划业务路径；它不能修改验证点，也不能请求准备 App。Lifecycle 在委托前按 `initialStateRequirement` 执行内部 prepare；失败时自动生成覆盖全部 expectation 的 BLOCKED CaseResult，因此无需创建 Case Agent。

Runtime 对动作、准备、恢复和 finish 做事务保护。已发送但结果未知的副作用不自动重放；恢复改变 Agent 可见事实时返回 `RECOVERY_APPLIED` 并停止旧请求。Agent 句柄丢失时，Batch 先 reconcile，再用同一 execution 的 continuation Brief 继续。

CaseResult 必须逐一覆盖 Frozen CaseSpec。Runtime 完成证据完整性校验后，主 Agent 才能 commit；Case Agent 的聊天摘要不是批次事实来源。
