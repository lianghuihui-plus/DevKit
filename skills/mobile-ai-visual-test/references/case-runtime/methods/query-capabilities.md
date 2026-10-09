# CaseRuntime.queryCapabilities

查询并冻结当前 execution 可用的外部能力目录。

签名参数是规范请求的 `input`；外壳固定为 `{operation,input}`。

```typescript
queryCapabilities({  })
```

## 参数

| 参数 | 必填 | 类型 | 含义 |
|---|---|---|---|


## 成功状态

- `SUCCEEDED`

### 成功

- 简单结果：`outcome`、`catalogRef`、`availableCount`。
- 主数据：`capabilityCatalog`。
- 关联资源：`capabilityDefinition`。

## 副作用

- 首次查询冻结能力目录并追加目录事件

## 幂等性

首次查询后始终读取同一冻结目录，不再探测能力实现。

## 错误

- [`AGENT_INPUT_INVALID`](../errors/transport.md#error-agent-input-invalid)
- [`BINDING_INVALID`](../errors/transport.md#error-binding-invalid)
- [`CASE_RUNTIME_TECHNICAL`](../errors/knowledge-recovery.md#error-case-runtime-technical)

## 最小示例

```json
{
  "operation": "queryCapabilities",
  "input": {}
}
```
