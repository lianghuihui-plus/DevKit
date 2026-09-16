# CaseRuntime.plan

单独创建或修订 Case Model。

```typescript
plan({ capability: "plan", caseModel: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"plan"` | 固定为 plan |
| `caseModel` | 是 | `object` | 完整 Case Model 快照 |

## 条件要求

- 首次 baseRevision 为 null；修订时等于当前 revision 且 reason 必填。

## 上下文校验

- 继续存在的验证点保留 ref；新验证点省略 ref。

## 成功状态

- `CASE_MODEL_RECORDED`

## 副作用

- 追加 Case Model revision

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
  "caseModel": {
    "baseRevision": null,
    "understanding": "验证目标",
    "preconditions": [],
    "verificationPoints": [
      {
        "text": "结果可见"
      }
    ],
    "items": [
      "观察并验证"
    ],
    "uncertainties": []
  }
}
```
