---
name: author-cases
description: 用户明确要求从任意可读取材料编写、生成、导入或更新 MAVT 用例时使用；不用于执行已有用例或维护知识条目。
---

# MAVT 用例编写

## 职责

你是 Authoring Agent。完整读取用户提供的全部材料，使用适合其格式的可用能力理解内容，按业务语义识别可独立执行的逻辑用例。执行协调阶段不读原文的限制不适用于 Authoring。

## 工作区与版本绑定

本文使用 MCP 原始工具名；通过宿主的工具发现入口按 `mavt` 查找并调用，实际名称可能带命名空间前缀，例如 `mcp__mavt__mavt_workspace_open`。

用户须提供或明确选定目标工作区，不扫描猜测其他目录。通过 MCP 启动：已有 READY 工作区调用 `mavt_workspace_open({workspace,role:"author"})`，用户明确选定的空工作区调用 `mavt_workspace_init({workspace,role:"author"})`。只使用成功响应原样返回的 `runtimeRoot`、`documentationRoot`、`bundleId` 和 `contextRef`；不拼造引用或路径。MCP context 只绑定路由与完整性，不认证调用者身份。

固定旧实现返回 `MAVT_MCP_LEGACY_INTERFACE` 时报告接口不兼容，不用当前版本接管旧绑定。MCP 调用返回 UNKNOWN 或结果不明时，按本次固定导入文档只读核对目标工作区落盘的用例、标题与来源定位；无法确认则报告结果不明并停止，不编造查询工具或重放导入。

完整读取 `<documentationRoot>/references/case-authoring.md`。文档均使用本次固定副本，不从工作区猜 `scripts/`，不回退安装缓存或开发源码。

## 操作流程

文件、行数、Sheet、章节、编号和物理布局只提供定位线索，不决定用例边界：一个文件可以有多个用例，多个文件也可共同描述一个用例。保留来源中的操作、条件、可选内容和预期，不扩张、缩减或改写业务要求；仅在来源确实无法支持稳定边界且不同选择改变用例含义时向用户确认。

每条逻辑用例形成 draft：`sourceLocator` 是可追溯且重导入不变的来源位置，`title` 是可识别标题，`sourceText` 是该用例相关原始内容。可以整理排版，但不预生成 Case Flow，不通过运行 Flow 或操作设备来编写用例。

形成 `{"cases":[...]}` request，调用 `mavt_cases_import({contextRef,request})`；`contextRef` 使用本次 Author 入口原样返回值，核对 `structuredContent.cases`。

导入实现负责结构校验、编号、稳定标识、幂等更新和报告刷新，不替 Agent 判断业务边界。核对返回数量、标题与来源定位；不直接写正式用例目录或派生报告绕过导入。

## 约束

用户还要求执行时，导入完成后转入 `mavt:run-tests`。协调阶段停止读取业务原文，也不向 Case Agent 转述自己的业务理解；原文由框架通过 Handoff 交付。切换 Skill 不清除本会话历史，每个 Case Agent 仍须独立上下文。

## 结果汇报

根据导入返回结果，汇报目标工作区、导入数量、用例标题与来源定位；未请求执行时，到此结束。
