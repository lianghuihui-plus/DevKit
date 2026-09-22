# CaseRuntime.act

基于当前 Scene 执行一个 ActionRef，并采集新 Scene。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
act({ sceneRef: string, action: object | object | object | object, purpose?: string, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `sceneRef` | 是 | `string` | 当前 Scene |
| `action` | 是 | `object \| object \| object \| object` | 发布的 ActionRef 或 Agent 自主视觉坐标动作 |
| `purpose` | 否/条件 | `string` | 可选的业务动作目的 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.action: { ref: string; input?: { durationMs?: number; text?: string; mode?: "replace" | "append"; ms?: number } } | { type: "tap" | "doubleTap"; target: { point: Array<number> } } | { type: "longPress"; target: { point: Array<number> }; durationMs: number } | { type: "swipe"; target: { from: Array<number>; to: Array<number> } }
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
```

## 条件要求

- action.ref 与 action.type 互斥；ActionRef 所需 action.input 字段必须存在。

## 上下文校验

- ActionRef、动态输入或 Scene 无效时拒绝 effect；业务判断通过 inspect 和 recordResult 单独提交。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`operationId`、`deliveryStatus`、`commandDeliveryKnown`、`sceneRef`。
- 主数据：`scene`。
- 关联资源：`screenshot`、`layout`、`elementSet`、`actionSpatialEvidence`、`technicalFact`。

## 副作用

- 最多投递一个设备动作
- 采集新 Scene

## 幂等性

已投递且结果未知的动作永不重放。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`SCENE_CHANGED`](../errors/scene-action.md#error-scene-changed)
- [`ACTION_NOT_AVAILABLE`](../errors/scene-action.md#error-action-not-available)
- [`ACTION_INPUT_INVALID`](../errors/scene-action.md#error-action-input-invalid)
- [`VISUAL_INSPECTION_REQUIRED`](../errors/scene-action.md#error-visual-inspection-required)
- [`ACTION_OUTCOME_UNKNOWN`](../errors/scene-action.md#error-action-outcome-unknown)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "act",
  "input": {
    "sceneRef": "mavt:0123456789abcdef01234567:scene:scene-1",
    "action": {
      "ref": "button-1:tap"
    }
  }
}
```
