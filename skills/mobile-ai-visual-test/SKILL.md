---
name: mobile-ai-visual-test
description: 当需要从任意可读取格式的人工用例生成测试工作区，或对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持 HarmonyOS、Android、iOS 的用例生成、环境确认、单用例或批量执行、独立 Case Agent、证据记录与报告生成。
---

# 移动端 AI 视觉测试

## 工作模式

用户要求生成、导入或维护用例时，你是 Authoring Agent。必须完整读取用户提供的输入，使用适合其格式的可用能力理解内容，自主判断逻辑用例边界，并按 `references/case-authoring.md` 生成一条或多条用例。执行阶段的隔离规则不适用于 Authoring。

用户要求执行已生成用例时，你是执行协调 Agent。你负责选择用例、取得用户确认、委托独立 Case Agent、处理批次级技术异常，并根据持久化状态汇报结果。每个 Case Agent 独立理解和执行一个用例；执行协调 Agent 不读取已生成的原始用例，不参与业务计划、设备操作或结果判断。

Coordinator Facade 负责 Workspace、环境、ExecutionRequest、Batch、Handoff 和报告发布。Facade 是正常流程的首选入口，不是技术异常下的排他能力边界。

启动时读取 `references/coordinator.md` 的方法短索引。只有紧凑签名不足以构造当前调用时才读取对应方法页；收到错误时只读取 `documentationRef` 指向的错误章节，不预读完整错误目录。

普通执行协调 Agent 和 Case Agent 不读取 `references/commands.md`。只有 Authoring、维护或技术排障确实需要直接调用正式 CLI 时，才从该索引进入当前一个功能模块；不要预读其他模块。

## 正常执行入口

先执行：

```bash
node <skill-root>/scripts/workspace.js --cwd <workspace>
```

脚本入口属于技能目录，`--cwd` 指向测试工作区；不要在测试工作区中解析相对的 `scripts/`。响应提供工作区事实和紧凑的 `coordinatorFacade { interfaceKind, protocol, command, documentation }` 绑定。执行协调 Agent 使用 `prepareRun`、`confirmRun`、`advanceRun`、`cancelRun` 和统一资源读取 `read`。

启动时读取一次 `references/coordinator.md`，原样执行已绑定 workspace 的 `coordinatorFacade.command`，通过 stdin 提交请求：

```bash
node <skill-root>/scripts/coordinator-agent.js --workspace <workspace> <<'MAVT_REQUEST'
{"operation":"prepareRun","input":{"caseNos":["014","015"]}}
MAVT_REQUEST
```

首次响应的 `result.command` 已绑定当前 run，后续所有操作原样复用这一个命令，通过 stdin 提交 `{operation,input}`。`confirmRun` 的业务字段取自当前 `data.content` 中的 `runDecision` 和用户选择。主复杂数据完整位于 `data`，关联数据通过 `resources` 的类型化引用按需 `read`；不拼接引用。

## 返回状态

顶层 `status` 为 `SUCCEEDED / REJECTED / FAILED / UNKNOWN`。成功后按 `result.outcome` 处理业务阶段：

- `NEED_USER_CONFIRMATION`：将 `runDecision` 中的选择和绑定事实映射到 `confirmRun`，只向用户确认缺失的业务字段。
- `NEED_CASE_AGENT`：创建不继承执行协调 Agent 上下文的全新 Case Agent，只发送 `caseDispatch` 中固定的 `delegationPrompt` 和原样 `loaderCommand`，随后等待该 Agent；已有活跃 Agent 时不得重复创建。
- `WAITING`：根据 `result.waitFor` 和 `runProgress` 判断等待对象，条件变化后提交 `advanceRun`。等待持久化结果不证明 Case Agent 仍在运行。
- `COMPLETE`：读取 `runSummary` 报告结果和报告位置。
- `BLOCKED`：保留现场和 `runSummary` 中的原因与诊断；技术阻塞不能改报为业务 FAIL。

错误按 `error.documentationRef` 处理，输入错误同时读取 `error.operationDocumentationRef`，诊断正文通过关联资源读取。`UNKNOWN` 禁止盲目重放可能已生效的操作。

用户明确停止时，通过原命令提交 `cancelRun`，`input` 只含 `reason`；只有终态 `runSummary` 确认取消完成才结束等待。

## 调用纪律

- 固定命令不得增删参数；输入错误按 `error.issues` 和定向文档修正一次，同类错误再次出现时停止猜字段。
- 执行协调 Agent 不调用 Batch、环境探测、ExecutionRequest、报告渲染或 Case Runtime 的内部 CLI 完成正常业务流程。
- `advanceRun` 会恢复持久化的 `INITIALIZING_RUN`；初始化中断后不得重新确认或重复启动初始化。
- 宿主命令返回仍在运行的会话句柄时，继续等待同一进程，不得重复执行 `advanceRun`。
- `NEED_CASE_AGENT` 后以 execution 持久化状态为准；聊天摘要不能替代框架结果。
- 执行协调 Agent 持有 Case Agent 的真实运行句柄；框架只记录 Handoff 的准备、领取及 execution 是否完成，不虚构 Agent 运行状态。
- 一个用例只保留一个有效写入者；正常 `WAITING` 不创建新 Case Agent，当前 case 未由 Batch commit 前不得委托后续 case。

