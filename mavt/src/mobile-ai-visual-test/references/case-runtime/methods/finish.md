# CaseRuntime.finish

从 CHECK ledger 收口并完成用例。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

## 调用分支

```typescript
finish({ mode: "complete", summary: string, uncertainties?: string[], flowContext?: object, finalReview?: object })
finish({ mode: "notRun", reason: string, evidence: object, summary: string, uncertainties?: string[], flowContext?: object, finalReview?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `mode` | 是 | `"complete" \| "notRun"` | complete 或 notRun |
| `summary` | 是 | `string` | 最终摘要 |
| `uncertainties` | 否/条件 | `string[]` | 仍需披露的不确定性 |
| `finalReview` | 否/条件 | `object` | 首次复核响应后必填：最新 token、Agent 明确 verdict、确认完整原文覆盖 sourceCoverageConfirmed:true。 |
| `reason` | 否/条件 | `string` | NOT_RUN 的业务原因 |
| `evidence` | 否/条件 | `object` | NOT_RUN 引用的已登记 Scene 或技术事实 |
| `flowContext` | 否/条件 | `object` | 实际到达的 END 节点 |

## 结构字段

```typescript
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
input.finalReview: { token: string; verdict: "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE" | "NOT_RUN"; sourceCoverageConfirmed: true }
input.evidence: { sceneRefs: Array<string>; technicalRefs: Array<string> }
```

## 上下文校验

- 正常收口由 Runtime 从 ledger 组装；全部 Baseline CHECK 和最终活跃补充 CHECK 必须已处置。
- 首次满足收口条件的 finish 要求原文复核；重复原请求不能代替确认。Agent 复核后提交 finalReview，token 必须绑定最新原文、Flow、结果和待处理修正，verdict 须与 ledger 聚合一致。
- recordResult 被拒绝时没有写入；必须成功重提交对应 CHECK 后才能 finish。读资源或重排路线不会解除待处理修正。
- WAIVED 与 NOT_APPLICABLE 不降低聚合后的 PASS；报告会单独披露豁免。
- 出现预期不符、操作无效果、异常反复、原因不明或无法形成可靠判断时，优先并尽早完成知识调查。只有问题已由现场证据或明确技术事实完整解释，且知识不会影响下一步或结论时才不查询；无适用候选仍按现场证据处置。
- NOT_RUN 必须提供原因和已登记证据。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`executionId`、`verdict`、`caseResultRef`、`idempotent`、`finalReviewRequired`、`finalReviewInstruction`、`originalCase`、`finalReviewToken`、`ledgerVerdict`、`pendingCheckNodeRefs`。
- 主数据：无。
- 关联资源：`caseResult`、`checkpointLedger`、`technicalFact`。

## 副作用

- 就绪后持久化最终结果

## 幂等性

复用现有可恢复 finish 事务。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`CASE_FLOW_REQUIRED`](../errors/flow-result.md#error-case-flow-required)
- [`CASE_RESULT_INCOMPLETE`](../errors/flow-result.md#error-case-result-incomplete)
- [`CASE_FINAL_REVIEW_REQUIRED`](../errors/flow-result.md#error-case-final-review-required)
- [`RESULT_CORRECTION_REQUIRED`](../errors/flow-result.md#error-result-correction-required)
- [`CASE_FINAL_VERDICT_MISMATCH`](../errors/flow-result.md#error-case-final-verdict-mismatch)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{"operation":"finish","input":{"mode":"complete","summary":"验证完成"}}
```

```json
{"operation":"finish","input":{"mode":"notRun","reason":"必要执行条件无法在当前 execution 内建立且没有安全继续路径","summary":"未运行","evidence":{"sceneRefs":["mavt:0123456789abcdef01234567:scene:scene-1"],"technicalRefs":[]}}}
```

```json
{"operation":"finish","input":{"mode":"complete","summary":"原文时序检查未满足","finalReview":{"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","verdict":"FAIL","sourceCoverageConfirmed":true}}}
```
