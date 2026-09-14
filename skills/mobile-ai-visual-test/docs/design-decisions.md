# mobile-ai-visual-test 关键设计决策

本文只记录长期有效的关键选择及原因，不描述实现细节、实施步骤或测试清单。当前系统行为以 [`architecture.md`](architecture.md) 为唯一事实来源。

## D1：用例定义与执行分离

- 状态：Accepted，已实现
- 决策：用例生成阶段发布不可变 `CaseDefinition`；执行阶段只引用定义，并确定性生成本次执行快照。
- 原因：避免主 Agent 在每次批量执行前重新理解全部原始用例，同时保证同一用例多次执行使用一致的验证语义。
- 影响：主 Agent 只处理定义状态和引用；原始用例仅由 Compiler 和对应 Case Agent 读取。

## D2：主 Agent、Case Agent 与 Runtime 职责隔离

- 状态：Accepted，已实现
- 决策：主 Agent 只负责编排，Case Agent 负责单用例业务判断，Runtime 负责确定性约束和设备访问；主 Agent 通过不透明 Handoff 引用委托 Case Agent。
- 原因：通过模型上下文转发完整 Prompt、原始用例和 Scene，会使主 Agent 实际参与理解并增加延迟与上下文消耗。
- 影响：Case Agent 自行加载并校验 Handoff；dispatch 使用 claim/lease 保证同一 execution 只有一个有效写入者。框架只报告 `PREPARED`、`CONSUMED` 和 execution 结果事实，不根据 `execution=RUNNING` 推断宿主 Agent 正在运行。

## D3：截图与控件树是并列证据

- 状态：Accepted，已实现
- 决策：Scene 同时提供视觉和结构证据；最终结论引用的 Scene 必须完成视觉检查登记，异常或纯视觉现场不能只依赖控件树。
- 原因：系统弹窗、Toast、遮罩、动画和长按过程等信息可能不在目标 App 的控件树中。
- 影响：Agent-facing `inspect(channel=visual)` 形成可审计记录，但它只证明 Agent 已登记检查，不能证明宿主工具调用本身。

## D4：知识查询是异常调查的常规能力

- 状态：Accepted，已实现
- 决策：顺利且证据充分时可以不查询；现场与预期不符、无法解释或继续、以及准备形成缺少技术依据的负向结论时必须查询并评估知识。
- 原因：截图和控件树描述当前现场，知识用于补充现场之外的规则、已知解释和适用边界。
- 影响：知识候选不直接决定 verdict；零候选或候选不适用也属于完成调查。

## D5：执行证据不可变，只解释当前格式

- 状态：Accepted，已实现
- 决策：原文、定义、CaseSpec、ValidationProfile、事件、结果和完成绑定形成不可变证据链；框架只读取当前 Execution 格式，不提供旧格式 Reader、迁移或降级。
- 原因：多版本兼容会把历史分支扩散到 Runtime、证据、完成态和看板，持续增加框架复杂度与数据歧义。
- 影响：旧格式返回 `FORMAT_UNSUPPORTED` 且只影响单个用例；重新执行会生成当前格式，原目录不自动修改或删除。

## D6：初始状态意图与平台实现分离

- 状态：Accepted，已实现
- 决策：用例声明业务所需初始状态，执行请求再按平台派生准备策略；Android、HarmonyOS 的 `FRESH_INSTALL` 等效为清除数据，iOS 使用冻结制品重装。
- 原因：业务意图应跨平台稳定，但不同平台达到相同初始状态所需的副作用和资产条件不同。
- 影响：Lifecycle 在委托 Case Agent 前完成准备；准备失败由框架形成技术性 BLOCKED，不交给 Agent 猜测处理。

## D7：业务终态与报告发布分离

- 状态：Accepted，已实现
- 决策：Execution 收口和平台释放决定 Batch 业务终态，报告随后通过唯一当前 Reader 只读生成；报告状态不反向控制业务状态。
- 原因：展示失败不等于测试仍在执行，也不应使取消或完成长期停留在等待态。
- 影响：发布失败只产生 `RETRY_REQUIRED` 或 `DEGRADED`；重建不回写 execution，总览和详情继续使用各自稳定的时间与步骤投影。

