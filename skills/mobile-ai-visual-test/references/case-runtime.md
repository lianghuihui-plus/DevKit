# Case Runtime

协议：`agent-facing`。启动时读取本索引；字段不足时读取对应方法页。

## 请求与响应

- stdin 一次提交 `{operation,input}`；签名内参数属于 `input`，空输入使用 `{}`。
- 响应为 `{protocol,status,operation,result,resources,data?,error?}`。状态：`SUCCEEDED`、`REJECTED`、`FAILED`、`UNKNOWN`；业务状态在 `result.outcome`。
- `result` 只含简单事实；主复杂结果完整放入 `data`，关联复杂数据只在 `resources` 发布引用，按需 `read({ref})`。
- ref 原样复制；不能从路径、ID 或文字拼装。输入错误同时读取 `error.documentationRef` 与 `error.operationDocumentationRef`；其他错误读取前者。
- Case Agent 用于领取唯一 execution Handoff 的预绑定 Loader。不附加输入。必须原样执行，不修改哈希、sequence、claim token 或路径。
- 当前 execution 的预绑定 Case Runtime Client。每轮通过 stdin 提交 {operation,input} 请求。必须原样使用命令绑定；业务字段只按当前方法页构造。

## 方法

| 方法 | 用途 | 紧凑签名 |
|---|---|---|
| [`observe`](case-runtime/methods/observe.md) | 采集一个新 Scene，不执行业务动作。 | `observe({ purpose?: string, flowContext?: object })` |
| [`read`](case-runtime/methods/read.md) | 按原样引用读取一个资源。 | `read({ ref: string })` |
| [`inspect`](case-runtime/methods/inspect.md) | 登记 Agent 已观察到的视觉或动作事实。 | `inspect({ mode: "visual", sceneRef: string, observation: string, checkNodeRefs?: string[], flowContext?: object }) / inspect({ mode: "action", sceneRef: string, observation: string, checkNodeRefs?: string[], flowContext?: object })` |
| [`plan`](case-runtime/methods/plan.md) | 创建或修订完整 Case Flow。 | `plan({ caseFlow: object })` |
| [`recordResult`](case-runtime/methods/record-result.md) | 独立记录验证点结果，不采集 Scene、不执行动作。 | `recordResult({ results: object[] })` |
| [`act`](case-runtime/methods/act.md) | 基于当前 Scene 执行一个 ActionRef，并采集新 Scene。 | `act({ sceneRef: string, action: object \| object \| object \| object, purpose?: string, flowContext?: object })` |
| [`runPlan`](case-runtime/methods/run-plan.md) | 连续执行受约束的短时动作、等待、采集、定位和技术检查计划。 | `runPlan({ submissionId: string, sceneRef: string, purpose: string, maxDurationMs: number, onFailure: "STOP" \| "CONTINUE", steps: object \| object \| object \| object \| object \| object[], flowContext?: object })` |
| [`knowledge`](case-runtime/methods/knowledge.md) | 查询知识，或登记指定 query 的候选复核结果。 | `knowledge({ mode: "query", sceneRef: string, query: string, checkNodeRefs?: string[], flowContext?: object }) / knowledge({ mode: "review", sceneRef: string, queryId: string, conclusion: "APPLICABLE_FOUND" \| "NO_APPLICABLE" \| "CONFLICTING" \| "INSUFFICIENT", assessments: object[], flowContext?: object })` |
| [`recover`](case-runtime/methods/recover.md) | 建立授权的 App 初始状态、重启恢复或登记框架外事实。 | `recover({ mode: "restart", sceneRef: string, reason: string, flowContext?: object }) / recover({ mode: "prepare", reason: string, targetState: "APP_LOCAL_STATE_EMPTY" \| "FRESH_INSTALL", flowContext?: object }) / recover({ mode: "external", reason: string, externalAction: object, flowContext?: object })` |
| [`finish`](case-runtime/methods/finish.md) | 从 CHECK ledger 收口并完成用例。 | `finish({ mode: "complete", summary: string, uncertainties?: string[], flowContext?: object }) / finish({ mode: "notRun", reason: string, evidence: object, summary: string, uncertainties?: string[], flowContext?: object })` |

## 参数来源

- CHECK 节点和分支引用来自 Case Flow 回执或 continuation brief。

## 按需文档

- [ActionRef 规则](case-runtime/action-refs.md)
- [资源目录](case-runtime/resources.md)
- [错误目录](case-runtime/errors.md)
