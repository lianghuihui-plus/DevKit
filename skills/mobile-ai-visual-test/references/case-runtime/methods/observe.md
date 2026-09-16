# CaseRuntime.observe

采集一个新 Scene，不执行业务动作。

```typescript
observe({ capability: "observe", basedOnSceneRef?: string, purpose?: string, expectationRefs?: string[], updates?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"observe"` | 固定为 observe |
| `basedOnSceneRef` | 否/条件 | `string` | 更新所依据的 Scene |
| `purpose` | 否/条件 | `string` | 本次观察目的 |
| `expectationRefs` | 否/条件 | `string[]` | 本次决策直接推进的验证点 |
| `updates` | 否/条件 | `object` | 随观察提交的已形成判断 |

## 条件要求

- 已有 Scene 且携带 updates 时必须提供 basedOnSceneRef。

## 上下文校验

- updates 绑定旧 Scene，新 Scene 在更新落盘后采集。

## 成功状态

- `READY`

## 副作用

- 保存有效 updates
- 采集一个新 Scene

## 幂等性

Updates 按 submission 幂等；恢复时复用已关联的新 Scene。

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
