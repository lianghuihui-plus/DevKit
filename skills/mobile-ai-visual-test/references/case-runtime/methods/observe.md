# CaseRuntime.observe

采集一个新 Scene，不执行业务动作。

```typescript
observe({ capability: "observe", purpose?: string, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"observe"` | 固定为 observe |
| `purpose` | 否/条件 | `string` | 本次观察目的 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 成功状态

- `SCENE`

## 副作用

- 采集一个新 Scene

## 幂等性

设备采集不重放未知 effect；重复 observe 生成新的现场事实。

## 错误

- [`AGENT_INPUT_INVALID`](../errors.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors.md#error-binding-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "observe"
}
```
