# CaseRuntime.inspect

登记 Agent 已观察到的视觉或动作事实。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

## 调用分支

```typescript
inspect({ mode: "visual", sceneRef: string, observation: string, checkNodeRefs?: string[], flowContext?: object })
inspect({ mode: "action", sceneRef: string, observation: string, checkNodeRefs?: string[], flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `sceneRef` | 是 | `string` | 被检查的 Scene |
| `mode` | 是 | `"visual" \| "action"` | visual 或 action |
| `observation` | 是 | `string` | 实际看到的事实 |
| `checkNodeRefs` | 否/条件 | `string[]` | 相关 CHECK 节点 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
```

## 条件要求

- visual/action 必须提供 observation。

## 上下文校验

- 历史 Scene 可登记事实；读取资源使用 read。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`sceneRef`、`inspectionId`、`checkNodeIds`。
- 主数据：无。
- 关联资源：`scene`、`screenshot`、`actionSpatialEvidence`。

## 副作用

- visual/action 追加事实事件

## 幂等性

相同 submission 不重复追加事实。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{"operation":"inspect","input":{"mode":"visual","sceneRef":"scene-1","observation":"目标按钮可见"}}
```

```json
{"operation":"inspect","input":{"mode":"action","sceneRef":"scene-1","observation":"上一动作标注落在目标内"}}
```
