# 执行流程

## 批次流程

```text
workspace -> import non-empty sources -> probe and confirm binding
-> ENV_CONFIRMED -> stop and wait for an explicit execution instruction
-> create SINGLE/BATCH execution request with ordered targets
-> freeze target snapshots + role protocols + implementation
-> batch init -> acquire platform runtime -> bootstrap App once
-> reconcile -> start case -> isolated Agent session
-> conclude -> commit -> next case on warm App state
-> release framework-managed platform runtime -> render reports
```

环境确认和执行授权是两个独立人工动作。`environment.js confirm` 只写 `environment-confirmation.json`，不得创建 `runs/<batch>/batch.json`、bootstrap App 或推断用户想执行哪些用例。用户随后明确给出单用例或有序批量范围后，协调器才创建不可变的 `execution-request.json` 并进入执行。

## 无人值守规则

执行请求固定 `interactionPolicy=UNATTENDED`。从创建请求到批次结束，协调器和 case Agent 都不得主动向用户提问、请求确认或进入等待用户状态：

- 用例表达不足或断言无法可靠判断：当前 case 输出 `INCONCLUSIVE`，提交后继续下一 case。
- 缺少账号、验证码、权限或其他外部条件：当前 case 输出 `BLOCKED`，提交后继续下一 case。
- App crash 或进程退出：按受控恢复策略自动处理；不能重放结果不确定的原动作。
- 共享设备、绑定或暖会话不可恢复：自动停止整个批次，保留现场并输出停止原因，不询问用户如何处理。
- 用户可从宿主侧主动终止任务；这不构成 Agent 请求交互，后续按磁盘状态 reconcile。

协调器按 `scripts/batch.js reconcile` 的客观动作推进：

- `BOOTSTRAP`：调用 `bootstrap`。
- `START_CASE`：调用 `start`，使用返回的 request 创建独立 case Agent session。
- `RESUME_CASE_START`：以 `case-start.draft.json` 幂等补齐同一 execution、Runtime、Agent request、batch 状态和稳定事件。
- `RESUME_EXECUTION`：从 execution 磁盘产物恢复一个独立 session；不注入上一 session 的对话。
- `RESUME_PHASE`：按 `phase.draft.json` 中冻结的 from/to/reason 补齐阶段事件，不能重新决定阶段迁移。
- `CONCLUDE_TIME_LIMIT`：冻结新的设备调用，确定性取消或关闭 Agent 草稿，再记录时限与可能存在的操作后观察缺口并进入 CONCLUDE。
- `RECOVER_APP`：消费 Case Agent 已冻结的控制请求，将返回的 `recoveryRequest` 原样交给 `batch.js recover`，成功后重新创建隔离 Agent继续同一 execution。
- `RESUME_RECOVERY`：以冻结 request 重入 `recover`，不能重放未确认结果的普通动作。
- `RESUME_FINALIZE`：以冻结 finalization draft 幂等完成收尾。
- `CREATE_AGENT_RESULT`：execution 已 finalized 但 AgentResult 缺失时，由 framework 从冻结产物补齐交接结果。
- `COMMIT_CASE`：调用 `commit`；先校验 AgentResult，再释放 Runtime，completion 和 batch state 写入成功后，由协调器增量刷新当前用例详情与首页，再进入下一 case。刷新耗时不计入 execution metrics，刷新失败只在 commit 响应中返回报告异常，不回滚结果或阻塞后续用例。
- `DEGRADED`、`BATCH_BLOCKED`、`BLOCKED`、`CORRUPTED`：自动停止批次，保留现场和产物，释放框架托管的平台运行资源并报告原因，不询问用户。
- `BATCH_COMPLETE`：释放框架托管的平台运行资源，结束批次并执行一次全量报告重建，校验最终一致性。

同一批次固定平台、设备、App 和入口。绑定变化必须结束当前批次并新建 batch。普通 case 间不重启 App；当前页面只是下一 case 的现场输入，不能继承上一 case 的业务结论。

Bootstrap、Case 启动、Recovery 和 Case 发布都优先收口已有草稿。Bootstrap 的适配器结果只获取一次，成功或失败都按稳定事件 ID 补齐审计事件。execution 已 finalized 后，Runtime release、completion 和 batch commit 只依赖本地冻结产物，不再因设备离线阻止发布；只有启动新 case 或恢复未完成 execution 前才探测设备暖会话。

