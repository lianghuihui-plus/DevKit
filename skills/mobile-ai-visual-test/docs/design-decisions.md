# mobile-ai-visual-test 关键设计决策

本文只记录长期选择及原因。当前行为与模块边界以 [`architecture.md`](architecture.md) 为准。

## D1：Case Agent 是唯一业务理解者

- 决策：Execution 只冻结原始用例和技术策略；Case Agent 在现场生成并修订统一 Case Flow，执行协调 Agent 不读取原文或参与业务判断。这不限制 execution 之前的 Authoring Agent 阅读来源并生成逻辑用例。
- 原因：独立 Compiler 会重复理解用例，增加批量耗时，并用冻结规则限制 Case Agent 的现场判断。
- 影响：revision 2 起只要求修改理由；节点和分支可自主调整，历史版本完整保留，Runtime 不审批业务语义。

## D2：Handoff 只负责身份与交付

- 决策：Handoff 绑定 execution、dispatch 和写入所有权，并直接交付原文、Scene、Case Flow 与 Runtime Client。
- 原因：执行协调 Agent 转读或转述 Case Agent 上下文会增加耗时并破坏角色隔离。
- 影响：执行协调 Agent 持有真实 Agent 句柄；框架只记录 Handoff 与 execution 事实，不虚构 Agent 运行状态。

## D3：薄 Agent-facing，厚确定性框架

- 决策：执行协调 Agent 面对四个、Case Agent 面对八个自描述能力，Translator 负责注入内部字段并交给严格契约。
- 原因：直接暴露 ID、状态机和完整 Schema 会分散业务注意力并造成参数猜测。
- 影响：独立服务文档提供签名、参数和恢复规则；响应只交付动态事实、错误原因和文档锚点，同类格式错误只定向修正一次。

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
- 影响：错误响应按需给出安全事实与 `documentationRef`；框架外动作不是证据，不能直接修改权威产物或未知归属资源。

## D7：事实与历史不可覆盖

- 决策：原文、动作、Scene、截图、知识、Case Flow revisions、结果和完成绑定采用不可变或追加式记录。
- 原因：报告必须还原每一步当时看到什么、依据哪个验证点、为何调整。
- 影响：每个事件绑定当时 Case Flow revision，被取消的节点和边引用不复用；历史 Case Model 只读展示。

## D8：只写当前格式，历史按 execution 隔离

- 决策：新 Agent-facing 接口只写 Case Flow，不提供旧 Case Model 的创建或修订入口，也不迁移历史 execution；同为 schema 12 的历史 Case Model 只保留报告投影和结果完整性 fallback。
- 原因：长期兼容会把版本分支扩散到 Runtime、证据、完成态和看板。
- 影响：历史目录可以保留，但当前 Reader 直接拒绝非当前 schema，不提供转换或补写路径；schema 12 内的历史 Case Model 不转换为 Case Flow，也不能由新 Case Agent 继续修订。

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
- 影响：执行协调 Agent 不询问或传递安装包；iOS 用平台原生命令验证安装事实，缺包或冲突在卸载前失败；明确失败受控恢复，未知结果不重放。

## D12：用例边界由 Authoring Agent 判断

- 决策：用例生成阶段允许并要求 Agent 完整阅读任意格式、任意数量的输入，自主形成一条或多条逻辑用例；框架只持久化 draft。
- 原因：文件、表格行、Sheet 或章节都不是稳定的业务边界，确定性拆分会把格式规则误当成用例语义。
- 影响：单用例与批量用例使用同一 `import-cases.js` 入口；`sourceLocator` 提供稳定身份和来源追踪，执行协调阶段的原文隔离保持不变。
