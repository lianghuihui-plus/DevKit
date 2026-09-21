# CaseRuntime.plan

创建或修订完整 Case Flow。

```typescript
plan({ capability: "plan", caseFlow: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"plan"` | 固定为 plan |
| `caseFlow` | 是 | `object` | 完整 Case Flow 快照 |

## 条件要求

- 首次 baseRevision 为 null；修订时等于当前 revision 且 reason 必填。
- CHECK 必须声明 REQUIRED 或 CONDITIONAL；CONDITIONAL 必须提供 applicability。

## 上下文校验

- 首次 revision 是只基于原始用例的 Baseline Flow，不写入当前 Scene 的现场适配。
- 提交首次 Flow 前完整阅读原始用例，结合后置的“若/如果/未出现则”等语句确定条件作用域。
- 原始用例允许某事实的不同取值分别进入正常路径时，该事实只建 DECISION；分支内验证建 CONDITIONAL CHECK，同一业务事实不得再建导致另一正常分支失败的 REQUIRED CHECK。
- 提交前逐条检查原始用例允许的正常 END 路径；任何正常 END 都不得天然要求某个 REQUIRED CHECK 为 FAIL 或依赖 WAIVED 才能收口。
- Baseline 节点和边不可改义；既有 CHECK 不可改义，现场适配或语义修正使用新 ref。
- 修订可改变 Working Flow 导航，但删除 Baseline CHECK 不会取消其最终处置责任。

## 成功状态

- `CASE_FLOW_RECORDED`

## 副作用

- 追加 Case Flow revision

## 幂等性

规范化后语义等价的 Case Flow 请求只写一次 revision，幂等键由框架内部派生。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`CASE_FLOW_REVISION_CONFLICT`](../errors/flow-result.md#error-case-flow-revision-conflict)
- [`CASE_FLOW_NODE_IDENTITY_CHANGED`](../errors/flow-result.md#error-case-flow-node-identity-changed)
- [`CASE_FLOW_EDGE_IDENTITY_CHANGED`](../errors/flow-result.md#error-case-flow-edge-identity-changed)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "plan",
  "caseFlow": {
    "baseRevision": null,
    "summary": "验证目标",
    "entryNodeRef": "N1",
    "nodes": [
      {
        "ref": "N1",
        "type": "CHECK",
        "text": "结果可见",
        "verificationKind": "DIRECT_OBSERVATION",
        "sourceBasis": "原始用例预期",
        "requirement": "REQUIRED"
      },
      {
        "ref": "N2",
        "type": "END",
        "text": "完成"
      }
    ],
    "edges": [
      {
        "ref": "L1",
        "from": "N1",
        "to": "N2"
      }
    ],
    "uncertainties": []
  }
}
```
