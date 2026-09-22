# 预绑定 Transport

Transport 命令由框架生成并绑定当前状态。Agent 原样执行，只构造文档明确要求的业务输入。

## Coordinator.prepareCommand

绑定 workspace 的启动命令。

- 输入：stdin 提交一次 {operation,input}；prepareRun.input 只包含 caseNos。
- 调用：原样执行 Workspace 提供的 command。
- 成功：SUCCEEDED
- 错误：`COORDINATOR_INPUT_INVALID`、`COORDINATOR_TECHNICAL`

## Coordinator.coordinatorCommand

绑定 run 的单一命令。

- 输入：stdin 提交 confirmRun、advanceRun、cancelRun 或 read 请求。
- 调用：所有后续操作原样复用 result.command。
- 成功：SUCCEEDED
- 错误：`COORDINATOR_INPUT_INVALID`、`COORDINATOR_STATE_INVALID`、`COORDINATOR_TECHNICAL`

## Case Runtime.loaderCommand

Case Agent 用于领取唯一 execution Handoff 的预绑定 Loader。

- 输入：不附加输入。
- 调用：必须原样执行，不修改哈希、sequence、claim token 或路径。
- 成功：SUCCEEDED；唯一 caseBrief 主数据包含冻结 prompt 和预绑定 Runtime Client。
- 错误：`BINDING_INVALID`、`PROTOCOL_MISMATCH`

## Case Runtime.runtimeClient

当前 execution 的预绑定 Case Runtime Client。

- 输入：每轮通过 stdin 提交 {operation,input} 请求。
- 调用：必须原样使用命令绑定；业务字段只按当前方法页构造。
- 成功：返回一个 Agent-facing Runtime 状态。
- 错误：`AGENT_INPUT_INVALID`、`AGENT_INPUT_STALLED`、`BINDING_INVALID`、`CASE_RUNTIME_TECHNICAL`
