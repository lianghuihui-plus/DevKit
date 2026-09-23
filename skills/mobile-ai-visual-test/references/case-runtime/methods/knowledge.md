# CaseRuntime.knowledge

查询知识，或登记指定 query 的候选复核结果。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

## 调用分支

```typescript
knowledge({ mode: "query", sceneRef: string, query: string, checkNodeRefs?: string[], flowContext?: object })
knowledge({ mode: "review", sceneRef: string, queryId: string, conclusion: "APPLICABLE_FOUND" | "NO_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT", assessments: object[], flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `mode` | 是 | `"query" \| "review"` | query 或 review |
| `sceneRef` | 是 | `string` | 当前 Scene |
| `query` | 否/条件 | `string` | 待调查问题 |
| `queryId` | 否/条件 | `string` | 已有查询引用 |
| `checkNodeRefs` | 否/条件 | `string[]` | 相关 CHECK 节点 |
| `conclusion` | 否/条件 | `"APPLICABLE_FOUND" \| "NO_APPLICABLE" \| "CONFLICTING" \| "INSUFFICIENT"` | 候选复核结论 |
| `assessments` | 否/条件 | `object[]` | 逐候选适用性判断 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
input.assessments: Array<{ entryId: string; status: "APPLICABLE" | "NOT_APPLICABLE" | "CONFLICTING" | "INSUFFICIENT"; reason: string }>
```

## 条件要求

- mode=query 和 mode=review 的字段不能混用。

## 上下文校验

- 复核必须覆盖当前 query 候选约束。
- 出现预期不符、操作无效果或异常反复，且平台、版本、账号、配置、条件适用性、同类异常处理方式或原文歧义可能影响下一步时，尽早使用 knowledge，不要等到结果收口。不存在这些外部依赖时不机械查询。

## 成功状态

- `SUCCEEDED`

### 成功 / mode=query

- 简单结果：`outcome`、`knowledgeQueryRef`、`candidateSetRef`、`candidateCount`、`reviewRequired`。
- 主数据：`candidateSet`。
- 关联资源：`knowledgeQuery`、`knowledgeDocument`。

### 成功 / mode=review

- 简单结果：`outcome`、`knowledgeQueryRef`、`knowledgeReviewRef`、`conclusion`、`idempotent`。
- 主数据：无。
- 关联资源：`knowledgeQuery`、`candidateSet`、`knowledgeReview`。

## 副作用

- 保存查询或复核事件

## 幂等性

重复 queryId 复核按内部事件规则处理。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`SCENE_REQUIRED`](../errors/scene-action.md#error-scene-required)
- [`KNOWLEDGE_QUERY_UNKNOWN`](../errors/knowledge-recovery.md#error-knowledge-query-unknown)
- [`KNOWLEDGE_REVIEW_INVALID`](../errors/knowledge-recovery.md#error-knowledge-review-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{"operation":"knowledge","input":{"mode":"query","sceneRef":"mavt:0123456789abcdef01234567:scene:scene-1","query":"解释当前异常"}}
```

```json
{"operation":"knowledge","input":{"mode":"review","sceneRef":"mavt:0123456789abcdef01234567:scene:scene-1","queryId":"query-1","conclusion":"NO_APPLICABLE","assessments":[]}}
```
