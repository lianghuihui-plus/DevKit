# CaseRuntime.recordResult

独立记录验证点结果，不采集 Scene、不执行动作。

```typescript
recordResult({ capability: "recordResult", results: object[] })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"recordResult"` | 固定为 recordResult |
| `results` | 是 | `object[]` | 已形成判断的验证结果和证据引用 |

## 上下文校验

- 所有结果先完整校验；任一结果无效时整批不写入。

## 成功状态

- `RESULTS_RECORDED`

## 副作用

- 追加 expectation result 事件

## 幂等性

相同结果重复提交不追加重复事件。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`EXPECTATION_UNKNOWN`](../errors/flow-result.md#error-expectation-unknown)
- [`EVIDENCE_REFERENCE_INVALID`](../errors/flow-result.md#error-evidence-reference-invalid)
- [`RECORD_RESULT_INVALID`](../errors/flow-result.md#error-record-result-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "recordResult",
  "results": [
    {
      "checkNodeRef": "N1",
      "status": "PASS",
      "actual": "目标结果可见",
      "evidence": {
        "sceneRefs": [
          "scene-1"
        ]
      }
    }
  ]
}
```
