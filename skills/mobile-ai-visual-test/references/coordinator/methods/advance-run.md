# Coordinator.advanceRun

推进或恢复当前 run 的确定性状态机。

```typescript
advanceRun({ capability: "advanceRun" })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"advanceRun"` | 固定为 advanceRun |

## 成功状态

- `NEED_USER_CONFIRMATION`
- `NEED_CASE_AGENT`
- `WAITING`
- `TECHNICAL`
- `COMPLETE`
- `BLOCKED`

## 副作用

- 推进当前 run

## 幂等性

持久化状态机恢复同一阶段；长进程不得重复启动。

## 错误

- [`COORDINATOR_INPUT_INVALID`](../errors/input-state.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors/input-state.md#error-coordinator-state-invalid)
- [`ENVIRONMENT_NOT_READY`](../errors/environment.md#error-environment-not-ready)
- [`PLATFORM_UNAVAILABLE`](../errors/environment.md#error-platform-unavailable)
- [`BATCH_BLOCKED`](../errors/batch.md#error-batch-blocked)
- [`COORDINATOR_TECHNICAL`](../errors/batch.md#error-coordinator-technical)

## 最小示例

```json
{
  "capability": "advanceRun"
}
```
