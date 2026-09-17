# CaseRuntime.recover

建立授权的 App 初始状态、重启恢复或登记框架外事实。

```typescript
recover({ capability: "recover", basedOnSceneRef?: string, reason: string, targetState?: "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL", externalAction?: object, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capability` | 是 | `"recover"` | 固定为 recover |
| `basedOnSceneRef` | 否/条件 | `string` | 重启恢复所依据的 Scene |
| `reason` | 是 | `string` | 恢复原因 |
| `targetState` | 否/条件 | `"APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL"` | 授权的目标 App 状态 |
| `externalAction` | 否/条件 | `object` | 已实际完成的框架外事实 |
| `flowContext` | 否/条件 | `object` | 异常发生时正在处理的 Case Flow 节点 |

## 条件要求

- targetState 与 externalAction 互斥。

## 上下文校验

- 有当前 Scene 的重启恢复必须绑定当前 Scene。

## 成功状态

- `SCENE`
- `EXTERNAL_ACTION_RECORDED`

## 副作用

- 执行授权恢复或保存外部事实

## 幂等性

由现有恢复事务保证。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`SCENE_CHANGED`](../errors/scene-action.md#error-scene-changed)
- [`APP_INITIAL_STATE_UNAVAILABLE`](../errors/knowledge-recovery.md#error-app-initial-state-unavailable)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "capability": "recover",
  "reason": "目标 App 无法继续交互"
}
```
