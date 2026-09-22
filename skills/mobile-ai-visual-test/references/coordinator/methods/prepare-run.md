# Coordinator.prepareRun

在绑定工作空间中创建一次 run。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
prepareRun({ caseNos: string[] })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `caseNos` | 是 | `string[]` | 用户指定的用例编号列表。 |

## 成功状态

- `SUCCEEDED`

### 成功 / outcome=NEED_USER_CONFIRMATION

- 简单结果：`outcome`、`phase`、`command`。
- 主数据：`runDecision`。
- 关联资源：`coordinatorDiagnostic`。

## 副作用

- 保存当前 run 的确定性进度

## 幂等性

创建新 run。

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
  "operation": "prepareRun",
  "input": {
    "caseNos": [
      "014"
    ]
  }
}
```
