# Coordinator 资源目录

资源引用来自 `data.ref`、`resources[].ref` 或明确标注的资源字段；原样传给返回该引用的绑定 Facade：

```json
{
  "operation": "read",
  "input": {
    "ref": "mavt:0123456789abcdef01234567:runDecision:published-identity"
  }
}
```

读取返回完整主数据 `data`，关联复杂数据仍为 `resources` 中的类型化引用；不截断、抽样或内联复制关联资源。`$resourceType` 表示所读资源类型，`$declaredResources` 表示该资源声明的关联资源。引用不可拼接、跨作用域使用或替换为流程节点、边和操作 ID。

| 类型 | 内容 |
|---|---|
| `runDecision` | 当前环境、设备或绑定决策的不可变完整投影。 |
| `caseDispatch` | 不可变 Handoff 绑定的独立 Case Agent 启动信息。 |
| `runProgress` | 当前等待对象与已持久化进度事实的不可变快照。 |
| `runSummary` | 首次终态与报告发布结果的不可变快照。 |
| `coordinatorDiagnostic` | 当前运行已持久化诊断事实。 |

错误中的 `documentationRef` 和 `operationDocumentationRef` 是静态文档路径，使用宿主文件读取能力打开，不传给 `read`。
