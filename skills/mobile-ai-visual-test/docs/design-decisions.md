# mobile-ai-visual-test 关键设计决策

本文只记录长期选择及原因。当前行为与模块边界以 [`architecture.md`](architecture.md) 为准。

## D1：Case Agent 是唯一业务理解者

- 决策：Execution 只冻结原始用例和技术策略；Case Agent 在现场生成并修订 Case Model，主 Agent 不读取原文或参与业务判断。
- 原因：独立 Compiler 会重复理解用例，增加批量耗时，并用冻结规则限制 Case Agent 的现场判断。
- 影响：revision 2 起只要求修改理由；验证点可新增、改写、合并和取消，历史版本完整保留。

## D2：Handoff 只负责身份与交付

- 决策：Handoff 绑定 execution、dispatch 和写入所有权，并直接交付原文、Scene、Case Model 与 Runtime Client。
- 原因：主 Agent 转读或转述 Case Agent 上下文会增加耗时并破坏角色隔离。
- 影响：主 Agent 持有真实 Agent 句柄；框架只记录 Handoff 与 execution 事实，不虚构 Agent 运行状态。

## D3：薄 Agent-facing，厚确定性框架

- 决策：主 Agent 面对四个、Case Agent 面对七个自描述能力，Translator 负责注入内部字段并交给严格契约。
- 原因：直接暴露 ID、状态机和完整 Schema 会分散业务注意力并造成参数猜测。
- 影响：示例随当前响应交付；同类格式错误只定向修正一次。

## D4：截图、控件树和知识是并列能力

- 决策：Scene 同时提供视觉与结构事实；异常、冲突和纯视觉现场必须检查图片，知识查询用于解释 Scene 外规则。
- 原因：权限弹窗、Toast、遮罩、动画和产品差异可能不在控件树中。
- 影响：最终 PASS/FAIL Scene 需要视觉登记；知识候选只提供支持，不直接决定 verdict。

## D5：动作反馈只返回事实

- 决策：坐标动作返回请求值、实际投递值、可选设备触点、坐标换算、标注图和整屏像素比较，不判断业务效果。
- 原因：Adapter 能证明投递事实，不能证明 Agent 是否选择了正确目标。
- 影响：操作异常时 Case Agent 用 `inspect(channel=action)` 检查标注图并自行纠错；未识别横向容器时不生成误导性的整屏横滑。

## D6：正常能力优先，但不排他

- 决策：Facade 与 Runtime 是大多数场景的首选路径；异常时 Agent 可在职责与授权范围内使用日志、Shell 和平台工具，随后回到框架核验。
- 原因：框架不可能提前封装所有设备、Appium、WDA、session 和状态矛盾。
- 影响：`technicalContext` 按需给出事实与 resume；框架外动作不是证据，不能直接修改权威产物或未知归属资源。

## D7：事实与历史不可覆盖

- 决策：原文、动作、Scene、截图、知识、Case Model revisions、结果和完成绑定采用不可变或追加式记录。
- 原因：报告必须还原每一步当时看到什么、依据哪个验证点、为何调整。
- 影响：每个事件绑定当时 Case Model revision，被取消的验证点引用不复用。

## D8：只写当前格式，历史按 execution 隔离

- 决策：新 Runtime 不维护旧协议继续执行或迁移分支；历史 execution 不修改、不删除。
- 原因：长期兼容会把版本分支扩散到 Runtime、证据、完成态和看板。
- 影响：旧静态报告继续保留；无法解释的旧记录只影响自身，较新的可发布结果优先展示。

## D9：业务终态与报告发布分离

- 决策：Execution 收口和平台释放决定 Batch 终态，报告随后只读生成。
- 原因：展示失败不等于测试仍在执行，也不应阻塞取消或完成。
- 影响：报告失败使用独立发布状态；总览只显示总耗时和起止时间，细分耗时放在详情。

## D10：iOS Session 是可替换的 Batch 资源

- 决策：Execution 保存 `sessionRef`，Device Port 从 Batch runtime 取得当前 Appium Session，并在统一锁与归属约束下重建或释放。
- 原因：Agent 调度可能超过 Session 生命周期，冻结 Session 会把失效误报成截图损坏。
- 影响：observe 可对明确失效恢复一次；action 发送后的错误不重放，终态且归属明确的托管资源才自动回收。

## D11：破坏性准备受 execution 授权约束

- 决策：执行确认统一授权当前目标 App 的平台等价状态准备；Case Agent 只通过 `recover.targetState` 表达目标。iOS 包由 Runtime 从 `app-packages/ios` 按需解析、唯一匹配并冻结，目录中存在包不触发自动安装。
- 原因：三端 Agent 接口应一致，安装包发现、身份校验和平台命令属于框架职责；授权范围仍必须限制在已确认目标 App。
- 影响：Main Agent 不询问或传递安装包；iOS 缺包或冲突在卸载前返回明确技术事实；未知结果的破坏性动作不重放。
