# Agent Runtime

Agent Runtime 把批次协调和单用例视觉执行隔离开。它由两个明确部分组成：仓库内可执行的 Runtime Core，以及 Agent 平台提供的薄 Host Adapter。Core 持有全部状态、契约和校验；Host Adapter 只把结构化操作映射到平台会话能力。

## Runtime Core

正式入口：

```bash
scripts/agent-runtime.js init <case-dir> --platform <platform> --execution-id <id> --provider codex --workspace-cwd <workspace>
scripts/agent-runtime.js next <case-dir> --platform <platform> --execution-id <id>
scripts/agent-runtime.js apply <case-dir> --platform <platform> --execution-id <id> --operation-result-json '<json>'
scripts/agent-runtime.js status <case-dir> --platform <platform> --execution-id <id>
scripts/agent-runtime.js interrupt <case-dir> --platform <platform> --execution-id <id> --reason '<reason>'
```

`init` 固化以下产物：

```text
<execution>/agent/
  contract.json
  request.json
  runtime.json
  response.json      # Host 返回后生成
  validation.json    # 结果校验后生成
  turns/*.draft.json # 单轮事实提交中断时临时保留，成功后删除
```

Runtime 状态只允许按下列方向推进：

```text
PREPARED
  -> SESSION_OPENING
  -> SESSION_RUNNING
  -> AWAITING_RESULT -> RESULT_RECEIVED -> VALIDATING -> VALIDATED
  -> RELEASING -> COMPLETED
```

持有 session 的创建后失败、等待失败、校验失败或超时必须经过 `INTERRUPTING -> RELEASING`，释放后才能进入 `FAILED`、`INTERRUPTED` 或 `TIMED_OUT`。`VALIDATING` 可重入；`next` 对同一待执行操作幂等，未 `apply` 前重复调用返回相同 operationId。释放失败最多产生三次 `RELEASE_SESSION`，仍未确认时进入 `RELEASE_FAILED`，批次必须阻塞而不能继续下一个 case。

所有 Runtime 终态都写 `validation.json`。Agent 结果校验通过时 `valid=true`；创建失败、中断、超时或结果无效时 `valid=false` 并保留对应 failureCode。未取得 session 的失败直接记录无会话可释放的终态时间，取得 session 后仍必须先中断和释放。

## 统一 Host Adapter 契约

Core 只会产生四种需要平台执行的操作：

- `OPEN_SESSION`：创建不继承业务对话的单 case 会话，并把 `requestPath` 作为唯一业务输入。
- `AWAIT_RESULT`：等待该会话返回结构化 CaseAgentResult。
- `INTERRUPT_SESSION`：异常时中断指定会话。
- `RELEASE_SESSION`：结果校验通过后释放会话句柄。

Host Adapter 输入是 `next.operation`，输出统一为：

```json
{
  "operationId": "runtime-operation-001",
  "ok": true,
  "sessionId": "host-session-id",
  "result": {}
}
```

不同 operation 只填写相关字段。`AWAIT_RESULT` 同时携带 `deadlineAt` 和 `remainingMs`，Host Adapter 必须执行硬等待上限。平台错误通过 `ok=false` 和 `reason` 返回，超时通过 `timedOut=true` 返回；Host Adapter 不能直接改写 runtime.json、timeline 或结果文件。运行时契约由 `scripts/lib/agent-runtime-contract.js` 和 `scripts/agent-runtime.js` 唯一校验。

这就是统一的 AgentRuntimeProvider 边界：Provider 不是仓库中一个假定可直接调用宿主工具的 JavaScript 类，而是“Runtime Core 操作协议 + 平台 Host Adapter”。新增平台只实现这四种操作的映射，Core 不变。

## 执行契约冻结

`run-case.js --start` 同时写入：

- `case.snapshot.json`：本 execution 的完整 case 契约。
- `execution.json.sourceSha1`。
- `execution.json.caseContractSha`。
- `execution.json.preconditionPlanSha`。

后续 reducer、事实写入、Agent request、finalize 和结果校验都读取 snapshot。源 `case.json` 在执行中变化，只会让报告变为过期，不会改变当前 execution。

CaseAgentRequest 带 Runtime Core 固化的规范 provider 和 `requestSha`。SkillContract 用 `protocolSha` 冻结角色规范文件，用 `implementationSha` 冻结实际运行脚本；Agent Runtime 的 `BOUND` 事实同时绑定 `provider + protocolSha + implementationSha + requestSha + sessionId`。provider 只允许在 Runtime 初始化入口输入一次，子 Agent 结果构造器从 request 读取，不能覆盖。`BOUND` 必须先于子 Agent 业务事实；相同绑定可幂等重放，不同绑定被拒绝。

`run-case --start` 在 Runtime 初始化前写入的 `executionStart`、`environmentProbe` 和 `scope=execution-bootstrap` 的 `restartApp actionResult` 属于启动事实。Runtime init 会拒绝除此以外的既有事实，BOUND 写入后才允许 Case Engine 产生前置条件和业务步骤事实。

## 角色所有权

批次协调器只使用 `batch-coordinator` SkillContract，负责 resolve、parse、环境、preflight、start、Runtime Core 操作往返、结果验证和串行推进。

单 case Agent 只使用 `case-executor` SkillContract。它完整读取 contract 中的 `requiredResources`，只能调用白名单入口；不能调用 Agent Runtime 写入器、结果验证器、批次入口或直接 run-case。

## 批次闭环

`scripts/batch-runtime.js` 在 `<workspace>/runs/<batchId>/` 写 `contract.json`、`batch.json` 和 `events.jsonl`。`commit-current` 自己读取绑定 runtime、validation、execution、result 和 metrics，确认 session 已释放后生成 `completion.json`：校验有效时发布业务结论，校验无效时发布控制面 `BLOCKED`，随后刷新 state、CONTEXT 和 index。它不接收调用方传入的 validation JSON。start 阶段由框架直接收尾的 execution 使用 `commit-start-result`。

`reconcile-current` 是批次开始时的一次性恢复归约，不是轮询监控。它先处理批次终态和精确所有权；多个未完成 execution 直接判为损坏，其他 batch 的 FINALIZING 也不得接管。`BATCH_BLOCKED`、`BATCH_COMPLETE` 和已提交 case 可安全重复查询。

批次必须串行。设备前台状态和单 active execution 约束高于宿主平台的并发能力。
