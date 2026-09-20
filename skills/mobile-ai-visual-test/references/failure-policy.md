# 失败与结果策略

业务 verdict 由 Case Agent 根据原始用例、当前 Case Flow 和现场形成：

- `PASS`：证据满足当前验证点。
- `FAIL`：证据明确不满足当前验证点。
- `INCONCLUSIVE`：原文、覆盖范围或证据不足以可靠判断。
- `BLOCKED`：客观技术或业务前置条件阻止继续执行。

设备离线、Adapter 不可用、Session 失效、截图产物异常和 Runtime 文件错误属于技术事实，不直接成为产品 FAIL。Runtime 返回 `TECHNICAL`、稳定错误码、最后 Scene、技术事实引用、动态 facts 和 `documentationRef`；只有仍属于当前 execution、generation 和验证点的有效技术事实才能被最终 check 引用。

收到错误时按 `documentationRef` 查阅恢复条件，并根据当前动态 facts 构造签名中允许的请求。恢复无效、状态长期无进展、框架不能表达所需操作，或诊断与现场矛盾时，Agent 可在职责与授权范围内读取日志并使用平台工具调查。不得直接修改权威产物；框架外处置用 `recover.externalAction` 登记后必须重新 `observe`。

每次普通动作自动采集新 Scene，并返回请求坐标、投递坐标、可选设备触点、落点标注图以及前后 Scene/截图引用。Runtime 不通过截图 hash 判断画面是否变化，也不判断动作是否命中业务目标；截图 hash 只用于产物完整性。动作无效果、证据冲突或落点可疑时，由 Agent 打开前后截图和标注图后判断；现场可能变化时重新 `observe`，再决定纠正动作或结论。动作已发出但结果未知时记录 `actionOutcomeUnknown`，先观察现场，不自动重放；旧 Scene 动作返回 `SCENE_CHANGED`。

生命周期短于一次 Agent 决策周期的 UI 可使用 `runPlan`。Runtime 只执行有限、声明式的动作/等待/采集/确定性定位/技术检查并保存证据；视觉变化、控件语义和业务 PASS/FAIL 仍由 Agent 判断。

截图与控件树是并列证据。控件树为空、缺失或冲突时不得推断页面空白；系统权限弹窗、Toast、遮罩、浮层、键盘、长按过程、动画和纯视觉结果必须通过 `view_image` 检查并登记。最终 PASS/FAIL 引用的 Scene 必须有视觉检查记录。

需要 App 初始状态时，Case Agent 只能请求 execution 已授权的准备策略；未授权时 Runtime 在调用清理命令前返回 `APP_INITIAL_STATE_UNAVAILABLE`。iOS 的卸载与安装通过原生工具确认三态安装态，不用 WDA 运行态代替安装事实；失败后根据错误文档与当前准备状态重试或登记已完成的外部处置，不能用 `observe` 绕过门禁。未知结果的清数据或重装不重放。

单用例预算为 30 分钟。预算结束后 Runtime 停止新的设备动作，但允许 Case Agent 检查已有 Scene、查询知识并 finish。无人值守批次不等待账号、验证码或业务解释；单用例可收口时继续下一条，只有共享平台与批次级故障停止批次。

登录账号、验证码和其他业务凭据由测试环境在执行前预置，框架不猜测、生成或轮试账号，也不把凭据写入 execution、事件或报告。缺少可用账号且没有有效 Runtime 技术事实时，按证据或业务前置条件不足形成 `INCONCLUSIVE`；存在直接阻止当前验证点的有效技术事实时才形成 `BLOCKED` 并引用该事实。

Runtime reconcile 的锁竞争最多重试三次；其他 execution 或批次存储错误进入统一阻塞收口。报告发布失败不改变已完成的业务终态。
