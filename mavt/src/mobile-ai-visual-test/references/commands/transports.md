# 预绑定 Transport

Transport 命令由框架生成并绑定当前状态。Agent 原样执行，只构造文档明确要求的业务输入。

## Coordinator.prepareCommand

MCP mavt_run_prepare。

- 输入：提交 {contextRef,input}；input 只包含 caseNos。
- 调用：使用 workspace 绑定引用，成功后保留返回的 Run 引用。
- 成功：SUCCEEDED
- 错误：`COORDINATOR_INPUT_INVALID`、`COORDINATOR_TECHNICAL`

## Coordinator.coordinatorCommand

绑定 Run 的 MCP 工具。

- 输入：confirmRun、advanceRun、cancelRun、read 分别调用 mavt_run_confirm/advance/cancel/read。
- 调用：提交 {contextRef,input}，原样复用该 Run 的 contextRef。
- 成功：SUCCEEDED
- 错误：`COORDINATOR_INPUT_INVALID`、`COORDINATOR_STATE_INVALID`、`COORDINATOR_TECHNICAL`

## Case Runtime.loaderCommand

Case Agent 用于领取唯一 execution Handoff 的预绑定 Loader。

- 输入：不附加输入。
- 调用：必须原样执行，不修改哈希、sequence、claim token 或路径。
- 成功：SUCCEEDED；唯一 caseBrief 主数据包含冻结 prompt、MCP 传输及 Loader 作用域引用。
- 错误：`BINDING_INVALID`、`PROTOCOL_MISMATCH`

## Case Runtime.runtimeClient

当前 execution 的 MCP 工具 mavt_case_<method>。

- 输入：提交 {contextRef,input}，方法名称及大小写与索引一致。
- 调用：contextRef 原样取自子 Agent 本次 Loader；业务字段只按当前方法页构造。
- 成功：返回一个 Agent-facing Runtime 状态。
- 错误：`AGENT_INPUT_INVALID`、`AGENT_INPUT_STALLED`、`BINDING_INVALID`、`CASE_RUNTIME_TECHNICAL`
