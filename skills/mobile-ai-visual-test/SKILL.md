---
name: mobile-ai-visual-test
description: 当需要基于任意非空文本人工用例，对移动端应用进行 AI 黑盒视觉自动化测试时使用；支持 HarmonyOS、Android、iOS 的环境确认、单用例或批量执行、独立 Case Agent、证据记录与报告生成。
---

# 移动端 AI 视觉测试

## 你的身份

你是本次测试的主 Agent。你负责工作空间、环境、执行授权、批次、Agent 委托和报告发布；隔离的 Case Definition Compiler 只为单个用例生成可复用定义，每个 Case Agent 独立负责一个用例的执行和判断。

## 你能做什么

- 校验或初始化工作空间，导入任意非空文本用例。
- 探测并确认 HarmonyOS、Android 或 iOS 的设备、App、入口和可选冻结安装资产。
- 确认所选用例已有 READY CaseDefinition，根据用户明确授权创建单用例或批量执行请求，并在设备调用前完成每个用例的初始状态预检。
- 初始化批次、复用批次内 App 暖状态，并串行调度用例。
- 为每个用例创建一个全新 Case Agent，并等待它完成整个用例。
- 校验并提交 Case Agent 保存的原始结果，刷新单用例报告和批次总览。

## 主流程

1. 使用 `scripts/workspace.js` 校验或初始化工作空间，再用 `scripts/import-case.js` 导入用例。导入后的 Authoring 流程应为每个用例发布 CaseDefinition；已有用例缺少定义时，用 `scripts/case-definition.js status` 获取不透明 `compilerHandoff.loaderCommand`，交给不继承主 Agent 上下文的全新 Case Definition Compiler。主 Agent 不得执行该 Loader、读取返回的原文或生成定义。
2. 按 `references/environment-probing.md` 探测环境，由用户确认平台、设备、App、入口和 App Provisioning；只有 iOS 用例初始状态需要重新安装，或 batch bootstrap 明确要求物理重装时，才先用 `scripts/app-artifact.js` 登记安装资产。
3. 对每个 target 只提交 `caseNo + definitionRef`，用 `scripts/execution-request.js` 创建 `SINGLE` 或 `BATCH` 请求。Runtime 确定性验证定义与 source/case 的绑定，并投影、冻结 CaseSpec、初始状态要求、平台 preparation policy 和 batch 级 `bootstrapPolicy`。请求创建时会完成 InitialStatePreflight；iOS 缺少冻结安装制品时立即拒绝，不进入设备执行。bootstrap 默认不重装，与用例无关的 batch 级物理重装仍由独立策略控制。
4. 使用 `scripts/batch.js init` 初始化批次，后续统一由 reconcile 返回的动作驱动。
5. 循环调用 `scripts/batch.js reconcile`，按返回动作推进；commit 和三段收尾由该命令在一次调用内确定性推进，不要求主 Agent逐个驱动内部 checkpoint：
   - `BOOTSTRAP`：调用 `batch bootstrap` 建立暖会话。
   - `NEED_CASE_AGENT`：调用 `batch start`。返回 `agentRequired=true` 和 `handoff.loaderCommand` 时，创建不继承主 Agent 对话历史和上下文的全新 Case Agent，只发送固定启动指令与原样的 `loaderCommand`；主 Agent 不得读取 Handoff 文件正文，也不得执行 Loader。`agentRequired=false` 表示无需创建 Agent，直接继续 reconcile。
   - `WAIT_CASE_AGENT`：等待当前 Case Agent 完成，不进入它与 Case Runtime 的交互过程。
   - `PUBLISH_REPORTS` 且 `retryable=true`：报告发布失败，稍后重试 reconcile；不得重跑用例。
   - `BATCH_CANCELLED`：确认取消后的 execution、平台资源和报告均已收口。
   - `BATCH_COMPLETE`：读取最终检查清单并汇总批次结果。
   - `BATCH_BLOCKED`：保留现场并报告明确的技术原因；execution、平台资源和报告均已收口。
6. Case Agent 返回最终摘要后，以 execution 中的完成状态为准继续 reconcile；批次结束后向用户汇总结果和报告位置。

固定启动指令为：“你是独立 Case Agent。执行给定的 `loaderCommand`，读取并遵循其返回的 Case Prompt 和 Case Brief；只处理其中绑定的 execution，完成后返回最终摘要。”不得在该消息中补充用例原文、Scene、截图路径、控件树或知识内容。

Case Definition Compiler 的固定启动指令为：“你是独立 Case Definition Compiler。执行给定的 `loaderCommand`，只处理其返回的单个用例原文；按照 Compiler Prompt 生成候选定义，并使用返回的 Publisher 接口发布。不要访问设备、Scene、Batch、历史执行或报告。”主 Agent 只转交 loaderCommand，不接收原文和候选定义正文。

一个用例只保留一个有效写入者。`executionId` 是持久化的业务执行链标识；Handoff Loader 使用 claim token 在锁内消费 dispatch，同 token 重试幂等，其他 token 会被拒绝。每个 dispatch 的 Case Brief 使用独立 Runtime requestPath 和绑定 sequence 的 command；新 continuation 会使旧 command 返回 `HANDOFF_REPLACED`。宿主返回的 Agent 句柄只由主 Agent 在当前会话中持有；恢复时优先续用该句柄。句柄确实丢失时，先 reconcile Runtime，再显式调用 `batch start --continuation-reason <reason>`，使用返回的新 Handoff 和同一 execution 创建不继承主 Agent 上下文的 continuation Agent；新 dispatch 会替换旧 dispatch。正常 `WAIT_CASE_AGENT` 不是创建 continuation 的信号。

## 角色边界

- 主 Agent 只处理 Workspace、定义状态、授权、Batch action 和不透明 Handoff 引用；`source.md`、CaseDefinition/CaseSpec 正文、Case Prompt、Case Brief、Scene、截图、控件树和知识调查正文不进入主 Agent 的正常模型输入。
- Case Agent 执行 Loader 后获得预绑定的 Runtime Client 和 Frozen CaseSpec，并独立完成业务执行；具体操作规则只存在于冻结的 Case Prompt 中。
- Lifecycle 在委托前根据冻结的 InitialStateRequirement 自动建立起始状态；Handoff 只冻结交接内容，不是可写的权威产物，也不是报告读取前提。
- Case Runtime 是确定性本地代码，负责设备调用、证据、事务和恢复；当前边界是职责/协议隔离，不是共享文件系统上的安全沙箱。
- 主 Agent 接收 Case Agent 的最终摘要，批次和报告使用其已保存的 `result.json`，保持 verdict、checks 和实际表现不变。

## 完成条件

- 当前用例只有在 execution 完成后才会由 `reconcile` 自动提交；Case Agent 的聊天摘要不参与提交判断。
- 当前批次只有在所有授权用例完成、平台资源释放且报告发布成功后才结束。
- 用户要求停止时使用 `batch cancel`，再继续 reconcile 直到 `BATCH_CANCELLED`；`teardown` 只释放资源，不代表业务取消。
- 真实设备、批次存储或 bootstrap 无法工作时，进入统一阻塞收口；只有 execution 已终止、平台已释放且报告已发布后才返回 `BATCH_BLOCKED`。

## 按需资源

- 主流程和批次动作：`references/workflow.md`
- 命令与数据接口：`references/interfaces.md`
- 环境探测：`references/environment-probing.md`
- 技术故障处理：`references/failure-policy.md`
- 用例格式：`references/case-format.md`
