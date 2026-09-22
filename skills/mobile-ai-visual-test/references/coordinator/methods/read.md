# Coordinator.read

完整读取当前 run 已发布的不可变资源。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
read({ ref: string })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `ref` | 是 | `string` | 原样复制当前绑定 Facade 返回的资源 ref；不能使用领域 ID 或文档路径。 |

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`resourceRef`、`resourceType`。
- 主数据：`$resourceType`。
- 关联资源：$declaredResources。

## 幂等性

只读，不推进状态。

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
  "operation": "read",
  "input": {
    "ref": "mavt:0123456789abcdef01234567:runDecision:published-identity"
  }
}
```
