# CaseRuntime.recover

建立授权的 App 初始状态、重启恢复或登记框架外事实。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

## 调用分支

```typescript
recover({ mode: "restart", sceneRef: string, reason: string, flowContext?: object })
recover({ mode: "prepare", reason: string, targetState: "APP_LOCAL_STATE_EMPTY" | "FRESH_INSTALL", flowContext?: object })
recover({ mode: "external", reason: string, externalAction: object, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `mode` | 是 | `"restart" \| "prepare" \| "external"` | restart、prepare 或 external |
| `sceneRef` | 否/条件 | `string` | 重启恢复所依据的 Scene |
| `reason` | 是 | `string` | 恢复原因 |
| `targetState` | 否/条件 | `"APP_LOCAL_STATE_EMPTY" \| "FRESH_INSTALL"` | 授权的目标 App 状态 |
| `externalAction` | 否/条件 | `object` | 已实际完成的框架外事实 |
| `flowContext` | 否/条件 | `object` | 异常发生时正在处理的 Case Flow 节点 |

## 结构字段

```typescript
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
input.externalAction: { summary: string; tool?: string }
```

## 条件要求

- targetState 与 externalAction 互斥。

## 上下文校验

- 有当前 Scene 的重启恢复必须绑定当前 Scene。

## 成功状态

- `SUCCEEDED`

### 成功 / mode=restart

- 简单结果：`outcome`、`sceneRef`、`preparationState`。
- 主数据：`scene`。
- 关联资源：`screenshot`、`layout`、`elementSet`、`technicalFact`。

### 成功 / mode=prepare

- 简单结果：`outcome`、`sceneRef`、`preparationState`。
- 主数据：`scene`。
- 关联资源：`screenshot`、`layout`、`elementSet`、`technicalFact`。

### 成功 / mode=external

- 简单结果：`outcome`、`externalActionDeclarationRef`、`verificationRequired`。
- 主数据：无。
- 关联资源：`externalActionDeclaration`、`technicalFact`。

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
{"operation":"recover","input":{"mode":"restart","sceneRef":"scene-1","reason":"目标 App 无法继续交互"}}
```

```json
{"operation":"recover","input":{"mode":"prepare","reason":"用例要求空本地状态","targetState":"APP_LOCAL_STATE_EMPTY"}}
```

```json
{"operation":"recover","input":{"mode":"external","reason":"登记已执行技术恢复","externalAction":{"summary":"已重启自动化服务"}}}
```
