# Coordinator.prepareRun

为指定工作空间和用例创建一次 Coordinator run。

```typescript
prepareRun({ capability: "prepareRun", workspace: string, caseNos: string[] })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"prepareRun"` | 固定为 prepareRun |
| `workspace` | 是 | `string` | 测试工作空间绝对路径 |
| `caseNos` | 是 | `string[]` | 按用户顺序给出的用例编号 |

## 成功状态

- `NEED_USER_CONFIRMATION`

## 副作用

- 创建 Coordinator run 状态

## 幂等性

不保证自动复用相同输入的旧 run。

## 错误

- [`COORDINATOR_INPUT_INVALID`](../errors/input-state.md#error-coordinator-input-invalid)
- [`COORDINATOR_STATE_INVALID`](../errors/input-state.md#error-coordinator-state-invalid)
- [`COORDINATOR_TECHNICAL`](../errors/batch.md#error-coordinator-technical)

## 最小示例

```json
{
  "capability": "prepareRun",
  "workspace": "/absolute/test-workspace",
  "caseNos": [
    "014"
  ]
}
```
