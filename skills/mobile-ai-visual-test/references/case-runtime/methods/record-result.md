# CaseRuntime.recordResult

独立记录验证点结果，不采集 Scene、不执行动作。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
recordResult({ results: object[] })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `results` | 是 | `object[]` | 已形成判断的验证结果和证据引用 |

## 结构字段

```typescript
input.results: Array<{ checkNodeRef: string; status: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED" | "NOT_APPLICABLE" | "WAIVED"; actual: string; reason?: string; evidence?: { sceneRefs?: Array<string>; knowledgeRefs?: Array<string>; technicalRefs?: Array<string>; searchAbsence?: { sceneRef: string; scrollContextRef: string } } }>
```

## 条件要求

- WAIVED 必须提供独立非空 reason；其他状态不得提供 reason。
- NOT_APPLICABLE 只允许用于 CONDITIONAL 检查点。

## 上下文校验

- 所有结果先完整校验；任一结果无效时整批不写入。
- Baseline CHECK 始终可处置；补充 CHECK 仅在最终 Working Flow 中活跃时进入结束闭环。
- 知识、Scene 和技术事实可支撑豁免，但 Runtime 不要求知识命中，也不判断豁免理由是否充分。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`recordedResultRefs`、`idempotentCheckNodeIds`。
- 主数据：无。
- 关联资源：`checkpointResult`、`checkpointLedger`。

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
  "operation": "recordResult",
  "input": {
    "results": [
      {
        "checkNodeRef": "N1",
        "status": "PASS",
        "actual": "目标结果可见",
        "evidence": {
          "sceneRefs": [
            "mavt:0123456789abcdef01234567:scene:scene-1"
          ]
        }
      }
    ]
  }
}
```
