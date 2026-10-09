# CaseRuntime.useCapability

调用当前冻结目录中的一项外部能力。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
useCapability({ capabilityRef: string, input: object, purpose: string, flowContext?: object })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `capabilityRef` | 是 | `string` | queryCapabilities 返回并可通过 read 查看完整 definition 的引用 |
| `input` | 是 | `object` | 严格符合冻结 inputSchema 的能力输入 |
| `purpose` | 是 | `string` | 本次调用的业务目的 |
| `flowContext` | 否/条件 | `object` | 当前 Case Flow 节点和可选分支选择 |

## 结构字段

```typescript
input.flowContext: { nodeRef: string; selectedEdgeRef?: string }
```

## 上下文校验

- 先调用 queryCapabilities，再读取所选 capabilityRef 的 definition；不拼接引用。

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`capabilityName`、`invocationRef`。
- 主数据：`capabilityInvocation`。
- 关联资源：`technicalFact`。

## 副作用

- 调用所选能力实现；外部修改持续存在
- 追加调用事件并保存脱敏 invocation 资源

## 幂等性

不自动重试；每次请求都是独立调用，UNKNOWN 禁止盲目重放。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`CAPABILITY_UNKNOWN`](../errors/capability.md#error-capability-unknown)
- [`CAPABILITY_SCOPE_MISMATCH`](../errors/capability.md#error-capability-scope-mismatch)
- [`CAPABILITY_INPUT_INVALID`](../errors/capability.md#error-capability-input-invalid)
- [`CAPABILITY_EXECUTION_FAILED`](../errors/capability.md#error-capability-execution-failed)
- [`CAPABILITY_OUTCOME_UNKNOWN`](../errors/capability.md#error-capability-outcome-unknown)
- [`CASE_RUNTIME_FINALIZED`](../errors/transport.md#error-case-runtime-finalized)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "useCapability",
  "input": {
    "capabilityRef": "mavt:0123456789abcdef01234567:capabilityDefinition:definition-1",
    "input": {},
    "purpose": "建立用例所需的服务器状态"
  }
}
```
