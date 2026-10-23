# Coordinator

协议：`agent-facing`。启动时读取本索引；字段不足时读取对应方法页。

响应的 `documentationRef`、`operationDocumentationRef` 按本次绑定的绝对 `documentationRoot` 解析；Markdown 相对链接按所在文档目录解析。旧 Run 使用原固定副本的文档。文档路径不传给资源 `read`。

## 请求与响应

- MCP 调用提交 `{contextRef,input}`；签名内参数属于 `input`，空输入使用 `{}`。方法页的 `{operation,input}` 示例用于说明业务参数：工具名决定 operation，MCP 不传该字段；读取 `structuredContent` 的领域响应。
- 响应为 `{protocol,status,operation,result,resources,data?,error?}`。状态：`SUCCEEDED`、`REJECTED`、`FAILED`、`UNKNOWN`；业务状态在 `result.outcome`。
- `result` 只含简单事实；主复杂结果完整放入 `data`，关联复杂数据只在 `resources` 发布引用，按需 `read({ref})`。
- ref 原样复制；不能从路径、ID 或文字拼装。输入错误同时读取 `error.documentationRef` 与 `error.operationDocumentationRef`；其他错误读取前者。
- MCP mavt_run_prepare。提交 {contextRef,input}；input 只包含 caseNos。使用 workspace 绑定引用，成功后保留返回的 Run 引用。
- 绑定 Run 的 MCP 工具。confirmRun、advanceRun、cancelRun、read 分别调用 mavt_run_confirm/advance/cancel/read。提交 {contextRef,input}，原样复用该 Run 的 contextRef。

## 方法

| 方法 | 用途 | 紧凑签名 |
|---|---|---|
| [`prepareRun`](coordinator/methods/prepare-run.md) | 在绑定工作空间中创建一次 run。 | `prepareRun({ caseNos: string[] })` |
| [`confirmRun`](coordinator/methods/confirm-run.md) | 确认当前环境、选择平台设备或确认绑定。 | `confirmRun({ decision: "USE_CURRENT", userInstruction: string }) / confirmRun({ decision: "SELECT_PLATFORM", platform: "harmony" \| "android" \| "ios", deviceId?: string, appId?: string, appName?: string }) / confirmRun({ decision: "SELECT_APP", appId: string }) / confirmRun({ decision: "SELECT_ENVIRONMENT_OPTION", optionId: string }) / confirmRun({ decision: "RETRY_ENVIRONMENT" }) / confirmRun({ decision: "CONFIRM_ENVIRONMENT", environmentRef: string, userInstruction: string }) / confirmRun({ decision: "CONFIRM_BINDING", userInstruction: string, binding: object })` |
| [`advanceRun`](coordinator/methods/advance-run.md) | 推进当前确定性状态机。 | `advanceRun({  })` |
| [`cancelRun`](coordinator/methods/cancel-run.md) | 按用户要求取消当前 run。 | `cancelRun({ reason: string })` |
| [`read`](coordinator/methods/read.md) | 完整读取当前 run 已发布的不可变资源。 | `read({ ref: string })` |

## 参数来源

- 用例、平台和设备选择来自 Coordinator 响应或当前用户输入。

## 按需文档

- [资源目录](coordinator/resources.md)
- [错误目录](coordinator/errors.md)
