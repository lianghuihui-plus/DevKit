# CaseRuntime.knowledge

查询知识，或登记指定 query 的候选复核结果。

```typescript
knowledge({ capability: "knowledge", basedOnSceneRef: string, query?: string, expectationRefs?: string[], queryId?: string, conclusion?: "APPLICABLE_FOUND" | "NO_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT", assessments?: object[] })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"knowledge"` | 固定为 knowledge |
| `basedOnSceneRef` | 是 | `string` | 当前 Scene |
| `query` | 否/条件 | `string` | 待调查问题 |
| `queryId` | 否/条件 | `string` | 已有查询引用 |
| `expectationRefs` | 否/条件 | `string[]` | 相关验证点 |
| `conclusion` | 否/条件 | `"APPLICABLE_FOUND" | "NO_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT"` | 候选复核结论 |
| `assessments` | 否/条件 | `object[]` | 逐候选适用性判断 |

## 条件要求

- query 与 queryId 两种模式互斥。

## 上下文校验

- 复核必须覆盖当前 query 候选约束。

## 成功状态

- `KNOWLEDGE`
- `KNOWLEDGE_REVIEWED`

## 副作用

- 保存查询或复核事件

## 幂等性

重复 queryId 复核按内部事件规则处理。

## 错误

- [`AGENT_INPUT_INVALID`](../errors.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors.md#error-binding-invalid)
- [`SCENE_REQUIRED`](../errors.md#error-scene-required)
- [`KNOWLEDGE_QUERY_UNKNOWN`](../errors.md#error-knowledge-query-unknown)
- [`KNOWLEDGE_REVIEW_INVALID`](../errors.md#error-knowledge-review-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "knowledge",
  "basedOnSceneRef": "scene-1",
  "query": "解释当前异常"
}
```
