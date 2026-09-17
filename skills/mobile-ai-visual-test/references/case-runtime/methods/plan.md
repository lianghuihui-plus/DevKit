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

## 上下文校验

- 语义不变的节点和边保留 ref；retired ref 不得复用。

## 成功状态

- `CASE_FLOW_RECORDED`

## 副作用

- 追加 Case Flow revision

## 幂等性

相同 submission 只写一次 revision。

## 错误

- [`AGENT_INPUT_INVALID`](../errors.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors.md#error-binding-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors.md#error-case-runtime-technical)

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
        "sourceBasis": "原始用例预期"
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
