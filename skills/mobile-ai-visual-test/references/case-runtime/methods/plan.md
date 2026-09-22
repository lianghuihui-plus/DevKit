# CaseRuntime.plan

创建或修订完整 Case Flow。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
plan({ caseFlow: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `caseFlow` | 是 | `object` | 完整 Case Flow 快照 |

## 结构字段

```typescript
input.caseFlow: { baseRevision: number | null; summary: string; entryNodeRef: string; nodes: Array<{ ref: string; type: "ACTION"; text: string } | { ref: string; type: "DECISION"; text: string; sourceBasis: string } | { ref: string; type: "CHECK"; text: string; sourceBasis: string; verificationKind: "DIRECT_OBSERVATION" | "SEARCH_EXISTENCE"; requirement: "REQUIRED" } | { ref: string; type: "CHECK"; text: string; sourceBasis: string; verificationKind: "DIRECT_OBSERVATION" | "SEARCH_EXISTENCE"; requirement: "CONDITIONAL"; applicability: string } | { ref: string; type: "END"; text: string }>; edges: Array<{ ref: string; from: string; to: string; condition?: string }>; uncertainties: Array<string>; reason?: string }
```

## 条件要求

- 首次 baseRevision 为 null；修订时等于当前 revision 且 reason 必填。
- CHECK 必须声明 REQUIRED 或 CONDITIONAL；CONDITIONAL 必须提供 applicability。

## 上下文校验

- Baseline 节点和边不可改义；既有 CHECK 不可改义，现场适配或语义修正使用新 ref。
- 修订可改变 Working Flow 导航，但删除 Baseline CHECK 不会取消其最终处置责任。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`caseFlowRef`、`revision`、`idempotent`、`retiredNodeIds`、`retiredEdgeIds`、`invalidatedResultRefs`。
- 主数据：无。
- 关联资源：`caseFlow`、`checkpointLedger`、`checkpointResult`。

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
  "operation": "plan",
  "input": {
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
}
```
