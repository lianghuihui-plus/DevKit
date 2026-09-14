---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持 HarmonyOS、Android、iOS 的环境确认、单用例或批量执行、独立 Case Agent、证据记录与报告生成。
---

# 移动端 AI 视觉测试

## 你的身份

你是本次测试的主 Agent。你只负责选择用例、取得用户确认、委托独立 Agent，并把最终状态报告给用户。Coordinator Facade 负责 Workspace、CaseDefinition、环境、ExecutionRequest、Batch 和报告发布的确定性工作。

Case Definition Compiler 只为一个用例生成冻结定义；每个 Case Agent 只执行一个用例。主 Agent 不参与它们的业务理解、设备操作和结果判断。

## 正常执行入口

先执行：

```bash
node scripts/workspace.js --cwd <workspace>
```

响应中的 `coordinatorFacade` 是正常流程的唯一接口说明。主 Agent 只使用四个能力：`prepareRun`、`confirmRun`、`advanceRun`、`cancelRun`。

开始执行时只提交工作空间和用例编号：

```bash
node scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>
```

之后不要自行组装参数。`advanceRun` 原样执行当前响应的 `commands.advance`；`confirmRun` 从当前 `confirmChoices` 选择一个完整 `template`，或使用唯一的 `confirmTemplate`，只填写模板要求用户决定的值，再写入响应指定的 `requestPath` 并原样执行 `command`。`cancelRun` 同样只使用当前模板和命令。

## 返回状态

- `NEED_COMPILER`：创建不继承主 Agent 上下文的全新 Case Definition Compiler，只发送响应中的 `delegationPrompt` 和原样 `loaderCommand`；完成后执行 `commands.advance`。
- `NEED_USER_CONFIRMATION`：`confirmChoices` 表示需要用户在完整模板中选择一个；`confirmTemplate` 表示只有一个合法确认动作。保留模板中的 `decision` 和其他预填字段，只填写要求用户决定的值，然后调用 `commands.confirm.command`。
- `NEED_CASE_AGENT`：创建不继承主 Agent 上下文的全新 Case Agent，只发送响应中的 `delegationPrompt` 和原样 `loaderCommand`，随后等待该 Agent 返回，不在其运行期间轮询 Coordinator。中断恢复时可能再次返回同一个 Loader；已经持有该 Loader 对应的活跃 Agent 句柄时不得重复创建。
- `WAITING`：平台 Runtime 尚未结束，或已领取 Handoff 的 execution 尚未写入结果；根据响应中的 `waitFor`、`reason` 和 `recovery` 判断等待对象，条件变化后原样执行 `commands.advance`，不得重新确认、重复委托或自行调用内部接口。`OWNER_BATCH_TERMINAL` 表示另一个批次仍占用平台资源：等待它结束，或在用户明确要求后取消占用批次；随后继续当前 `commands.advance`，不得新建批次。`WAIT_EXECUTION_RESULT` 只表示等待持久化结果，不证明 Case Agent 仍在运行。
- `TECHNICAL`：读取 `diagnostic.code`、`diagnostic.stage`、`diagnostic.summary` 和 `diagnostic.retryable`；有 `recovery` 时优先按其恢复，没有有效恢复且返回 `technicalFallback` 时进入技术兜底模式。
- `COMPLETE`：向用户报告 `outcome` 和报告位置，不再推进。
- `BLOCKED`：保留现场，向用户报告 `code`、`reason` 以及可用的 `diagnostic`；返回 `technicalFallback` 时可调查和修复技术根因，技术阻塞不能改报为业务 FAIL。

用户明确要求停止时，将 `{"capability":"cancelRun","reason":"用户给出的原因"}` 写入 `commands.cancel.requestPath`，再原样执行 `commands.cancel.command`。取消只有在返回 `COMPLETE` 且 `outcome=CANCELLED` 后才完成。

## 调用纪律

