# Coordinator.advanceRun

推进当前确定性状态机。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
advanceRun({  })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|


## 成功状态

- `SUCCEEDED`

### 成功 / outcome=NEED_USER_CONFIRMATION

- 简单结果：`outcome`、`phase`、`command`。
- 主数据：`runDecision`。
- 关联资源：`coordinatorDiagnostic`。

### 成功 / outcome=CONFIRMED

- 简单结果：`outcome`、`phase`、`command`。
- 主数据：无。
- 关联资源：无。

### 成功 / outcome=NEED_CASE_AGENT

- 简单结果：`outcome`、`phase`、`command`、`caseNo`。
- 主数据：`caseDispatch`。
- 关联资源：无。

### 成功 / outcome=WAITING

- 简单结果：`outcome`、`phase`、`command`、`waitFor`、`caseNo`。
- 主数据：`runProgress`。
- 关联资源：`coordinatorDiagnostic`。

### 成功 / outcome=COMPLETE

- 简单结果：`outcome`、`phase`、`command`、`reportStatus`。
- 主数据：`runSummary`。
- 关联资源：`coordinatorDiagnostic`。

### 成功 / outcome=BLOCKED

- 简单结果：`outcome`、`phase`、`command`、`reportStatus`。
- 主数据：`runSummary`。
- 关联资源：`coordinatorDiagnostic`。

## 副作用

- 保存当前 run 的确定性进度

## 幂等性

advanceRun/cancelRun 终态复用原 runSummary；confirmRun 终态拒绝。

## 错误

- [`AGENT_INPUT_STALLED`](../errors/input-state.md#error-agent-input-stalled)
- [`COORDINATOR_INPUT_INVALID`](../errors/input-state.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors/input-state.md#error-coordinator-state-invalid)
- [`COORDINATOR_TERMINAL`](../errors/input-state.md#error-coordinator-terminal)
- [`DECISION_NOT_ALLOWED`](../errors/input-state.md#error-decision-not-allowed)
- [`ENVIRONMENT_NOT_READY`](../errors/environment.md#error-environment-not-ready)
- [`IOS_SIGNING_REQUIRED`](../errors/environment.md#error-ios-signing-required)
- [`INPUT_CAPABILITY_NOT_READY`](../errors/environment.md#error-input-capability-not-ready)
- [`PLATFORM_UNAVAILABLE`](../errors/environment.md#error-platform-unavailable)
- [`BATCH_BLOCKED`](../errors/batch.md#error-batch-blocked)
- [`COORDINATOR_TECHNICAL`](../errors/batch.md#error-coordinator-technical)
- [`RESOURCE_UNKNOWN`](../errors/resources.md#error-resource-unknown)
- [`RESOURCE_SCOPE_MISMATCH`](../errors/resources.md#error-resource-scope-mismatch)
- [`RESOURCE_INTEGRITY_INVALID`](../errors/resources.md#error-resource-integrity-invalid)

## 最小示例

```json
{
  "operation": "advanceRun",
  "input": {}
}
```