## App 初始状态

Case Agent 通过 `recover` 的 `input.mode="prepare"` 和 `input.targetState` 表达需要空本地状态或首次安装状态，平台差异由 Runtime 处理。Android、HarmonyOS 清除目标 App 数据；iOS 仅在 Case Agent 确实请求该状态时，从工作区 `app-packages/ios` 自动查找与 Bundle ID 和设备类型匹配的 `.app` 或 `.ipa`，校验并冻结后卸载、重装目标 App。

iOS 真机用 `devicectl`、模拟器用 `simctl` 核验安装事实，不使用 WDA 运行态代替安装态。初始态准备失败时 Case Agent 根据错误原因和 `documentationRef` 处理；连续失败需先完成技术处置并登记，再重试原目标状态。

执行协调 Agent 不读取用例来预判重装，不询问、登记或向 Case Agent 传递安装包。目录中没有唯一可用安装包时，Runtime 向 Case Agent 返回明确技术事实；放入该约定目录表示允许在已确认的目标 App 上按需重装，不表示每条用例都自动重装。

## 技术异常

Coordinator 响应只提供错误原因、诊断、当前资源事实和 `documentationRef`，不内联恢复请求或使用示例。恢复方法由错误文档说明，当前状态与资源归属以响应事实为准。

当确定性恢复失败、状态长期无进展、Coordinator 无输出、资源锁与批次终态矛盾，或设备发现、Appium、WDA、Xcode 状态与诊断不一致时，可以在当前批次职责和已有授权内读取日志，使用 Shell 或平台原生工具调查并恢复共享设备、进程、端口与自动化服务。

- 只处理当前批次或已确认终态批次拥有的资源，不终止活动批次或归属不明的进程。
- 技术排障未经用户确认，不执行额外卸载、清数据、改变签名等有业务影响的动作；`recover` 的 `prepare` 模式只使用 execution 已授权的目标 App 状态能力。
- 不直接修改 Batch、Execution、Result、Scene、事件或报告文件来伪造恢复。
- 基础设施恢复后，按错误文档选择当前状态允许的方法回到 Facade；可推进状态通过原 command 提交 `advanceRun`，由框架重新探测并落盘。
- 技术排障不代替 Case Agent 的用例理解、设备操作和业务判断。

## 角色与 Handoff

- 执行协调 Agent 不执行 Case Agent Loader，不读取 `source.md`、Handoff 正文、Case Prompt、Scene、截图、控件树或知识调查正文。
- 执行协调 Agent 不向 Case Agent 转述原文、截图路径、控件树、知识内容或自己的业务判断。
- Handoff 只绑定唯一 execution、协议摘要和写入所有权，并直接向 Case Agent 提供原始用例、当前 Scene、已有 Case Flow 及预绑定 Runtime Client。
- Case Agent Brief 自带唯一的业务执行原则；执行协调 Agent 不读取或转述这些规则。Case Agent 独立负责 Baseline/Working Flow、条件适用性和检查点结果，Runtime 只校验结构、枚举、生命周期与引用，不审批业务判断。
- `runPlan` 只批量执行确定性动作、采集和技术检查；其技术 check 不自动完成业务 CHECK，Agent 必须读取证据后调用 `recordResult`。
- 三端输入由 Case Runtime 统一发布目标级 `inputText`，Case Agent 复制 Scene 动作即可完成目标聚焦和整段输入；无目标焦点输入只是 Scene 无法识别输入控件时的兜底。
- 输入组件依赖由 Runtime 自动准备、校验和恢复，执行协调 Agent 与 Case Agent 不安装、启用或切换平台输入组件；文本投递是否完整由 Case Agent 根据 `previousAction` 的技术核验事实判断并决定有限恢复。
- Handoff 与职责隔离不是操作系统安全沙箱。正常流程优先使用框架；技术异常时两个 Agent 都可在各自职责和授权范围内独立调查，随后回到框架核验与持久化。

固定委托文本由 Facade 的 `caseDispatch` 主资源提供，Case Agent 原样执行 `loaderCommand` 后读取响应 `data.content` 中的完整 Brief，遵循其中冻结的 `casePrompt`，只处理绑定的 execution。

全部委托必须不继承执行协调 Agent 上下文。

## Authoring 入口

只有用户明确要求生成、导入或维护用例时，才读取 `references/case-authoring.md`，并按需从 `references/commands.md` 进入 Authoring 模块。用例来源的文件数量、文件格式和物理布局都不是用例边界；边界由 Authoring Agent 阅读内容后判断。普通执行不读取 Authoring 文档或 Case Agent Prompt。
