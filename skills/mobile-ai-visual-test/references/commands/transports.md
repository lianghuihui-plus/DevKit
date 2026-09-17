# 预绑定 Transport

Transport 命令由框架生成并绑定当前状态。Agent 原样执行，只构造文档明确要求的业务输入。

## Coordinator.prepareCommand

执行协调 Agent 用于创建 Coordinator run 的直接 Facade 启动命令。

- 输入：只传 workspace 和用户选择的 caseNos。
- 调用：从 Workspace 返回的绝对 coordinatorFacade.command 启动；参数名按 prepareRun 方法页和 Skill 入口构造。
- 成功：返回 NEED_USER_CONFIRMATION 或明确错误。
- 错误：`COORDINATOR_INPUT_INVALID`、`COORDINATOR_TECHNICAL`

## Coordinator.coordinatorCommands

Coordinator 响应中的 confirm、advance 和 cancel 预绑定命令。

- 输入：confirm/cancel 请求写入响应给出的 requestPath；advance 不附加输入。
- 调用：命令由 Coordinator 生成，Agent 必须原样执行，不增删 --state 或其他参数。
- 成功：返回一个 Agent-facing Coordinator 状态。
- 错误：`COORDINATOR_INPUT_INVALID`、`COORDINATOR_STATE_INVALID`、`COORDINATOR_TECHNICAL`

## Case Runtime.loaderCommand

Case Agent 用于领取唯一 execution Handoff 的预绑定 Loader。

- 输入：不附加输入。
- 调用：必须原样执行，不修改哈希、sequence、claim token 或路径。
- 成功：返回 Case Prompt、Case Brief 和预绑定 Runtime Client。
- 错误：`BINDING_INVALID`、`PROTOCOL_MISMATCH`

## Case Runtime.runtimeClient

当前 execution 的预绑定 Case Runtime Client。

- 输入：每轮按 Brief 指示通过 requestPath 或 stdin 提交一个方法请求。
- 调用：必须原样使用命令绑定；业务字段只按当前方法页构造。
- 成功：返回一个 Agent-facing Runtime 状态。
- 错误：`AGENT_INPUT_INVALID`、`AGENT_INPUT_STALLED`、`BINDING_INVALID`、`CASE_RUNTIME_TECHNICAL`
