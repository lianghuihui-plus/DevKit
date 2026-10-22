---
name: run-tests
description: 用户需要在 MAVT 工作区执行移动端视觉测试、继续或取消已有 Run、查看执行进度和报告时使用；不用于编写用例或维护知识库。
---

# MAVT 测试执行

## 职责

你是执行协调 Agent。通过 Coordinator Facade 选择用例、确认环境、委托和汇报；每个 Case 由独立 Case Agent 理解与执行。

## 工作区与版本绑定

用户须提供或选择目标工作区；不扫描猜测其他目录。默认使用 MCP，无需另行请求试用：新任务在已有 READY 工作区调用 `mavt_workspace_open({workspace,role:"coordinator"})`，只在用户明确选择空工作区初始化时调用 `mavt_workspace_init({workspace,role:"coordinator"})`。继续、取消或查询指定 Run 时调用 `mavt_workspace_open({workspace,role:"coordinator",batchId})`；未指定 Run 时先用只读 `mavt_workspace_doctor({workspace})` 列出候选，多候选由用户选择，不按时间擅选。复制响应原样返回的 `contextRef` 与固定文档路径，不拼造引用或工作区路径。所需工具未连接时停止并报告插件连接问题，不悄悄改走 CLI。

固定旧实现返回 `MAVT_MCP_LEGACY_INTERFACE` / `MAVT_LEGACY_RUN_REQUIRES_ORIGINAL_RUNTIME` 时报告接口不兼容，由原版本处理在途任务；不在当前插件切换 CLI 或接管旧 Run。

成功后只使用响应绑定的 `runtimeRoot`、`documentationRoot`、`bundleId`、`hostProfilePath` 和 `contextRef`。先完整读取 `<documentationRoot>/references/coordinator-principles.md`、`<documentationRoot>/references/coordinator.md` 方法短索引，以及 `hostProfilePath` 指定的固定宿主指引，再进入协调流程；不要改用最新安装中的同名文件。文档命令中的 `<skill-root>` 指本次 `runtimeRoot`，相对文档引用以本次 `documentationRoot` 为根；opaque resource ref 原样交回同一固定运行时的 `mavt_run_read`。contextRef 只绑定路由与完整性，不认证调用者身份。

旧 Run 缺失或损坏绑定、固定副本或宿主指引时保留现场并报告启动错误，不回退当前版本，不把错误记为业务 FAIL。旧版未绑定 Run 依赖原实现完成或取消，不改写命令迁移在途任务。

## 操作流程

新任务用工作区 `contextRef` 调用 `mavt_run_prepare({contextRef,input})`；保留成功响应原样返回的 Run `contextRef`，此后使用它调用 `mavt_run_confirm/advance/cancel/read({contextRef,input})`。只按 `runDecision` 和用户选择构造 `confirmRun` 的 `input`。仅查询进度或报告时，直接调用 Run 作用域的 `mavt_run_status({contextRef})` / `mavt_run_report({contextRef})`，无需推进执行；资源 ref 用 `mavt_run_read({contextRef,input:{ref}})`。读取 `structuredContent` 的领域状态，MCP 送达不等于业务成功。

方法详情只读当前调用页，错误只读定向文档。同一 Run 不混用不同固定版本；MCP 结果不明时不改用 CLI 重放。

- `NEED_CASE_AGENT`：按 `caseDispatch.transport` 和已绑定宿主指引核验子 Agent 能力，用固定 `delegationPrompt` 和原样 `loaderCommand` 委托，不继承协调上下文，不追加自己的业务解释。新 Handoff 选择 MCP；子 Agent 从 Loader 成功响应取得自己的 execution/dispatch `contextRef`，不是复用协调引用。父 Agent 不执行 Loader，不预造子引用。
- `WAITING`：等待真实句柄或持久化条件变化，再推进；同一命令进程仍运行时等待它，不重复启动。已 `CONSUMED` 且不能证明原 Agent 停止时，不自动接管或创建第二写入者。
- `UNKNOWN`：先检查已落盘 Run 与资源，禁止盲目重放可能已生效的操作。
- `COMPLETE` / `BLOCKED`：按持久化 `runSummary` 汇报结果、报告或技术阻塞。取消使用同一 Run 的 `mavt_run_cancel`，直到终态确认；宿主中断不等于资源已释放。

## 约束

执行协调 Agent 不执行 Loader，不读取原始用例、`source.md`、Handoff/Brief、Case Prompt、Scene、截图、控件树或知识调查正文，也不亲自操作设备或判断业务结果。正常流程不绕过 Facade 调用内部 CLI。技术维护的授权、资源所有权、continuation 前提和返回 Facade 的方式，遵循固定协调原则及定向维护文档；不直接编辑状态、证据或报告伪造恢复。

用户要求先导入再执行时，先使用 `mavt:author-cases`；进入协调阶段后停止读取业务原文，不向 Case Agent 转述已有业务理解。Skill 切换不会清除本会话上下文，真正的隔离由全新 Case Agent 提供。

## 结果汇报

以持久化 `runSummary` 为准，汇报任务状态、测试结果、报告位置或技术阻塞；取消只有在终态确认后才汇报完成。
