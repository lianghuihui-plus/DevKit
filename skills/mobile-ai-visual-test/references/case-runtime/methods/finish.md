# CaseRuntime.finish

从 expectation ledger 收口并完成用例。

```typescript
finish({ capability: "finish", summary: string, uncertainties?: string[] })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"finish"` | 固定为 finish |
| `summary` | 是 | `string` | 最终摘要 |
| `uncertainties` | 否/条件 | `string[]` | 仍需披露的不确定性 |

## 上下文校验

- 不接收 updates 或全量 checks；Runtime 从 ledger 组装并执行完整性校验。

## 成功状态

- `COMPLETED`
- `RESULT_INCOMPLETE`

## 副作用

- 就绪后持久化最终结果

## 幂等性

复用现有可恢复 finish 事务。

## 错误

- [`AGENT_INPUT_INVALID`](../errors.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors.md#error-binding-invalid)
- [`CASE_MODEL_REQUIRED`](../errors.md#error-case-model-required)
- [`CASE_RESULT_INCOMPLETE`](../errors.md#error-case-result-incomplete)
- [`CASE_RUNTIME_TECHNICAL`](../errors.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "finish",
  "summary": "验证完成"
}
```
