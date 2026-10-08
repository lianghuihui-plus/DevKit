# CaseRuntime.runSequence

连续执行已确定的动作、等待与采集。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
runSequence({ sceneRef: string, purpose: string, steps: Array<{ type: "act"; ... } | { type: "wait"; ... } | { type: "capture"; ... }>, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `sceneRef` | 是 | `string` | 当前 Scene |
| `purpose` | 是 | `string` | 动作序列的业务目的 |
| `steps` | 是 | `Array<{ type: "act"; ... } \| { type: "wait"; ... } \| { type: "capture"; ... }>` | 最多 12 个动作、等待或采集步骤 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.steps: Array<{ id: string; type: "act"; action: { ref: string; input?: { durationMs?: number; text?: string; mode?: "replace" | "append"; ms?: number } } | { type: "tap" | "doubleTap"; target: { point: Array<number> } } | { type: "longPress"; target: { point: Array<number> }; durationMs: number } | { type: "swipe"; target: { from: Array<number>; to: Array<number> } } } | { id: string; type: "wait"; ms: number } | { id: string; type: "capture"; mode: "SCREENSHOT_ONLY" | "FULL_SCENE"; purpose: string }>
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
```

## 条件要求

- 步骤 id 唯一；视觉动作坐标按 Scene 截图四边标尺填写 0 到 10000 的整数。

## 上下文校验

- 两个及以上动作已由当前证据完整确定、步骤间不需要视觉理解、业务判断或重新规划时，优先使用 runSequence。
- 动作后需要立即判断时使用 act；单动作后仍需按指定时机 wait 或 capture 时可以使用 runSequence。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`sequenceResultRef`、`sequenceId`、`sceneRef`、`idempotent`、`deliveryStatus`、`commandDeliveryKnown`。
- 主数据：`scene`。
- 关联资源：`sequenceResult`、`scene`、`screenshot`、`actionSpatialEvidence`、`technicalFact`。

## 副作用

- 按顺序投递动作
- 保存动作后截图并采集最终完整 Scene

## 幂等性

相同规范化请求返回已签名终态；未知动作结果永不重放。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`SCENE_CHANGED`](../errors/scene-action.md#error-scene-changed)
- [`SEQUENCE_INVALID`](../errors/sequence.md#error-sequence-invalid)
- [`SEQUENCE_STEP_FAILED`](../errors/sequence.md#error-sequence-step-failed)
- [`SEQUENCE_RECORD_INCOMPLETE`](../errors/sequence.md#error-sequence-record-incomplete)
- [`SEQUENCE_ACTION_OUTCOME_UNKNOWN`](../errors/sequence.md#error-sequence-action-outcome-unknown)
- [`SEQUENCE_ACTION_FAILED`](../errors/sequence.md#error-sequence-action-failed)
- [`SEQUENCE_CAPTURE_FAILED`](../errors/sequence.md#error-sequence-capture-failed)
- [`SEQUENCE_FINAL_CAPTURE_FAILED`](../errors/sequence.md#error-sequence-final-capture-failed)
- [`SEQUENCE_INTERRUPTED`](../errors/sequence.md#error-sequence-interrupted)
- [`SEQUENCE_TIMEOUT`](../errors/sequence.md#error-sequence-timeout)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "runSequence",
  "input": {
    "sceneRef": "mavt:0123456789abcdef01234567:scene:scene-1",
    "purpose": "完成短时交互",
    "steps": [
      {
        "id": "open",
        "type": "act",
        "action": {
          "ref": "button-1:tap"
        }
      },
      {
        "id": "confirm",
        "type": "act",
        "action": {
          "ref": "confirm-1:tap"
        }
      }
    ]
  }
}
```
