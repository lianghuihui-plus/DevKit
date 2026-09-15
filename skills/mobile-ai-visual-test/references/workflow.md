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

Coordinator 从用例编号解析当前 `case.json` 和 `source.md`，为新 execution 冻结 `case.snapshot.json`、`source.snapshot.md`、环境、App、初始状态策略和协议摘要。它不理解原始用例，也不生成验证点或执行计划。

主 Agent 通过 Facade 推进：

- `NEED_CASE_AGENT`：将不透明 Handoff Loader 交给一个不继承主 Agent 上下文的新 Case Agent。
- `WAIT_EXECUTION_RESULT`：只等待持久化结果，不推断 Case Agent 是否仍在运行。
- `COMPLETE` / `BLOCKED`：报告终态；报告发布状态与 Batch 业务终态分离。

Handoff 绑定唯一 execution、dispatch sequence 和写入所有权，并直接向 Case Agent 提供原始用例、当前 Scene、已有 Case Model 与预绑定 Runtime Client。主 Agent 不读取或转述这些内容。Agent 句柄丢失时，Batch 先 reconcile，再生成 continuation Handoff；新 dispatch 替换旧 dispatch。

## 单用例

Case Agent 读取原始用例和当前 Scene，使用 `plan` 形成 Case Model：用例理解、前置条件、验证点、计划和不确定项。revision 1 不需要理由；后续可改写、新增、合并或取消，并提交完整新版本与非空理由。所有动作、检查、知识查询和结果自动绑定当时 revision。

截图与控件树是并列能力。视觉现场先用 `view_image` 查看，再用 `inspect(channel=visual)` 登记；操作异常时可查看上一动作落点标注图，并用 `inspect(channel=action)` 登记客观坐标事实。框架不判断是否命中业务目标。

Case Agent 可以用 `recover.targetState` 请求 execution 已授权的目标 App 状态，或用 `recover.externalAction` 登记框架外技术处置。Android、HarmonyOS 在底层清数据；iOS 按需从 `app-packages/ios` 唯一匹配、校验并冻结安装包后重装。Agent 不处理平台安装参数；一般框架外声明后重新 `observe`，初始态准备失败则按 Runtime 返回的 `nextCall` 重试准备并由新 Scene 验证。

`finish` 必须逐一覆盖当前 Case Model 中有效的验证点，并引用真实 Scene、知识或技术事实。Runtime 完成证据完整性校验后，主 Agent 才能 commit；聊天摘要不是批次事实来源。

## 技术异常

Facade 和 Runtime 是正常首选路径，不是排他能力边界。异常响应的 `technicalContext` 提供范围、错误码、日志入口、资源事实和返回框架的 `resume` 示例。

主 Agent 处理批次级设备、资源锁、Appium/WDA 和 Coordinator 异常；Case Agent 处理当前 execution 的 App、session、Scene 与动作异常。两者都可以在职责和授权范围内使用 Shell 或平台原生工具，但不能直接修改 Batch、Execution、Result、Scene、事件或报告，也不能处置活动批次或归属不明资源。

问题缓解后必须回到 `advanceRun`、`observe` 或 `recover`，由框架重新核对现场并持久化。
