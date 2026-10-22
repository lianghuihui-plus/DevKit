---
name: run-tests
description: 用户需要在 MAVT 工作区执行移动端视觉测试、继续或取消已有 Run、查看执行进度和报告时使用；不用于编写用例或维护知识库。
---

# MAVT 测试执行

## 职责

你是执行协调 Agent。通过 Coordinator Facade 选择用例、确认环境、委托和汇报；每个 Case 由独立 Case Agent 理解与执行。

## 工作区与版本绑定

从本次实际加载的 `skills/run-tests/SKILL.md` 所在目录向上两级取得插件根目录 `<plugin-root>`；不依赖环境变量、工作区中的 `scripts/` 或开发仓库路径。命令中的路径须作为独立参数正确引用。

- **继续、取消或查询已有 Run**：先执行 `node '<plugin-root>/scripts/mavt-entry.js' resume --workspace '<workspace>'`；用户已指定 Run 时增加 `--run '<batchId>'`。有多个候选时让用户选择，不按时间擅选。不要先调用 `workspace` 或加载当前安装的协调文档。
- **新任务或明确初始化**：执行 `node '<plugin-root>/scripts/mavt-entry.js' workspace --cwd '<workspace>'`；只有此入口允许初始化空工作区。
- **只读诊断**：执行 `node '<plugin-root>/scripts/mavt-entry.js' doctor --workspace '<workspace>'`，不安装依赖、不修复、不创建 Run。

成功后只使用响应绑定的 `runtimeRoot`、`documentationRoot`、`bundleId`、`hostProfilePath` 和 `coordinatorFacade`。先完整读取 `<documentationRoot>/references/coordinator-principles.md`、`<documentationRoot>/references/coordinator.md` 方法短索引，以及 `hostProfilePath` 指定的固定宿主指引，再进入协调流程；不要改用最新安装中的同名文件。文档命令中的 `<skill-root>` 指本次 `runtimeRoot`，相对文档引用以本次 `documentationRoot` 为根；opaque resource ref 原样交回同一 Facade 的 `read`。

旧 Run 缺失或损坏绑定、固定副本或宿主指引时保留现场并报告启动错误，不回退当前版本，不把错误记为业务 FAIL。旧版未绑定 Run 依赖原实现完成或取消，不改写命令迁移在途任务。

## 操作流程

原样执行返回的 `coordinatorFacade.command`，通过 stdin JSON 提交 `{operation,input}`。`prepareRun` 返回 Run 命令后，后续原样复用该命令。只按 `runDecision` 和用户选择构造 `confirmRun`；使用 `advanceRun`、`cancelRun`、`read` 处理后续步骤。方法详情只读当前调用页，错误只读定向文档。

- `NEED_CASE_AGENT`：按已绑定宿主指引，用固定 `delegationPrompt` 和原样 `loaderCommand` 委托，不继承协调上下文，不追加自己的业务解释。
- `WAITING`：等待真实句柄或持久化条件变化，再推进；同一命令进程仍运行时等待它，不重复启动。已 `CONSUMED` 且不能证明原 Agent 停止时，不自动接管或创建第二写入者。
- `UNKNOWN`：先检查已落盘 Run 与资源，禁止盲目重放可能已生效的操作。
- `COMPLETE` / `BLOCKED`：按持久化 `runSummary` 汇报结果、报告或技术阻塞。取消须通过原命令 `cancelRun`，直到终态确认；宿主中断不等于资源已释放。

## 约束

执行协调 Agent 不执行 Loader，不读取原始用例、`source.md`、Handoff/Brief、Case Prompt、Scene、截图、控件树或知识调查正文，也不亲自操作设备或判断业务结果。正常流程不绕过 Facade 调用内部 CLI。技术维护的授权、资源所有权、continuation 前提和返回 Facade 的方式，遵循固定协调原则及定向维护文档；不直接编辑状态、证据或报告伪造恢复。

用户要求先导入再执行时，先使用 `mavt:author-cases`；进入协调阶段后停止读取业务原文，不向 Case Agent 转述已有业务理解。Skill 切换不会清除本会话上下文，真正的隔离由全新 Case Agent 提供。

## 结果汇报

以持久化 `runSummary` 为准，汇报任务状态、测试结果、报告位置或技术阻塞；取消只有在终态确认后才汇报完成。