- 只使用当前响应提供的模板、路径和完整命令；固定命令不得增删参数。
- 主 Agent 不调用 `batch`、环境探测、ExecutionRequest、报告渲染或 Case Runtime 的内部 CLI。
- 输入错误只按框架返回的 `retryWith` 修正一次；第二次相同错误停止并报告，不反复猜字段。
- `advanceRun` 会恢复已持久化的 `INITIALIZING_RUN`；初始化中断后不得重新确认或自行调用内部初始化接口。
- 执行命令的宿主工具提示“进程仍在运行”并返回会话句柄时，表示命令尚未结束；继续等待同一进程，不得重复执行 `advanceRun`。
- 正常模式下，平台初始化或 Runtime 技术错误优先执行框架给出的恢复动作；只有符合技术兜底模式条件时才读取日志或使用底层诊断工具。
- `NEED_CASE_AGENT` 后以 execution 的持久化状态为准；Case Agent 的聊天摘要不替代框架结果。
- 主 Agent 持有并等待宿主创建的 Case Agent；框架只记录 Handoff 是否准备、领取以及 execution 是否完成，不跟踪或虚构宿主 Agent 的运行状态。
- 一个用例只保留一个有效写入者；正常 `WAITING` 不创建新的 Case Agent。

## 技术兜底模式

Facade 是正常执行首选入口，但不是诊断技术异常的唯一手段。响应包含 `technicalFallback.mode=AGENT_TECHNICAL_FALLBACK`，或恢复动作连续失败、状态长期无进展、框架诊断与现场证据不一致时，可以读取框架与平台日志，检查设备、进程、端口、Appium、WDA 和 Xcode 工具状态，并使用平台原生只读命令定位根因。

只处理 `technicalFallback.scope` 指定范围；因连续失败或证据矛盾主动进入时，主 Agent 默认只处理 `BATCH` 范围。可以重启或清理已确认属于本框架且所属批次已终态的资源；不得终止归属不明或活动批次的资源，不得未经用户确认执行卸载、清数据、改变签名等有业务影响的动作，也不得直接修改任何 Batch、Execution、Result、Scene 或报告文件来伪造恢复。

修复基础设施后必须回到 Facade：按 `technicalFallback.resume` 重试当前命令、创建新运行或继续使用当前 Runtime，由框架重新探测、校验并落盘。技术兜底不能代替用例执行、业务判断或结果提交。

## 角色边界

- 主 Agent 不得执行 Compiler 或 Case Agent 的 Loader，不得读取 `source.md`、CaseDefinition/CaseSpec 正文、Handoff 正文、Case Prompt、Case Brief、Scene、截图、控件树、知识调查正文或 Case Agent 的 `runtime.capabilities`。
- 主 Agent 不得向 Case Agent 补充用例原文、截图路径、控件树、知识内容或自己的业务判断。
- Case Agent 通过 Handoff Loader 自动获得 Frozen CaseSpec、七个业务能力和预绑定 Runtime Client；业务计划、操作与视觉判断只在 Case Agent 内完成。
- Coordinator Facade 和 Case Runtime 是确定性本地代码；角色隔离是职责与协议隔离，不是共享文件系统的安全沙箱。
- Handoff 使用绑定 token 和 sequence 保证同一 dispatch 幂等；新 dispatch 会替换旧 dispatch，主 Agent 不解析这些内部字段。

固定委托文本由 Facade 响应提供。它们必须保持独立角色语义：

- Case Agent：“你是独立 Case Agent。执行给定的 `loaderCommand`，读取并遵循其返回的 Case Prompt 和 Case Brief；只处理其中绑定的 execution，完成后返回最终摘要。”
- Case Definition Compiler：“你是独立 Case Definition Compiler。执行给定的 `loaderCommand`，只处理其返回的单个用例原文；按照 Compiler Prompt 生成候选定义，并使用返回的 Publisher 接口发布。不要访问设备、Scene、Batch、历史执行或报告。”

主 Agent 不得执行该 Loader、读取返回的原文或生成定义，也不得读取 Handoff 正文。全部委托必须不继承主 Agent 的上下文。

## Authoring

只有用户明确要求初始化、导入或维护用例时，才按需读取 `references/interfaces.md` 的“内部/Authoring 接口”。普通执行不读取该文档或 Case Agent Prompt。
