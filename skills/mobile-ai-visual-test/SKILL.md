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

响应中的 `coordinatorFacade` 是正常执行的唯一接口说明。主 Agent 只使用四个能力：`prepareRun`、`confirmRun`、`advanceRun`、`cancelRun`。

开始执行时只提交工作空间和用例编号：

```bash
node scripts/coordinator-agent.js prepare --workspace <workspace> --case-nos <014,015>
```

之后不要自行组装参数。`advanceRun` 原样执行当前响应的 `commands.advance`；`confirmRun` 和 `cancelRun` 先把当前模板填入响应指定的 `requestPath`，再原样执行对应的 `command`。

## 返回状态

- `NEED_COMPILER`：创建不继承主 Agent 上下文的全新 Case Definition Compiler，只发送响应中的 `delegationPrompt` 和原样 `loaderCommand`；完成后执行 `commands.advance`。
- `NEED_USER_CONFIRMATION`：向用户确认响应指出的平台、设备、App 或执行授权；只修改 `confirmTemplate` 中要求用户决定的值，写入 `commands.confirm.requestPath`，再原样执行 `commands.confirm.command`。
- `NEED_CASE_AGENT`：创建不继承主 Agent 上下文的全新 Case Agent，只发送响应中的 `delegationPrompt` 和原样 `loaderCommand`。
- `WAITING`：等待当前 Case Agent 或可重试的报告发布；条件变化后原样执行 `commands.advance`。
- `COMPLETE`：向用户报告 `outcome` 和报告位置，不再推进。
- `BLOCKED`：保留现场，向用户报告 `code` 和 `reason`，不猜测或绕过框架。

用户明确要求停止时，将 `{"capability":"cancelRun","reason":"用户给出的原因"}` 写入 `commands.cancel.requestPath`，再原样执行 `commands.cancel.command`。取消只有在返回 `COMPLETE` 且 `outcome=CANCELLED` 后才完成。

## 调用纪律

- 只使用当前响应提供的模板、路径和完整命令；固定命令不得增删参数。
- 主 Agent 不调用 `batch`、环境探测、ExecutionRequest、报告渲染或 Case Runtime 的内部 CLI。
- 输入错误只按框架返回的 `retryWith` 修正一次；第二次相同错误停止并报告，不反复猜字段。
- `NEED_CASE_AGENT` 后以 execution 的持久化状态为准；Case Agent 的聊天摘要不替代框架结果。
- 一个用例只保留一个有效写入者；正常 `WAITING` 不创建新的 Case Agent。

## 角色边界

- 主 Agent 不得执行 Compiler 或 Case Agent 的 Loader，不得读取 `source.md`、CaseDefinition/CaseSpec 正文、Handoff 正文、Case Prompt、Case Brief、Scene、截图、控件树、知识调查正文或 Case Agent 的 `runtime.capabilities`。
- 主 Agent 不得向 Case Agent 补充用例原文、截图路径、控件树、知识内容或自己的业务判断。
- Case Agent 通过 Handoff Loader 自动获得 Frozen CaseSpec、六个业务能力和预绑定 Runtime Client；业务操作与视觉判断只在 Case Agent 内完成。
- Coordinator Facade 和 Case Runtime 是确定性本地代码；角色隔离是职责与协议隔离，不是共享文件系统的安全沙箱。
- Handoff 使用绑定 token 和 sequence 保证同一 dispatch 幂等；新 dispatch 会替换旧 dispatch，主 Agent 不解析这些内部字段。

固定委托文本由 Facade 响应提供。它们必须保持独立角色语义：

- Case Agent：“你是独立 Case Agent。执行给定的 `loaderCommand`，读取并遵循其返回的 Case Prompt 和 Case Brief；只处理其中绑定的 execution，完成后返回最终摘要。”
- Case Definition Compiler：“你是独立 Case Definition Compiler。执行给定的 `loaderCommand`，只处理其返回的单个用例原文；按照 Compiler Prompt 生成候选定义，并使用返回的 Publisher 接口发布。不要访问设备、Scene、Batch、历史执行或报告。”

主 Agent 不得执行该 Loader、读取返回的原文或生成定义，也不得读取 Handoff 正文。全部委托必须不继承主 Agent 的上下文。

## Authoring

只有用户明确要求初始化、导入或维护用例时，才按需读取 `references/interfaces.md` 的“内部/Authoring 接口”。普通执行不读取该文档或 Case Agent Prompt。
