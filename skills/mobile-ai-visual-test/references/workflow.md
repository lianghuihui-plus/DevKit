# 执行流程

## 批次状态机

```text
workspace -> import -> CaseDefinition compile/publish -> probe -> optional artifact registration -> environment confirmation
-> definitionRef selection -> execution/bootstrap authorization + preflight
-> request -> init -> bootstrap -> NEED_CASE_AGENT -> start + initial-state establishment
-> delegate once -> WAIT_EXECUTION_RESULT -> reconcile auto-commit -> next case
-> FINALIZING -> deterministic finalization -> BATCH_COMPLETE

cancel -> CANCELLING -> deterministic finalization -> BATCH_CANCELLED
fatal -> BLOCKING -> deterministic finalization -> BATCH_BLOCKED
```

CaseDefinition 发布、环境确认和执行授权是三个独立动作。定义阶段只处理单个用例原文并冻结业务验证点与平台无关初始状态意图；执行阶段根据 `definitionRef` 确定性投影 CaseSpec、平台策略和 InitialStatePreflight，主 Agent 不读取原文或定义正文。`appProvisioning` 只冻结 App 来源；`bootstrapPolicy` 决定批次启动是否执行与用例无关的物理重装。

主 Agent 循环处理 `batch reconcile`：

- `BOOTSTRAP`：建立暖会话；只有执行配置明确选择 `REINSTALL_FROZEN` 且冻结制品可用时才安装。
- `NEED_CASE_AGENT`：调用 `batch start`。Lifecycle 先自动建立冻结的初始状态；`agentRequired=true` 时只把返回的 `handoff.loaderCommand` 交给不继承主 Agent 上下文的新 Case Agent，主 Agent 不读取 Handoff 正文；`false` 时直接继续 reconcile。未领取的同一 Handoff 会幂等返回相同 Loader。
- `WAIT_EXECUTION_RESULT`：Handoff 已领取但 execution 尚未完成；只等待持久化结果，不推断宿主 Case Agent 仍在运行，也不进入它的观察、动作或恢复循环。
- `PUBLISH_REPORTS` 且 `retryable=true`：自动发布失败，稍后重试 reconcile，不重跑用例。
- `BATCH_COMPLETE` / `BATCH_CANCELLED` / `BATCH_BLOCKED`：execution、平台资源和报告均已收口。

`COMMIT_CASE`、`SETTLE_EXECUTIONS`、`RELEASE_PLATFORM` 和 `PUBLISH_REPORTS` 仍是 Batch 内部可审计 checkpoint，但 `scripts/batch.js reconcile` 会在一次调用中自动推进，主 Agent 不逐段编排。返回的 `progress` 保留本次已完成迁移。

Runtime reconcile 只把 `EXECUTION_LOCKED` 视为可重试，并把次数写入 batch state；第三次仍失败时升级为 `FATAL_EXECUTION`。事件存储损坏等错误为 `FATAL_BATCH`。两者都进入 `BLOCKING`，不会无限返回 `WAIT_EXECUTION_RESULT`。

同一批次固定平台、设备、App、入口、App Provisioning、Bootstrap Policy 和有序目标。用例间复用当前 App 暖状态，但 Case Agent、Frozen CaseSpec、execution 上下文和证据相互独立。

## 单用例

Case Agent 在独立上下文中执行 Handoff Loader，再从返回的冻结 Case Prompt 和 Case Brief 读取原文、Frozen CaseSpec、初始状态结果和当前 Scene，自主规划业务路径；它不能修改验证点，也不能请求准备 App。Lifecycle 在委托前按 `initialStateRequirement` 执行内部 prepare；失败时自动生成覆盖全部 expectation 的 BLOCKED CaseResult，因此无需创建 Case Agent。

Runtime 对动作、准备、恢复和 finish 做事务保护。已发送但结果未知的副作用不自动重放；恢复改变 Agent 可见事实时返回 `RECOVERY_APPLIED` 并停止旧请求。Agent 句柄丢失时，Batch 先 reconcile，再显式生成同一 execution 的 continuation Handoff；Handoff 的持久化 claim/lease 保证只有最新 dispatch 可写，正常等待不会产生 continuation。

CaseResult 必须逐一覆盖 Frozen CaseSpec。Runtime 完成证据完整性校验后，主 Agent 才能 commit；Case Agent 的聊天摘要不是批次事实来源。

## 技术兜底

正常流程始终通过 Coordinator Facade 或 Case Runtime Facade。技术异常先使用响应提供的确定性恢复；没有有效恢复、恢复无进展或现场与诊断矛盾时，`technicalFallback` 才开放受控诊断。`scope=BATCH` 由主 Agent 调查共享设备和平台 Runtime，`scope=EXECUTION` 由 Case Agent 调查当前执行和 session；任何一方都不能直接修改 Batch、Execution、Result、Scene 或报告。

兜底处理只修复基础设施，不替代状态迁移。完成后按 `resume` 返回原 Facade：`RETRY_CURRENT_COMMAND` 重试当前 Coordinator 命令，`PREPARE_NEW_RUN` 为已终态阻塞创建新运行，`USE_CURRENT_RUNTIME` 继续当前 Case Runtime。框架重新探测并形成权威记录后，流程才算恢复。
