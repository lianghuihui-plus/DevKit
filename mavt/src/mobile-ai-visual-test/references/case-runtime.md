# Case Runtime

协议：`agent-facing`。启动时读取本索引；字段不足时读取对应方法页。

响应的 `documentationRef`、`operationDocumentationRef` 按本次绑定的绝对 `documentationRoot` 解析；Markdown 相对链接按所在文档目录解析。旧 Run 使用原固定副本的文档。文档路径不传给资源 `read`。

## 请求与响应

- MCP 调用提交 `{contextRef,input}`；签名内参数属于 `input`，空输入使用 `{}`。方法页的 `{operation,input}` 示例用于说明业务参数：工具名决定 operation，MCP 不传该字段；读取 `structuredContent` 的领域响应。
- 响应为 `{protocol,status,operation,result,resources,data?,error?}`。状态：`SUCCEEDED`、`REJECTED`、`FAILED`、`UNKNOWN`；业务状态在 `result.outcome`。
- `result` 只含简单事实；主复杂结果完整放入 `data`，关联复杂数据只在 `resources` 发布引用，按需 `read({ref})`。
- ref 原样复制；不能从路径、ID 或文字拼装。输入错误同时读取 `error.documentationRef` 与 `error.operationDocumentationRef`；其他错误读取前者。
- Case Agent 用于领取唯一 execution Handoff 的预绑定 Loader。不附加输入。必须原样执行，不修改哈希、sequence、claim token 或路径。
- 当前 execution 的 MCP 工具 mavt_case_<method>。提交 {contextRef,input}，方法名称及大小写与索引一致。contextRef 原样取自子 Agent 本次 Loader；业务字段只按当前方法页构造。

## 方法

| 方法 | 用途 | 紧凑签名 |
|---|---|---|
| [`observe`](case-runtime/methods/observe.md) | 采集一个新 Scene，不执行业务动作。 | `observe({ purpose?: string, flowContext?: object })` |
| [`read`](case-runtime/methods/read.md) | 按原样引用读取一个资源。 | `read({ ref: string })` |
| [`inspect`](case-runtime/methods/inspect.md) | 登记 Agent 已观察到的视觉或动作事实。 | `inspect({ mode: "visual", sceneRef: string, observation: string, checkNodeRefs?: string[], flowContext?: object }) / inspect({ mode: "action", sceneRef: string, observation: string, checkNodeRefs?: string[], flowContext?: object })` |
| [`plan`](case-runtime/methods/plan.md) | 创建或修订完整 Case Flow。 | `plan({ caseFlow: object })` |
| [`queryCapabilities`](case-runtime/methods/query-capabilities.md) | 查询并冻结当前 execution 可用的外部能力目录。 | `queryCapabilities({  })` |
| [`useCapability`](case-runtime/methods/use-capability.md) | 调用当前冻结目录中的一项外部能力。 | `useCapability({ capabilityRef: string, input: object, purpose: string, flowContext?: object })` |
| [`recordResult`](case-runtime/methods/record-result.md) | 独立记录已完成证据闭环的验证点结果；成功表示整批结果均已闭环，不采集 Scene、不执行动作。 | `recordResult({ results: Array<object \| { status: "WAIVED"; ... }> })` |
| [`act`](case-runtime/methods/act.md) | 执行一个动作并返回完整新 Scene，控制权立即交还 Agent。 | `act({ sceneRef: string, action: object \| object \| object \| object, purpose?: string, flowContext?: object })` |
| [`runSequence`](case-runtime/methods/run-sequence.md) | 连续执行预先给定的动作、等待与采集；步骤间不交还控制权，结束后返回最终 Scene 和步骤证据。 | `runSequence({ sceneRef: string, purpose: string, steps: Array<{ type: "act"; ... } \| { type: "wait"; ... } \| { type: "capture"; ... }>, flowContext?: object })` |
| [`knowledge`](case-runtime/methods/knowledge.md) | 查询知识，或登记指定 query 的候选复核结果。 | `knowledge({ mode: "query", sceneRef: string, query: string, context?: object, checkNodeRefs?: string[], flowContext?: object }) / knowledge({ mode: "review", sceneRef: string, queryId: string, conclusion: "APPLICABLE_FOUND" \| "NO_APPLICABLE" \| "CONFLICTING" \| "INSUFFICIENT", assessments: object[], flowContext?: object })` |
| [`recover`](case-runtime/methods/recover.md) | 建立授权的 App 初始状态、重启恢复或登记框架外事实。 | `recover({ mode: "restart", sceneRef: string, reason: string, flowContext?: object }) / recover({ mode: "prepare", reason: string, targetState: "APP_LOCAL_STATE_EMPTY" \| "FRESH_INSTALL", flowContext?: object }) / recover({ mode: "external", reason: string, externalAction: object, flowContext?: object })` |
| [`finish`](case-runtime/methods/finish.md) | 从 CHECK ledger 收口并完成用例。 | `finish({ mode: "complete", summary: string, uncertainties?: string[], flowContext?: object, finalReview?: object }) / finish({ mode: "notRun", reason: string, evidence: object, summary: string, uncertainties?: string[], flowContext?: object, finalReview?: object })` |

## 参数来源

- CHECK 节点和分支引用来自 Case Flow 回执或 continuation brief。

## 按需文档

- [ActionRef 规则](case-runtime/action-refs.md)
- [资源目录](case-runtime/resources.md)
- [错误目录](case-runtime/errors.md)
