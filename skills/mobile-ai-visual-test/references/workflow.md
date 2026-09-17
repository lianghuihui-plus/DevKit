# 执行流程

## 批次状态机

```text
workspace -> import -> optional workspace App package -> probe -> environment confirmation
-> execution authorization -> request -> init -> bootstrap -> NEED_CASE_AGENT
-> delegate once -> WAIT_EXECUTION_RESULT -> reconcile/commit -> next case
-> FINALIZING -> release platform -> publish report -> BATCH_COMPLETE

cancel -> CANCELLING -> finalization -> BATCH_CANCELLED
fatal -> BLOCKING -> finalization -> BATCH_BLOCKED
```

看板分开展示“未执行”与“无法执行”：用例没有任何 execution 记录时投影为 `PENDING`（未执行）；已创建 execution，但因前置条件、环境或其他问题未进入实际执行时投影为 `NOT_RUN`（无法执行）。是否已进入实际执行，以是否产生第一条 `actionRequested` 或 `sceneObserved` 事件为检查点；检查点后发生技术中断投影为 `BLOCKED`，用户取消保留为 `CANCELLED`，不再合并到 `NOT_RUN`。

Coordinator 从用例编号解析当前 `case.json` 和 `source.md`，为新 execution 冻结 `case.snapshot.json`、`source.snapshot.md`、环境、App、初始状态策略和协议摘要。它不理解原始用例，也不生成验证点或执行计划。

主 Agent 通过 Facade 推进：

- `NEED_CASE_AGENT`：将不透明 Handoff Loader 交给一个不继承主 Agent 上下文的新 Case Agent。
- `WAIT_EXECUTION_RESULT`：只等待持久化结果，不推断 Case Agent 是否仍在运行。
- `COMPLETE` / `BLOCKED`：报告终态；报告发布状态与 Batch 业务终态分离。

Handoff 绑定唯一 execution、dispatch sequence 和写入所有权，并直接向 Case Agent 提供原始用例、当前 Scene、已有 Case Flow 与预绑定 Runtime Client。主 Agent 不读取或转述这些内容。Agent 句柄丢失时，Batch 先 reconcile，再生成 continuation Handoff；新 dispatch 替换旧 dispatch。

## 单用例

Case Agent 读取原始用例和当前 Scene，使用 `plan` 形成 Case Flow，以 `ACTION / DECISION / CHECK / END` 保存操作、条件分支、检查点和结束路径。revision 1 不需要理由；后续可改写、新增、合并或取消，并提交完整新版本与非空理由。执行调用可通过 `flowContext` 关联当时节点和 Agent 选择的分支。

截图与控件树是并列能力。视觉现场先用 `view_image` 查看，再用 `inspect(channel=visual)` 登记；操作异常时可查看上一动作落点标注图，并用 `inspect(channel=action)` 登记客观坐标事实。框架不判断是否命中业务目标。

Case Agent 可以用 `recover.targetState` 请求 execution 已授权的目标 App 状态，或用 `recover.externalAction` 登记框架外技术处置。Android、HarmonyOS 在底层清数据；iOS 按需从 `app-packages/ios` 唯一匹配、校验并冻结安装包后重装。Agent 不处理平台安装参数；一般框架外声明后重新 `observe`，初始态准备失败则根据错误文档和当前准备事实重试，并由新 Scene 验证。

CHECK 判断在执行过程中通过独立 `recordResult` 增量保存，并引用真实 Scene、知识或技术事实。`observe` 只采集 Scene，`act` 只投递一个动作并采集动作后 Scene，正常 `finish` 由 ledger 组装完整 checks；用例级前置条件不满足时由 Case Agent 显式提交 `NOT_RUN`。聊天摘要不是批次事实来源。

## 技术异常

Facade 和 Runtime 是正常首选路径，不是排他能力边界。异常响应提供范围、错误码、诊断、动态资源事实和 `documentationRef`；使用与恢复说明只存在于对应文档，不随每次响应重复发送。

主 Agent 处理批次级设备、资源锁、Appium/WDA 和 Coordinator 异常；Case Agent 处理当前 execution 的 App、session、Scene 与动作异常。两者都可以在职责和授权范围内使用 Shell 或平台原生工具，但不能直接修改 Batch、Execution、Result、Scene、事件或报告，也不能处置活动批次或归属不明资源。

问题缓解后必须回到 `advanceRun`、`observe` 或 `recover`，由框架重新核对现场并持久化。
