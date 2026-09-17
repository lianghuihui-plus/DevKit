# CaseRuntime.inspect

登记视觉事实，或按需读取 elements 或 layout。

```typescript
inspect({ capability: "inspect", basedOnSceneRef: string, channel: "visual" | "action" | "elements" | "layout", observation?: string, checkNodeRefs?: string[], flowContext?: object, filter?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"inspect"` | 固定为 inspect |
| `basedOnSceneRef` | 是 | `string` | 被检查的 Scene |
| `channel` | 是 | `"visual" | "action" | "elements" | "layout"` | 检查通道 |
| `observation` | 否/条件 | `string` | visual/action 通道看到的事实 |
| `checkNodeRefs` | 否/条件 | `string[]` | 相关 CHECK 节点 |
| `filter` | 否/条件 | `object` | elements 过滤器 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 条件要求

- visual/action 必须提供 observation。

## 上下文校验

- 历史 Scene 可登记事实；读取通道只返回所请求投影。

## 成功状态

- `VISUAL_INSPECTED`
- `ACTION_SPATIAL_INSPECTED`
- `SCENE_INSPECTION`

## 副作用

- visual/action 追加事实事件

## 幂等性

相同 submission 不重复追加事实。

## 错误

- [`AGENT_INPUT_INVALID`](../errors.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors.md#error-binding-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "inspect",
  "basedOnSceneRef": "scene-1",
  "channel": "elements"
}
```
