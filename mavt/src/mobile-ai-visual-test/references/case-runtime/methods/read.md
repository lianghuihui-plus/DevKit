# CaseRuntime.read

按原样引用读取一个资源。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
read({ ref: string })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `ref` | 是 | `string` | 当前绑定发布的资源引用 |

## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`resourceRef`、`resourceType`。
- 主数据：`$resourceType`。
- 关联资源：$declaredResources。

## 幂等性

Read-only.

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`RESOURCE_UNKNOWN`](../errors/transport.md#error-resource-unknown)
- [`RESOURCE_SCOPE_MISMATCH`](../errors/transport.md#error-resource-scope-mismatch)
- [`RESOURCE_INTEGRITY_INVALID`](../errors/runtime.md#error-resource-integrity-invalid)
- [`RESOURCE_FORMAT_UNSUPPORTED`](../errors/runtime.md#error-resource-format-unsupported)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "read",
  "input": {
    "ref": "mavt:0123456789abcdef01234567:scene:scene-1"
  }
}
```
