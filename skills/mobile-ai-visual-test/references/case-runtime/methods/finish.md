# CaseRuntime.finish

从 CHECK ledger 收口并完成用例。

## 调用分支

```typescript
finish({ capability: "finish", summary: string, uncertainties?: string[], flowContext?: object })
finish({ capability: "finish", outcome: "NOT_RUN", reason: string, evidence: object, summary: string, uncertainties?: string[], flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"finish"` | 固定为 finish |
| `summary` | 是 | `string` | 最终摘要 |
| `uncertainties` | 否/条件 | `string[]` | 仍需披露的不确定性 |
| `outcome` | 否/条件 | `"NOT_RUN"` | 仅前置条件不满足时使用 NOT_RUN |
| `reason` | 否/条件 | `string` | NOT_RUN 的业务原因 |
| `evidence` | 否/条件 | `object` | NOT_RUN 引用的已登记 Scene 或技术事实 |
| `flowContext` | 否/条件 | `object` | 实际到达的 END 节点 |

## 上下文校验

- 正常收口由 Runtime 从 ledger 组装；全部 Baseline CHECK 和最终活跃补充 CHECK 必须已处置。
- WAIVED 与 NOT_APPLICABLE 不降低聚合后的 PASS；报告会单独披露豁免。
- FAIL、INCONCLUSIVE、BLOCKED 和 WAIVED 不强制知识调查；已提交的证据引用仍必须有效。
- NOT_RUN 必须提供原因和已登记证据。

## 成功状态

- `COMPLETED`
- `RESULT_INCOMPLETE`

## 副作用

- 就绪后持久化最终结果

## 幂等性

复用现有可恢复 finish 事务。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`CASE_FLOW_REQUIRED`](../errors/flow-result.md#error-case-flow-required)
- [`CASE_RESULT_INCOMPLETE`](../errors/flow-result.md#error-case-result-incomplete)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "finish",
  "summary": "验证完成"
}
```