## D8：薄 Agent、厚框架的两层接口

- 状态：Accepted，已实现
- 决策：主 Agent 只面对四个、Case Agent 只面对七个自描述业务能力；确定性 Facade 把简化输入转换为完整 internal 契约，Prompt 只描述职责和使用时机。
- 原因：直接暴露框架 ID、状态机和完整 Schema 会分散 Agent 的业务注意力，也会造成参数猜测和重复失败。
- 影响：当前有效示例随能力自动交付；`plan` 只接收计划项和可选调整原因，框架补齐内部计划事件及其他上下文并严格校验，同一格式错误只允许一次定向修正。

## D9：版本属于数据契约而不是代码模块

- 状态：Accepted，已实现
- 决策：只有独立持久化根或真实跨进程协议保留一个当前 `schemaVersion`；Broker、Brief、Facade、Coordinator 临时状态和 Completion 子协议不单独编号。
- 原因：随同一代码发布的内部对象不存在独立演进边界，单独版本只会制造组合矩阵和兼容分支。
- 影响：内部结构通过类型、必填字段、hash 和 `protocolSha` 校验；引入新版本号必须先证明存在独立发布与读取边界。

## D10：iOS Session 是可替换的 Batch 资源

- 状态：Accepted，已实现
- 决策：Execution 只保存 `sessionRef`；Device Port 每次从 Batch runtime 取得当前 Appium Session，并在统一锁和 generation 约束下重建或释放。
- 原因：Agent 调度延迟可能超过 Appium Session 生命周期，冻结 Session 副本会把正常超时误报为截图损坏，并诱发错误重试。
- 影响：observe 只对明确失效恢复一次；action 发送后的失败不重放，保留结果未知和原始 Session 错误。

## D11：正常流程封装，异常流程受控开放

- 状态：Accepted，已实现
- 决策：正常执行只使用简化 Facade；无有效恢复、恢复无进展或诊断与现场矛盾时，`technicalFallback` 按 Batch/Execution 范围开放日志和平台诊断，恢复后必须回到 Facade 落盘。
- 原因：角色隔离不能以丢失根因和恢复手段为代价，框架也无法预先封装所有设备和工具异常。
- 影响：Agent 可以修复框架尚未覆盖的基础设施问题，但不能直接修改权威状态、结果或不明归属资源；业务执行和状态迁移仍由 Facade/Runtime 完成。

## D12：托管运行时按归属安全回收

- 状态：Accepted，已实现
- 决策：运行时发现框架注册表中的旧 Appium/WDA 进程时，仅在进程身份、进程组和批次归属均可验证且占用批次已进入终态时自动清理并重试；活动批次返回 `SERVICE_IN_USE`，归属不明返回 `OWNERSHIP_UNKNOWN`。
- 原因：终态批次的残留资源是确定可恢复的框架故障，不应阻塞后续用例；活动或未知归属的进程可能被其他任务使用，不能由框架擅自终止。
- 影响：恢复动作留在 Adapter/Runtime 层，Facade 向 Agent 暴露稳定错误码、诊断和等待/取消建议；不符合清理条件的资源保持现场并进入 `BLOCKED`。

## D13：iOS 真机失败不得阻塞批次

- 状态：Accepted，已实现
- 决策：Bootstrap 使用独立且有上限的 iOS 时间预算；超时后立即进入统一收口流程。平台清理失败不再让业务批次无限停留在 `BLOCKING`，而是记录 `platformCleanupDeferred` 并提交 `BLOCKED`，后续依据归属和清理期限回收资源。
- 原因：WDA 启动、App 冷启动和进程停止耗时均受真实设备状态影响，单一 60 秒外层 timeout 会把正常慢路径误判为失败，并在异常路径遗留 ACTIVE Runtime。
