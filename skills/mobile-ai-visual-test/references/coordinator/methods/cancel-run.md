# Coordinator.cancelRun

仅在用户明确取消时停止当前 run。

```typescript
cancelRun({ capability: "cancelRun", reason: string })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"cancelRun"` | 固定为 cancelRun |
| `reason` | 是 | `string` | 用户取消原因 |

## 上下文校验

- 取消不覆盖已持久化 execution 结果。

## 成功状态

- `COMPLETE`
- `BLOCKED`

## 副作用

- 取消仍可取消的工作

## 幂等性

已终止 run 返回当前终态。

## 错误

- [`COORDINATOR_INPUT_INVALID`](../errors/input-state.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors/input-state.md#error-coordinator-state-invalid)
- [`COORDINATOR_TECHNICAL`](../errors/batch.md#error-coordinator-technical)

## 最小示例

```json
{
  "capability": "cancelRun",
  "reason": "用户取消测试"
}
```
