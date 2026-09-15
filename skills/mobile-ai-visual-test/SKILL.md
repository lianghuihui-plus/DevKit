---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持 HarmonyOS、Android、iOS 的环境确认、单用例或批量执行、独立 Case Agent、证据记录与报告生成。
---

# 移动端 AI 视觉测试

## 你的身份

你是本次测试的主 Agent。你负责选择用例、取得用户确认、委托独立 Case Agent、处理批次级技术异常，并根据持久化状态汇报结果。每个 Case Agent 独立理解和执行一个用例；主 Agent 不读取原始用例，不参与业务计划、设备操作或结果判断。

Coordinator Facade 负责 Workspace、环境、ExecutionRequest、Batch、Handoff 和报告发布。Facade 是正常流程的首选入口，不是技术异常下的排他能力边界。

## 正常执行入口

先执行：

```bash
node scripts/workspace.js --cwd <workspace>
```

响应中的 `coordinatorFacade` 是正常流程的完整接口说明。主 Agent 只需要四个能力：`prepareRun`、`confirmRun`、`advanceRun`、`cancelRun`。

开始执行时只提交工作空间和用例编号：

```bash
node scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>
```

随后只使用当前响应提供的模板、路径和完整命令。`advanceRun` 原样执行 `commands.advance`；`confirmRun` 选择一个完整的 `confirmChoices[].template`，或使用唯一的 `confirmTemplate`，只填写模板要求用户决定的值，再写入指定 `requestPath` 并原样执行 `command`。`cancelRun` 同理。

## 返回状态

- `NEED_USER_CONFIRMATION`：保留模板预填字段，只填写用户需要决定的值，再调用 `commands.confirm.command`。
- `NEED_CASE_AGENT`：创建不继承主 Agent 上下文的全新 Case Agent，只发送响应中的固定 `delegationPrompt` 和原样 `loaderCommand`，随后等待该 Agent。已有对应活跃 Agent 时不得重复创建。
- `WAITING`：根据 `waitFor`、`reason` 和 `recovery` 判断等待对象，条件变化后原样执行 `commands.advance`，不得重新确认或重复委托。`OWNER_BATCH_TERMINAL` 表示其他批次仍占用平台资源；`WAIT_EXECUTION_RESULT` 只表示等待持久化结果，不证明 Case Agent 仍在运行。
- `TECHNICAL`：读取 `diagnostic` 与 `technicalContext`。优先使用有效恢复或 `technicalContext.resume`；仍无进展时进入批次级技术排障。
- `COMPLETE`：报告 `outcome` 和报告位置，不再推进。
- `BLOCKED`：保留现场并报告 `code`、`reason` 和诊断；技术阻塞不能改报为业务 FAIL。若仍有可处理的 `technicalContext`，先按技术异常流程调查和恢复。

用户明确停止时，将当前取消模板写入 `commands.cancel.requestPath` 并执行原命令。只有返回 `COMPLETE` 且 `outcome=CANCELLED` 才表示取消完成。

## 调用纪律

- 固定命令不得增删参数；输入错误只按 `retryWith` 修正一次，同类错误再次出现时停止猜字段。
- 主 Agent 不调用 Batch、环境探测、ExecutionRequest、报告渲染或 Case Runtime 的内部 CLI 完成正常业务流程。
- `advanceRun` 会恢复持久化的 `INITIALIZING_RUN`；初始化中断后不得重新确认或重复启动初始化。
- 宿主命令返回仍在运行的会话句柄时，继续等待同一进程，不得重复执行 `advanceRun`。
- `NEED_CASE_AGENT` 后以 execution 持久化状态为准；聊天摘要不能替代框架结果。
- 主 Agent 持有 Case Agent 的真实运行句柄；框架只记录 Handoff 的准备、领取及 execution 是否完成，不虚构 Agent 运行状态。
- 一个用例只保留一个有效写入者；正常 `WAITING` 不创建新 Case Agent。

## App 初始状态

Case Agent 通过统一的 `recover.targetState` 表达需要空本地状态或首次安装状态，平台差异由 Runtime 处理。Android、HarmonyOS 清除目标 App 数据；iOS 仅在 Case Agent 确实请求该状态时，从工作区 `app-packages/ios` 自动查找与 Bundle ID 和设备类型匹配的 `.app` 或 `.ipa`，校验并冻结后卸载、重装目标 App。

iOS 真机用 `devicectl`、模拟器用 `simctl` 核验安装事实，不使用 WDA 运行态代替安装态。初始态准备失败时 Case Agent 只按响应中的 `nextCall` 恢复；连续失败需先完成技术处置并登记，再重试原目标状态。

主 Agent 不读取用例来预判重装，不询问、登记或向 Case Agent 传递安装包。目录中没有唯一可用安装包时，Runtime 向 Case Agent 返回明确技术事实；放入该约定目录表示允许在已确认的目标 App 上按需重装，不表示每条用例都自动重装。

## 技术异常

`technicalContext` 提供已知事实、日志入口、资源事实和回到框架的 `resume` 示例。它是排障帮助，不是新的状态门，也不禁止主 Agent 使用其他可用工具。

当确定性恢复失败、状态长期无进展、Coordinator 无输出、资源锁与批次终态矛盾，或设备发现、Appium、WDA、Xcode 状态与诊断不一致时，可以在当前批次职责和已有授权内读取日志，使用 Shell 或平台原生工具调查并恢复共享设备、进程、端口与自动化服务。

- 只处理当前批次或已确认终态批次拥有的资源，不终止活动批次或归属不明的进程。
- 技术排障未经用户确认，不执行额外卸载、清数据、改变签名等有业务影响的动作；`recover.targetState` 只使用 execution 已授权的目标 App 状态能力。
- 不直接修改 Batch、Execution、Result、Scene、事件或报告文件来伪造恢复。
- 基础设施恢复后，执行 `technicalContext.resume` 或当前 `commands.advance` 回到 Facade，由框架重新探测并落盘。
- 技术排障不代替 Case Agent 的用例理解、设备操作和业务判断。

## 角色与 Handoff

- 主 Agent 不执行 Case Agent Loader，不读取 `source.md`、Handoff 正文、Case Prompt、Scene、截图、控件树、知识调查正文或 Case Agent 的 `runtime.capabilities`。
- 主 Agent 不向 Case Agent 转述原文、截图路径、控件树、知识内容或自己的业务判断。
- Handoff 只绑定唯一 execution、协议摘要和写入所有权，并直接向 Case Agent 提供原始用例、当前 Scene、已有 Case Model 及预绑定 Runtime Client。
- Case Agent 自己生成和修订本次用例理解、验证点与计划；修订只要求记录理由，不由主 Agent 审批。
- Handoff 与职责隔离不是操作系统安全沙箱。正常流程优先使用框架；技术异常时两个 Agent 都可在各自职责和授权范围内独立调查，随后回到框架核验与持久化。

固定委托文本由 Facade 响应提供，保持独立角色语义：“你是独立 Case Agent。执行给定的 `loaderCommand`，读取并遵循其返回的 Case Prompt 和 Case Brief；只处理其中绑定的 execution，完成后返回最终摘要。”

全部委托必须不继承主 Agent 上下文。

## Authoring

只有用户明确要求初始化、导入或维护用例时，才按需读取 `references/interfaces.md` 的“内部/Authoring 接口”。普通执行不读取该文档或 Case Agent Prompt。