平台运行资源属于批次协调器，不属于 Case Agent。iOS adapter 将 Appium、WDA 和本地端口转发作为一个复合资源返回，但各自保存独立状态和所有权。Appium 按服务地址登记；WDA 按设备 ID 与 bundle id 登记，并冻结批次开始前的匹配进程基线。终态先处理 WDA、再处理 Appium，最后核对 WDA 进程和 8100/9100 端口；只有命令、设备、bundle、PID、独立进程组和所有权记录全部匹配的框架进程才能终止。外部资源保留并形成 `RETAINED`，任一框架资源残留形成 `RELEASE_FAILED`。清理在结果提交之后执行，失败不改写用例结果，后续 `reconcile` 或终态 `teardown` 使用冻结资源记录重试。

暖会话探测失败通过统一停批入口持久化 failureCode、reason、stoppedAt、当前 case/execution、暖会话代次和探测摘要，并写入稳定 `batchStopped` 事件。后续 reconcile 只返回已落盘的 `BATCH_BLOCKED`，不依赖首次探测响应恢复原因。

## 单用例流程

1. `understand`：读取原文，提交 sourceRefs、requirements、uncertainties 和检查点；框架生成 understanding/plan revision 与 `planSha`。
2. `inspect PREPARE`：取得当前截图、控件树精简元素和诊断资料，但不自动确认起点。
3. `step PREPARE`：按需执行建立起点所需的状态调整；每个 step 自动采集动作后现场，不存在业务副作用门禁。
4. `mark-start`：显式确认最新 PREPARE observation 满足当前 understanding，然后进入业务执行；理解修订或 recovery 后重新确认。
5. `step BUSINESS`：围绕检查点选择一个语义动作，消费自动返回的新现场，再继续、修订 understanding/plan 或形成判断。
6. `investigate`：疑似异常时复核原文与现场，查询知识并由 Agent 评估候选适用性。
7. `conclude`：为全部 requirement 提交语义 finding；框架自动绑定 revision/planSha/当前现场，生成必要 verdictReview、result、metrics 和 AgentResult。

阶段用于时间线和耗时统计，不作为业务授权。Agent 可在建立起点、执行、调查和结论复核间往返；旧计划中的一步错误不会自动导致用例失败，Agent 应根据新证据修订计划，并保持原文 requirement 可追溯。

## 受控恢复

允许恢复的触发包括原文明示冷启动、Agent 基于当前现场决定的受控重启、App crash、系统杀进程、未知退出、App 无响应和自动化会话丢失。Agent 决定的重启必须记录 `decisionReason` 并引用当前 execution、当前暖会话代次的 observation；技术触发必须引用客观 evidence；原文明示触发必须引用 sourceRef。同一 checkpoint 可以在单用例时限内再次恢复，每次使用新的 recoveryId 和恢复前当前证据。

恢复会递增 warm session generation。恢复前后仍属于同一 execution 和 Agent 业务上下文；协调器同步重绑定 Runtime 与当前 Agent request，并归档恢复前 request。恢复前 observation 只保留审计价值，不能再建立起点、授权动作或支撑当前结论；必须先重新观察。

App crash、系统退出等事故恢复必须记录 `runtimeIncident`，包含 `PRODUCT | TECHNICAL` 分类、原因和当前 execution 证据；Agent 主动决定的重启不是事故，只记录决策理由和 `recoveryStarted/recoveryCompleted`。状态已提交但时间线事件缺失时，使用同一 recoveryId 重入会定位该 recovery 绑定的原 execution 并补写事件，不重复重启 App。原 execution 已封存时只允许校验和返回已有结果；恢复事务不完整则停批，禁止写入后续 case。

## 中断恢复

用例导入、执行请求、Batch 初始化、Bootstrap、Case 启动、Agent Turn、设备 Operation、知识查询、Phase 迁移、Recovery、Finalize 和 Case 发布都以磁盘草稿作为提交日志。草稿先冻结绑定和稳定 ID，权威状态原子写入后再补审计事件并删除草稿。`reconcile` 或 Agent status 只根据草稿与权威状态暴露恢复项；恢复不得分配新的 execution/session，不得重新读取实时用例或实时知识，也不得重放结果不确定的设备动作。

`reconcile` 自动恢复 step、operation、turn、知识查询和 phase 草稿，不要求 Case Agent 读取或重新组装内部请求。动作已完成时不重放；知识查询继续使用首次冻结候选。任一内部恢复项存在期间禁止 Agent 写入，恢复完成后再创建或继续 Case Agent。

每个 case commit 后，协调器只重渲染该 case 的平台详情和用例详情，再读取全部 case 摘要重建首页；不会重写其他 case 详情。详情与首页都先生成 `report-publication.draft.json`，逐文件原子替换内容，最后发布带文件 SHA 的 `report-metadata.json` 并清理草稿。批次进入 `BATCH_COMPLETE` 后再调用一次工作区级 `render-index` 全量重建；任一文件不一致时可从 execution 重新渲染。
