# CaseRuntime.observe

采集一个新 Scene，不执行业务动作。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
observe({ purpose?: string, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `purpose` | 否/条件 | `string` | 本次观察目的 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
```

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`sceneRef`。
- 主数据：`scene`。
- 关联资源：`screenshot`、`layout`、`elementSet`、`actionSpatialEvidence`、`technicalFact`。

## 副作用

- 采集一个新 Scene

## 幂等性

设备采集不重放未知 effect；重复 observe 生成新的现场事实。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "observe",
  "input": {}
}
```
