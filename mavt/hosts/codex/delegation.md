# Codex Case Agent 委托

本文件只定义宿主协作方式。Coordinator 决定何时委托、绑定哪个 execution；Case Agent 的业务原则来自原样 Loader 返回的固定 Brief。Case Agent 是内部角色，不重新加载 Authoring 或执行协调 Skill；Brief 中出现原 Skill 身份也不改变角色。

会话能力核验以同一固定 bundle 的 `hosts/codex/harness-requirements.json` 为准，分委托前与子 Agent 执行 Loader 后两阶段。当前构建的新 Handoff 冻结 `brief.runtime.transport:"MCP"`，公开的 `caseDispatch.transport` 提供相同选择；委托前核验宿主支持独立上下文及真实创建/等待/取消句柄。子 Agent 启动并执行 Loader 后，在自己的会话中发现 `mavt_case_*` 工具和 MCP 图片或本地图片查看能力。调用绑定使用 Loader 返回的 execution/dispatch scoped `contextRef`；该引用不在委托前产生，也不得由 Coordinator 预交付或编造。引用仅提供路由与完整性边界，不代表调用者身份认证或操作系统隔离。

## 能力与上下文

通过宿主的工具发现入口按 `mavt` 查找工具并使用返回的真实名称。本文使用 MCP 原始工具名；Codex 可能展示为 `mcp__mavt__mavt_case_observe`，或经工具搜索、`functions.exec` 的 `ALL_TOOLS` 目录提供。根据本会话实际提供的入口发现和调用。

协调 Agent 检查创建独立上下文 Agent、等待和中断的实际宿主能力；子 Agent 自行确认 Shell、固定文件读取、MCP 工具与图片查看能力。使用真实工具名称、参数与返回的句柄，不假设所有 Codex 版本有相同 API，不指定未经支持或用户要求的模型。委托前不要求 execution `contextRef`；它只可能由子 Agent 执行 Loader 后取得。子 Agent 核对 Loader 成功响应中的 `role:"case"`、`scope:"execution"`、`contextRef`、`executionId`、`dispatchSequence` 与 `result` 身份字段，再以原样引用调用 `mavt_case_<method>({contextRef,input})`；方法名称大小写与 Brief 方法索引一致。服务端仍验证固定 bundle、当前 execution 与活跃 dispatch。

例如实际提供 `collaboration.spawn_agent` 且支持 `fork_turns: "none"` 时，用该参数创建全新上下文。Case 由独立 Case Agent 执行，协调 Agent 保持协调职责。旧 Handoff 未选择 MCP 时报告接口不兼容，由原版本处理，不迁移在途任务。职责隔离不是操作系统安全沙箱。

## 唯一委托与等待

仅在 Facade 返回 `NEED_CASE_AGENT`、且确认没有同 execution 活跃写入 Agent 时创建。发送给新 Agent 的内容只有当前 `caseDispatch.delegationPrompt` 与原样 `loaderCommand`；不添加用例摘录、截图路径、知识、工作区业务判断或父会话历史。协调 Agent 不执行 Loader、不读取 Brief；Case Agent 原样运行 Loader，完整读取响应 `data.content` 中的 Brief，遵循冻结的 `casePrompt`，只处理绑定 execution。

保存返回的真实 Agent 句柄并等待。若创建返回异步设置句柄，按实际工具协议等到可用身份后关联，不能编造已运行状态。Agent 的聊天完成或摘要不是 execution 完成证明；回到同一固定 Run 的 `mavt_run_advance` 核验、commit、释放并发布，当前 Case commit 前不派发后续 Case。Facade 的 WAITING 不证明 Agent 活着，也不授权新建一个。

## 恢复与取消

- 原句柄可查且活跃：重新关联并等待。
- dispatch 未领取且确认无活跃 Agent：原样交付已有 dispatch，不另造一份。
- dispatch 已 `CONSUMED`，原 Agent 状态不明：保留 WAITING 和诊断；超时、会话断开、旧安装删除都不能证明旧写入者停止。
- 宿主已证明原 Agent 停止、execution 未终态：进入固定版本的技术维护文档。已有 `batch.js start --continuation-reason` 属于维护入口，先满足文档前提，由框架替换 dispatch sequence，再回到 Facade 获取固定委托；不能用普通 `advanceRun` 冒充自动接管，也不自行编造 Loader。
- execution 已终态：由 Coordinator 核验与发布，不重新执行 Case。

用户明确取消时，使用原 Run 的 `contextRef` 调用 `mavt_run_cancel`；在实际宿主支持的范围内中断对应 Case Agent，并持续核验原 Coordinator 的持久化取消结果。仅操作当前批次拥有的句柄、进程和资源；未知归属或其他活动批次的资源不得终止。宿主中断不证明设备、锁、进程或报告已清理。

恢复时使用绑定入口返回并校验过的固定 `hostProfilePath`；不拿当前插件的新指引替换旧 Run 规则。无法证明旧写入者停止时，报告阻塞，或在用户要求停止时走取消流程。
