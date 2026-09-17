# CaseRuntime.act

基于当前 Scene 执行一个 ActionRef，并采集新 Scene。

```typescript
act({ capability: "act", basedOnSceneRef: string, actionRef: string, input?: object, purpose: string, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"act"` | 固定为 act |
| `basedOnSceneRef` | 是 | `string` | 当前 Scene |
| `actionRef` | 是 | `string` | 控件、屏幕或视觉动作引用 |
| `purpose` | 是 | `string` | 业务动作目的 |
| `input` | 否/条件 | `object` | 动作类型对应输入 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 条件要求

- actionRef 对应动作所需 input 字段必须存在。

## 上下文校验

- ActionRef、动态输入或 Scene 无效时拒绝 effect；业务判断通过 inspect 和 recordResult 单独提交。

## 成功状态

- `SCENE`

## 副作用

- 最多投递一个设备动作
- 采集新 Scene

## 幂等性

已投递且结果未知的动作永不重放。

## 错误

- [`AGENT_INPUT_INVALID`](../errors.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors.md#error-binding-invalid)
- [`SCENE_CHANGED`](../errors.md#error-scene-changed)
- [`ACTION_NOT_AVAILABLE`](../errors.md#error-action-not-available)
- [`ACTION_INPUT_INVALID`](../errors.md#error-action-input-invalid)
- [`VISUAL_INSPECTION_REQUIRED`](../errors.md#error-visual-inspection-required)
- [`ACTION_OUTCOME_UNKNOWN`](../errors.md#error-action-outcome-unknown)
- [`CASE_RUNTIME_TECHNICAL`](../errors.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "act",
  "basedOnSceneRef": "scene-1",
  "actionRef": "button-1:tap",
  "purpose": "继续"
}
```
